//! 统一主窗口尺寸策略；桌面原生后端在系统应用尺寸之前约束 16:9。

use bevy::{
    prelude::*,
    window::{EnabledButtons, PresentMode, PrimaryWindow, WindowResizeConstraints},
};

#[cfg(any(target_os = "windows", test))]
mod geometry;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// 主菜单在此逻辑尺寸及以上保持按钮和页脚完整可见。
pub(crate) const MIN_LOGICAL_SIZE: Vec2 = Vec2::new(960.0, 540.0);

/// 主窗口与原生约束共用初始 16:9 尺寸。
const INITIAL_SIZE: UVec2 = UVec2::new(1280, 720);

/// 在现有会话日志和原生窗口创建之后安装比例策略。
pub(crate) struct WindowPolicyPlugin;

impl Plugin for WindowPolicyPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, log_policy);
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        app.init_non_send::<NativePolicies>()
            // 窗口系统消息不能用玩家动作表达；非 Send 参数保证只在窗口线程操作。
            .add_systems(PreUpdate, install_native_policy);
    }
}

/// 主窗口暂时隐藏，等原生约束装好再显示，避免首帧可绕过缩放限制。
pub(crate) fn primary_window() -> Window {
    let supported = cfg!(any(target_os = "macos", target_os = "windows"));
    Window {
        title: "Island Courier".into(),
        resolution: INITIAL_SIZE.into(),
        resize_constraints: WindowResizeConstraints {
            min_width: MIN_LOGICAL_SIZE.x,
            min_height: MIN_LOGICAL_SIZE.y,
            ..default()
        },
        visible: !supported,
        // 无原生比例后端的平台使用固定窗口，不能默默允许任意比例缩放。
        resizable: supported,
        enabled_buttons: EnabledButtons {
            maximize: supported,
            ..default()
        },
        // 避免垂直同步把玩家帧率上限额外限制为显示器刷新率。
        present_mode: PresentMode::AutoNoVsync,
        ..default()
    }
}

fn log_policy() {
    info!(
        aspect_ratio = "16:9",
        initial_width = INITIAL_SIZE.x,
        initial_height = INITIAL_SIZE.y,
        min_width = MIN_LOGICAL_SIZE.x,
        min_height = MIN_LOGICAL_SIZE.y,
        native_resize = cfg!(any(target_os = "macos", target_os = "windows")),
        "Window policy initialized"
    );
}

#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;

/// 原生句柄守护对象必须与窗口线程绑定，实体退出时释放对应约束。
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[derive(Default)]
struct NativePolicies {
    active: std::collections::HashMap<Entity, platform::NativeWindowPolicy>,
    failed: std::collections::HashSet<Entity>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn install_native_policy(
    _window_thread: bevy::ecs::system::NonSendMarker,
    mut policies: NonSendMut<NativePolicies>,
    mut windows: Query<
        (Entity, &mut Window, Option<&bevy::window::RawHandleWrapper>),
        With<PrimaryWindow>,
    >,
) {
    // 窗口后端存在线程局部表中；这里只取得身份快照。
    // 不跨原生 API 调用持有 RefCell 借用，避免同步窗口通知重入时发生借用冲突。
    let live: std::collections::HashSet<_> = bevy::winit::WINIT_WINDOWS.with_borrow(|backend| {
        windows
            .iter()
            .filter(|(entity, _, _)| backend.get_window(*entity).is_some())
            .map(|(entity, _, _)| entity)
            .collect()
    });
    // 无窗口测试的后端表为空；仅有 Window ECS 数据不能调用原生 API。
    policies
        .active
        .retain(|entity, guard| live.contains(entity) && guard.is_alive());
    policies
        .failed
        .retain(|entity| windows.get(*entity).is_ok());
    for (entity, mut window, handle) in &mut windows {
        if let Some(guard) = policies.active.get_mut(&entity) {
            #[cfg(target_os = "macos")]
            guard.refresh_bounds();
            #[cfg(target_os = "windows")]
            let _ = guard;
            continue;
        }
        if policies.failed.contains(&entity) || !live.contains(&entity) {
            continue;
        }
        let Some(handle) = handle else {
            continue;
        };
        match platform::install(handle) {
            Ok(guard) => {
                policies.active.insert(entity, guard);
                window.visible = true;
                info!(
                    window = ?entity,
                    backend = std::env::consts::OS,
                    aspect_ratio = "16:9",
                    "Native window aspect ratio policy installed"
                );
            }
            Err(error) => {
                // 安装失败时仍可进入游戏，但收紧为固定尺寸，避免静默违反比例约束。
                policies.failed.insert(entity);
                window.resizable = false;
                window.enabled_buttons.maximize = false;
                window.visible = true;
                error!(window = ?entity, error = %error, reason = "native_policy_failed", "Window resizing disabled");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_window_has_supported_aspect_and_minimum_size() {
        let window = primary_window();
        assert_eq!(
            window.resolution.physical_width() * 9,
            window.resolution.physical_height() * 16
        );
        assert_eq!(window.resize_constraints.min_width, 960.0);
        assert_eq!(window.resize_constraints.min_height, 540.0);
        assert_eq!(window.mode, bevy::window::WindowMode::Windowed);
    }

    #[test]
    fn headless_policy_does_not_require_native_window_or_create_one() {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, WindowPolicyPlugin));
        let entity = app
            .world_mut()
            .spawn((primary_window(), PrimaryWindow))
            .id();
        app.update();
        assert_eq!(
            app.world()
                .get::<Window>(entity)
                .unwrap()
                .resolution
                .physical_size(),
            INITIAL_SIZE
        );
        assert_eq!(
            app.world_mut().query::<&Window>().iter(app.world()).count(),
            1
        );
    }
}

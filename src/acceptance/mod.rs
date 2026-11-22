//! 在主世界装配 Bevy 原生远程接口，为应用验收提供离屏呈现与输入。

use avian3d::prelude::{LinearVelocity, Position, Rotation};
use bevy::{
    camera::{CameraUpdateSystems, NormalizedRenderTarget, RenderTarget},
    input::{
        keyboard::KeyboardInput,
        mouse::{MouseButtonInput, MouseMotion, MouseWheel},
    },
    picking::{
        PickingSystems,
        hover::Hovered,
        pointer::{PointerId, PointerInput},
    },
    prelude::*,
    remote::{RemotePlugin, http::RemoteHttpPlugin},
    render::{
        render_resource::TextureFormat,
        view::screenshot::{Screenshot, ScreenshotCaptured},
    },
    window::{
        CursorMoved, CursorOptions, PrimaryWindow, WindowCloseRequested, WindowEvent,
        WindowResolution,
    },
};

use crate::{
    first_person::MouseLookState,
    game_flow::AppState,
    session_log::SessionLogInfo,
    settings::SettingsDraft,
    ui::{MenuButton, MenuFocus, MenuInputSource, MenuState},
};

#[cfg(test)]
mod tests;

const OFFSCREEN_SIZE: UVec2 = UVec2::new(1920, 1080);
const OFFSCREEN_IMAGE: Handle<Image> =
    bevy::asset::uuid_handle!("90f84289-3b0e-4450-966f-8342d0e3f011");

/// 提供输入和窗口关闭流程使用的 ECS 数据，与离屏目标共用视口尺寸。
pub(crate) fn input_window_plugin() -> WindowPlugin {
    WindowPlugin {
        primary_window: Some(Window {
            focused: true,
            visible: false,
            resolution: WindowResolution::new(OFFSCREEN_SIZE.x, OFFSCREEN_SIZE.y)
                .with_scale_factor_override(1.0),
            ..default()
        }),
        ..default()
    }
}

/// 仅在验收模式下安装，在默认渲染插件创建 RenderApp 之前调用。
pub(crate) struct AcceptancePlugin;

impl Plugin for AcceptancePlugin {
    fn build(&self, app: &mut App) {
        // 两个原生插件只为已经存在的世界注册远程系统。
        app.add_plugins((
            RemotePlugin::default(),
            RemoteHttpPlugin::default().with_header("X-Bevy-Pid", std::process::id().to_string()),
        ));
        register_types(app);
        register_offscreen_systems(app);
    }
}

fn register_offscreen_systems(app: &mut App) {
    app.add_systems(Startup, init_offscreen_image)
        .add_systems(PostStartup, retarget_cameras.before(CameraUpdateSystems))
        .add_systems(PostUpdate, retarget_cameras.before(CameraUpdateSystems))
        .add_systems(First, retarget_mouse.in_set(PickingSystems::PostInput));
}

fn init_offscreen_image(mut images: ResMut<Assets<Image>>) {
    // UUID 句柄可通过原生 BRP 反射往返。同一图像留在两份世界中供相机和渲染器读取。
    images
        .insert(
            OFFSCREEN_IMAGE.id(),
            Image::new_target_texture(
                OFFSCREEN_SIZE.x,
                OFFSCREEN_SIZE.y,
                TextureFormat::Rgba8UnormSrgb,
                None,
            ),
        )
        .expect("Offscreen image uses a UUID asset ID");
    info!(target: "demo::acceptance", width = OFFSCREEN_SIZE.x, height = OFFSCREEN_SIZE.y,
        "Offscreen rendering initialized");
}

/// 菜单与玩法使用默认 UI 相机，在每台相机首次计算视口前连接离屏目标。
fn retarget_cameras(
    mut cameras: Query<&mut RenderTarget, (Added<Camera>, With<IsDefaultUiCamera>)>,
) {
    for mut target in &mut cameras {
        if target.as_image() != Some(&OFFSCREEN_IMAGE) {
            *target = RenderTarget::Image(OFFSCREEN_IMAGE.into());
        }
    }
}

/// 在 Picking 消费前把合成主窗口的鼠标事件指向同一视口，保留原生鼠标动作。
fn retarget_mouse(
    mut messages: MessageMutator<PointerInput>,
    window: Single<Entity, With<PrimaryWindow>>,
) {
    for message in messages.read() {
        if message.pointer_id == PointerId::Mouse
            && matches!(
                &message.location.target,
                NormalizedRenderTarget::Window(target) if target.entity() == *window
            )
        {
            message.location.target = NormalizedRenderTarget::Image(OFFSCREEN_IMAGE.into());
        }
    }
}

fn register_types(app: &mut App) {
    app.register_type::<State<AppState>>()
        .register_type::<SessionLogInfo>()
        .register_type::<MenuState>()
        .register_type::<MenuFocus>()
        .register_type::<MenuInputSource>()
        .register_type::<MenuButton>()
        .register_type::<SettingsDraft>()
        .register_type::<MouseLookState>()
        .register_type::<Camera>()
        .register_type::<RenderTarget>()
        .register_type::<Name>()
        .register_type::<Transform>()
        .register_type::<Position>()
        .register_type::<Rotation>()
        .register_type::<LinearVelocity>()
        .register_type::<Window>()
        .register_type::<PrimaryWindow>()
        .register_type::<CursorOptions>()
        .register_type::<ButtonInput<KeyCode>>()
        .register_type::<ButtonInput<MouseButton>>()
        .register_type::<KeyboardInput>()
        .register_type::<CursorMoved>()
        .register_type::<MouseButtonInput>()
        .register_type::<MouseMotion>()
        .register_type::<MouseWheel>()
        .register_type::<WindowEvent>()
        .register_type::<WindowCloseRequested>()
        .register_type::<ComputedNode>()
        .register_type::<UiGlobalTransform>()
        .register_type::<Hovered>()
        .register_type::<Screenshot>()
        .register_type::<ScreenshotCaptured>();
}

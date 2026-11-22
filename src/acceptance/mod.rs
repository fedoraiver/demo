//! 在主世界装配 Bevy 原生远程接口，供窗口验收脚本读写已注册的数据。

use avian3d::prelude::{LinearVelocity, Position, Rotation};
use bevy::{
    input::{
        keyboard::KeyboardInput,
        mouse::{MouseButtonInput, MouseMotion, MouseWheel},
    },
    picking::hover::Hovered,
    prelude::*,
    remote::{RemotePlugin, http::RemoteHttpPlugin},
    render::view::screenshot::{Screenshot, ScreenshotCaptured},
    window::{CursorMoved, CursorOptions, PrimaryWindow, WindowCloseRequested, WindowEvent},
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

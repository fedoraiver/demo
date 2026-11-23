//! 装配世界检查器并记录启用状态。

#[cfg(test)]
mod tests;

#[cfg(feature = "inspector")]
use bevy::prelude::*;
#[cfg(feature = "inspector")]
use bevy_inspector_egui::{
    bevy_egui::{EguiPlugin, PrimaryEguiContext},
    quick::WorldInspectorPlugin,
};

#[cfg(feature = "inspector")]
use crate::game_flow::gameplay_running;

/// 注册检查器及其启动日志；面板只在游戏运行时显示。
#[cfg(feature = "inspector")]
pub struct InspectorPlugin;

#[cfg(feature = "inspector")]
impl Plugin for InspectorPlugin {
    fn build(&self, app: &mut App) {
        // 检查器复用主窗口与相机，Egui 必须先于世界检查器注册。
        app.add_plugins((
            EguiPlugin::default(),
            WorldInspectorPlugin::new().run_if(gameplay_running),
        ))
        .add_observer(attach_to_ui_camera)
        .add_systems(Startup, log_world_inspector);
    }
}

/// 主菜单与游戏会交替创建界面相机，各自需要检查器上下文。
#[cfg(feature = "inspector")]
fn attach_to_ui_camera(camera: On<Add<IsDefaultUiCamera>>, mut commands: Commands) {
    commands
        .entity(camera.entity)
        .try_insert_if_new(PrimaryEguiContext);
}

/// 启用记录表示插件已装配，不依赖场景实体或当前面板可见性。
#[cfg(feature = "inspector")]
fn log_world_inspector() {
    info!(target: "demo::inspector", plugin = "WorldInspectorPlugin", reason = "initialization",
        "World inspector enabled");
}

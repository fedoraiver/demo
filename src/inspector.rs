//! 封装世界检查器的装配和启用日志，复用统一会话日志设施。

use bevy::prelude::*;
use bevy_inspector_egui::{bevy_egui::EguiPlugin, quick::WorldInspectorPlugin};

use crate::app_flow::gameplay_running;

/// 注册检查器及其启动日志；面板只在游戏运行时显示。
pub struct ProjectInspectorPlugin;

impl Plugin for ProjectInspectorPlugin {
    fn build(&self, app: &mut App) {
        // 检查器复用主窗口与相机，Egui 必须先于世界检查器注册。
        app.add_plugins((
            EguiPlugin::default(),
            WorldInspectorPlugin::new().run_if(gameplay_running),
        ))
        .add_systems(Startup, log_world_inspector);
    }
}

/// 启用记录表示插件已装配，不依赖场景实体或当前面板可见性。
fn log_world_inspector() {
    info!(target: "demo::inspector", plugin = "WorldInspectorPlugin", reason = "initialization",
        "World inspector enabled");
}

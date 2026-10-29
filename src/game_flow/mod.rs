//! 游戏状态和时钟生命周期，以及功能之间的显式调度契约。

use std::time::Duration;

use avian3d::{
    interpolation::TransformEasingSystems,
    prelude::{Physics, PhysicsTime},
};
use bevy::prelude::*;

/// 固定玩法模拟频率；渲染限帧由设置功能独立管理。
pub(crate) const FIXED_SIMULATION_HZ: f64 = 60.0;

/// 应用的唯一运行状态；暂停保留当前会话，返回主菜单才清理实体。
#[derive(States, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) enum AppState {
    #[default]
    MainMenu,
    Running,
    Paused,
}

/// 固定模拟阶段；结构变更在依赖阶段之间提交。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum FixedGameplaySystems {
    Recover,
    Facing,
    Motion,
    Interaction,
    Target,
    Attachment,
}

/// 固定循环后的呈现阶段，零固定步的帧也执行同一顺序。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum PresentationSystems {
    Facing,
    HeldPhysics,
    HeldPresentation,
    Camera,
    Visibility,
}

/// 管理游戏状态与时钟，连接各功能公开的调度阶段。
pub(crate) struct GameFlowPlugin;

impl Plugin for GameFlowPlugin {
    fn build(&self, app: &mut App) {
        configure_feature_order(app);
        app.init_state::<AppState>()
            .add_systems(OnEnter(AppState::MainMenu), enter_main_menu)
            .add_systems(OnEnter(AppState::Paused), pause_simulation)
            .add_systems(OnEnter(AppState::Running), resume_simulation);
    }
}

/// 只配置执行依赖；无窗口夹具可复用，而不创建应用状态或安装其他插件。
pub(crate) fn configure_feature_order(app: &mut App) {
    use crate::{audio::AudioSystems, ui::UiSystems};
    app.configure_sets(
        FixedUpdate,
        (
            FixedGameplaySystems::Recover,
            FixedGameplaySystems::Facing,
            FixedGameplaySystems::Motion,
            FixedGameplaySystems::Interaction,
            FixedGameplaySystems::Target,
            FixedGameplaySystems::Attachment,
        )
            .chain(),
    )
    .configure_sets(
        RunFixedMainLoop,
        (
            PresentationSystems::Facing,
            PresentationSystems::HeldPhysics,
            PresentationSystems::HeldPresentation,
            PresentationSystems::Camera,
            PresentationSystems::Visibility,
        )
            .chain()
            .in_set(RunFixedMainLoopSystems::AfterFixedMainLoop)
            .after(TransformEasingSystems::Ease)
            .before(TransformEasingSystems::UpdateEasingTick),
    )
    .configure_sets(
        Update,
        (UiSystems::Style, AudioSystems::Mix, AudioSystems::Playback).chain(),
    );
}

/// 独立功能测试没有应用状态；真实游戏只在 Running 推进玩法。
pub(crate) fn gameplay_running(app_state: Option<Res<State<AppState>>>) -> bool {
    app_state.is_none_or(|state| *state.get() == AppState::Running)
}

fn enter_main_menu(
    mut virtual_time: Option<ResMut<Time<Virtual>>>,
    physics_time: Option<ResMut<Time<Physics>>>,
) {
    if let Some(time) = virtual_time.as_mut() {
        time.unpause();
    }
    pause_physics(physics_time);
}

fn pause_simulation(
    mut virtual_time: Option<ResMut<Time<Virtual>>>,
    physics_time: Option<ResMut<Time<Physics>>>,
) {
    if let Some(time) = virtual_time.as_mut() {
        time.pause();
        time.advance_by(Duration::ZERO);
    }
    pause_physics(physics_time);
}

fn pause_physics(mut physics_time: Option<ResMut<Time<Physics>>>) {
    if let Some(time) = physics_time.as_mut() {
        time.pause();
        // Avian 仍可能读取上一非零 delta，状态入口必须立即清零。
        time.advance_by(Duration::ZERO);
    }
}

fn resume_simulation(
    mut virtual_time: Option<ResMut<Time<Virtual>>>,
    mut physics_time: Option<ResMut<Time<Physics>>>,
) {
    if let Some(time) = virtual_time.as_mut() {
        time.unpause();
    }
    if let Some(time) = physics_time.as_mut() {
        time.unpause();
    }
}

#[cfg(test)]
mod tests;

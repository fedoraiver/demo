//! 游戏状态和时钟生命周期，以及功能之间的显式调度契约。

use std::time::Duration;

use avian3d::{
    interpolation::TransformEasingSystems,
    prelude::{Physics, PhysicsTime},
};
use bevy::{prelude::*, state::app::StatesPlugin};

/// 游戏会话只在 InGame 期间存在，暂停不切换该状态。
#[derive(States, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) enum AppState {
    #[default]
    MainMenu,
    InGame,
}

/// 会话内的运行状态；暂停保留场景、角色和持有关系。
#[derive(SubStates, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[source(AppState = AppState::InGame)]
pub(crate) enum PlayState {
    #[default]
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
        if !app.is_plugin_added::<StatesPlugin>() {
            app.add_plugins(StatesPlugin);
        }
        app.init_state::<AppState>()
            .add_sub_state::<PlayState>()
            .add_systems(OnEnter(AppState::MainMenu), enter_main_menu)
            .add_systems(OnEnter(PlayState::Paused), pause_simulation)
            .add_systems(OnEnter(PlayState::Running), resume_simulation);
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

/// 独立功能测试没有应用状态；真实游戏要求同时处于会话和运行子状态。
pub(crate) fn gameplay_running(
    app_state: Option<Res<State<AppState>>>,
    play_state: Option<Res<State<PlayState>>>,
) -> bool {
    app_state.is_none_or(|state| {
        *state.get() == AppState::InGame
            && play_state.is_some_and(|state| *state.get() == PlayState::Running)
    })
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

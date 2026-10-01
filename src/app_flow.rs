//! 主菜单与游戏会话的生命周期；暂停只冻结模拟，不销毁玩法实体。

use std::time::Duration;

use avian3d::prelude::{Physics, PhysicsTime};
use bevy::{
    prelude::*,
    state::app::StatesPlugin,
    window::{CursorGrabMode, CursorOptions},
};
use bevy_enhanced_input::prelude::ContextActivity;

use crate::{
    camera::MouseLookState,
    gameplay::CharacterIntent,
    input::GameplayContext,
    ui::{MenuFocus, MenuPage, MenuState},
};

/// 游戏会话只在 InGame 期间存在，设置和暂停不切换该状态。
#[derive(States, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum AppState {
    #[default]
    MainMenu,
    InGame,
}

/// 游戏内部的暂停子状态，不触发场景重新生成或清理。
#[derive(SubStates, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[source(AppState = AppState::InGame)]
pub enum PlayState {
    #[default]
    Running,
    Paused,
}

/// 注册状态入口与退出行为；无窗口测试也可复用相同生命周期。
pub struct AppFlowPlugin;

impl Plugin for AppFlowPlugin {
    fn build(&self, app: &mut App) {
        if !app.is_plugin_added::<StatesPlugin>() {
            app.add_plugins(StatesPlugin);
        }
        app.init_state::<AppState>()
            .add_sub_state::<PlayState>()
            .init_resource::<MenuState>()
            .init_resource::<MenuFocus>()
            .add_systems(
                OnEnter(AppState::MainMenu),
                (show_main_menu, suspend_input).chain(),
            )
            .add_systems(
                OnEnter(PlayState::Paused),
                (show_pause_menu, suspend_input).chain(),
            )
            .add_systems(OnEnter(PlayState::Running), resume_game);
    }
}

/// 独立玩法测试不安装菜单状态；实际游戏必须同时处于会话与运行子状态。
pub fn gameplay_running(
    app_state: Option<Res<State<AppState>>>,
    play_state: Option<Res<State<PlayState>>>,
) -> bool {
    app_state.is_none_or(|state| {
        *state.get() == AppState::InGame
            && play_state.is_some_and(|state| *state.get() == PlayState::Running)
    })
}

fn show_main_menu(
    mut menu: ResMut<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut virtual_time: Option<ResMut<Time<Virtual>>>,
    mut transitions: MessageReader<StateTransitionEvent<AppState>>,
) {
    let state_before = transitions.read().last().and_then(|change| change.exited);
    menu.page = MenuPage::Main;
    menu.return_page = MenuPage::Main;
    menu.status = None;
    focus.0 = 0;
    // 主菜单的展示动画仍使用正常虚拟时间，物理时钟由 suspend_input 单独停用。
    if let Some(time) = virtual_time.as_mut() {
        time.unpause();
    }
    info!(target: "demo::ui", ?state_before, state_after = "main_menu", reason = "enter_main_menu", "Application state changed");
}

fn show_pause_menu(mut menu: ResMut<MenuState>, mut focus: ResMut<MenuFocus>) {
    menu.page = MenuPage::Pause;
    menu.return_page = MenuPage::Pause;
    menu.status = None;
    focus.0 = 0;
    info!(target: "demo::ui", state_before = "running", state_after = "paused", reason = "pause_action", "Application state changed");
}

/// 状态入口在固定循环之前执行，清理本帧待消费请求并立即冻结物理增量。
fn suspend_input(
    mut commands: Commands,
    menu: Res<MenuState>,
    mut virtual_time: Option<ResMut<Time<Virtual>>>,
    mut physics_time: Option<ResMut<Time<Physics>>>,
    mut intents: Query<&mut CharacterIntent>,
    controllers: Query<Entity, With<GameplayContext>>,
    mut captures: Query<&mut MouseLookState>,
    mut cursors: Query<&mut CursorOptions>,
) {
    if menu.page == MenuPage::Pause
        && let Some(time) = virtual_time.as_mut()
    {
        time.pause();
        time.advance_by(Duration::ZERO);
    }
    if let Some(time) = physics_time.as_mut() {
        time.pause();
        // Avian 暂停后仍可能读上一非零 delta；立即清零，防止暂停当帧额外积分。
        time.advance_by(Duration::ZERO);
    }
    for mut intent in &mut intents {
        *intent = CharacterIntent::default();
    }
    for entity in &controllers {
        commands
            .entity(entity)
            .insert(ContextActivity::<GameplayContext>::INACTIVE);
    }
    for mut capture in &mut captures {
        capture.active = false;
        capture.skip_motion = true;
    }
    for mut cursor in &mut cursors {
        cursor.visible = true;
        cursor.grab_mode = CursorGrabMode::None;
    }
}

fn resume_game(
    mut menu: ResMut<MenuState>,
    mut virtual_time: Option<ResMut<Time<Virtual>>>,
    mut physics_time: Option<ResMut<Time<Physics>>>,
    mut captures: Query<&mut MouseLookState>,
    mut transitions: MessageReader<StateTransitionEvent<PlayState>>,
) {
    let state_before = transitions.read().last().and_then(|change| change.exited);
    menu.page = MenuPage::Hidden;
    menu.status = None;
    if let Some(time) = virtual_time.as_mut() {
        time.unpause();
    }
    if let Some(time) = physics_time.as_mut() {
        time.unpause();
    }
    // 相机的统一捕获系统在下一次输入准备时恢复锁定，并跳过自由光标阶段的位移。
    for mut capture in &mut captures {
        capture.initialized = false;
        capture.skip_motion = true;
    }
    info!(target: "demo::ui", ?state_before, state_after = "running", reason = "enter_running", "Application state changed");
}

#[cfg(test)]
mod tests {
    use super::*;

    use avian3d::prelude::{Collider, LinearVelocity, Position, RigidBody};
    use bevy::time::TimeUpdateStrategy;

    use crate::gameplay::GameplayPlugin;

    #[test]
    fn pause_freezes_actual_physics_immediately_and_resume_does_not_catch_up() {
        // 使用真实 Avian 调度和单个几何刚体，直接检查每次 app.update 返回后的位姿。
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            TransformPlugin,
            AppFlowPlugin,
            GameplayPlugin,
        ))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
            1.0 / 60.0,
        )));
        app.finish();
        app.cleanup();
        app.update();
        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::InGame);
        app.update();
        let body = app
            .world_mut()
            .spawn((
                RigidBody::Dynamic,
                Collider::cuboid(0.6, 0.6, 0.6),
                LinearVelocity(Vec3::new(2.0, 0.0, 0.0)),
                Transform::from_xyz(0.0, 10.0, 0.0),
            ))
            .id();
        for _ in 0..3 {
            app.update();
        }
        let position = *app.world().get::<Position>(body).unwrap();
        let velocity = *app.world().get::<LinearVelocity>(body).unwrap();
        assert!(position.x > 0.0);
        assert!(velocity.y < 0.0);
        app.world_mut()
            .resource_mut::<NextState<PlayState>>()
            .set(PlayState::Paused);
        for _ in 0..12 {
            app.update();
            assert_eq!(*app.world().get::<Position>(body).unwrap(), position);
            assert_eq!(*app.world().get::<LinearVelocity>(body).unwrap(), velocity);
        }
        app.world_mut()
            .resource_mut::<NextState<PlayState>>()
            .set(PlayState::Running);
        app.update();
        app.update();
        let resumed = app.world().get::<Position>(body).unwrap();
        assert!(resumed.x > position.x);
        assert!(
            resumed.x - position.x < 0.08,
            "resume must not integrate paused wall time"
        );
    }
}

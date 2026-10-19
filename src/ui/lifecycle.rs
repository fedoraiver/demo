//! 菜单只响应应用状态更新页面；时钟和玩家输入由各自功能响应同一状态。

use super::{MenuFocus, MenuPage, MenuState};
use crate::game_flow::{AppState, PlayState};
use bevy::prelude::*;

pub(super) fn register(app: &mut App) {
    app.init_resource::<MenuState>()
        .init_resource::<MenuFocus>()
        .add_systems(OnEnter(AppState::MainMenu), show_main_menu)
        .add_systems(OnEnter(PlayState::Paused), show_pause_menu)
        .add_systems(OnEnter(PlayState::Running), hide_menu);
}

fn show_main_menu(
    mut menu: ResMut<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut transitions: MessageReader<StateTransitionEvent<AppState>>,
) {
    let state_before = transitions.read().last().and_then(|change| change.exited);
    menu.page = MenuPage::Main;
    menu.return_page = MenuPage::Main;
    menu.status = None;
    focus.0 = 0;
    info!(target: "demo::ui", ?state_before, state_after = "main_menu", reason = "enter_main_menu", "Application state changed");
}

fn show_pause_menu(mut menu: ResMut<MenuState>, mut focus: ResMut<MenuFocus>) {
    menu.page = MenuPage::Pause;
    menu.return_page = MenuPage::Pause;
    menu.status = None;
    focus.0 = 0;
    info!(target: "demo::ui", state_before = "running", state_after = "paused", reason = "pause_action", "Application state changed");
}

fn hide_menu(
    mut menu: ResMut<MenuState>,
    mut transitions: MessageReader<StateTransitionEvent<PlayState>>,
) {
    let state_before = transitions.read().last().and_then(|change| change.exited);
    menu.page = MenuPage::Hidden;
    menu.status = None;
    info!(target: "demo::ui", ?state_before, state_after = "running", reason = "enter_running", "Application state changed");
}

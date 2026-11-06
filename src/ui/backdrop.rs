//! 主菜单使用纯色背景；暂停菜单沿用当前玩法相机。

use bevy::prelude::*;
use bevy_inspector_egui::bevy_egui::PrimaryEguiContext;

use crate::game_flow::AppState;

const MENU_BACKGROUND: Color = Color::srgb(0.15, 0.17, 0.20);

/// 菜单相机随主菜单退出清理，设置和帮助页面沿用该相机。
#[derive(Component, Default, Clone)]
pub(super) struct MenuBackdrop;

pub(super) fn register(app: &mut App) {
    app.add_systems(OnEnter(AppState::MainMenu), spawn_backdrop);
}

fn spawn_backdrop(mut commands: Commands) {
    let backdrop = commands
        .spawn_scene(bsn! {
            #MenuBackdrop
            MenuBackdrop
            DespawnOnExit::<AppState>(AppState::MainMenu)
            Transform
            Children [
                @menu_camera()
            ]
        })
        .id();
    info!(target: "demo::ui::backdrop", ?backdrop, state = "main_menu",
        reason = "state_enter", "Menu backdrop spawned");
}

/// 菜单界面的独立相机用纯色清屏。
pub(super) fn menu_camera() -> impl Scene {
    bsn! {
        #MenuCamera
        Camera3d
        Camera {
            clear_color: {ClearColorConfig::Custom(MENU_BACKGROUND)},
        }
        IsDefaultUiCamera
        PrimaryEguiContext
    }
}

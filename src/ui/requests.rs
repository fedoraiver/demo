//! 每帧只消费一个菜单语义请求，集中管理草稿、保存与状态切换。

use super::{navigation::MenuContext, *};
use crate::{
    audio::{SoundCue, SoundRequest},
    game_flow::{AppState, PlayState},
    settings::{GameSettings, SettingsDraft, SettingsFile},
};
use bevy::prelude::*;
use bevy_enhanced_input::prelude::EnhancedInputSystems;

pub(super) fn register(app: &mut App) {
    // 动作应用后、状态切换及固定循环前消费，暂停在当帧生效。
    app.add_systems(
        PreUpdate,
        handle_requests.after(EnhancedInputSystems::Trigger),
    );
}

fn open_page(menu: &mut MenuState, focus: &mut MenuFocus, page: MenuPage) {
    menu.return_page = menu.page;
    menu.page = page;
    menu.status = None;
    focus.index = 0;
}

/// 每帧只消费一项语义请求，避免鼠标与确认键同时激活，或旧页面动作穿过页面切换。
fn handle_requests(
    mut requests: MessageReader<UiRequest>,
    mut menu: ResMut<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut draft: ResMut<SettingsDraft>,
    mut settings: ResMut<GameSettings>,
    path: Res<SettingsFile>,
    mut app_state: ResMut<NextState<AppState>>,
    mut play_state: ResMut<NextState<PlayState>>,
    mut exits: MessageWriter<AppExit>,
    controllers: Query<Entity, With<MenuContext>>,
    mut sounds: MessageWriter<SoundRequest>,
    mut volume_edit: Local<Option<(SettingKey, u8)>>,
) {
    let mut actions = requests.read().map(|request| request.action);
    let action = actions.next();
    // 同一拖动帧可同时包含最后坐标与释放；键盘操作优先于上一帧排队的拖动，避免吞掉 Esc。
    let mut finished_volume = false;
    let action = action.map(|action| match action {
        UiAction::SetVolume(..) | UiAction::FinishVolumeEdit => {
            let mut selected = action;
            for next in actions {
                match next {
                    UiAction::SetVolume(next_key, next_value) => {
                        if let UiAction::SetVolume(key, _) = selected
                            && next_key == key
                        {
                            selected = UiAction::SetVolume(key, next_value);
                        }
                    }
                    UiAction::FinishVolumeEdit => finished_volume = true,
                    // 滑条上的 Enter 只是无效 Adjust，不应打断正在编辑的初值。
                    UiAction::Adjust(_, 0) => {}
                    action => {
                        selected = action;
                        break;
                    }
                }
            }
            selected
        }
        action => action,
    });
    requests.clear();
    let Some(action) = action else {
        return;
    };
    let before = menu.page;
    let mut cue = SoundCue::MenuConfirm;
    match action {
        UiAction::StartGame if menu.page == MenuPage::Main => app_state.set(AppState::InGame),
        UiAction::OpenSettings if matches!(menu.page, MenuPage::Main | MenuPage::Pause) => {
            *draft = SettingsDraft::from_settings(&settings);
            menu.tab = SettingsTab::Graphics;
            open_page(&mut menu, &mut focus, MenuPage::Settings);
        }
        UiAction::OpenHelp if matches!(menu.page, MenuPage::Main | MenuPage::Pause) => {
            open_page(&mut menu, &mut focus, MenuPage::Help)
        }
        UiAction::Quit if menu.page == MenuPage::Main => {
            exits.write(AppExit::Success);
        }
        UiAction::Resume if menu.page == MenuPage::Pause => {
            play_state.set(PlayState::Running);
            cue = SoundCue::MenuCancel;
        }
        UiAction::ReturnToMenu if menu.page == MenuPage::Pause => {
            app_state.set(AppState::MainMenu);
            cue = SoundCue::MenuCancel;
        }
        UiAction::Back => match menu.page {
            MenuPage::Hidden => play_state.set(PlayState::Paused),
            MenuPage::Pause => {
                play_state.set(PlayState::Running);
                cue = SoundCue::MenuCancel;
            }
            MenuPage::Settings | MenuPage::Help => {
                *draft = SettingsDraft::from_settings(&settings);
                menu.page = menu.return_page;
                menu.status = None;
                focus.index = 0;
                cue = SoundCue::MenuCancel;
            }
            MenuPage::Main => return,
        },
        UiAction::SelectTab(tab) if menu.page == MenuPage::Settings => {
            if menu.tab == tab {
                return;
            }
            menu.tab = tab;
            menu.status = None;
            focus.index = match tab {
                SettingsTab::Graphics => 0,
                SettingsTab::Audio => 1,
                SettingsTab::Controls => 2,
                SettingsTab::Accessibility => 3,
            };
        }
        UiAction::Adjust(key, direction) if menu.page == MenuPage::Settings => {
            let before = draft.clone();
            draft.adjust(key, direction);
            if before == *draft {
                return;
            }
            if let Some(volume_before) = before.volume(key) {
                info!(target: "demo::settings", ?key, volume_before,
                    volume_after = draft.volume(key), reason = "volume_step",
                    "Audio volume preview changed");
            }
            menu.status = None;
        }
        UiAction::SetVolume(key, value)
            if menu.page == MenuPage::Settings && menu.tab == SettingsTab::Audio =>
        {
            let Some(previous) = draft.volume(key) else {
                return;
            };
            if volume_edit
                .as_ref()
                .is_none_or(|(editing, _)| *editing != key)
            {
                *volume_edit = Some((key, previous));
            }
            if draft.set_volume(key, value) {
                menu.status = None;
            }
            if !finished_volume {
                return;
            }
            let Some((editing, initial)) = volume_edit.take() else {
                return;
            };
            if draft.volume(editing) == Some(initial) {
                return;
            }
            info!(target: "demo::settings", ?editing, volume_before = initial,
                volume_after = draft.volume(editing), reason = "volume_drag_finished",
                "Audio volume preview changed");
        }
        UiAction::FinishVolumeEdit
            if menu.page == MenuPage::Settings && menu.tab == SettingsTab::Audio =>
        {
            let Some((editing, initial)) = volume_edit.take() else {
                return;
            };
            if draft.volume(editing) == Some(initial) {
                return;
            }
            info!(target: "demo::settings", ?editing, volume_before = initial,
                volume_after = draft.volume(editing), reason = "volume_drag_finished",
                "Audio volume preview changed");
        }
        UiAction::TestSfx if menu.page == MenuPage::Settings && menu.tab == SettingsTab::Audio => {
            *volume_edit = None;
            // 试听复用素材请求，来源为菜单控制者；不触发拿放系统或伪造玩法成功日志。
            if let Ok(source) = controllers.single() {
                sounds.write(SoundRequest::new(SoundCue::ParcelPickup, source));
                info!(target: "demo::ui", event = "parcel_pickup", ?source,
                    reason = "settings_preview", "Audio sample requested");
            }
            return;
        }
        UiAction::RestoreDefaults if menu.page == MenuPage::Settings => {
            *draft = SettingsDraft::default();
            menu.status = Some("Defaults restored. Choose Apply to save.".into());
        }
        UiAction::ApplySettings if menu.page == MenuPage::Settings => {
            match draft
                .to_settings()
                .and_then(|updated| updated.save(&path.path).map(|()| updated))
            {
                Ok(updated) => {
                    info!(target: "demo::settings", path = %path.path.display(),
                        max_fps_before = settings.max_fps.get(), max_fps_after = updated.max_fps.get(),
                        sensitivity_before = settings.camera.mouse_sensitivity, sensitivity_after = updated.camera.mouse_sensitivity,
                        invert_y_before = settings.camera.invert_y, invert_y_after = updated.camera.invert_y,
                        master_volume_before = settings.audio.master_volume, master_volume_after = updated.audio.master_volume,
                        sfx_volume_before = settings.audio.sfx_volume, sfx_volume_after = updated.audio.sfx_volume,
                        ui_volume_before = settings.audio.ui_volume, ui_volume_after = updated.audio.ui_volume,
                        reason = "settings_apply", "Game settings saved and applied");
                    *settings = updated;
                    menu.status = Some("Settings applied.".into());
                }
                Err(error) => {
                    error!(target: "demo::settings", path = %path.path.display(), %error, operation = "apply_settings", "Failed to save settings");
                    menu.status = Some("Could not save settings. Your changes are still available; try Apply again.".into());
                    cue = SoundCue::MenuCancel;
                }
            }
        }
        _ => return,
    }
    if !matches!(action, UiAction::SetVolume(..) | UiAction::FinishVolumeEdit) {
        // 只在其他操作真正被接受后结束旧手势，无效确认或边界调整不破坏初值。
        *volume_edit = None;
    }
    // 只对本帧真正消费并接受的语义请求反馈，鼠标与确认键并存也只产生一次。
    if let Ok(source) = controllers.single() {
        sounds.write(SoundRequest::new(cue, source));
        info!(target: "demo::ui", event = cue.id(), ?source, action = ?action,
            reason = "handled_ui_request", "Menu audio cue emitted");
    }
    if before != menu.page {
        info!(target: "demo::ui", page_before = ?before, page_after = ?menu.page, reason = ?action, "Menu page changed");
    }
}

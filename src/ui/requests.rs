//! 每帧只消费一个菜单语义请求，集中管理草稿、保存与状态切换。

use super::{navigation::MenuContext, *};
use crate::{
    audio::{SoundCue, SoundRequest},
    game_flow::AppState,
    settings::{GameSettings, SettingsDraft, SettingsFile},
};
use bevy::input_focus::{FocusCause, InputFocus};
use bevy::prelude::*;
use bevy::text::EditableText;
use bevy_enhanced_input::prelude::EnhancedInputSystems;

pub(super) fn register(app: &mut App) {
    // 动作应用后、状态切换及固定循环前消费，暂停在当帧生效。
    app.add_systems(
        PreUpdate,
        handle_requests
            .after(EnhancedInputSystems::Trigger)
            .after(super::sensitivity::apply_pending_input),
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
    mut exits: MessageWriter<AppExit>,
    controllers: Query<Entity, With<MenuContext>>,
    mut sounds: MessageWriter<SoundRequest>,
    mut volume_edit: Local<Option<(SettingKey, u8)>>,
    mut input_focus: ResMut<InputFocus>,
    sensitivity_inputs: Query<(Entity, &super::sensitivity::SensitivityInput, &EditableText)>,
    mut sensitivity_slider_edit: Local<Option<String>>,
) {
    let mut actions = requests.read().map(|request| request.action);
    let action = actions.next();
    // 同一拖动帧可同时包含最后坐标与释放；键盘操作优先于上一帧排队的拖动，避免吞掉 Esc。
    let mut finished_volume = false;
    let mut finished_sensitivity = false;
    let action = action.map(|action| match action {
        UiAction::SetVolume(..)
        | UiAction::FinishVolumeEdit
        | UiAction::SetSensitivity(_)
        | UiAction::FinishSensitivitySlider => {
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
                    UiAction::SetSensitivity(value) => {
                        if matches!(selected, UiAction::SetSensitivity(_)) {
                            selected = UiAction::SetSensitivity(value);
                        }
                    }
                    UiAction::FinishSensitivitySlider => finished_sensitivity = true,
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
        UiAction::StartGame if menu.page == MenuPage::Main => {
            app_state.set_if_different(AppState::Running)
        }
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
            app_state.set_if_different(AppState::Running);
            cue = SoundCue::MenuCancel;
        }
        UiAction::ReturnToMenu if menu.page == MenuPage::Pause => {
            app_state.set_if_different(AppState::MainMenu);
            cue = SoundCue::MenuCancel;
        }
        UiAction::Back => match menu.page {
            MenuPage::Hidden => app_state.set_if_different(AppState::Paused),
            MenuPage::Pause => {
                app_state.set_if_different(AppState::Running);
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
            if menu.tab == SettingsTab::Controls
                && sensitivity_inputs.iter().any(|(entity, input, _)| {
                    input.was_focused || input_focus.get() == Some(entity)
                })
            {
                draft.normalize_sensitivity();
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
        UiAction::EditSensitivity
            if menu.page == MenuPage::Settings && menu.tab == SettingsTab::Controls =>
        {
            if let Ok((entity, _, _)) = sensitivity_inputs.single()
                && input_focus.get() != Some(entity)
            {
                input_focus.set(entity, FocusCause::Navigated);
            }
        }
        UiAction::FinishSensitivityEdit if menu.page == MenuPage::Settings => {
            if sensitivity_inputs
                .iter()
                .any(|(_, _, text)| text.is_composing() || text.pending_paste.is_some())
            {
                return;
            }
            if !draft.normalize_sensitivity() {
                menu.status = Some(super::sensitivity::INPUT_ERROR.into());
                return;
            }
            input_focus.clear();
        }
        UiAction::SetSensitivity(step)
            if menu.page == MenuPage::Settings && menu.tab == SettingsTab::Controls =>
        {
            sensitivity_slider_edit.get_or_insert_with(|| draft.mouse_sensitivity_text.clone());
            if draft.set_sensitivity_multiplier(
                f32::from(step) / f32::from(crate::settings::MOUSE_SENSITIVITY_STEPS_PER_UNIT),
            ) {
                menu.status = None;
            }
            if !finished_sensitivity {
                return;
            }
            let Some(initial) = sensitivity_slider_edit.take() else {
                return;
            };
            if initial == draft.mouse_sensitivity_text {
                return;
            }
            info!(target: "demo::settings", multiplier = draft.sensitivity_multiplier(), reason = "sensitivity_drag_finished", "Mouse sensitivity draft changed");
        }
        UiAction::FinishSensitivitySlider
            if menu.page == MenuPage::Settings && menu.tab == SettingsTab::Controls =>
        {
            let Some(initial) = sensitivity_slider_edit.take() else {
                return;
            };
            if initial == draft.mouse_sensitivity_text {
                return;
            }
            info!(target: "demo::settings", multiplier = draft.sensitivity_multiplier(), reason = "sensitivity_drag_finished", "Mouse sensitivity draft changed");
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
        UiAction::RestoreDefaults if menu.page == MenuPage::Settings => {
            *draft = SettingsDraft::default();
            menu.status = Some("Defaults restored. Choose Apply to save.".into());
        }
        UiAction::ApplySettings if menu.page == MenuPage::Settings => {
            if sensitivity_inputs
                .iter()
                .any(|(_, _, text)| text.is_composing() || text.pending_paste.is_some())
            {
                menu.status = Some("Finish the current text input before applying.".into());
                return;
            }
            if sensitivity_inputs
                .iter()
                .any(|(entity, input, _)| input.was_focused || input_focus.get() == Some(entity))
            {
                draft.normalize_sensitivity();
            }
            let updated = match draft.to_settings() {
                Ok(updated) => updated,
                Err(error) => {
                    warn!(target: "demo::settings", %error, reason = "invalid_settings_input", "Settings input validation failed");
                    menu.status = Some(super::sensitivity::INPUT_ERROR.into());
                    return;
                }
            };
            match updated.save(&path.path).map(|()| updated) {
                Ok(updated) => {
                    info!(target: "demo::settings", path = %path.path.display(),
                        max_fps_before = settings.max_fps.get(), max_fps_after = updated.max_fps.get(),
                        sensitivity_before = settings.camera.mouse_sensitivity, sensitivity_after = updated.camera.mouse_sensitivity,
                        invert_y_before = settings.camera.invert_y, invert_y_after = updated.camera.invert_y,
                        master_volume_before = settings.audio.master_volume, master_volume_after = updated.audio.master_volume,
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
    if !matches!(
        action,
        UiAction::SetSensitivity(_) | UiAction::FinishSensitivitySlider
    ) {
        *sensitivity_slider_edit = None;
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

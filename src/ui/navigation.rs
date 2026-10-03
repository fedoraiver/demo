//! 键盘与手柄使用 Enhanced Input，鼠标使用 Bevy UI 交互，统一产生菜单请求。

use bevy::{input::InputSystems, prelude::*, window::PrimaryWindow};
use bevy_enhanced_input::prelude::{Press, *};

use crate::{
    app_flow::{AppState, PlayState},
    audio_events::{SoundCue, SoundRequest},
    settings::{GameSettings, SettingsDraft, SettingsFile},
};

use super::*;

#[derive(Component)]
struct MenuContext;

#[derive(InputAction)]
#[action_output(bool)]
struct PreviousAction;
#[derive(InputAction)]
#[action_output(bool)]
struct NextAction;
#[derive(InputAction)]
#[action_output(bool)]
struct LeftAction;
#[derive(InputAction)]
#[action_output(bool)]
struct RightAction;
#[derive(InputAction)]
#[action_output(bool)]
struct ConfirmAction;
#[derive(InputAction)]
#[action_output(bool)]
struct BackAction;

pub(super) fn register(app: &mut App) {
    app.add_input_context::<MenuContext>()
        .add_observer(previous)
        .add_observer(next)
        .add_observer(left)
        .add_observer(right)
        .add_observer(confirm)
        .add_observer(back)
        .add_systems(Startup, spawn_menu_controller)
        .add_systems(
            PreUpdate,
            sync_context
                .after(InputSystems)
                .before(EnhancedInputSystems::Prepare),
        )
        // PreUpdate 的动作请求必须在 StateTransition 与固定循环之前处理，暂停当帧即生效。
        .add_systems(
            PreUpdate,
            handle_requests.after(EnhancedInputSystems::Apply),
        )
        // 页面切换先销毁旧按钮并应用延迟命令，再读取点击，避免旧页面补发返回请求。
        .add_systems(
            Update,
            pointer_interaction
                .after(UiSystems::Build)
                .before(UiSystems::Style),
        );
}

/// 菜单上下文覆盖所有页面，Esc 在游戏运行时表达暂停，而不另读底层按键。
fn spawn_menu_controller(mut commands: Commands) {
    let settings = || ActionSettings {
        require_reset: true,
        consume_input: true,
        ..default()
    };
    commands.spawn((
        Name::new("Menu input controller"),
        MenuContext,
        ContextPriority::<MenuContext>::new(10),
        GamepadDevice::Any,
        actions!(MenuContext[
            (Action::<PreviousAction>::new(), settings(), Press::default(), bindings![KeyCode::ArrowUp, GamepadButton::DPadUp]),
            (Action::<NextAction>::new(), settings(), Press::default(), bindings![KeyCode::ArrowDown, GamepadButton::DPadDown]),
            (Action::<LeftAction>::new(), settings(), Press::default(), bindings![KeyCode::ArrowLeft, GamepadButton::DPadLeft]),
            (Action::<RightAction>::new(), settings(), Press::default(), bindings![KeyCode::ArrowRight, GamepadButton::DPadRight]),
            (Action::<ConfirmAction>::new(), settings(), Press::default(), bindings![KeyCode::Enter, GamepadButton::South]),
            (Action::<BackAction>::new(), settings(), Press::default(), bindings![KeyCode::Escape, GamepadButton::East, GamepadButton::Start]),
        ]),
    ));
}

fn sync_context(
    mut commands: Commands,
    windows: Query<&Window, With<PrimaryWindow>>,
    contexts: Query<(Entity, &ContextActivity<MenuContext>)>,
) {
    let focused = windows.single().is_ok_and(|window| window.focused);
    for (entity, activity) in &contexts {
        if **activity != focused {
            commands
                .entity(entity)
                .insert(ContextActivity::<MenuContext>::new(focused));
        }
    }
}

fn step_focus(
    menu: &MenuState,
    focus: &mut MenuFocus,
    source: &mut MenuInputSource,
    buttons: &Query<(Entity, &MenuButton)>,
    direction: i32,
) -> Option<Entity> {
    if menu.page == MenuPage::Hidden {
        return None;
    }
    let count = buttons
        .iter()
        .map(|(_, button)| button.index + 1)
        .max()
        .unwrap_or(0);
    if count > 0 {
        *source = MenuInputSource::Navigation;
        let before = focus.0;
        focus.0 = (focus.0 as i32 + direction).rem_euclid(count as i32) as usize;
        if focus.0 != before {
            return buttons
                .iter()
                .find_map(|(entity, button)| (button.index == focus.0).then_some(entity));
        }
    }
    None
}

fn previous(
    _event: On<Fire<PreviousAction>>,
    menu: Res<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<(Entity, &MenuButton)>,
    mut sounds: MessageWriter<SoundRequest>,
) {
    if let Some(entity) = step_focus(&menu, &mut focus, &mut source, &buttons, -1) {
        sounds.write(SoundRequest::new(SoundCue::MenuHover, entity));
    }
}

fn next(
    _event: On<Fire<NextAction>>,
    menu: Res<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<(Entity, &MenuButton)>,
    mut sounds: MessageWriter<SoundRequest>,
) {
    if let Some(entity) = step_focus(&menu, &mut focus, &mut source, &buttons, 1) {
        sounds.write(SoundRequest::new(SoundCue::MenuHover, entity));
    }
}

fn adjust_focused(
    menu: &MenuState,
    focus: &MenuFocus,
    buttons: &Query<&MenuButton>,
    requests: &mut MessageWriter<UiRequest>,
    direction: i8,
) {
    if menu.page != MenuPage::Settings {
        return;
    }
    if let Some(button) = buttons.iter().find(|button| button.index == focus.0)
        && let UiAction::Adjust(key, _) = button.action
    {
        requests.write(UiRequest(UiAction::Adjust(key, direction)));
    }
}

fn left(
    _event: On<Fire<LeftAction>>,
    menu: Res<MenuState>,
    focus: Res<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<&MenuButton>,
    mut requests: MessageWriter<UiRequest>,
) {
    if menu.page != MenuPage::Hidden {
        *source = MenuInputSource::Navigation;
    }
    adjust_focused(&menu, &focus, &buttons, &mut requests, -1);
}

fn right(
    _event: On<Fire<RightAction>>,
    menu: Res<MenuState>,
    focus: Res<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<&MenuButton>,
    mut requests: MessageWriter<UiRequest>,
) {
    if menu.page != MenuPage::Hidden {
        *source = MenuInputSource::Navigation;
    }
    adjust_focused(&menu, &focus, &buttons, &mut requests, 1);
}

fn confirm(
    _event: On<Fire<ConfirmAction>>,
    menu: Res<MenuState>,
    focus: Res<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<&MenuButton>,
    mut requests: MessageWriter<UiRequest>,
) {
    if menu.page != MenuPage::Hidden
        && let Some(button) = buttons.iter().find(|button| button.index == focus.0)
    {
        *source = MenuInputSource::Navigation;
        requests.write(UiRequest(button.action));
    }
}

fn back(
    _event: On<Fire<BackAction>>,
    mut source: ResMut<MenuInputSource>,
    mut requests: MessageWriter<UiRequest>,
) {
    *source = MenuInputSource::Navigation;
    requests.write(UiRequest(UiAction::Back));
}

/// Bevy 原生 UI 已完成按钮命中；这里不再读取 MouseButton，防止双重触发。
pub(super) fn pointer_interaction(
    menu: Res<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    windows: Query<&Window, With<PrimaryWindow>>,
    buttons: Query<(Entity, &MenuButton, Ref<Interaction>)>,
    mut requests: MessageWriter<UiRequest>,
    mut sounds: MessageWriter<SoundRequest>,
    mut previous_cursor: Local<Option<Vec2>>,
    mut previous_hover: Local<Option<Entity>>,
) {
    // 原生 UI 重建也会产生 Hovered；只用窗口位置变化识别真实鼠标导航，避免抢走键盘焦点。
    // 底层位置只区分悬停来源，键盘与手柄动作仍由 Enhanced Input 处理，点击仍用 Interaction。
    let cursor = windows.single().ok().and_then(Window::cursor_position);
    let pointer_moved = cursor != *previous_cursor;
    *previous_cursor = cursor;
    if menu.page == MenuPage::Hidden {
        *previous_hover = None;
        return;
    }
    // 移到空白或离开窗口也切回鼠标模式，避免上次鼠标序号继续被画成键盘焦点。
    if pointer_moved {
        *source = MenuInputSource::Pointer;
    }
    let hovered = buttons
        .iter()
        .find_map(|(entity, _, interaction)| (*interaction != Interaction::None).then_some(entity));
    for (entity, button, interaction) in &buttons {
        match *interaction {
            Interaction::Hovered if pointer_moved => {
                focus.0 = button.index;
                // 同一按钮内移动、点击释放与新页面初始悬停都不重复发出焦点音。
                if *previous_hover != Some(entity) && !interaction.is_added() {
                    sounds.write(SoundRequest::new(SoundCue::MenuHover, entity));
                }
            }
            Interaction::Pressed if interaction.is_changed() => {
                *source = MenuInputSource::Pointer;
                focus.0 = button.index;
                // 滑条使用局部绝对位置生成精确数值，不再通过按钮路径重复生成调整请求。
                if !matches!(button.action, UiAction::Adjust(_, 0)) {
                    requests.write(UiRequest(button.action));
                }
            }
            _ => {}
        }
    }
    *previous_hover = hovered;
}

fn open_page(menu: &mut MenuState, focus: &mut MenuFocus, page: MenuPage) {
    menu.return_page = menu.page;
    menu.page = page;
    menu.status = None;
    focus.0 = 0;
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
    let mut actions = requests.read().map(|request| request.0);
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
                focus.0 = 0;
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
            focus.0 = match tab {
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
                .and_then(|updated| updated.save(&path.0).map(|()| updated))
            {
                Ok(updated) => {
                    info!(target: "demo::settings", path = %path.0.display(),
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
                    error!(target: "demo::settings", path = %path.0.display(), %error, operation = "apply_settings", "Failed to save settings");
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

#[cfg(test)]
mod tests {
    use super::*;

    use crate::app_flow::AppFlowPlugin;
    use bevy::{
        asset::AssetPlugin, input::InputPlugin, scene::ScenePlugin, time::TimeUpdateStrategy,
    };
    use std::path::PathBuf;

    fn test_app() -> App {
        // 使用真实输入、状态调度与 BSN 页面，只生成 ECS 数据，不安装 UI 渲染或窗口后端。
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            AssetPlugin::default(),
            ScenePlugin,
            InputPlugin,
            EnhancedInputPlugin,
            AppFlowPlugin,
        ))
        .init_asset::<Font>()
        // 现成空句柄避免测试加载本地字体或等待异步资产任务。
        .insert_resource(theme::UiTheme {
            heading: Handle::default(),
            body: Handle::default(),
            scale: 1.0,
        })
        .init_resource::<GameSettings>()
        .init_resource::<SettingsDraft>()
        .init_resource::<SettingsFile>()
        .init_resource::<MenuInputSource>()
        .add_message::<UiRequest>()
        .add_message::<SoundRequest>()
        .add_message::<AppExit>()
        .insert_resource(TimeUpdateStrategy::ManualDuration(
            std::time::Duration::from_millis(16),
        ))
        .configure_sets(Update, (UiSystems::Build, UiSystems::Style).chain());
        register(&mut app);
        screens::register(&mut app);
        volume::register(&mut app);
        app.world_mut().spawn((Window::default(), PrimaryWindow));
        app.finish();
        app.cleanup();
        app.update();
        app
    }

    fn request(app: &mut App, action: UiAction) {
        app.world_mut().write_message(UiRequest(action));
        app.update();
    }

    fn drain_sounds(app: &mut App) -> Vec<SoundCue> {
        app.world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .map(|request| request.cue)
            .collect()
    }

    #[test]
    fn volume_drag_coalesces_final_value_and_confirms_only_changed_release() {
        let mut app = test_app();
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
        drain_sounds(&mut app);

        request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 61));
        request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 42));
        assert!(drain_sounds(&mut app).is_empty());
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            42
        );
        assert_eq!(
            app.world().resource::<GameSettings>().audio.master_volume,
            100
        );
        request(&mut app, UiAction::FinishVolumeEdit);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        request(&mut app, UiAction::FinishVolumeEdit);
        assert!(drain_sounds(&mut app).is_empty());

        // 最后一帧坐标和释放同时到达仍应用最终值，只反馈一次。
        for action in [
            UiAction::SetVolume(SettingKey::SfxVolume, 70),
            UiAction::SetVolume(SettingKey::SfxVolume, 33),
            UiAction::FinishVolumeEdit,
        ] {
            app.world_mut().write_message(UiRequest(action));
        }
        app.update();
        assert_eq!(app.world().resource::<SettingsDraft>().audio.sfx_volume, 33);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);

        // 拖回初值没有净变化；无效字段不能通过滑条入口修改相机或帧率。
        request(&mut app, UiAction::SetVolume(SettingKey::UiVolume, 20));
        request(&mut app, UiAction::SetVolume(SettingKey::UiVolume, 100));
        request(&mut app, UiAction::FinishVolumeEdit);
        request(&mut app, UiAction::SetVolume(SettingKey::FrameRate, 70));
        assert!(drain_sounds(&mut app).is_empty());
        assert_eq!(app.world().resource::<SettingsDraft>().max_fps, 60);

        request(&mut app, UiAction::Back);
        drain_sounds(&mut app);
        request(&mut app, UiAction::FinishVolumeEdit);
        assert!(drain_sounds(&mut app).is_empty());
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            100
        );
    }

    #[test]
    fn enhanced_input_adjusts_focused_volume_without_rebuilding_or_repeating() {
        let mut app = test_app();
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
        drain_sounds(&mut app);
        let (slider, index) = app
            .world_mut()
            .query::<(Entity, &MenuButton)>()
            .iter(app.world())
            .find_map(|(entity, button)| {
                (button.action == UiAction::Adjust(SettingKey::MasterVolume, 0))
                    .then_some((entity, button.index))
            })
            .unwrap();
        app.world_mut().resource_mut::<MenuFocus>().0 = index;
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowLeft);
        app.update();
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            95
        );
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        assert!(app.world().get::<MenuButton>(slider).is_some());
        for _ in 0..3 {
            app.update();
        }
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            95
        );
        assert!(drain_sounds(&mut app).is_empty());
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .release(KeyCode::ArrowLeft);
        app.update();
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowRight);
        app.update();
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            100
        );
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .release(KeyCode::ArrowRight);
        app.update();
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowRight);
        app.update();
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            100
        );
        assert!(
            drain_sounds(&mut app).is_empty(),
            "A boundary press is silent"
        );
    }

    #[test]
    fn queued_drag_never_swallows_back_and_no_op_confirm_keeps_gesture() {
        let mut app = test_app();
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
        request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 80));
        drain_sounds(&mut app);
        request(&mut app, UiAction::Adjust(SettingKey::MasterVolume, 0));
        assert!(drain_sounds(&mut app).is_empty());
        request(&mut app, UiAction::FinishVolumeEdit);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 70));
        // 上一帧鼠标采样已排队，本帧 Esc 必须立即接受并取消整个草稿。
        app.world_mut()
            .write_message(UiRequest(UiAction::SetVolume(SettingKey::MasterVolume, 60)));
        app.world_mut().write_message(UiRequest(UiAction::Back));
        app.update();
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Main);
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            100
        );
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
        request(&mut app, UiAction::FinishVolumeEdit);
        assert!(drain_sounds(&mut app).is_empty());
    }

    #[test]
    fn audio_apply_cancel_defaults_and_failed_save_preserve_committed_values() {
        let mut app = test_app();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tmp/ui-settings-tests");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        app.insert_resource(SettingsFile(path.clone()));
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
        request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 73));
        request(&mut app, UiAction::SetVolume(SettingKey::SfxVolume, 0));
        request(&mut app, UiAction::SetVolume(SettingKey::UiVolume, 49));
        request(&mut app, UiAction::SelectTab(SettingsTab::Controls));
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            73
        );
        assert_eq!(
            app.world().resource::<GameSettings>().audio.master_volume,
            100
        );
        request(&mut app, UiAction::ApplySettings);
        let committed = app.world().resource::<GameSettings>().audio;
        assert_eq!(committed.master_volume, 73);
        assert_eq!(committed.sfx_volume, 0);
        assert_eq!(committed.ui_volume, 49);
        assert_eq!(GameSettings::load(&path).audio, committed);
        let saved = std::fs::read_to_string(&path).unwrap();

        request(&mut app, UiAction::RestoreDefaults);
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            100
        );
        assert_eq!(app.world().resource::<GameSettings>().audio, committed);
        request(&mut app, UiAction::Back);
        assert_eq!(app.world().resource::<SettingsDraft>().audio, committed);
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
        request(&mut app, UiAction::Adjust(SettingKey::MasterVolume, -1));
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            68
        );
        // 保存目标改为实际目录，触发可复现的 I/O 失败而不触及用户配置。
        app.insert_resource(SettingsFile(directory));
        request(&mut app, UiAction::ApplySettings);
        assert_eq!(app.world().resource::<GameSettings>().audio, committed);
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            68
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
        assert!(
            app.world()
                .resource::<MenuState>()
                .status
                .as_ref()
                .unwrap()
                .starts_with("Could not save")
        );
        request(&mut app, UiAction::Back);
        assert_eq!(app.world().resource::<SettingsDraft>().audio, committed);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn sfx_sample_works_in_pause_without_changing_gameplay_or_settings() {
        let mut app = test_app();
        request(&mut app, UiAction::TestSfx);
        assert!(drain_sounds(&mut app).is_empty());
        request(&mut app, UiAction::StartGame);
        request(&mut app, UiAction::Back);
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
        drain_sounds(&mut app);
        let draft = app.world().resource::<SettingsDraft>().clone();
        // 同帧重复试听也只产生一个素材请求，来源是菜单而非角色或包裹。
        app.world_mut().write_message(UiRequest(UiAction::TestSfx));
        app.world_mut().write_message(UiRequest(UiAction::TestSfx));
        app.update();
        let samples: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .collect();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].cue, SoundCue::ParcelPickup);
        assert!(app.world().get::<MenuContext>(samples[0].source).is_some());
        assert_eq!(*app.world().resource::<SettingsDraft>(), draft);
        assert!(app.world().resource::<Time<Virtual>>().is_paused());
        assert_eq!(
            *app.world().resource::<State<PlayState>>().get(),
            PlayState::Paused
        );
        request(&mut app, UiAction::SelectTab(SettingsTab::Graphics));
        drain_sounds(&mut app);
        request(&mut app, UiAction::TestSfx);
        assert!(drain_sounds(&mut app).is_empty());
    }

    #[test]
    fn menu_sounds_follow_accepted_requests_and_skip_no_ops() {
        let mut app = test_app();
        request(&mut app, UiAction::Back);
        request(&mut app, UiAction::ApplySettings);
        assert!(drain_sounds(&mut app).is_empty());

        // 同帧多种输入只消费首项，声音与最终接受的菜单动作对应。
        app.world_mut()
            .write_message(UiRequest(UiAction::OpenSettings));
        app.world_mut().write_message(UiRequest(UiAction::OpenHelp));
        app.update();
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        request(&mut app, UiAction::SelectTab(SettingsTab::Graphics));
        request(&mut app, UiAction::Adjust(SettingKey::FrameRate, -1));
        assert!(drain_sounds(&mut app).is_empty());
        request(&mut app, UiAction::SelectTab(SettingsTab::Controls));
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        request(&mut app, UiAction::Adjust(SettingKey::InvertY, 1));
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        request(&mut app, UiAction::RestoreDefaults);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        request(&mut app, UiAction::Back);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);

        request(&mut app, UiAction::StartGame);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        request(&mut app, UiAction::Back);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        assert!(app.world().resource::<Time<Virtual>>().is_paused());
        request(&mut app, UiAction::OpenHelp);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        // 帮助页只有返回按钮，导航不会切换目标，也不发出焦点音。
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowDown);
        app.update();
        assert!(drain_sounds(&mut app).is_empty());
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .release(KeyCode::ArrowDown);
        request(&mut app, UiAction::Back);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
        request(&mut app, UiAction::Resume);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
        request(&mut app, UiAction::Back);
        drain_sounds(&mut app);
        request(&mut app, UiAction::ReturnToMenu);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
    }

    #[test]
    fn enhanced_input_emits_one_hover_or_confirm_per_press() {
        let mut app = test_app();
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowDown);
        app.update();
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuHover]);
        for _ in 0..3 {
            app.update();
            assert!(drain_sounds(&mut app).is_empty());
        }
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .release(KeyCode::ArrowDown);
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::Enter);
        app.update();
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        for _ in 0..3 {
            app.update();
            assert!(drain_sounds(&mut app).is_empty());
        }
        let window = app
            .world_mut()
            .query_filtered::<Entity, With<PrimaryWindow>>()
            .single(app.world())
            .unwrap();
        app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowDown);
        app.update();
        assert!(drain_sounds(&mut app).is_empty());
    }

    #[test]
    fn pointer_sound_requires_entering_an_existing_button() {
        // 只运行真实指针系统与 ECS 交互状态，不创建窗口后端或音频设备。
        let mut app = App::new();
        app.init_resource::<MenuState>()
            .init_resource::<MenuFocus>()
            .init_resource::<MenuInputSource>()
            .add_message::<UiRequest>()
            .add_message::<SoundRequest>()
            .add_systems(Update, pointer_interaction);
        let mut window = Window::default();
        window.set_cursor_position(Some(Vec2::new(80.0, 80.0)));
        let window = app.world_mut().spawn((window, PrimaryWindow)).id();
        let button = app
            .world_mut()
            .spawn((MenuButton::default(), Interaction::None))
            .id();
        app.update();
        let mut presses = 0;
        for (interaction, x, expected) in [
            (Interaction::Hovered, 82.0, vec![SoundCue::MenuHover]),
            (Interaction::Hovered, 84.0, vec![]),
            (Interaction::None, 86.0, vec![]),
            (Interaction::Hovered, 88.0, vec![SoundCue::MenuHover]),
            (Interaction::Pressed, 88.0, vec![]),
            (Interaction::Pressed, 88.0, vec![]),
            (Interaction::Hovered, 90.0, vec![]),
        ] {
            let mut current = app.world_mut().get_mut::<Interaction>(button).unwrap();
            if *current != interaction {
                *current = interaction;
            }
            app.world_mut()
                .get_mut::<Window>(window)
                .unwrap()
                .set_cursor_position(Some(Vec2::new(x, 80.0)));
            app.update();
            assert_eq!(drain_sounds(&mut app), expected);
            presses += app
                .world_mut()
                .resource_mut::<Messages<UiRequest>>()
                .drain()
                .count();
        }
        assert_eq!(presses, 1);
        app.world_mut().despawn(button);
        app.world_mut()
            .spawn((MenuButton::default(), Interaction::Hovered));
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_cursor_position(Some(Vec2::new(92.0, 80.0)));
        app.update();
        assert!(drain_sounds(&mut app).is_empty());
        app.update();
        assert!(drain_sounds(&mut app).is_empty());
    }

    fn assert_button_highlight(app: &App, entity: Entity, highlighted: bool) {
        assert_eq!(
            app.world().get::<BackgroundColor>(entity).unwrap().0,
            if highlighted {
                theme::GOLD
            } else {
                theme::PAPER
            }
        );
        assert_eq!(
            *app.world().get::<BorderColor>(entity).unwrap(),
            BorderColor::all(if highlighted {
                theme::INK
            } else {
                theme::CREAM
            })
        );
    }

    fn assert_page_hover_cycle(app: &mut App) {
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        let buttons: Vec<_> = app
            .world_mut()
            .query_filtered::<Entity, With<MenuButton>>()
            .iter(app.world())
            .collect();
        assert!(!buttons.is_empty());
        for entity in buttons {
            assert_button_highlight(app, entity, false);
            *app.world_mut().get_mut::<Interaction>(entity).unwrap() = Interaction::Hovered;
            app.update();
            assert_button_highlight(app, entity, true);
            *app.world_mut().get_mut::<Interaction>(entity).unwrap() = Interaction::None;
            app.update();
            assert_button_highlight(app, entity, false);
        }
    }

    #[test]
    fn every_bsn_page_button_highlights_only_while_pointer_is_over_it() {
        let mut app = test_app();
        assert_page_hover_cycle(&mut app);
        request(&mut app, UiAction::OpenHelp);
        assert_page_hover_cycle(&mut app);
        request(&mut app, UiAction::Back);
        request(&mut app, UiAction::OpenSettings);
        for tab in [
            SettingsTab::Graphics,
            SettingsTab::Audio,
            SettingsTab::Controls,
            SettingsTab::Accessibility,
        ] {
            request(&mut app, UiAction::SelectTab(tab));
            assert_page_hover_cycle(&mut app);
        }
        request(&mut app, UiAction::Back);
        request(&mut app, UiAction::StartGame);
        request(&mut app, UiAction::Back);
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
        assert_page_hover_cycle(&mut app);
    }

    #[test]
    fn keyboard_focus_survives_stationary_hover_and_pointer_to_blank_clears_highlight() {
        let mut app = test_app();
        let window = app
            .world_mut()
            .query_filtered::<Entity, With<PrimaryWindow>>()
            .single(app.world())
            .unwrap();
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_cursor_position(Some(Vec2::new(80.0, 80.0)));
        app.update();
        let mut buttons: Vec<_> = app
            .world_mut()
            .query::<(Entity, &MenuButton)>()
            .iter(app.world())
            .map(|(entity, button)| (button.index, entity))
            .collect();
        buttons.sort_by_key(|(index, _)| *index);
        *app.world_mut()
            .get_mut::<Interaction>(buttons[0].1)
            .unwrap() = Interaction::Hovered;
        app.update();
        assert_button_highlight(&app, buttons[0].1, true);

        // 真实 Enhanced Input 导航接管；静止鼠标留在另一按钮上不能产生第二个焦点。
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowDown);
        app.update();
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Navigation
        );
        assert_eq!(app.world().resource::<MenuFocus>().0, 1);
        assert_button_highlight(&app, buttons[0].1, false);
        assert_button_highlight(&app, buttons[1].1, true);
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .release(KeyCode::ArrowDown);
        app.update();
        assert_button_highlight(&app, buttons[1].1, true);

        *app.world_mut()
            .get_mut::<Interaction>(buttons[0].1)
            .unwrap() = Interaction::None;
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_cursor_position(Some(Vec2::new(140.0, 140.0)));
        app.update();
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        assert_eq!(app.world().resource::<MenuFocus>().0, 1);
        for (_, entity) in &buttons {
            assert_button_highlight(&app, *entity, false);
        }

        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowUp);
        app.update();
        assert_button_highlight(&app, buttons[0].1, true);
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_cursor_position(None);
        app.update();
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        for (_, entity) in buttons {
            assert_button_highlight(&app, entity, false);
        }
    }

    #[test]
    fn page_changes_preserve_pointer_or_navigation_source() {
        let mut app = test_app();
        request(&mut app, UiAction::OpenHelp);
        assert_page_hover_cycle(&mut app);
        request(&mut app, UiAction::Back);
        app.world_mut().resource_mut::<MenuFocus>().0 = 2;
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::Enter);
        app.update();
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Help);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Navigation
        );
        let back = app
            .world_mut()
            .query_filtered::<Entity, With<MenuButton>>()
            .single(app.world())
            .unwrap();
        assert_button_highlight(&app, back, true);

        // 点击返回在下一帧消费；页面重置序号后仍保持鼠标模式，Start 不会无故常亮。
        *app.world_mut().get_mut::<Interaction>(back).unwrap() = Interaction::Pressed;
        app.update();
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        app.update();
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Main);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        assert_page_hover_cycle(&mut app);
    }

    #[test]
    fn rebuilt_hover_preserves_keyboard_focus_and_real_pointer_input_takes_over() {
        // 只提供窗口组件与按钮状态，不安装原生窗口、UI 渲染器或输入后端。
        let mut app = App::new();
        app.init_resource::<MenuState>()
            .init_resource::<MenuFocus>()
            .init_resource::<MenuInputSource>()
            .add_message::<UiRequest>()
            .add_message::<SoundRequest>()
            .add_systems(Update, pointer_interaction);
        let mut window = Window::default();
        window.set_cursor_position(Some(Vec2::new(80.0, 80.0)));
        let window = app.world_mut().spawn((window, PrimaryWindow)).id();
        app.update();
        app.world_mut().resource_mut::<MenuFocus>().0 = 4;
        *app.world_mut().resource_mut::<MenuInputSource>() = MenuInputSource::Navigation;

        let action = UiAction::SelectTab(SettingsTab::Graphics);
        let mut hovered = app
            .world_mut()
            .spawn((MenuButton { action, index: 0 }, Interaction::Hovered))
            .id();
        app.update();
        assert_eq!(app.world().resource::<MenuFocus>().0, 4);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Navigation
        );
        for _ in 0..2 {
            app.world_mut().despawn(hovered);
            hovered = app
                .world_mut()
                .spawn((MenuButton { action, index: 0 }, Interaction::Hovered))
                .id();
            app.update();
            assert_eq!(app.world().resource::<MenuFocus>().0, 4);
            assert_eq!(
                *app.world().resource::<MenuInputSource>(),
                MenuInputSource::Navigation
            );
        }

        // 鼠标在同一按钮内移动时 Interaction 不变，也应重新接管焦点。
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_cursor_position(Some(Vec2::new(82.0, 80.0)));
        app.update();
        assert_eq!(app.world().resource::<MenuFocus>().0, 0);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );

        app.world_mut().resource_mut::<MenuFocus>().0 = 4;
        *app.world_mut().resource_mut::<MenuInputSource>() = MenuInputSource::Navigation;
        *app.world_mut().get_mut::<Interaction>(hovered).unwrap() = Interaction::Pressed;
        app.update();
        assert_eq!(app.world().resource::<MenuFocus>().0, 0);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        let requests: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiRequest>>()
            .drain()
            .map(|request| request.0)
            .collect();
        assert_eq!(requests, vec![action]);
        app.update();
        assert_eq!(
            app.world_mut()
                .resource_mut::<Messages<UiRequest>>()
                .drain()
                .count(),
            0
        );
    }

    #[test]
    fn simultaneous_settings_back_and_old_button_press_remain_paused() {
        let mut app = test_app();
        request(&mut app, UiAction::StartGame);
        request(&mut app, UiAction::Back);
        request(&mut app, UiAction::OpenSettings);
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Settings);
        let old_back = app
            .world_mut()
            .query::<(Entity, &MenuButton)>()
            .iter(app.world())
            .find_map(|(entity, button)| (button.action == UiAction::Back).then_some(entity))
            .unwrap();
        drain_sounds(&mut app);

        // 同一帧键盘返回与旧页按钮的点击并存；真实 Build 必须先清理旧按钮。
        *app.world_mut().get_mut::<Interaction>(old_back).unwrap() = Interaction::Pressed;
        app.world_mut().write_message(UiRequest(UiAction::Back));
        app.update();
        assert!(app.world().get_entity(old_back).is_err());
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
        assert_eq!(
            *app.world().resource::<State<PlayState>>().get(),
            PlayState::Paused
        );

        // 检查帧末后再推进一帧，防止残留 Back 在暂停页被解释为 Resume。
        app.update();
        assert!(drain_sounds(&mut app).is_empty());
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
        assert_eq!(
            *app.world().resource::<State<PlayState>>().get(),
            PlayState::Paused
        );
    }

    #[test]
    fn settings_cancel_preserves_runtime_and_apply_commits_only_after_save() {
        let mut app = test_app();
        let path = PathBuf::from("tmp")
            .join("ui-settings-tests")
            .join(format!("{}.json", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        app.world_mut().insert_resource(SettingsFile(path.clone()));
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::Adjust(SettingKey::FrameRate, 1));
        assert_eq!(app.world().resource::<SettingsDraft>().max_fps, 90);
        assert_eq!(app.world().resource::<GameSettings>().max_fps.get(), 60);
        assert!(!path.exists());
        request(&mut app, UiAction::Back);
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Main);
        assert_eq!(app.world().resource::<SettingsDraft>().max_fps, 60);
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::Adjust(SettingKey::FrameRate, 1));
        drain_sounds(&mut app);
        request(&mut app, UiAction::ApplySettings);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
        assert_eq!(app.world().resource::<GameSettings>().max_fps.get(), 90);
        assert_eq!(GameSettings::load(&path).max_fps.get(), 90);
        std::fs::remove_file(&path).unwrap();

        // 保存目标是目录时产生真实 I/O 失败，界面保留草稿而运行设置保持原值。
        app.world_mut()
            .insert_resource(SettingsFile(path.parent().unwrap().to_path_buf()));
        request(&mut app, UiAction::Adjust(SettingKey::FrameRate, 1));
        drain_sounds(&mut app);
        request(&mut app, UiAction::ApplySettings);
        assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
        assert_eq!(app.world().resource::<GameSettings>().max_fps.get(), 90);
        assert_eq!(app.world().resource::<SettingsDraft>().max_fps, 120);
        assert!(
            app.world()
                .resource::<MenuState>()
                .status
                .as_ref()
                .unwrap()
                .starts_with("Could not save")
        );
    }

    #[test]
    fn held_confirm_fires_once_and_navigation_stops_when_window_loses_focus() {
        let mut app = test_app();
        app.world_mut().resource_mut::<MenuFocus>().0 = 1;
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::Enter);
        app.update();
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Settings);
        for _ in 0..5 {
            app.update();
        }
        assert_eq!(
            app.world().resource::<MenuState>().return_page,
            MenuPage::Main
        );
        let original = app.world().resource::<MenuFocus>().0;
        let window = app
            .world_mut()
            .query_filtered::<Entity, With<PrimaryWindow>>()
            .single(app.world())
            .unwrap();
        app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::ArrowDown);
        app.update();
        assert_eq!(app.world().resource::<MenuFocus>().0, original);
    }

    #[test]
    fn pause_help_and_settings_return_to_pause_without_replacing_session() {
        let mut app = test_app();
        request(&mut app, UiAction::StartGame);
        assert_eq!(
            *app.world().resource::<State<AppState>>().get(),
            AppState::InGame
        );
        request(&mut app, UiAction::Back);
        assert_eq!(
            *app.world().resource::<State<PlayState>>().get(),
            PlayState::Paused
        );
        request(&mut app, UiAction::OpenHelp);
        assert_eq!(
            app.world().resource::<MenuState>().return_page,
            MenuPage::Pause
        );
        request(&mut app, UiAction::Back);
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::Back);
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
        assert_eq!(
            *app.world().resource::<State<PlayState>>().get(),
            PlayState::Paused
        );
        request(&mut app, UiAction::Resume);
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Hidden);
        assert_eq!(
            *app.world().resource::<State<PlayState>>().get(),
            PlayState::Running
        );
    }
}

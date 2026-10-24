use super::*;
use bevy::{
    input::mouse::MouseScrollUnit,
    text::TextLayoutInfo,
    ui_widgets::{Scrollbar, ScrollbarThumb},
};
use bevy::{picking::hover::Hovered, ui::Pressed};

use super::super::test_support::*;
fn live_settings_app() -> App {
    let size = UVec2::new(960, 540);
    let mut app = crate::ui::test_support::layout_app_with(size, |app| {
        app.add_plugins((
            bevy::input::InputPlugin,
            bevy_enhanced_input::prelude::EnhancedInputPlugin,
            crate::game_flow::GameFlowPlugin,
        ));
        let theme = layout_theme(app);
        app.insert_resource(theme)
            .init_resource::<crate::settings::GameSettings>()
            .init_resource::<SettingsDraft>()
            .init_resource::<crate::settings::SettingsFile>()
            .init_resource::<crate::audio::AudioPreview>()
            .add_message::<super::super::UiRequest>()
            .add_message::<crate::audio::SoundRequest>()
            .add_message::<AppExit>()
            .configure_sets(Update, (UiSystems::Build, UiSystems::Style).chain());
        crate::ui::register_menu(app);
        app.world_mut().spawn((
            Window {
                resolution: (960, 540).into(),
                ..default()
            },
            PrimaryWindow,
        ));
    });
    for _ in 0..3 {
        app.update();
    }
    request_action(&mut app, UiAction::OpenSettings);
    app
}

fn request_action(app: &mut App, action: UiAction) {
    app.world_mut()
        .write_message(super::super::UiRequest(action));
    app.update();
}

fn settings_identity(app: &mut App) -> Vec<Entity> {
    let world = app.world_mut();
    let mut entities: Vec<_> = world
        .query_filtered::<Entity, Or<(
            With<MenuRoot>,
            With<SettingsPanel>,
            With<MenuScroll>,
            With<SettingsScrollbar>,
            With<ScrollbarThumb>,
            With<MenuButton>,
            With<SettingValue>,
            With<SettingsStatus>,
        )>>()
        .iter(world)
        .collect();
    entities.sort();
    entities
}

fn scroll_settings_for_edit(app: &mut App) -> (Entity, f32) {
    let world = app.world_mut();
    let area = world
        .query_filtered::<Entity, With<MenuScroll>>()
        .single(world)
        .unwrap();
    let title = world
        .query::<(Entity, &Text)>()
        .iter(world)
        .find(|(_, text)| text.0 == "SETTINGS")
        .unwrap()
        .0;
    assert_eq!(wheel_over(app, title, MouseScrollUnit::Line, -3.0), area);
    app.update();
    let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
    assert!(
        offset > 0.0,
        "Regression must start at a nonzero panel offset"
    );
    (area, offset)
}

fn assert_panel_preserved(app: &mut App, identity: &[Entity], area: Entity, old_offset: f32) {
    assert_eq!(
        settings_identity(app),
        identity,
        "Editing must preserve UI entity identities"
    );
    let world = app.world_mut();
    let node = world.get::<ComputedNode>(area).unwrap();
    let range = (node.content_size().y - node.size().y).max(0.0) * node.inverse_scale_factor();
    let expected = old_offset.min(range);
    assert!(
        (world.get::<ScrollPosition>(area).unwrap().y - expected).abs() < 0.01,
        "Text updates may clamp to the new range, never reset an overflowing panel to zero"
    );
    let (track, scrollbar, children) = world
        .query::<(Entity, &Scrollbar, &Children)>()
        .single(world)
        .unwrap();
    assert_eq!(scrollbar.target, area);
    if expected > 0.0 {
        let thumb = children
            .iter()
            .find(|entity| world.get::<ScrollbarThumb>(*entity).is_some())
            .unwrap();
        let track_rect = node_rect(
            world.get::<ComputedNode>(track).unwrap(),
            world.get::<UiGlobalTransform>(track).unwrap(),
        );
        let thumb_rect = node_rect(
            world.get::<ComputedNode>(thumb).unwrap(),
            world.get::<UiGlobalTransform>(thumb).unwrap(),
        );
        assert!(
            thumb_rect.min.y > track_rect.min.y + 0.1,
            "Nonzero offset must leave scrollbar thumb below the top"
        );
    }
}

fn setting_text(app: &mut App, key: SettingKey) -> String {
    let world = app.world_mut();
    let (_, text, node, layout) = world
        .query::<(&SettingValue, &Text, &ComputedNode, &TextLayoutInfo)>()
        .iter(world)
        .find(|(value, _, _, _)| value.0 == key)
        .unwrap();
    assert!(node.size().x > 0.0 && node.size().y > 0.0 && !layout.glyphs.is_empty());
    text.0.clone()
}

#[test]
fn frame_rate_clicks_refresh_values_without_resetting_scroll_or_focus() {
    let mut app = live_settings_app();
    // 先建立此字段的真实说明与焦点，按钮调整时不能借重建重新滚入或回到顶部。
    app.world_mut().resource_mut::<MenuFocus>().0 = 5;
    app.update();
    let (area, _) = scroll_settings_for_edit(&mut app);
    let identity = settings_identity(&mut app);
    for (direction, expected) in [(1, "90 FPS"), (1, "120 FPS"), (-1, "90 FPS")] {
        let world = app.world_mut();
        let button = world
            .query::<(Entity, &MenuButton)>()
            .iter(world)
            .find(|(_, button)| button.action == UiAction::Adjust(SettingKey::FrameRate, direction))
            .map(|(entity, _)| entity)
            .unwrap();
        let offset = world.get::<ScrollPosition>(area).unwrap().y;
        world.entity_mut(button).insert(Pressed);
        pointer_press(world, button, PointerButton::Primary);
        app.update(); // 真实 pointer_interaction 将鼠标状态转为 UiRequest。
        app.update(); // 下一帧消费请求、原位更新文字，帧末布局和滑块必须已经一致。
        assert_eq!(setting_text(&mut app, SettingKey::FrameRate), expected);
        assert_panel_preserved(&mut app, &identity, area, offset);
        assert_eq!(
            app.world().resource::<MenuFocus>().0,
            app.world().get::<MenuButton>(button).unwrap().index
        );
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        app.world_mut().entity_mut(button).remove::<Pressed>();
        app.world_mut().entity_mut(button).insert(Hovered(false));
        app.update();
    }
    // 数值边界 no-op 也不能因资源的 changed 标记而销毁页面。
    app.world_mut().resource_mut::<SettingsDraft>().max_fps = 240;
    app.update();
    let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
    request_action(&mut app, UiAction::Adjust(SettingKey::FrameRate, 1));
    assert_eq!(setting_text(&mut app, SettingKey::FrameRate), "240 FPS");
    assert_panel_preserved(&mut app, &identity, area, offset);
}

#[test]
fn defaults_apply_errors_and_other_values_preserve_scroll_but_real_page_changes_rebuild() {
    let mut app = live_settings_app();
    let folder =
        std::path::PathBuf::from("tmp/ui-scroll-edit-tests").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&folder).unwrap();
    let saved = folder.join("settings.json");
    app.world_mut()
        .insert_resource(crate::settings::SettingsFile(saved.clone()));
    let (area, _) = scroll_settings_for_edit(&mut app);
    let identity = settings_identity(&mut app);
    for action in [
        UiAction::Adjust(SettingKey::FrameRate, 1),
        UiAction::RestoreDefaults,
        UiAction::ApplySettings,
    ] {
        let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        request_action(&mut app, action);
        assert_panel_preserved(&mut app, &identity, area, offset);
        let world = app.world_mut();
        let status = world
            .query_filtered::<&Text, With<SettingsStatus>>()
            .single(world)
            .unwrap();
        assert_eq!(
            status.0,
            world
                .resource::<MenuState>()
                .status
                .as_deref()
                .unwrap_or(DEFAULT_SETTINGS_STATUS)
        );
    }
    assert!(saved.is_file());
    // 真实保存失败提示更长，但也只能更改文字和合法滚动范围。
    app.world_mut()
        .insert_resource(crate::settings::SettingsFile(folder.clone()));
    let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
    request_action(&mut app, UiAction::ApplySettings);
    assert_panel_preserved(&mut app, &identity, area, offset);
    assert!(
        app.world()
            .resource::<MenuState>()
            .status
            .as_ref()
            .unwrap()
            .starts_with("Could not save")
    );
    let world = app.world_mut();
    let status = world
        .query_filtered::<&Text, With<SettingsStatus>>()
        .single(world)
        .unwrap();
    assert_eq!(
        status.0,
        world
            .resource::<MenuState>()
            .status
            .as_ref()
            .unwrap()
            .as_str()
    );
    assert!(status.0.starts_with("Could not save"));
    request_action(&mut app, UiAction::SelectTab(SettingsTab::Controls));
    assert!(app.world().get_entity(area).is_err());
    let new_area = app
        .world_mut()
        .query_filtered::<Entity, With<MenuScroll>>()
        .single(app.world())
        .unwrap();
    assert_eq!(app.world().get::<ScrollPosition>(new_area).unwrap().y, 0.0);
    let (area, _) = scroll_settings_for_edit(&mut app);
    let identity = settings_identity(&mut app);
    for (key, expected) in [
        (SettingKey::MouseSensitivity, "117%"),
        (SettingKey::InvertY, "On"),
    ] {
        let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        request_action(&mut app, UiAction::Adjust(key, 1));
        assert_eq!(setting_text(&mut app, key), expected);
        assert_panel_preserved(&mut app, &identity, area, offset);
    }
    // 重选当前分类保持同一树；退出再进入则仍应建立新页面并从顶部开始。
    let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
    request_action(&mut app, UiAction::SelectTab(SettingsTab::Controls));
    assert_panel_preserved(&mut app, &identity, area, offset);
    request_action(&mut app, UiAction::Back);
    assert!(app.world().get_entity(area).is_err());
    request_action(&mut app, UiAction::OpenSettings);
    let new_area = app
        .world_mut()
        .query_filtered::<Entity, With<MenuScroll>>()
        .single(app.world())
        .unwrap();
    assert_eq!(app.world().get::<ScrollPosition>(new_area).unwrap().y, 0.0);
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn volume_updates_preserve_scrolled_panel_slider_and_navigation_focus() {
    use crate::ui::volume::VolumeSlider;

    let mut app = live_settings_app();
    request_action(&mut app, UiAction::SelectTab(SettingsTab::Audio));
    // 先让真实布局完成并建立导航焦点，再滚出非零偏移，避免焦点滚入掩盖重建。
    app.world_mut().resource_mut::<MenuFocus>().0 = 5;
    for _ in 0..3 {
        app.update();
    }
    let (area, _) = scroll_settings_for_edit(&mut app);
    let identity = settings_identity(&mut app);
    let slider = app
        .world_mut()
        .query::<(Entity, &VolumeSlider)>()
        .iter(app.world())
        .find_map(|(entity, slider)| (slider.key == SettingKey::MasterVolume).then_some(entity))
        .unwrap();
    let old_offset = app.world().get::<ScrollPosition>(area).unwrap().y;
    request_action(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 37));
    assert_panel_preserved(&mut app, &identity, area, old_offset);
    assert!(app.world().get::<VolumeSlider>(slider).is_some());
    assert_eq!(app.world().resource::<MenuFocus>().0, 5);
    let group = app.world().get::<ChildOf>(slider).unwrap().parent();
    let world = app.world_mut();
    let value = world
        .query::<(Entity, &Text, &ComputedNode, &TextLayoutInfo)>()
        .iter(world)
        .find(|(entity, text, _, _)| descends_from(world, *entity, group) && text.0 == "37%")
        .unwrap();
    assert!(value.2.size().x > 0.0 && value.2.size().y > 0.0 && !value.3.glyphs.is_empty());
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        37
    );
    let old_offset = app.world().get::<ScrollPosition>(area).unwrap().y;
    request_action(&mut app, UiAction::RestoreDefaults);
    assert_panel_preserved(&mut app, &identity, area, old_offset);
    assert!(app.world().get::<VolumeSlider>(slider).is_some());
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        100
    );
}

#[test]
fn height_only_resize_rebuilds_fixed_menu() {
    let mut app = crate::ui::test_support::layout_app(UVec2::new(1440, 810));
    let theme = layout_theme(&mut app);
    app.insert_resource(theme)
        .init_resource::<MenuState>()
        .init_resource::<SettingsDraft>()
        .add_systems(Update, rebuild_page);
    let window = app
        .world_mut()
        .spawn((
            Window {
                resolution: (1440, 810).into(),
                ..default()
            },
            PrimaryWindow,
        ))
        .id();
    app.update();
    let original_root = app
        .world_mut()
        .query_filtered::<Entity, With<MenuRoot>>()
        .single(app.world())
        .unwrap();
    app.update();
    assert!(app.world().get_entity(original_root).is_ok());
    let original_font_size = app
        .world_mut()
        .query::<(&Text, &TextFont)>()
        .iter(app.world())
        .find(|(text, _)| text.0 == "ISLAND")
        .unwrap()
        .1
        .font_size;
    app.world_mut()
        .get_mut::<Window>(window)
        .unwrap()
        .resolution
        .set(1440.0, 720.0);
    app.update();
    assert!(app.world().get_entity(original_root).is_err());
    let resized_font_size = app
        .world_mut()
        .query::<(&Text, &TextFont)>()
        .iter(app.world())
        .find(|(text, _)| text.0 == "ISLAND")
        .unwrap()
        .1
        .font_size;
    assert_ne!(original_font_size, resized_font_size);
}

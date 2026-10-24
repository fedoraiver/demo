use super::*;
use bevy::ui_widgets::Button;
use bevy::{asset::AssetPlugin, scene::ScenePlugin};

use super::super::style::style_buttons;
fn test_theme() -> UiTheme {
    UiTheme {
        heading: Handle::default(),
        body: Handle::default(),
        scale: 1.0,
    }
}

/// 只启用 BSN 所需资产资源；生成 ECS 树时不加载字体文件、渲染器或窗口。
fn actions(scene: impl Scene) -> Vec<UiAction> {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, AssetPlugin::default(), ScenePlugin))
        .init_asset::<Font>();
    app.finish();
    app.cleanup();
    let world = app.world_mut();
    world.spawn_scene(scene).unwrap();
    let mut buttons: Vec<_> = world
        .query::<&MenuButton>()
        .iter(world)
        .map(|button| (button.index, button.action))
        .collect();
    buttons.sort_by_key(|(index, _)| *index);
    for (expected, (actual, _)) in buttons.iter().enumerate() {
        assert_eq!(*actual, expected, "Navigation indices must be consecutive");
    }
    buttons.into_iter().map(|(_, action)| action).collect()
}

#[test]
fn bsn_pages_expose_supported_actions_with_stable_navigation() {
    let theme = test_theme();
    assert_eq!(
        actions(main_page(&theme, false)),
        vec![
            UiAction::StartGame,
            UiAction::OpenSettings,
            UiAction::OpenHelp,
            UiAction::Quit
        ]
    );
    assert_eq!(
        actions(main_page(&theme, true)),
        vec![
            UiAction::Resume,
            UiAction::OpenSettings,
            UiAction::OpenHelp,
            UiAction::ReturnToMenu
        ]
    );
    assert_eq!(actions(help_page(&theme)), vec![UiAction::Back]);
    let mut state = MenuState {
        page: MenuPage::Settings,
        ..default()
    };
    let graphics = actions(settings_page(
        &theme,
        &state,
        &SettingsDraft::default(),
        false,
    ));
    assert_eq!(
        &graphics[4..6],
        &[
            UiAction::Adjust(SettingKey::FrameRate, -1),
            UiAction::Adjust(SettingKey::FrameRate, 1)
        ]
    );
    assert_eq!(
        &graphics[6..],
        &[
            UiAction::RestoreDefaults,
            UiAction::ApplySettings,
            UiAction::Back
        ]
    );
    state.tab = SettingsTab::Controls;
    let controls = actions(settings_page(
        &theme,
        &state,
        &SettingsDraft::default(),
        true,
    ));
    assert_eq!(
        &controls[4..8],
        &[
            UiAction::Adjust(SettingKey::MouseSensitivity, -1),
            UiAction::Adjust(SettingKey::MouseSensitivity, 1),
            UiAction::Adjust(SettingKey::InvertY, -1),
            UiAction::Adjust(SettingKey::InvertY, 1)
        ]
    );
    assert_eq!(
        &controls[8..],
        &[
            UiAction::RestoreDefaults,
            UiAction::ApplySettings,
            UiAction::Back
        ]
    );
    state.tab = SettingsTab::Audio;
    let audio = actions(settings_page(
        &theme,
        &state,
        &SettingsDraft::default(),
        false,
    ));
    assert_eq!(
        &audio[4..14],
        &[
            UiAction::Adjust(SettingKey::MasterVolume, -1),
            UiAction::Adjust(SettingKey::MasterVolume, 0),
            UiAction::Adjust(SettingKey::MasterVolume, 1),
            UiAction::Adjust(SettingKey::SfxVolume, -1),
            UiAction::Adjust(SettingKey::SfxVolume, 0),
            UiAction::Adjust(SettingKey::SfxVolume, 1),
            UiAction::Adjust(SettingKey::UiVolume, -1),
            UiAction::Adjust(SettingKey::UiVolume, 0),
            UiAction::Adjust(SettingKey::UiVolume, 1),
            UiAction::TestSfx,
        ]
    );
    assert_eq!(
        &audio[14..],
        &[
            UiAction::RestoreDefaults,
            UiAction::ApplySettings,
            UiAction::Back
        ]
    );
    state.tab = SettingsTab::Accessibility;
    let placeholders = actions(settings_page(
        &theme,
        &state,
        &SettingsDraft::default(),
        false,
    ));
    assert_eq!(
        &placeholders[4..],
        &[
            UiAction::RestoreDefaults,
            UiAction::ApplySettings,
            UiAction::Back
        ]
    );
}

#[test]
fn volume_and_status_changes_keep_the_current_bsn_tree_and_focus() {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, AssetPlugin::default(), ScenePlugin))
        .init_asset::<Font>()
        .insert_resource(test_theme())
        .insert_resource(MenuState {
            page: MenuPage::Settings,
            tab: SettingsTab::Audio,
            ..default()
        })
        .init_resource::<SettingsDraft>()
        .insert_resource(MenuFocus(5))
        .insert_resource(MenuInputSource::Navigation)
        .init_resource::<crate::audio::AudioPreview>()
        .add_message::<super::super::UiRequest>()
        .configure_sets(Update, (UiSystems::Build, UiSystems::Style).chain());
    register(&mut app);
    super::super::volume::register(&mut app);
    super::super::style::register(&mut app);
    app.finish();
    app.cleanup();
    app.update();
    let root = app
        .world_mut()
        .query_filtered::<Entity, With<MenuRoot>>()
        .single(app.world())
        .unwrap();
    let slider = app
        .world_mut()
        .query::<(Entity, &super::super::volume::VolumeSlider)>()
        .iter(app.world())
        .find_map(|(entity, slider)| (slider.key == SettingKey::MasterVolume).then_some(entity))
        .unwrap();
    app.world_mut()
        .resource_mut::<SettingsDraft>()
        .set_volume(SettingKey::MasterVolume, 0);
    app.world_mut().resource_mut::<MenuState>().status = Some("Settings applied.".into());
    app.update();
    assert!(app.world().get::<MenuRoot>(root).is_some());
    assert!(
        app.world()
            .get::<super::super::volume::VolumeSlider>(slider)
            .is_some()
    );
    assert_eq!(app.world().resource::<MenuFocus>().0, 5);
    assert_eq!(app.world().get::<BackgroundColor>(slider).unwrap().0, GOLD);
    let mut text = app.world_mut().query::<&Text>();
    assert!(text.iter(app.world()).any(|text| text.0 == "Muted"));
    assert!(
        text.iter(app.world())
            .any(|text| text.0 == "Settings applied.")
    );
    app.world_mut().resource_mut::<MenuState>().tab = SettingsTab::Controls;
    app.update();
    assert!(
        app.world().get_entity(root).is_err(),
        "Changing category must still rebuild the page"
    );
}

#[test]
fn keyboard_focus_is_visible_only_for_navigation_source() {
    let mut app = App::new();
    app.insert_resource(MenuFocus(1))
        .insert_resource(MenuInputSource::Navigation)
        .add_systems(Update, style_buttons);
    let category = app
        .world_mut()
        .spawn((
            Button,
            MenuButton {
                action: UiAction::SelectTab(SettingsTab::Graphics),
                index: 0,
            },
        ))
        .id();
    let apply = app
        .world_mut()
        .spawn((
            Button,
            MenuButton {
                action: UiAction::ApplySettings,
                index: 1,
            },
        ))
        .id();
    app.update();
    assert_eq!(
        app.world().get::<BackgroundColor>(category).unwrap().0,
        PAPER
    );
    assert_eq!(
        *app.world().get::<BorderColor>(category).unwrap(),
        BorderColor::all(CREAM)
    );
    assert_eq!(
        *app.world().get::<BorderColor>(apply).unwrap(),
        BorderColor::all(INK)
    );
    assert_eq!(app.world().get::<BackgroundColor>(apply).unwrap().0, GOLD);
    app.world_mut().resource_mut::<MenuFocus>().0 = 0;
    app.update();
    assert_eq!(
        *app.world().get::<BorderColor>(category).unwrap(),
        BorderColor::all(INK)
    );
    assert_eq!(
        *app.world().get::<BorderColor>(apply).unwrap(),
        BorderColor::all(CREAM)
    );
    assert_eq!(app.world().get::<BackgroundColor>(apply).unwrap().0, PAPER);
    *app.world_mut().resource_mut::<MenuInputSource>() = MenuInputSource::Pointer;
    app.update();
    for entity in [category, apply] {
        assert_eq!(app.world().get::<BackgroundColor>(entity).unwrap().0, PAPER);
        assert_eq!(
            *app.world().get::<BorderColor>(entity).unwrap(),
            BorderColor::all(CREAM)
        );
    }
}

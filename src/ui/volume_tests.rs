use super::super::test_support::pointer_press;
use super::*;
use bevy::{picking::hover::Hovered, ui::Pressed, ui_widgets::Button};

fn pointer_app() -> (App, Entity, Entity) {
    let mut app = App::new();
    app.insert_resource(MenuState {
        page: MenuPage::Settings,
        tab: SettingsTab::Audio,
        ..default()
    })
    .init_resource::<MenuFocus>()
    .insert_resource(MenuInputSource::Navigation)
    .init_resource::<ButtonInput<MouseButton>>()
    .add_message::<PointerPress>()
    .add_message::<UiRequest>()
    .add_systems(Update, sample_slider_pointer);
    let window = app
        .world_mut()
        .spawn((Window::default(), PrimaryWindow))
        .id();
    let slider = app
        .world_mut()
        .spawn((
            Button,
            VolumeSlider {
                key: SettingKey::MasterVolume,
            },
            MenuButton {
                action: UiAction::Adjust(SettingKey::MasterVolume, 0),
                index: 5,
            },
            Pressed,
            ComputedNode {
                size: Vec2::new(220.0, 43.0),
                padding: BorderRect::all(10.0),
                border: BorderRect::all(2.0),
                ..default()
            },
            UiGlobalTransform::from_xy(200.0, 200.0),
        ))
        .id();
    (app, window, slider)
}

fn requests(app: &mut App) -> Vec<UiAction> {
    app.world_mut()
        .resource_mut::<Messages<UiRequest>>()
        .drain()
        .map(|request| request.0)
        .collect()
}

fn cursor(app: &mut App, window: Entity, position: Option<Vec2>) {
    app.world_mut()
        .get_mut::<Window>(window)
        .unwrap()
        .set_cursor_position(position);
}

#[test]
fn pointer_drag_keeps_capture_outside_slider_and_finishes_once() {
    let (mut app, window, slider) = pointer_app();
    cursor(&mut app, window, Some(Vec2::new(151.0, 200.0)));
    app.world_mut()
        .resource_mut::<ButtonInput<MouseButton>>()
        .press(MouseButton::Left);
    pointer_press(app.world_mut(), slider, PointerButton::Primary);
    app.update();
    assert_eq!(
        requests(&mut app),
        vec![UiAction::SetVolume(SettingKey::MasterVolume, 25)]
    );
    assert_eq!(app.world().resource::<MenuFocus>().0, 5);
    assert_eq!(
        *app.world().resource::<MenuInputSource>(),
        MenuInputSource::Pointer
    );
    app.world_mut()
        .resource_mut::<ButtonInput<MouseButton>>()
        .clear();
    app.world_mut().entity_mut(slider).remove::<Pressed>();
    app.world_mut().entity_mut(slider).insert(Hovered(false));
    cursor(&mut app, window, Some(Vec2::new(53.0, 240.0)));
    app.update();
    assert_eq!(
        requests(&mut app),
        vec![UiAction::SetVolume(SettingKey::MasterVolume, 0)]
    );
    cursor(&mut app, window, Some(Vec2::new(250.96, 240.0)));
    app.update();
    assert_eq!(
        requests(&mut app),
        vec![UiAction::SetVolume(SettingKey::MasterVolume, 76)]
    );
    app.update();
    assert!(
        requests(&mut app).is_empty(),
        "A stationary cursor must not repeat volume requests"
    );
    cursor(&mut app, window, Some(Vec2::new(350.0, 240.0)));
    app.world_mut()
        .resource_mut::<ButtonInput<MouseButton>>()
        .release(MouseButton::Left);
    app.update();
    assert_eq!(
        requests(&mut app),
        vec![
            UiAction::SetVolume(SettingKey::MasterVolume, 100),
            UiAction::FinishVolumeEdit
        ]
    );
    app.update();
    assert!(
        requests(&mut app).is_empty(),
        "Release must finish a gesture exactly once"
    );
}

#[test]
fn pointer_leaving_window_or_losing_focus_finishes_capture() {
    for leave_window in [true, false] {
        let (mut app, window, slider) = pointer_app();
        cursor(&mut app, window, Some(Vec2::new(200.0, 200.0)));
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .press(MouseButton::Left);
        pointer_press(app.world_mut(), slider, PointerButton::Primary);
        app.update();
        requests(&mut app);
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .clear();
        if leave_window {
            cursor(&mut app, window, None);
        } else {
            app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
        }
        app.update();
        assert_eq!(requests(&mut app), vec![UiAction::FinishVolumeEdit]);
        app.update();
        assert!(requests(&mut app).is_empty());
    }
}

#[test]
fn destroyed_slider_or_window_finishes_existing_capture() {
    for remove_window in [true, false] {
        let (mut app, window, slider) = pointer_app();
        cursor(&mut app, window, Some(Vec2::new(200.0, 200.0)));
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .press(MouseButton::Left);
        pointer_press(app.world_mut(), slider, PointerButton::Primary);
        app.update();
        requests(&mut app);
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .clear();
        app.world_mut()
            .despawn(if remove_window { window } else { slider });
        app.update();
        assert_eq!(requests(&mut app), vec![UiAction::FinishVolumeEdit]);
        app.update();
        assert!(requests(&mut app).is_empty());
    }
}

#[test]
fn pointer_uses_physical_coordinates_and_never_starts_on_old_pressed_tree() {
    let (mut app, window, slider) = pointer_app();
    app.world_mut()
        .get_mut::<Window>(window)
        .unwrap()
        .resolution
        .set_scale_factor_override(Some(2.0));
    cursor(&mut app, window, Some(Vec2::new(100.0, 100.0)));
    app.update();
    assert!(
        requests(&mut app).is_empty(),
        "A stale Pressed alone is not a new gesture"
    );
    app.world_mut()
        .resource_mut::<ButtonInput<MouseButton>>()
        .press(MouseButton::Left);
    pointer_press(app.world_mut(), slider, PointerButton::Primary);
    app.update();
    assert_eq!(
        requests(&mut app),
        vec![UiAction::SetVolume(SettingKey::MasterVolume, 50)]
    );
    app.world_mut()
        .resource_mut::<ButtonInput<MouseButton>>()
        .clear();
    app.world_mut().resource_mut::<MenuState>().tab = SettingsTab::Controls;
    app.update();
    assert!(requests(&mut app).is_empty());
    app.world_mut().resource_mut::<MenuState>().tab = SettingsTab::Audio;
    cursor(&mut app, window, Some(Vec2::new(125.0, 100.0)));
    app.update();
    assert!(
        requests(&mut app).is_empty(),
        "Changing tabs must drop the old capture"
    );
}

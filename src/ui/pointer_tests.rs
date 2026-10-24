use super::super::test_support::{drain_sounds, menu_app as test_app, pointer_press, request};
use super::*;
use bevy::{picking::hover::Hovered, ui::Pressed};
#[test]
fn pointer_sound_requires_entering_an_existing_button() {
    // 只运行真实指针系统与 ECS 交互状态，不创建窗口后端或音频设备。
    let mut app = App::new();
    app.init_resource::<MenuState>()
        .init_resource::<MenuFocus>()
        .init_resource::<MenuInputSource>()
        .add_message::<PointerPress>()
        .add_message::<UiRequest>()
        .add_message::<SoundRequest>()
        .add_systems(Update, pointer_interaction);
    let mut window = Window::default();
    window.set_cursor_position(Some(Vec2::new(80.0, 80.0)));
    let window = app.world_mut().spawn((window, PrimaryWindow)).id();
    let button = app
        .world_mut()
        .spawn((MenuButton::default(), Hovered(false)))
        .id();
    app.update();
    let mut presses = 0;
    for (hovered, pressed, x, expected) in [
        (true, false, 82.0, vec![SoundCue::MenuHover]),
        (true, false, 84.0, vec![]),
        (false, false, 86.0, vec![]),
        (true, false, 88.0, vec![SoundCue::MenuHover]),
        (true, true, 88.0, vec![]),
        (true, true, 88.0, vec![]),
        (true, false, 90.0, vec![]),
    ] {
        app.world_mut().entity_mut(button).insert(Hovered(hovered));
        if pressed {
            if !app.world().entity(button).contains::<Pressed>() {
                app.world_mut().entity_mut(button).insert((
                    Pressed,
                    PrimaryPress(bevy::picking::pointer::PointerId::Mouse),
                ));
                pointer_press(app.world_mut(), button, PointerButton::Primary);
            }
        } else {
            app.world_mut()
                .entity_mut(button)
                .remove::<(Pressed, PrimaryPress)>();
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
        .spawn((MenuButton::default(), Hovered(true)));
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
        app.world_mut().entity_mut(entity).insert(Hovered(true));
        app.update();
        assert_button_highlight(app, entity, true);
        app.world_mut().entity_mut(entity).insert(Hovered(false));
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
    app.world_mut()
        .entity_mut(buttons[0].1)
        .insert(Hovered(true));
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

    app.world_mut()
        .entity_mut(buttons[0].1)
        .insert(Hovered(false));
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
    app.world_mut().entity_mut(back).insert((
        Pressed,
        PrimaryPress(bevy::picking::pointer::PointerId::Mouse),
    ));
    pointer_press(app.world_mut(), back, PointerButton::Primary);
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
        .add_message::<PointerPress>()
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
        .spawn((MenuButton { action, index: 0 }, Hovered(true)))
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
            .spawn((MenuButton { action, index: 0 }, Hovered(true)))
            .id();
        app.update();
        assert_eq!(app.world().resource::<MenuFocus>().0, 4);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Navigation
        );
    }

    // 鼠标在同一按钮内移动时 Hovered 不变，也应重新接管焦点。
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
    app.world_mut().entity_mut(hovered).insert((
        Pressed,
        PrimaryPress(bevy::picking::pointer::PointerId::Mouse),
    ));
    pointer_press(app.world_mut(), hovered, PointerButton::Primary);
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
fn focused_native_button_keyboard_events_leave_activation_to_enhanced_input() {
    use super::super::test_support::menu_app_with;
    use bevy::{
        camera::NormalizedRenderTarget,
        input::{
            ButtonState,
            keyboard::{Key, KeyboardInput},
        },
        input_focus::{
            InputDispatchPlugin, InputFocus, InputFocusPlugin, pointer_focus::PointerFocusPlugin,
            tab_navigation::TabIndex,
        },
        picking::{
            backend::HitData,
            pointer::{Location, PointerId},
        },
        ui_widgets::{Activate, ButtonPlugin},
        window::WindowRef,
    };
    #[derive(Resource, Default)]
    struct Activations(usize);
    let mut app = menu_app_with(|app| {
        app.add_plugins((
            InputFocusPlugin,
            InputDispatchPlugin,
            PointerFocusPlugin,
            ButtonPlugin,
        ))
        .init_resource::<Activations>()
        .add_observer(|_: On<Activate>, mut activations: ResMut<Activations>| activations.0 += 1);
    });
    request(&mut app, UiAction::OpenSettings);
    let window = app
        .world_mut()
        .query_filtered::<Entity, With<PrimaryWindow>>()
        .single(app.world())
        .unwrap();
    let graphics = app
        .world_mut()
        .query::<(Entity, &MenuButton)>()
        .iter(app.world())
        .find_map(|(entity, button)| {
            (button.action == UiAction::SelectTab(SettingsTab::Graphics)).then_some(entity)
        })
        .unwrap();
    // 点击给原生焦点分发路径一个真实按钮目标；额外 TabIndex 也覆盖将来加入焦点导航的情形。
    app.world_mut().entity_mut(graphics).insert(TabIndex(0));
    let pointer = Pointer::new(
        PointerId::Mouse,
        Location {
            target: NormalizedRenderTarget::Window(
                WindowRef::Entity(window).normalize(Some(window)).unwrap(),
            ),
            position: Vec2::new(80.0, 80.0),
        },
    );
    app.world_mut().trigger(PointerPress {
        entity: graphics,
        pointer: pointer.clone(),
        button: PointerButton::Primary,
        hit: HitData::new(Entity::PLACEHOLDER, 0.0, None, None),
        count: 1,
    });
    pointer_press(app.world_mut(), graphics, PointerButton::Primary);
    app.update();
    assert_eq!(app.world().resource::<InputFocus>().get(), Some(graphics));
    app.world_mut().trigger(PointerRelease {
        entity: graphics,
        pointer,
        button: PointerButton::Primary,
        hit: HitData::new(Entity::PLACEHOLDER, 0.0, None, None),
    });
    app.update();
    app.world_mut()
        .resource_mut::<Messages<UiRequest>>()
        .drain()
        .for_each(drop);
    drain_sounds(&mut app);
    *app.world_mut().resource_mut::<MenuInputSource>() = MenuInputSource::Navigation;
    fn key(app: &mut App, window: Entity, key_code: KeyCode, state: ButtonState, repeat: bool) {
        app.world_mut().write_message(KeyboardInput {
            key_code,
            logical_key: Key::Unidentified(bevy::input::keyboard::NativeKey::Unidentified),
            state,
            text: None,
            repeat,
            window,
        });
        app.update();
    }
    // Space 会被原生 Button 转成 Activate；菜单没有绑定它，也不能把它误判为鼠标按下。
    key(
        &mut app,
        window,
        KeyCode::Space,
        ButtonState::Pressed,
        false,
    );
    assert_eq!(app.world().resource::<Activations>().0, 1);
    assert!(!app.world().entity(graphics).contains::<Pressed>());
    assert_eq!(
        *app.world().resource::<MenuInputSource>(),
        MenuInputSource::Navigation
    );
    assert_eq!(
        app.world_mut()
            .resource_mut::<Messages<UiRequest>>()
            .drain()
            .count(),
        0
    );
    key(
        &mut app,
        window,
        KeyCode::Space,
        ButtonState::Released,
        false,
    );
    // 原生焦点留在 Graphics，Enhanced Input 的菜单焦点选择 Audio，只能产生 Audio 的单次请求。
    app.world_mut().resource_mut::<MenuFocus>().0 = 1;
    key(
        &mut app,
        window,
        KeyCode::Enter,
        ButtonState::Pressed,
        false,
    );
    assert_eq!(app.world().resource::<MenuState>().tab, SettingsTab::Audio);
    assert_eq!(app.world().resource::<Activations>().0, 2);
    let requests: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<UiRequest>>()
        .drain()
        .map(|request| request.0)
        .collect();
    assert_eq!(requests, [UiAction::SelectTab(SettingsTab::Audio)]);
    assert_eq!(
        *app.world().resource::<MenuInputSource>(),
        MenuInputSource::Navigation
    );
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    key(&mut app, window, KeyCode::Enter, ButtonState::Pressed, true);
    assert_eq!(
        app.world_mut()
            .resource_mut::<Messages<UiRequest>>()
            .drain()
            .count(),
        0
    );
    assert_eq!(app.world().resource::<Activations>().0, 2);
}

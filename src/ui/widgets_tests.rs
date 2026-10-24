use super::super::test_support::*;
use super::*;
use bevy::{text::TextLayoutInfo, ui::Pressed};

#[test]
fn slider_visual_children_pass_real_ui_picking_to_the_parent_button() {
    use super::super::{
        MenuFocus, MenuInputSource, MenuPage, MenuState, SettingsTab, UiRequest,
        volume::VolumeSlider,
    };
    use crate::settings::SettingsDraft;
    use bevy::{
        camera::{NormalizedRenderTarget, RenderTarget},
        picking::{
            InteractionPlugin, PickingPlugin,
            pointer::{Location, PointerAction, PointerId, PointerInput},
        },
        ui::{UiStack, picking_backend::UiPickingPlugin},
        ui_widgets::ButtonPlugin,
        window::{PrimaryWindow, WindowRef},
    };
    let mut app = layout_app_with(UVec2::new(1280, 720), |app| {
        app.add_plugins((
            PickingPlugin,
            InteractionPlugin,
            UiPickingPlugin,
            ButtonPlugin,
        ));
        super::super::scroll::register(app);
    });
    app.init_resource::<ButtonInput<MouseButton>>()
        .init_resource::<UiStack>()
        .init_resource::<MenuFocus>()
        .init_resource::<MenuInputSource>()
        .init_resource::<SettingsDraft>()
        .insert_resource(MenuState {
            page: MenuPage::Settings,
            tab: SettingsTab::Audio,
            ..default()
        })
        .add_message::<UiRequest>();
    super::super::volume::register(&mut app);
    let window = app
        .world_mut()
        .spawn((Window::default(), PrimaryWindow))
        .id();
    let camera = app
        .world_mut()
        .query_filtered::<Entity, With<Camera>>()
        .single(app.world())
        .unwrap();
    app.world_mut()
        .entity_mut(camera)
        .insert(RenderTarget::Window(WindowRef::Entity(window)));
    app.world_mut().spawn(PointerId::Mouse);
    let theme = UiTheme {
        heading: default(),
        body: default(),
        scale: 1.0,
    };
    let root = app.world_mut().spawn_scene(bsn! {
        Node { width: px(400), height: px(120) }
        Children [
            @super::super::volume::volume_row(&theme, "Master Volume", 50, SettingKey::MasterVolume, 0, "Adjust every sound.")
        ]
    }).unwrap().id();
    // 单相机且无 ZIndex 的固定树按父先子后绘制；仅绘制栈是测试数据。
    // 真实字体测量、UI 布局、Picking 与原生 Button Observer 负责尺寸和命中。
    fn collect_stack(world: &World, entity: Entity, nodes: &mut Vec<Entity>) {
        if world.get::<Node>(entity).is_some() {
            nodes.push(entity);
        }
        if let Some(children) = world.get::<Children>(entity) {
            for child in children.iter() {
                collect_stack(world, child, nodes);
            }
        }
    }
    let mut stack_nodes = Vec::new();
    collect_stack(app.world(), root, &mut stack_nodes);
    app.insert_resource(UiStack {
        partition: vec![0..stack_nodes.len()],
        uinodes: stack_nodes,
    });
    // 无窗口数据实体提供可见性和坐标；命中、冒泡与按下状态由真正的 Bevy 系统生成。
    let nodes: Vec<_> = app
        .world_mut()
        .query_filtered::<Entity, With<Node>>()
        .iter(app.world())
        .collect();
    for entity in nodes {
        app.world_mut()
            .entity_mut(entity)
            .insert(InheritedVisibility::VISIBLE);
    }
    app.world_mut()
        .resource_mut::<SettingsDraft>()
        .set_volume(SettingKey::MasterVolume, 50);
    for _ in 0..3 {
        app.update();
    }
    let slider = app
        .world_mut()
        .query_filtered::<Entity, With<VolumeSlider>>()
        .single(app.world())
        .unwrap();
    let track = app.world().get::<Children>(slider).unwrap()[0];
    let fill = app.world().get::<Children>(track).unwrap()[0];
    let thumb = app.world().get::<Children>(fill).unwrap()[0];
    for target in [track, fill, thumb] {
        assert_eq!(
            *app.world().get::<Pickable>(target).unwrap(),
            Pickable::IGNORE
        );
        let position = app
            .world()
            .get::<UiGlobalTransform>(target)
            .unwrap()
            .affine()
            .translation;
        let location = Location {
            target: NormalizedRenderTarget::Window(
                WindowRef::Entity(window).normalize(Some(window)).unwrap(),
            ),
            position,
        };
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_physical_cursor_position(Some(position.as_dvec2()));
        app.world_mut().write_message(PointerInput::new(
            PointerId::Mouse,
            location.clone(),
            PointerAction::Move { delta: Vec2::ZERO },
        ));
        app.update();
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .press(MouseButton::Left);
        app.world_mut().write_message(PointerInput::new(
            PointerId::Mouse,
            location.clone(),
            PointerAction::Press(PointerButton::Primary),
        ));
        app.update();
        assert!(
            app.world().entity(slider).contains::<Pressed>(),
            "A visual child must not block its slider"
        );
        let actions: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiRequest>>()
            .drain()
            .map(|request| request.0)
            .collect();
        assert!(
            matches!(
                actions.as_slice(),
                [UiAction::SetVolume(SettingKey::MasterVolume, _)]
            ),
            "Real UI picking must reach precise volume sampling: {actions:?}"
        );
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .release(MouseButton::Left);
        app.world_mut().write_message(PointerInput::new(
            PointerId::Mouse,
            location,
            PointerAction::Release(PointerButton::Primary),
        ));
        app.update();
        let actions: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiRequest>>()
            .drain()
            .map(|request| request.0)
            .collect();
        assert_eq!(actions, [UiAction::FinishVolumeEdit]);
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .clear();
    }
}

#[test]
fn bsn_row_text_keeps_intrinsic_width_and_column_text_wraps() {
    let mut app = layout_app(UVec2::new(900, 900));
    // TextPlugin 的内嵌字体是真实字体，避免测试依赖本机的外部美术资产。
    let theme = UiTheme {
        heading: default(),
        body: default(),
        scale: 1.0,
    };
    const PARAGRAPH: &str = "Move around the island with WASD. Jump with Space. Carry a parcel to explore a new route and make your next delivery.";
    app.world_mut()
        .spawn_scene(bsn! {
            column(12.0)
            Node { width: percent(100), height: percent(100), padding: px(16) }
            Children [
                Node { column_gap: px(12), align_items: AlignItems::Center }
                Children [
                    @small_button(&theme, "Restore Defaults", UiAction::RestoreDefaults, 0)
                    --
                    @small_button(&theme, "Apply", UiAction::ApplySettings, 1)
                    --
                    @small_button(&theme, "Back", UiAction::Back, 2)
                ]
                --
                @setting_row(&theme, "Frame Rate Limit", "60 FPS".into(), SettingKey::FrameRate, 3, "Adjust the maximum frame rate.")
                --
                @super::super::volume::volume_row(&theme, "Master Volume", 100, SettingKey::MasterVolume, 5, "Adjust every sound.")
                --
                @super::super::volume::volume_row(&theme, "SFX Volume", 0, SettingKey::SfxVolume, 8, "Adjust gameplay sounds.")
                --
                @super::super::volume::volume_row(&theme, "UI Volume", 37, SettingKey::UiVolume, 11, "Adjust menu sounds.")
                --
                @placeholder_row(&theme, "Window Mode", false)
                --
                Node { column_gap: px(9), align_items: AlignItems::Center }
                Children [
                    @keycap(&theme, "Arrows", true)
                    --
                    @label(&theme, "Navigate", 17.0, CREAM)
                    --
                    @keycap(&theme, "Enter", true)
                    --
                    @label(&theme, "Confirm", 17.0, CREAM)
                    --
                    @keycap(&theme, "Esc", true)
                    --
                    @label(&theme, "Back", 17.0, CREAM)
                    --
                    @keycap(&theme, "WASD", false)
                    --
                    @keycap(&theme, "Space", false)
                    --
                    @keycap(&theme, "E", false)
                ]
                --
                Node { column_gap: px(9), align_items: AlignItems::Center }
                Children [
                    Node { width: px(49), height: px(49), align_items: AlignItems::Center, justify_content: JustifyContent::Center }
                    BackgroundColor(GOLD)
                    Children [
                        @heading(&theme, "01", 26.0, INK)
                    ]
                    --
                    @heading(&theme, "MOVE & JUMP", 27.0, INK)
                ]
                --
                Node { column_gap: px(9), align_items: AlignItems::Center }
                Children [
                    @parcel_stamp(&theme)
                    --
                    @label(&theme, "ISLAND DELIVERY CO.", 15.0, CREAM)
                ]
                --
                column(8.0)
                Node { width: px(240), padding: px(12), flex_shrink: 0.0 }
                Children [
                    @heading(&theme, "HOW TO PLAY", 25.0, INK)
                    --
                    @label(&theme, PARAGRAPH, 18.0, INK)
                ]
            ]
        })
        .unwrap();
    // 资产事件首帧进入字体集合，后续更新完成实际字形与布局计算。
    for _ in 0..3 {
        app.update();
    }
    let world = app.world_mut();
    let mut texts = world.query::<(&Text, &ComputedNode, &TextLayoutInfo)>();
    let invisible: Vec<_> = texts
        .iter(world)
        .filter(|(_, node, layout)| {
            node.size().x <= 0.0 || node.size().y <= 0.0 || layout.glyphs.is_empty()
        })
        .map(|(text, node, layout)| (text.0.as_str(), node.size(), layout.glyphs.len()))
        .collect();
    assert!(
        invisible.is_empty(),
        "Text needs visible layout: {invisible:?}"
    );
    let (_, paragraph, glyphs) = texts
        .iter(world)
        .find(|(text, _, _)| text.0 == PARAGRAPH)
        .unwrap();
    assert!(paragraph.size().x <= 216.0);
    assert!(
        paragraph.size().y > 36.0,
        "Description must wrap into multiple lines"
    );
    assert!(!glyphs.glyphs.is_empty());
}

/// 真实 Picking 与原生 Button 的最小无窗口组合，不安装菜单请求消费器。
fn native_pointer_app(slider: bool) -> (App, Entity, Entity) {
    use super::super::{MenuFocus, MenuInputSource, MenuPage, MenuState, SettingsTab, UiSystems};
    use crate::{audio::SoundRequest, settings::SettingsDraft};
    use bevy::{
        camera::RenderTarget,
        picking::{InteractionPlugin, PickingPlugin},
        ui::{UiStack, picking_backend::UiPickingPlugin},
        ui_widgets::ButtonPlugin,
        window::{PrimaryWindow, WindowRef},
    };
    let mut app = layout_app_with(UVec2::new(960, 540), |app| {
        app.add_plugins((
            PickingPlugin,
            InteractionPlugin,
            UiPickingPlugin,
            ButtonPlugin,
        ));
    });
    app.init_resource::<ButtonInput<MouseButton>>()
        .init_resource::<UiStack>()
        .init_resource::<MenuFocus>()
        .init_resource::<MenuInputSource>()
        .init_resource::<SettingsDraft>()
        .insert_resource(MenuState {
            page: MenuPage::Settings,
            tab: SettingsTab::Audio,
            ..default()
        })
        .add_message::<super::super::UiRequest>()
        .add_message::<SoundRequest>()
        .configure_sets(
            Update,
            (UiSystems::Build, UiSystems::Pointer, UiSystems::Style).chain(),
        )
        .add_systems(
            Update,
            super::super::style::style_buttons.in_set(UiSystems::Style),
        );
    super::super::pointer::register(&mut app);
    super::super::volume::register(&mut app);
    let window = app
        .world_mut()
        .spawn((Window::default(), PrimaryWindow))
        .id();
    let camera = app
        .world_mut()
        .query_filtered::<Entity, With<Camera>>()
        .single(app.world())
        .unwrap();
    app.world_mut()
        .entity_mut(camera)
        .insert(RenderTarget::Window(WindowRef::Entity(window)));
    app.world_mut()
        .spawn(bevy::picking::pointer::PointerId::Mouse);
    let theme = UiTheme {
        heading: default(),
        body: default(),
        scale: 1.0,
    };
    let root = if slider {
        app.world_mut()
            .spawn_scene(super::super::volume::volume_row(
                &theme,
                "Master Volume",
                50,
                SettingKey::MasterVolume,
                0,
                "Adjust every sound.",
            ))
            .unwrap()
            .id()
    } else {
        app.world_mut()
            .spawn_scene(small_button(&theme, "Back", UiAction::Back, 2))
            .unwrap()
            .id()
    };
    fn collect(world: &World, entity: Entity, result: &mut Vec<Entity>) {
        if world.get::<Node>(entity).is_some() {
            result.push(entity);
        }
        if let Some(children) = world.get::<Children>(entity) {
            for child in children {
                collect(world, *child, result);
            }
        }
    }
    let mut nodes = Vec::new();
    collect(app.world(), root, &mut nodes);
    app.insert_resource(UiStack {
        partition: vec![0..nodes.len()],
        uinodes: nodes.clone(),
    });
    for entity in nodes {
        app.world_mut()
            .entity_mut(entity)
            .insert(InheritedVisibility::VISIBLE);
    }
    for _ in 0..3 {
        app.update();
    }
    let target = if slider {
        app.world_mut()
            .query_filtered::<Entity, With<super::super::volume::VolumeSlider>>()
            .single(app.world())
            .unwrap()
    } else {
        root
    };
    let position = app
        .world()
        .get::<UiGlobalTransform>(target)
        .unwrap()
        .affine()
        .translation;
    native_input(
        &mut app,
        window,
        position,
        bevy::picking::pointer::PointerAction::Move { delta: Vec2::ZERO },
    );
    app.update();
    (app, window, target)
}

fn native_input(
    app: &mut App,
    window: Entity,
    position: Vec2,
    action: bevy::picking::pointer::PointerAction,
) {
    use bevy::{
        camera::NormalizedRenderTarget,
        picking::pointer::{Location, PointerId, PointerInput},
        window::WindowRef,
    };
    app.world_mut()
        .get_mut::<Window>(window)
        .unwrap()
        .set_cursor_position(Some(position));
    app.world_mut().write_message(PointerInput::new(
        PointerId::Mouse,
        Location {
            target: NormalizedRenderTarget::Window(
                WindowRef::Entity(window).normalize(Some(window)).unwrap(),
            ),
            position,
        },
        action,
    ));
}

fn native_requests(app: &mut App) -> Vec<UiAction> {
    app.world_mut()
        .resource_mut::<Messages<super::super::UiRequest>>()
        .drain()
        .map(|request| request.0)
        .collect()
}

#[test]
fn native_buttons_keep_fast_primary_clicks_and_ignore_other_pointer_buttons() {
    use super::super::{MenuFocus, MenuInputSource, pointer::PrimaryPress};
    use bevy::picking::pointer::PointerAction;
    let (mut app, window, target) = native_pointer_app(false);
    let position = app
        .world()
        .get::<UiGlobalTransform>(target)
        .unwrap()
        .affine()
        .translation;
    native_input(
        &mut app,
        window,
        position,
        PointerAction::Press(PointerButton::Primary),
    );
    native_input(
        &mut app,
        window,
        position,
        PointerAction::Release(PointerButton::Primary),
    );
    app.update();
    assert!(!app.world().entity(target).contains::<Pressed>());
    assert!(!app.world().entity(target).contains::<PrimaryPress>());
    assert_eq!(native_requests(&mut app), [UiAction::Back]);
    app.update();
    assert!(native_requests(&mut app).is_empty());
    // 取消真正的主键手势后，后续右／中键也不能继承主键样式。
    native_input(
        &mut app,
        window,
        position,
        PointerAction::Press(PointerButton::Primary),
    );
    app.update();
    native_requests(&mut app);
    assert!(app.world().entity(target).contains::<PrimaryPress>());
    app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
    app.update();
    assert!(!app.world().entity(target).contains::<PrimaryPress>());
    assert!(!app.world().entity(target).contains::<Pressed>());
    app.world_mut().get_mut::<Window>(window).unwrap().focused = true;
    native_input(
        &mut app,
        window,
        position,
        PointerAction::Press(PointerButton::Primary),
    );
    app.update();
    native_requests(&mut app);
    assert!(app.world().entity(target).contains::<PrimaryPress>());
    native_input(&mut app, window, position, PointerAction::Cancel);
    app.update();
    assert!(!app.world().entity(target).contains::<Pressed>());
    assert!(!app.world().entity(target).contains::<PrimaryPress>());
    for button in [PointerButton::Secondary, PointerButton::Middle] {
        *app.world_mut().resource_mut::<MenuInputSource>() = MenuInputSource::Navigation;
        app.world_mut().resource_mut::<MenuFocus>().0 = 0;
        native_input(&mut app, window, position, PointerAction::Press(button));
        app.update();
        assert!(native_requests(&mut app).is_empty());
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Navigation
        );
        assert_eq!(app.world().get::<BackgroundColor>(target).unwrap().0, PAPER);
        assert!(!app.world().entity(target).contains::<PrimaryPress>());
        native_input(&mut app, window, position, PointerAction::Release(button));
        app.update();
    }
}

#[test]
fn native_slider_samples_and_finishes_a_press_and_release_in_one_frame() {
    use bevy::picking::pointer::PointerAction;
    let (mut app, window, target) = native_pointer_app(true);
    let position = app
        .world()
        .get::<UiGlobalTransform>(target)
        .unwrap()
        .affine()
        .translation;
    app.world_mut()
        .resource_mut::<ButtonInput<MouseButton>>()
        .press(MouseButton::Left);
    app.world_mut()
        .resource_mut::<ButtonInput<MouseButton>>()
        .release(MouseButton::Left);
    native_input(
        &mut app,
        window,
        position,
        PointerAction::Press(PointerButton::Primary),
    );
    native_input(
        &mut app,
        window,
        position,
        PointerAction::Release(PointerButton::Primary),
    );
    app.update();
    assert!(!app.world().entity(target).contains::<Pressed>());
    assert_eq!(
        native_requests(&mut app),
        [
            UiAction::SetVolume(SettingKey::MasterVolume, 50),
            UiAction::FinishVolumeEdit
        ]
    );
    app.update();
    assert!(native_requests(&mut app).is_empty());
}

#[test]
fn native_button_press_is_discarded_when_build_replaces_the_target_tree() {
    use super::super::UiSystems;
    use bevy::picking::pointer::PointerAction;
    let (mut app, window, target) = native_pointer_app(false);
    let position = app
        .world()
        .get::<UiGlobalTransform>(target)
        .unwrap()
        .affine()
        .translation;
    app.add_systems(
        Update,
        (move |mut commands: Commands| {
            commands.entity(target).try_despawn();
        })
        .in_set(UiSystems::Build),
    );
    native_input(
        &mut app,
        window,
        position,
        PointerAction::Press(PointerButton::Primary),
    );
    app.update();
    assert!(app.world().get_entity(target).is_err());
    assert!(native_requests(&mut app).is_empty());
}

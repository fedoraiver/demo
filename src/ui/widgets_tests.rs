use super::super::test_support::*;
use super::*;
use bevy::text::TextLayoutInfo;

#[test]
fn slider_visual_children_pass_real_ui_focus_to_the_parent_button() {
    use super::super::{
        MenuFocus, MenuInputSource, MenuPage, MenuState, SettingsTab, UiRequest,
        volume::VolumeSlider,
    };
    use crate::settings::SettingsDraft;
    use bevy::{
        input::touch::Touches,
        ui::{FocusPolicy, UiStack, ui_focus_system},
        window::PrimaryWindow,
    };
    let mut app = layout_app(UVec2::new(1280, 720));
    app.init_resource::<ButtonInput<MouseButton>>()
        .init_resource::<Touches>()
        .init_resource::<UiStack>()
        .init_resource::<UiScale>()
        .init_resource::<MenuFocus>()
        .init_resource::<MenuInputSource>()
        .init_resource::<SettingsDraft>()
        .insert_resource(MenuState {
            page: MenuPage::Settings,
            tab: SettingsTab::Audio,
            ..default()
        })
        .add_message::<UiRequest>()
        .add_systems(PreUpdate, ui_focus_system);
    super::super::volume::register(&mut app);
    let window = app
        .world_mut()
        .spawn((Window::default(), PrimaryWindow))
        .id();
    let theme = UiTheme {
        heading: default(),
        body: default(),
        scale: 1.0,
    };
    let root = app.world_mut().spawn_scene(bsn! {
        Node { width: px(400), height: px(120) }
        Children [super::super::volume::volume_row(&theme, "Master Volume", 50, SettingKey::MasterVolume, 0, "Adjust every sound.")]
    }).unwrap().id();
    // 单相机且无 ZIndex 的固定树按父先子后绘制；仅绘制栈是测试数据。
    // 真实字体测量、UI 布局与 ui_focus_system 仍负责尺寸和命中，不伪造 Interaction。
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
    // UI focus读真实布局、可见性和栈；无窗口数据实体仅提供坐标来源。
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
            *app.world().get::<FocusPolicy>(target).unwrap(),
            FocusPolicy::Pass
        );
        let position = app
            .world()
            .get::<UiGlobalTransform>(target)
            .unwrap()
            .affine()
            .translation;
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_physical_cursor_position(Some(position.as_dvec2()));
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .press(MouseButton::Left);
        app.update();
        assert_eq!(
            *app.world().get::<Interaction>(slider).unwrap(),
            Interaction::Pressed,
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
            "Real UI focus must reach precise volume sampling: {actions:?}"
        );
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .release(MouseButton::Left);
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
            template_value(column(12.0))
            Node { width: percent(100), height: percent(100), padding: px(16) }
            Children [
                (
                    Node { column_gap: px(12), align_items: AlignItems::Center }
                    Children [
                        small_button(&theme, "Restore Defaults", UiAction::RestoreDefaults, 0),
                        small_button(&theme, "Apply", UiAction::ApplySettings, 1),
                        small_button(&theme, "Back", UiAction::Back, 2),
                    ]
                ),
                setting_row(&theme, "Frame Rate Limit", "60 FPS".into(), SettingKey::FrameRate, 3, "Adjust the maximum frame rate."),
                super::super::volume::volume_row(&theme, "Master Volume", 100, SettingKey::MasterVolume, 5, "Adjust every sound."),
                super::super::volume::volume_row(&theme, "SFX Volume", 0, SettingKey::SfxVolume, 8, "Adjust gameplay sounds."),
                super::super::volume::volume_row(&theme, "UI Volume", 37, SettingKey::UiVolume, 11, "Adjust menu sounds."),
                placeholder_row(&theme, "Window Mode", false),
                (
                    Node { column_gap: px(9), align_items: AlignItems::Center }
                    Children [
                        keycap(&theme, "Arrows", true),
                        label(&theme, "Navigate", 17.0, CREAM),
                        keycap(&theme, "Enter", true),
                        label(&theme, "Confirm", 17.0, CREAM),
                        keycap(&theme, "Esc", true),
                        label(&theme, "Back", 17.0, CREAM),
                        keycap(&theme, "WASD", false),
                        keycap(&theme, "Space", false),
                        keycap(&theme, "E", false),
                    ]
                ),
                (
                    Node { column_gap: px(9), align_items: AlignItems::Center }
                    Children [
                        (
                            Node { width: px(49), height: px(49), align_items: AlignItems::Center, justify_content: JustifyContent::Center }
                            BackgroundColor(GOLD)
                            Children [heading(&theme, "01", 26.0, INK)]
                        ),
                        heading(&theme, "MOVE & JUMP", 27.0, INK),
                    ]
                ),
                (
                    Node { column_gap: px(9), align_items: AlignItems::Center }
                    Children [
                        parcel_stamp(&theme),
                        label(&theme, "ISLAND DELIVERY CO.", 15.0, CREAM),
                    ]
                ),
                (
                    template_value(column(8.0))
                    Node { width: px(240), padding: px(12), flex_shrink: 0.0 }
                    Children [heading(&theme, "HOW TO PLAY", 25.0, INK), label(&theme, PARAGRAPH, 18.0, INK)]
                ),
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

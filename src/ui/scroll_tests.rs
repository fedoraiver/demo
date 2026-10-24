use super::super::{test_support::*, widgets::*};
use super::*;
use bevy::{
    camera::NormalizedRenderTarget,
    input::touch::TouchPhase,
    picking::{
        backend::HitData,
        pointer::{Location, PointerId},
    },
};

#[derive(Component, Clone, Default)]
struct ScrollbarTestRoot;

#[derive(Component, Clone, Default)]
struct ScrollbarTestContent;

#[derive(Component, Clone, Default)]
struct ScrollbarTestPanel;

#[derive(Component, Clone, Default)]
struct ScrollbarTestFixedSibling;

fn spawn_scrollbar_fixture(app: &mut App) {
    let theme = UiTheme {
        heading: default(),
        body: default(),
        scale: 1.0,
    };
    app.world_mut()
        .spawn_scene(bsn! {
            ScrollbarTestRoot
            Node {
                width: percent(100), height: percent(100),
                min_height: px(0),
                flex_direction: FlexDirection::Column,
                row_gap: px(12), padding: px(16),
            }
            Children [
                ScrollbarTestFixedSibling
                Node { height: px(24), flex_shrink: 0.0 }
                --
                ScrollbarTestPanel
                @paper_panel(&theme)
                Node { width: percent(100), min_height: px(0), flex_grow: 1.0, flex_basis: px(0) }
                Children [
                    @settings_scroll_frame(&theme, bsn! {
                            ScrollbarTestContent
                            Node { width: percent(100), height: px(1000), flex_shrink: 0.0 }
                    })
                ]
                --
                ScrollbarTestFixedSibling
                Node { height: px(36), flex_shrink: 0.0 }
            ]
        })
        .unwrap();
    for _ in 0..3 {
        app.update();
    }
}

fn scrollbar_entities(app: &mut App) -> (Entity, Entity, Entity) {
    let world = app.world_mut();
    let (track, scrollbar, children) = world
        .query_filtered::<(Entity, &Scrollbar, &Children), With<SettingsScrollbar>>()
        .single(world)
        .unwrap();
    let thumb = children
        .iter()
        .find(|entity| world.get::<ScrollbarThumb>(*entity).is_some())
        .unwrap();
    (scrollbar.target, track, thumb)
}

// 只向无窗口 World 注入 UI 事件，验证真正的 Bevy Observer，不模拟桌面输入。
fn send_pointer<E: bevy::picking::events::PointerEvent>(
    app: &mut App,
    entity: Entity,
    position: Vec2,
    event: impl FnOnce(Entity, Pointer) -> E,
) where
    for<'a> E::Trigger<'a>: Default,
{
    let pointer = Pointer::new(
        PointerId::Mouse,
        Location {
            target: NormalizedRenderTarget::None {
                width: 480,
                height: 400,
            },
            position,
        },
    );
    app.world_mut().trigger(event(entity, pointer));
}

fn pointer_hit(app: &mut App) -> HitData {
    let world = app.world_mut();
    let camera = world
        .query_filtered::<Entity, With<Camera>>()
        .single(world)
        .unwrap();
    HitData::new(camera, 0.0, None, None)
}

fn pointer_scroll(app: &mut App, entity: Entity, unit: MouseScrollUnit, y: f32) {
    let hit = pointer_hit(app);
    send_pointer(app, entity, Vec2::ZERO, |entity, pointer| PointerScroll {
        entity,
        pointer,
        unit,
        x: 0.0,
        y,
        hit,
        phase: TouchPhase::Moved,
    });
}

fn node_rect(world: &World, entity: Entity) -> Rect {
    let center = world
        .get::<UiGlobalTransform>(entity)
        .unwrap()
        .affine()
        .translation;
    let half_size = world.get::<ComputedNode>(entity).unwrap().size() * 0.5;
    Rect::from_corners(center - half_size, center + half_size)
}

#[test]
fn settings_scrollbar_stays_inside_the_paper_panel_and_keeps_outer_siblings_fixed() {
    let mut app = layout_app(UVec2::new(480, 400));
    app.insert_resource(MenuState {
        page: MenuPage::Settings,
        ..default()
    });
    spawn_scrollbar_fixture(&mut app);
    let (area, track, _) = scrollbar_entities(&mut app);
    let world = app.world_mut();
    let panel = world
        .query_filtered::<Entity, With<ScrollbarTestPanel>>()
        .single(world)
        .unwrap();
    let content = world
        .query_filtered::<Entity, With<ScrollbarTestContent>>()
        .single(world)
        .unwrap();
    let fixed: Vec<_> = world
        .query_filtered::<Entity, With<ScrollbarTestFixedSibling>>()
        .iter(world)
        .map(|entity| (entity, node_rect(world, entity)))
        .collect();
    let panel_rect = node_rect(world, panel);
    let area_rect = node_rect(world, area);
    let track_rect = node_rect(world, track);
    let content_rect = node_rect(world, content);
    assert_eq!(world.get::<Node>(area).unwrap().padding, UiRect::ZERO);
    assert!(area_rect.min.y > panel_rect.min.y && area_rect.max.y < panel_rect.max.y);
    assert!(area_rect.max.x <= track_rect.min.x);
    assert!(track_rect.min.x > panel_rect.min.x && track_rect.max.x < panel_rect.max.x);
    assert!((track_rect.min.y - area_rect.min.y).abs() < 1.0);
    assert!((track_rect.max.y - area_rect.max.y).abs() < 1.0);

    pointer_scroll(&mut app, area, MouseScrollUnit::Line, -4.0);
    app.update();
    assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, 128.0);
    assert!(node_rect(app.world(), content).min.y < content_rect.min.y);
    assert_eq!(node_rect(app.world(), panel), panel_rect);
    assert_eq!(node_rect(app.world(), track), track_rect);
    for (entity, rect) in fixed {
        assert_eq!(node_rect(app.world(), entity), rect);
        pointer_scroll(&mut app, entity, MouseScrollUnit::Line, -4.0);
    }
    assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, 128.0);
}

#[test]
fn settings_scrollbar_native_pointer_actions_follow_the_scroll_position_at_multiple_scales() {
    for (dpi, ui_scale) in [(1.0_f32, 1.0_f32), (2.0, 1.0), (2.0, 1.25)] {
        let mut app = layout_app((Vec2::new(480.0, 400.0) * dpi).as_uvec2());
        app.world_mut().resource_mut::<UiScale>().0 = ui_scale;
        let world = app.world_mut();
        for mut camera in world.query::<&mut Camera>().iter_mut(world) {
            camera.computed.target_info.as_mut().unwrap().scale_factor = dpi;
        }
        app.insert_resource(MenuState {
            page: MenuPage::Settings,
            ..default()
        });
        spawn_scrollbar_fixture(&mut app);
        let (area, track, thumb) = scrollbar_entities(&mut app);
        assert_eq!(
            *app.world().get::<Visibility>(track).unwrap(),
            Visibility::Inherited
        );
        assert!(app.world().get::<Node>(thumb).is_none());
        assert!(app.world().get::<MenuButton>(thumb).is_none());
        let initial_thumb = node_rect(app.world(), thumb);
        let initial_track = node_rect(app.world(), track);
        assert!((initial_thumb.min.y - initial_track.min.y).abs() < 1.0);

        pointer_scroll(&mut app, area, MouseScrollUnit::Line, -4.0);
        pointer_scroll(&mut app, thumb, MouseScrollUnit::Pixel, -16.0);
        app.update();
        assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, 144.0);
        assert!(node_rect(app.world(), thumb).min.y > initial_thumb.min.y);

        // 键盘导航直接写同一个 ScrollPosition，原生滑块应随源偏移更新。
        app.world_mut().get_mut::<ScrollPosition>(area).unwrap().y = 0.0;
        app.world_mut()
            .resource_mut::<MenuInputSource>()
            .clone_from(&MenuInputSource::Navigation);
        app.update();
        let track_rect = node_rect(app.world(), track);
        let render_scale = app
            .world()
            .get::<ComputedUiRenderTargetInfo>(track)
            .unwrap()
            .scale_factor();
        let click =
            Vec2::new(track_rect.center().x, track_rect.max.y - 1.0) * ui_scale / render_scale;
        let hit = pointer_hit(&mut app);
        send_pointer(&mut app, track, click, |entity, pointer| PointerPress {
            entity,
            pointer,
            button: PointerButton::Primary,
            hit,
            count: 1,
        });
        let area_node = app.world().get::<ComputedNode>(area).unwrap();
        let page_size =
            (area_node.size().y - area_node.scrollbar_size.y) * area_node.inverse_scale_factor();
        assert!((app.world().get::<ScrollPosition>(area).unwrap().y - page_size).abs() < 0.1);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );

        let before = app.world().get::<ScrollPosition>(area).unwrap().y;
        let hit = pointer_hit(&mut app);
        send_pointer(&mut app, thumb, click, |entity, pointer| PointerPress {
            entity,
            pointer,
            button: PointerButton::Primary,
            hit,
            count: 1,
        });
        assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, before);
        let hit = pointer_hit(&mut app);
        send_pointer(&mut app, thumb, click, |entity, pointer| PointerDragStart {
            entity,
            pointer,
            button: PointerButton::Primary,
            hit,
        });
        assert!(
            app.world()
                .get::<ScrollbarDragState>(thumb)
                .unwrap()
                .dragging
        );
        let distance = Vec2::new(0.0, 18.0 * ui_scale);
        send_pointer(&mut app, thumb, click, |entity, pointer| PointerDrag {
            entity,
            pointer,
            button: PointerButton::Primary,
            distance,
            delta: distance,
        });
        let area_node = app.world().get::<ComputedNode>(area).unwrap();
        let track_node = app.world().get::<ComputedNode>(track).unwrap();
        let content_height = area_node.content_size().y * area_node.inverse_scale_factor();
        let track_height = track_node.size().y * track_node.inverse_scale_factor();
        let range = vertical_scroll_range(area_node);
        let expected = (before + 18.0 * content_height / track_height).min(range);
        assert!((app.world().get::<ScrollPosition>(area).unwrap().y - expected).abs() < 0.1);
        send_pointer(&mut app, thumb, click, |entity, pointer| PointerDrag {
            entity,
            pointer,
            button: PointerButton::Primary,
            distance: Vec2::new(0.0, 10000.0),
            delta: Vec2::new(0.0, 10000.0),
        });
        app.update();
        assert!((app.world().get::<ScrollPosition>(area).unwrap().y - range).abs() < 0.1);
        assert!(
            (node_rect(app.world(), thumb).max.y - node_rect(app.world(), track).max.y).abs() < 1.0
        );
        send_pointer(&mut app, thumb, click, |entity, pointer| PointerDragEnd {
            entity,
            pointer,
            button: PointerButton::Primary,
            distance,
        });
        assert!(
            !app.world()
                .get::<ScrollbarDragState>(thumb)
                .unwrap()
                .dragging
        );
        let hit = pointer_hit(&mut app);
        send_pointer(&mut app, thumb, click, |entity, pointer| PointerDragStart {
            entity,
            pointer,
            button: PointerButton::Primary,
            hit,
        });
        let hit = pointer_hit(&mut app);
        send_pointer(&mut app, thumb, click, |entity, pointer| PointerCancel {
            entity,
            pointer,
            hit,
        });
        assert!(
            !app.world()
                .get::<ScrollbarDragState>(thumb)
                .unwrap()
                .dragging
        );
    }
}

#[test]
fn settings_scrollbar_hides_clamps_and_clears_drag_when_layout_or_page_changes() {
    let mut app = layout_app(UVec2::new(480, 400));
    app.insert_resource(MenuState {
        page: MenuPage::Settings,
        ..default()
    });
    spawn_scrollbar_fixture(&mut app);
    let (area, track, thumb) = scrollbar_entities(&mut app);
    pointer_scroll(&mut app, area, MouseScrollUnit::Line, -8.0);
    let hit = pointer_hit(&mut app);
    send_pointer(&mut app, thumb, Vec2::ZERO, |entity, pointer| {
        PointerDragStart {
            entity,
            pointer,
            button: PointerButton::Primary,
            hit,
        }
    });
    let world = app.world_mut();
    let content = world
        .query_filtered::<Entity, With<ScrollbarTestContent>>()
        .single(world)
        .unwrap();
    world.get_mut::<Node>(content).unwrap().height = px(40);
    app.update();
    assert_eq!(
        *app.world().get::<Visibility>(track).unwrap(),
        Visibility::Hidden
    );
    assert_eq!(
        *app.world().get::<Pickable>(track).unwrap(),
        Pickable::IGNORE
    );
    assert_eq!(
        *app.world().get::<Pickable>(thumb).unwrap(),
        Pickable::IGNORE
    );
    assert_eq!(
        app.world().get::<ScrollPosition>(area).unwrap().0,
        Vec2::ZERO
    );
    assert!(
        !app.world()
            .get::<ScrollbarDragState>(thumb)
            .unwrap()
            .dragging
    );

    app.world_mut().get_mut::<Node>(content).unwrap().height = px(1000);
    app.update();
    assert_eq!(
        *app.world().get::<Visibility>(track).unwrap(),
        Visibility::Inherited
    );
    pointer_scroll(&mut app, area, MouseScrollUnit::Line, -8.0);
    let hit = pointer_hit(&mut app);
    send_pointer(&mut app, thumb, Vec2::ZERO, |entity, pointer| {
        PointerDragStart {
            entity,
            pointer,
            button: PointerButton::Primary,
            hit,
        }
    });
    app.world_mut().resource_mut::<MenuState>().page = MenuPage::Main;
    app.update();
    pointer_scroll(&mut app, area, MouseScrollUnit::Line, -8.0);
    pointer_scroll(&mut app, thumb, MouseScrollUnit::Line, -8.0);
    assert_eq!(
        app.world().get::<ScrollPosition>(area).unwrap().0,
        Vec2::ZERO
    );
    assert_eq!(
        *app.world().get::<Visibility>(track).unwrap(),
        Visibility::Hidden
    );
    assert!(
        !app.world()
            .get::<ScrollbarDragState>(thumb)
            .unwrap()
            .dragging
    );

    // 页签重建销毁整个旧子树，原生拖拽状态不会跨实体存活。
    let world = app.world_mut();
    let root = world
        .query_filtered::<Entity, With<ScrollbarTestRoot>>()
        .single(world)
        .unwrap();
    world.despawn(root);
    assert!(world.get_entity(thumb).is_err());
    world.resource_mut::<MenuState>().page = MenuPage::Settings;
    spawn_scrollbar_fixture(&mut app);
    let (_, new_track, new_thumb) = scrollbar_entities(&mut app);
    assert_ne!(new_thumb, thumb);
    assert_eq!(
        *app.world().get::<Visibility>(new_track).unwrap(),
        Visibility::Inherited
    );
    assert!(
        !app.world()
            .get::<ScrollbarDragState>(new_thumb)
            .unwrap()
            .dragging
    );
}

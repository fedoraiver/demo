use super::*;
use bevy::{
    input::mouse::MouseScrollUnit,
    text::TextLayoutInfo,
    ui_widgets::{Scrollbar, ScrollbarThumb},
};

use super::super::test_support::*;
#[test]
fn fixed_menus_fit_supported_viewports_with_real_fonts() {
    for size in [
        UVec2::new(960, 540),
        UVec2::new(1280, 720),
        UVec2::new(1920, 1080),
    ] {
        for page in [MenuPage::Main, MenuPage::Pause, MenuPage::Help] {
            let mut app = page_layout_app(size, page);
            let world = app.world_mut();
            let root_children = world
                .query_filtered::<&Children, With<MenuRoot>>()
                .single(world)
                .unwrap();
            let footer = root_children[1];
            let footer_rect = node_rect(
                world.get::<ComputedNode>(footer).unwrap(),
                world.get::<UiGlobalTransform>(footer).unwrap(),
            );
            assert!(
                rect_in_viewport(footer_rect, size.as_vec2()),
                "Footer is outside viewport: {page:?} {size:?} {footer_rect:?}"
            );
            let buttons: Vec<_> = world
                .query::<(&MenuButton, &ComputedNode, &UiGlobalTransform)>()
                .iter(world)
                .map(|(button, node, transform)| {
                    (button.action, node.size(), node_rect(node, transform))
                })
                .collect();
            assert_eq!(buttons.len(), if page == MenuPage::Help { 1 } else { 4 });
            for (action, dimensions, rect) in buttons {
                assert!(dimensions.x > 0.0 && dimensions.y > 0.0);
                assert!(
                    rect_in_viewport(rect, size.as_vec2()) && rect.max.y <= footer_rect.min.y + 1.0,
                    "Button overlaps footer or viewport: {page:?} {size:?} {action:?} {rect:?}"
                );
            }
            let invalid: Vec<_> = world
                .query::<(
                    Entity,
                    &Text,
                    &ComputedNode,
                    &UiGlobalTransform,
                    &TextLayoutInfo,
                )>()
                .iter(world)
                .filter(|(entity, text, node, transform, glyphs)| {
                    !text.0.is_empty()
                        && (node.size().x <= 0.0
                            || node.size().y <= 0.0
                            || glyphs.glyphs.is_empty()
                            || !rect_in_viewport(node_rect(node, transform), size.as_vec2())
                            || (page == MenuPage::Help
                                && (glyphs.size.x > node.size().x + 1.0
                                    || glyphs.size.y > node.size().y + 1.0
                                    || (!descends_from(world, *entity, footer)
                                        && node_rect(node, transform).max.y
                                            > footer_rect.min.y + 1.0))))
                })
                .map(|(_, text, node, transform, glyphs)| {
                    (
                        text.0.clone(),
                        node_rect(node, transform),
                        glyphs.glyphs.len(),
                        glyphs.size,
                    )
                })
                .collect();
            assert!(
                invalid.is_empty(),
                "Text needs visible layout: {page:?} {size:?} {invalid:?}"
            );
            if page == MenuPage::Help {
                let back_rect = world
                    .query::<(&MenuButton, &ComputedNode, &UiGlobalTransform)>()
                    .iter(world)
                    .find(|(button, _, _)| button.action == UiAction::Back)
                    .map(|(_, node, transform)| node_rect(node, transform))
                    .unwrap();
                for paragraph in [
                    "Move relative to the camera. Build up speed, coast to a stop, and jump while grounded.",
                    "Get close to a parcel with a clear path. Hold it with physics, then release it to let gravity do the rest.",
                    "Use the mouse to look around in first-person. Press Esc to pause and resume.",
                ] {
                    let (_, node, transform, parent) = world
                        .query::<(&Text, &ComputedNode, &UiGlobalTransform, &ChildOf)>()
                        .iter(world)
                        .find(|(text, _, _, _)| text.0 == paragraph)
                        .expect("Help must retain each complete instruction paragraph");
                    let text_rect = node_rect(node, transform);
                    let card_rect = node_rect(
                        world.get::<ComputedNode>(parent.parent()).unwrap(),
                        world.get::<UiGlobalTransform>(parent.parent()).unwrap(),
                    );
                    assert!(
                        text_rect.min.x >= card_rect.min.x - 1.0
                            && text_rect.max.x <= card_rect.max.x + 1.0
                            && text_rect.min.y >= card_rect.min.y - 1.0
                            && text_rect.max.y <= card_rect.max.y + 1.0
                            && card_rect.max.y <= back_rect.min.y + 1.0,
                        "Help paragraph overflows its card: {size:?} {paragraph} {text_rect:?} {card_rect:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn fixed_menus_ignore_wheel_and_focus_scrolling() {
    for page in [MenuPage::Main, MenuPage::Pause, MenuPage::Help] {
        let mut app = page_layout_app(UVec2::new(960, 540), page);
        app.add_systems(Update, scroll_focused_button);
        let buttons: Vec<_> = app
            .world_mut()
            .query::<(Entity, &MenuButton)>()
            .iter(app.world())
            .map(|(entity, button)| (entity, button.index))
            .collect();
        let before: Vec<_> = buttons
            .iter()
            .map(|(entity, _)| {
                (
                    *entity,
                    *app.world().get::<UiGlobalTransform>(*entity).unwrap(),
                )
            })
            .collect();
        for (entity, index) in buttons {
            wheel_over(&mut app, entity, MouseScrollUnit::Line, -10.0);
            wheel_over(&mut app, entity, MouseScrollUnit::Pixel, 100.0);
            app.world_mut().resource_mut::<MenuFocus>().0 = index;
            app.update();
        }
        let world = app.world_mut();
        assert_eq!(world.query::<&MenuScroll>().iter(world).count(), 0);
        assert_eq!(world.query::<&Scrollbar>().iter(world).count(), 0);
        // Node 自动要求 ScrollPosition，因此验证零偏移而非断言组件不存在。
        assert!(
            world
                .query::<(&Node, &ScrollPosition, &ComputedNode)>()
                .iter(world)
                .all(|(node, position, computed)| {
                    node.overflow.y != OverflowAxis::Scroll
                        && position.0 == Vec2::ZERO
                        && computed.scroll_position == Vec2::ZERO
                })
        );
        for (entity, transform) in before {
            assert_eq!(*world.get::<UiGlobalTransform>(entity).unwrap(), transform);
        }
    }
}

#[test]
fn settings_panel_scrolls_without_moving_the_page_or_fixed_controls() {
    let mut saw_overflow = false;
    for tab in [
        SettingsTab::Graphics,
        SettingsTab::Audio,
        SettingsTab::Controls,
        SettingsTab::Accessibility,
    ] {
        let mut app = page_layout_app_with_state(
            UVec2::new(960, 540),
            &MenuState {
                page: MenuPage::Settings,
                tab,
                ..default()
            },
        );
        let world = app.world_mut();
        let panel = world
            .query_filtered::<Entity, With<SettingsPanel>>()
            .single(world)
            .unwrap();
        let (area, range) = world
            .query_filtered::<(Entity, &ComputedNode), With<MenuScroll>>()
            .iter(world)
            .map(|(entity, node)| {
                (
                    entity,
                    (node.content_size().y - node.size().y).max(0.0) * node.inverse_scale_factor(),
                )
            })
            .next()
            .unwrap();
        assert!(descends_from(world, area, panel));
        let title = world
            .query::<(Entity, &Text)>()
            .iter(world)
            .find(|(entity, text)| text.0 == "SETTINGS" && descends_from(world, *entity, area))
            .unwrap()
            .0;
        let fixed_nodes: Vec<_> = world
            .query::<(Entity, &ComputedNode, &UiGlobalTransform)>()
            .iter(world)
            .filter(|(entity, _, _)| {
                !descends_from(world, *entity, area)
                    && world.get::<ScrollbarThumb>(*entity).is_none()
            })
            .map(|(entity, _, transform)| (entity, *transform))
            .collect();
        let buttons: Vec<_> = world
            .query::<(Entity, &MenuButton)>()
            .iter(world)
            .map(|(entity, button)| (entity, button.action, button.index))
            .collect();
        let fixed_buttons: Vec<_> = buttons
            .iter()
            .copied()
            .filter(|(_, action, _)| {
                matches!(
                    action,
                    UiAction::SelectTab(_)
                        | UiAction::RestoreDefaults
                        | UiAction::ApplySettings
                        | UiAction::Back
                )
            })
            .collect();
        assert_eq!(fixed_buttons.len(), 7);
        for (entity, _, _) in &fixed_buttons {
            assert!(
                !descends_from(world, *entity, panel),
                "Fixed button belongs outside paper panel"
            );
        }
        let adjustment = buttons
            .iter()
            .copied()
            .filter(|(entity, _, _)| descends_from(world, *entity, area))
            .max_by_key(|(_, _, index)| *index);
        assert_eq!(
            wheel_over(&mut app, title, MouseScrollUnit::Line, -3.0),
            area
        );
        saw_overflow |= range > 0.0;
        assert_eq!(
            app.world().get::<ScrollPosition>(area).unwrap().y,
            96.0_f32.min(range)
        );
        wheel_over(&mut app, title, MouseScrollUnit::Pixel, -100_000.0);
        assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, range);
        app.update();
        let world = app.world_mut();
        let (_, status_node, status_transform) = world
            .query::<(&Text, &ComputedNode, &UiGlobalTransform)>()
            .iter(world)
            .find(|(text, _, _)| text.0 == "Changes are saved only when you choose Apply.")
            .unwrap();
        let status_rect = node_rect(status_node, status_transform);
        let viewport_rect = node_rect(
            world.get::<ComputedNode>(area).unwrap(),
            world.get::<UiGlobalTransform>(area).unwrap(),
        );
        assert!(
            status_rect.min.y >= viewport_rect.min.y - 1.0
                && status_rect.max.y <= viewport_rect.max.y + 1.0,
            "Saving hint must be reachable at panel bottom: {tab:?} {status_rect:?} {viewport_rect:?}"
        );
        let title_rect = node_rect(
            app.world().get::<ComputedNode>(title).unwrap(),
            app.world().get::<UiGlobalTransform>(title).unwrap(),
        );
        if range > 0.0 {
            assert!(
                title_rect.min.y
                    < node_rect(
                        app.world().get::<ComputedNode>(area).unwrap(),
                        app.world().get::<UiGlobalTransform>(area).unwrap()
                    )
                    .min
                    .y,
                "SETTINGS header is part of scrolling panel content"
            );
        }
        for (entity, _, _) in &fixed_buttons {
            wheel_over(&mut app, *entity, MouseScrollUnit::Line, 4.0);
            assert_eq!(
                app.world().get::<ScrollPosition>(area).unwrap().y,
                range,
                "Wheel outside paper panel must not move it: {tab:?}"
            );
        }
        let root = app
            .world_mut()
            .query_filtered::<Entity, With<MenuRoot>>()
            .single(app.world())
            .unwrap();
        wheel_over(&mut app, root, MouseScrollUnit::Line, 4.0);
        assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, range);
        app.add_systems(Update, scroll_focused_button);
        for (_, _, index) in &fixed_buttons {
            app.world_mut().resource_mut::<MenuFocus>().0 = *index;
            app.update();
            assert_eq!(
                app.world().get::<ScrollPosition>(area).unwrap().y,
                range,
                "Fixed button focus must not scroll panel: {tab:?}"
            );
        }
        if let Some((entity, _, index)) = adjustment {
            app.world_mut().resource_mut::<MenuFocus>().0 = index;
            app.update();
            let area_rect = node_rect(
                app.world().get::<ComputedNode>(area).unwrap(),
                app.world().get::<UiGlobalTransform>(area).unwrap(),
            );
            let button_rect = node_rect(
                app.world().get::<ComputedNode>(entity).unwrap(),
                app.world().get::<UiGlobalTransform>(entity).unwrap(),
            );
            assert!(
                button_rect.min.y >= area_rect.min.y - 1.0
                    && button_rect.max.y <= area_rect.max.y + 1.0,
                "Setting adjustment must scroll into panel viewport: {tab:?} {button_rect:?} {area_rect:?}"
            );
        }
        wheel_over(&mut app, title, MouseScrollUnit::Pixel, 100_000.0);
        app.update();
        assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, 0.0);
        for (entity, transform) in fixed_nodes {
            assert_eq!(
                *app.world().get::<UiGlobalTransform>(entity).unwrap(),
                transform,
                "Panel scrolling must leave page, sidebar, actions and rail fixed: {tab:?} {entity:?}"
            );
        }
    }
    assert!(saw_overflow, "Long panel must exercise wheel scrolling");
}

#[test]
fn offscreen_setting_focus_scrolls_only_the_paper_panel() {
    let mut app = page_layout_app(UVec2::new(960, 540), MenuPage::Settings);
    let world = app.world_mut();
    let panel = world
        .query_filtered::<Entity, With<SettingsPanel>>()
        .single(world)
        .unwrap();
    // 限制真实面板的内容视口，让已有字段确实越界，不能用已可见字段冒充滚入验证。
    // 这里只改变无窗口布局 fixture，不改变游戏窗口的最小尺寸。
    world.get_mut::<Node>(panel).unwrap().max_height = px(180);
    app.update();
    let world = app.world_mut();
    let area = world
        .query_filtered::<Entity, With<MenuScroll>>()
        .single(world)
        .unwrap();
    let (button, index) = world
        .query::<(Entity, &MenuButton)>()
        .iter(world)
        .find(|(_, button)| button.action == UiAction::Adjust(SettingKey::FrameRate, 1))
        .map(|(entity, button)| (entity, button.index))
        .unwrap();
    let viewport = node_rect(
        world.get::<ComputedNode>(area).unwrap(),
        world.get::<UiGlobalTransform>(area).unwrap(),
    );
    let original_button = node_rect(
        world.get::<ComputedNode>(button).unwrap(),
        world.get::<UiGlobalTransform>(button).unwrap(),
    );
    assert!(
        original_button.max.y > viewport.max.y,
        "Fixture must put setting adjustment below panel viewport"
    );
    let fixed: Vec<_> = world
        .query::<(Entity, &MenuButton, &UiGlobalTransform)>()
        .iter(world)
        .filter(|(entity, _, _)| !descends_from(world, *entity, area))
        .map(|(entity, button, transform)| (entity, button.index, *transform))
        .collect();
    app.add_systems(Update, scroll_focused_button);
    app.world_mut().resource_mut::<MenuFocus>().0 = index;
    app.update();
    let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
    assert!(
        offset > 0.0,
        "Offscreen setting must trigger positive panel scrolling"
    );
    let focused = node_rect(
        app.world().get::<ComputedNode>(button).unwrap(),
        app.world().get::<UiGlobalTransform>(button).unwrap(),
    );
    assert!(
        focused.min.y >= viewport.min.y - 1.0 && focused.max.y <= viewport.max.y + 1.0,
        "Setting adjustment must finish inside panel: {focused:?} {viewport:?}"
    );
    for (entity, index, transform) in fixed {
        assert_eq!(
            *app.world().get::<UiGlobalTransform>(entity).unwrap(),
            transform
        );
        app.world_mut().resource_mut::<MenuFocus>().0 = index;
        app.update();
        assert_eq!(
            app.world().get::<ScrollPosition>(area).unwrap().y,
            offset,
            "Fixed menu and action focus must leave panel offset unchanged"
        );
    }
}

#[test]
fn settings_scrollbar_matches_real_overflow_without_covering_content() {
    let mut saw_overflow = false;
    let mut saw_fitting_content = false;
    for size in [
        UVec2::new(960, 540),
        UVec2::new(1280, 720),
        UVec2::new(1920, 1080),
    ] {
        for tab in [
            SettingsTab::Graphics,
            SettingsTab::Audio,
            SettingsTab::Controls,
            SettingsTab::Accessibility,
        ] {
            let mut app = page_layout_app_with_state(
                size,
                &MenuState {
                    page: MenuPage::Settings,
                    tab,
                    ..default()
                },
            );
            let world = app.world_mut();
            let panel = world
                .query_filtered::<Entity, With<SettingsPanel>>()
                .single(world)
                .unwrap();
            let panel_rect = node_rect(
                world.get::<ComputedNode>(panel).unwrap(),
                world.get::<UiGlobalTransform>(panel).unwrap(),
            );
            assert!(rect_in_viewport(panel_rect, size.as_vec2()));
            let footer = world
                .query_filtered::<&Children, With<MenuRoot>>()
                .single(world)
                .unwrap()[1];
            let footer_rect = node_rect(
                world.get::<ComputedNode>(footer).unwrap(),
                world.get::<UiGlobalTransform>(footer).unwrap(),
            );
            let (track, target, visibility, track_rect) = world
                .query::<(
                    Entity,
                    &Scrollbar,
                    &ComputedNode,
                    &UiGlobalTransform,
                    &Visibility,
                )>()
                .single(world)
                .map(|(entity, scrollbar, node, transform, visibility)| {
                    (
                        entity,
                        scrollbar.target,
                        *visibility,
                        node_rect(node, transform),
                    )
                })
                .unwrap();
            assert!(world.get::<MenuScroll>(target).is_some());
            assert!(descends_from(world, target, panel));
            assert!(descends_from(world, track, panel));
            assert_eq!(world.query::<&MenuScroll>().iter(world).count(), 1);
            for (entity, button, node, transform) in world
                .query::<(Entity, &MenuButton, &ComputedNode, &UiGlobalTransform)>()
                .iter(world)
            {
                if !matches!(
                    button.action,
                    UiAction::SelectTab(_)
                        | UiAction::RestoreDefaults
                        | UiAction::ApplySettings
                        | UiAction::Back
                ) {
                    continue;
                }
                assert!(!descends_from(world, entity, panel));
                let rect = node_rect(node, transform);
                assert!(
                    rect_in_viewport(rect, size.as_vec2()) && rect.max.y <= footer_rect.min.y + 1.0,
                    "Fixed settings controls must fit: {size:?} {tab:?} {:?} {rect:?}",
                    button.action
                );
            }
            let invalid_fixed_text: Vec<_> = world
                .query::<(
                    Entity,
                    &Text,
                    &ComputedNode,
                    &UiGlobalTransform,
                    &TextLayoutInfo,
                )>()
                .iter(world)
                .filter(|(entity, text, node, transform, glyphs)| {
                    !descends_from(world, *entity, target)
                        && !text.0.is_empty()
                        && (node.size().x <= 0.0
                            || node.size().y <= 0.0
                            || glyphs.glyphs.is_empty()
                            || !rect_in_viewport(node_rect(node, transform), size.as_vec2())
                            || (!descends_from(world, *entity, footer)
                                && node_rect(node, transform).max.y > footer_rect.min.y + 1.0))
                })
                .map(|(_, text, node, transform, _)| (text.0.clone(), node_rect(node, transform)))
                .collect();
            assert!(
                invalid_fixed_text.is_empty(),
                "Settings shell text must stay visible: {size:?} {tab:?} {invalid_fixed_text:?}"
            );
            let area_node = world.get::<ComputedNode>(target).unwrap();
            let area_rect = node_rect(area_node, world.get::<UiGlobalTransform>(target).unwrap());
            let overflow = area_node.content_size().y > area_node.size().y + 1.0;
            saw_overflow |= overflow;
            saw_fitting_content |= !overflow;
            assert_eq!(
                visibility,
                if overflow {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                },
                "Scrollbar visibility must follow real content overflow: {size:?} {tab:?}"
            );
            assert!(
                rect_in_viewport(track_rect, size.as_vec2())
                    && track_rect.min.x >= panel_rect.min.x
                    && track_rect.max.x <= panel_rect.max.x
                    && track_rect.min.y >= panel_rect.min.y
                    && track_rect.max.y <= panel_rect.max.y
                    && area_rect.max.x <= track_rect.min.x + 1.0
                    && (area_rect.min.y - track_rect.min.y).abs() <= 1.0
                    && (area_rect.max.y - track_rect.max.y).abs() <= 1.0,
                "Scrollbar must stay inside paper panel beside its content: {size:?} {tab:?} {area_rect:?} {track_rect:?} {panel_rect:?}"
            );
            if overflow {
                let thumb = world
                    .get::<Children>(track)
                    .unwrap()
                    .iter()
                    .find(|child| world.get::<ScrollbarThumb>(*child).is_some())
                    .unwrap();
                let thumb_node = world.get::<ComputedNode>(thumb).unwrap();
                let thumb_rect =
                    node_rect(thumb_node, world.get::<UiGlobalTransform>(thumb).unwrap());
                assert!(
                    thumb_node.size().x > 0.0
                        && thumb_node.size().y > 0.0
                        && thumb_node.size().y < track_rect.height()
                        && thumb_rect.min.x >= track_rect.min.x - 1.0
                        && thumb_rect.max.x <= track_rect.max.x + 1.0
                        && thumb_rect.min.y >= track_rect.min.y - 1.0
                        && thumb_rect.max.y <= track_rect.max.y + 1.0,
                    "Native thumb must fit its visible track: {size:?} {tab:?} {thumb_rect:?} {track_rect:?}"
                );
            }
        }
    }
    assert!(
        saw_overflow,
        "Regression must cover an overflowing Settings page"
    );
    assert!(
        saw_fitting_content,
        "Regression must cover a fitting Settings page"
    );
}

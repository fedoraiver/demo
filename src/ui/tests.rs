//! 菜单、指针、控件与真实字体布局的无窗口回归。

use super::*;
use super::{
    scroll::{MenuScroll, SettingsScrollbar, scroll_focused_button},
    theme::*,
    widgets::*,
};
use bevy::window::PrimaryWindow;

mod test_support {
    //! 真实菜单和字体布局的无窗口夹具，不安装窗口后端、渲染器或音频设备。

    use super::{pages::page_scene, *};
    use crate::{
        audio::{SoundCue, SoundRequest},
        game_flow::GameFlowPlugin,
        settings::GameSettings,
    };
    use bevy::{
        app::{HierarchyPropagatePlugin, PropagateSet},
        asset::{AssetEventSystems, AssetPlugin},
        camera::{ComputedCameraValues, NormalizedRenderTarget, RenderTargetInfo, Viewport},
        input::{mouse::MouseScrollUnit, touch::TouchPhase},
        picking::{
            backend::HitData,
            pointer::{Location, PointerId},
        },
        scene::ScenePlugin,
        state::app::StatesPlugin,
        text::{TextPlugin, detect_text_needs_rerender, load_font_assets_into_font_collection},
        ui::{
            ui_layout_system,
            ui_surface::UiSurface,
            update::propagate_ui_target_cameras,
            widget::{measure_text_system, text_system},
        },
        ui_widgets::ScrollbarPlugin,
    };
    use bevy::{input::InputPlugin, time::TimeUpdateStrategy, window::PrimaryWindow};
    use bevy_enhanced_input::prelude::EnhancedInputPlugin;

    pub(super) fn menu_app() -> App {
        menu_app_with(|_| {})
    }

    pub(super) fn menu_app_with(configure: impl FnOnce(&mut App)) -> App {
        // 使用真实输入、状态调度与 BSN 页面，只生成 ECS 数据，不安装 UI 渲染或窗口后端。
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            AssetPlugin::default(),
            ScenePlugin,
            InputPlugin,
            EnhancedInputPlugin,
            StatesPlugin,
            GameFlowPlugin,
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
        super::register_menu(&mut app);
        app.world_mut().spawn((Window::default(), PrimaryWindow));
        configure(&mut app);
        app.finish();
        app.cleanup();
        app.update();
        app
    }

    pub(super) fn request(app: &mut App, action: UiAction) {
        app.world_mut().write_message(UiRequest { action });
        app.update();
    }

    pub(super) fn drain_sounds(app: &mut App) -> Vec<SoundCue> {
        app.world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .map(|request| request.cue)
            .collect()
    }

    /// 使用真实字体测量与字形布局；虚拟相机只提供尺寸，不安装窗口或渲染器。
    pub(super) fn layout_app(size: UVec2) -> App {
        layout_app_with(size, super::scroll::register)
    }

    /// 额外输入和状态插件须在 finish 前注册，仍然不安装窗口后端或渲染器。
    pub(super) fn layout_app_with(size: UVec2, configure: impl FnOnce(&mut App)) -> App {
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            AssetPlugin::default(),
            ScenePlugin,
            TextPlugin,
            ScrollbarPlugin,
            HierarchyPropagatePlugin::<ComputedUiTargetCamera>::new(PostUpdate),
            HierarchyPropagatePlugin::<ComputedUiRenderTargetInfo>::new(PostUpdate),
        ))
        .init_asset::<Image>()
        .init_resource::<UiScale>()
        .init_resource::<UiSurface>()
        .add_systems(
            PostUpdate,
            (
                propagate_ui_target_cameras,
                measure_text_system
                    .after(load_font_assets_into_font_collection)
                    .after(detect_text_needs_rerender),
                ui_layout_system.in_set(bevy::ui::UiSystems::Layout),
                text_system.before(AssetEventSystems),
            )
                .chain(),
        )
        .configure_sets(
            PostUpdate,
            PropagateSet::<ComputedUiTargetCamera>::default()
                .after(propagate_ui_target_cameras)
                .before(measure_text_system),
        )
        .configure_sets(
            PostUpdate,
            PropagateSet::<ComputedUiRenderTargetInfo>::default()
                .after(propagate_ui_target_cameras)
                .before(measure_text_system),
        );
        // PointerTraversal 读取 Option<&Window>；只注册组件元数据即可支持指针冒泡，
        // 否则无窗口 World 的 get_components 会因类型未注册而提前停止遍历。
        app.world_mut().register_component::<Window>();
        app.world_mut().spawn((
            Camera2d,
            IsDefaultUiCamera,
            Camera {
                computed: ComputedCameraValues {
                    target_info: Some(RenderTargetInfo {
                        physical_size: size,
                        scale_factor: 1.0,
                    }),
                    ..default()
                },
                viewport: Some(Viewport {
                    physical_size: size,
                    ..default()
                }),
                ..default()
            },
        ));
        configure(&mut app);
        app.finish();
        app.cleanup();
        app
    }

    /// 直接放入游戏实际字体资产，布局检查不依赖异步加载，也不安装窗口后端。
    pub(super) fn layout_theme(app: &mut App) -> UiTheme {
        let mut fonts = app.world_mut().resource_mut::<Assets<Font>>();
        UiTheme {
            heading: fonts.add(Font::from_bytes(
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/assets/ui/fonts/heading.ttf"
                ))
                .to_vec(),
            )),
            body: fonts.add(Font::from_bytes(
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/assets/ui/fonts/body.ttf"
                ))
                .to_vec(),
            )),
            scale: 1.0,
        }
    }

    pub(super) fn page_layout_app(size: UVec2, page: MenuPage) -> App {
        page_layout_app_with_state(size, &MenuState { page, ..default() })
    }

    pub(super) fn page_layout_app_with_state(size: UVec2, state: &MenuState) -> App {
        let mut app = crate::ui::tests::test_support::layout_app(size);
        let theme = layout_theme(&mut app);
        app.init_resource::<MenuFocus>();
        app.world_mut()
            .spawn_scene(page_scene(
                &theme,
                state,
                &SettingsDraft::default(),
                size.as_vec2(),
            ))
            .unwrap();
        // 字体集合、测量与最终几何均经过实际 UI 调度，不能只检查声明组件。
        for _ in 0..3 {
            app.update();
        }
        app
    }

    pub(super) fn node_rect(node: &ComputedNode, transform: &UiGlobalTransform) -> Rect {
        let center = transform.affine().translation;
        let half_size = node.size() / 2.0;
        Rect {
            min: center - half_size,
            max: center + half_size,
        }
    }

    pub(super) fn rect_in_viewport(rect: Rect, viewport: Vec2) -> bool {
        rect.min.x >= -1.0
            && rect.min.y >= -1.0
            && rect.max.x <= viewport.x + 1.0
            && rect.max.y <= viewport.y + 1.0
    }

    pub(super) fn descends_from(world: &World, mut entity: Entity, ancestor: Entity) -> bool {
        loop {
            if entity == ancestor {
                return true;
            }
            let Some(parent) = world.get::<ChildOf>(entity) else {
                return false;
            };
            entity = parent.parent();
        }
    }

    /// 触发真实的 Bevy 指针滚轮事件，检查事件冒泡到页面区域后的行为。
    pub(super) fn wheel_over(
        app: &mut App,
        target: Entity,
        unit: MouseScrollUnit,
        y: f32,
    ) -> Entity {
        let camera = app
            .world_mut()
            .query_filtered::<Entity, With<Camera>>()
            .single(app.world())
            .unwrap();
        let mut event = PointerScroll {
            entity: target,
            pointer: Pointer::new(
                PointerId::Mouse,
                Location {
                    target: NormalizedRenderTarget::None {
                        width: 960,
                        height: 540,
                    },
                    position: Vec2::new(100.0, 100.0),
                },
            ),
            unit,
            x: 0.0,
            y,
            hit: HitData::new(camera, 0.0, None, None),
            phase: TouchPhase::Moved,
        };
        app.world_mut().trigger_ref(&mut event);
        event.entity
    }

    /// 状态级测试显式提交与原生 Picking 相同的缓冲按下消息；真实命中另由集成回归覆盖。
    pub(super) fn pointer_press(world: &mut World, entity: Entity, button: PointerButton) {
        world.write_message(PointerPress {
            entity,
            pointer: Pointer::new(
                PointerId::Mouse,
                Location {
                    target: NormalizedRenderTarget::None {
                        width: 960,
                        height: 540,
                    },
                    position: Vec2::new(80.0, 80.0),
                },
            ),
            button,
            hit: HitData::new(Entity::PLACEHOLDER, 0.0, None, None),
            count: 1,
        });
    }
}

mod backdrop_tests {
    use crate::game_flow::AppState;
    use crate::ui::backdrop::*;
    use bevy::world_serialization::WorldInstanceReady;
    use bevy::{
        animation::{RepeatAnimation, graph::AnimationNodeType},
        asset::AssetPlugin,
        camera::CameraProjection,
        scene::ScenePlugin,
        state::app::StatesPlugin,
        world_serialization::{WorldAsset, WorldInstanceSpawner},
    };
    use bevy_inspector_egui::bevy_egui::PrimaryEguiContext;

    use super::*;

    /// 用真实 BSN 相机声明验证状态清理，最小 App 不安装窗口后端或渲染器。
    #[test]
    fn leaving_main_menu_removes_backdrop_camera_and_preserves_other_camera() {
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            AssetPlugin::default(),
            ScenePlugin,
            StatesPlugin,
        ))
        .init_state::<AppState>();
        app.update();
        let other_camera = app.world_mut().spawn(Camera3d::default()).id();
        let root = app
            .world_mut()
            .spawn_scene(bsn! {
                MenuBackdrop
                DespawnOnExit::<AppState>(AppState::MainMenu)
                Transform
                Children [
                    @menu_camera()
                ]
            })
            .unwrap()
            .id();
        let menu_camera = app.world().get::<Children>(root).unwrap()[0];
        assert!(app.world().get::<IsDefaultUiCamera>(menu_camera).is_some());
        assert!(app.world().get::<PrimaryEguiContext>(menu_camera).is_some());

        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::InGame);
        app.update();

        assert!(app.world().get_entity(root).is_err());
        assert!(app.world().get_entity(menu_camera).is_err());
        assert!(app.world().get::<Camera3d>(other_camera).is_some());
    }

    /// 无窗口检查具名资产约定，GLB 再导出可以改变排列但不能移除菜单持箱动作。
    #[test]
    fn courier_asset_contains_carry_clip_and_independent_parcel() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
        let bytes = std::fs::read(root.join(COURIER_PATH)).unwrap();
        assert_eq!(&bytes[..4], b"glTF");
        let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let gltf: serde_json::Value = serde_json::from_slice(&bytes[20..20 + json_len]).unwrap();
        assert_eq!(
            gltf["animations"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|animation| animation["name"] == COURIER_ANIMATION)
                .count(),
            1
        );
        assert_eq!(gltf["scenes"].as_array().unwrap().len(), 1);
        assert!(
            gltf["skins"]
                .as_array()
                .is_some_and(|skins| !skins.is_empty())
        );
        assert!(root.join("models/props/prop_parcel_standard.glb").is_file());
    }

    /// 真实 Observer 和图绑定覆盖场景先就绪、父 GLB 后到达，以及动画导出排列变化。
    #[test]
    fn courier_menu_resolves_named_clip_after_scene_and_asset_are_ready() {
        let mut app = App::new();
        // 只安装资产与动画调度，不安装窗口、渲染器或完整游戏。
        app.add_plugins((
            TaskPoolPlugin::default(),
            AssetPlugin::default(),
            AnimationPlugin,
        ))
        .init_resource::<Assets<Gltf>>()
        .init_resource::<Assets<WorldAsset>>()
        .init_resource::<Time>()
        .add_observer(mark_courier_animation_ready)
        .add_systems(Update, play_courier_animation);
        app.finish();
        app.cleanup();
        let gltf_handle = app.world().resource::<Assets<Gltf>>().reserve_handle();
        let carry_clip = app
            .world()
            .resource::<Assets<AnimationClip>>()
            .reserve_handle();
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        let backward_clip = clips.add(AnimationClip::default());
        let walk_clip = clips.add(AnimationClip::default());
        let root = app
            .world_mut()
            .spawn(CourierAnimation {
                gltf: gltf_handle.clone(),
            })
            .id();
        let armature = app.world_mut().spawn(ChildOf(root)).id();
        let player = app
            .world_mut()
            .spawn((AnimationPlayer::default(), ChildOf(armature)))
            .id();
        let world_asset = app
            .world_mut()
            .resource_mut::<Assets<WorldAsset>>()
            .add(WorldAsset::new(World::new()));
        let instance_id = WorldInstanceSpawner::default()
            .spawn_sync(app.world_mut(), world_asset.id())
            .unwrap();
        app.world_mut().trigger(WorldInstanceReady {
            entity: root,
            instance_id,
        });
        app.update();
        assert!(app.world().get::<CourierAnimationPending>(root).is_some());
        assert!(app.world().get::<AnimationGraphHandle>(player).is_none());
        let gltf = Gltf {
            scenes: default(),
            named_scenes: default(),
            meshes: default(),
            named_meshes: default(),
            materials: default(),
            named_materials: default(),
            nodes: default(),
            named_nodes: default(),
            skins: default(),
            named_skins: default(),
            default_scene: None,
            // Carry_Idle 故意排在第三个，不能把索引 0 的倒走片段接到展示角色上。
            animations: vec![backward_clip.clone(), walk_clip.clone(), carry_clip.clone()],
            named_animations: [
                ("Carry_Backward".into(), backward_clip),
                ("Walk".into(), walk_clip),
                (COURIER_ANIMATION.into(), carry_clip.clone()),
            ]
            .into_iter()
            .collect(),
            source: None,
        };
        app.world_mut()
            .resource_mut::<Assets<Gltf>>()
            .insert(gltf_handle.id(), gltf)
            .unwrap();
        app.update();
        assert!(app.world().get::<CourierAnimationPending>(root).is_some());
        assert!(app.world().get::<AnimationGraphHandle>(player).is_none());
        let mut clip = AnimationClip::default();
        clip.set_duration(0.8);
        app.world_mut()
            .resource_mut::<Assets<AnimationClip>>()
            .insert(carry_clip.id(), clip)
            .unwrap();
        app.update();
        assert!(app.world().get::<CourierAnimationPending>(root).is_none());
        assert!(app.world().get::<AnimationPlayer>(root).is_none());
        let graph_handle = app
            .world()
            .get::<AnimationGraphHandle>(player)
            .unwrap()
            .0
            .clone();
        let graph = app
            .world()
            .resource::<Assets<AnimationGraph>>()
            .get(&graph_handle)
            .unwrap();
        let playing = app.world().get::<AnimationPlayer>(player).unwrap();
        let active: Vec<_> = playing.playing_animations().collect();
        assert_eq!(active.len(), 1);
        let (node, active) = active[0];
        assert!(matches!(active.repeat_mode(), RepeatAnimation::Forever));
        let AnimationNodeType::Clip(bound_clip) = &graph[*node].node_type else {
            panic!("Menu courier must play a named animation clip");
        };
        assert_eq!(bound_clip.id(), carry_clip.id());
        // pending 已消费，后续帧不能重复生成动画图或重置正在播放的动作。
        app.update();
        assert_eq!(
            app.world()
                .get::<AnimationGraphHandle>(player)
                .unwrap()
                .0
                .id(),
            graph_handle.id()
        );
        assert_eq!(app.world().resource::<Assets<AnimationGraph>>().len(), 1);
    }

    /// 投影检查只验证固定构图的数学边界，真实光照、遮挡与材质仍由用户验收。
    #[test]
    fn camera_frames_courier_and_station_on_right_at_wide_and_narrow_aspects() {
        let view = camera_transform().to_matrix().inverse();
        for aspect in [16.0 / 9.0, 4.0 / 3.0] {
            let projection = PerspectiveProjection {
                fov: 46.0_f32.to_radians(),
                aspect_ratio: aspect,
                near: 0.1,
                far: 1000.0,
                ..default()
            }
            .get_clip_from_view();
            for point in [
                COURIER_POSITION,
                COURIER_POSITION + Vec3::Y * 1.91,
                STATION_POSITION + Vec3::Y * 2.0,
            ] {
                let clip = projection * view * point.extend(1.0);
                let ndc = clip.truncate() / clip.w;
                assert!(ndc.x > 0.0 && ndc.x < 1.0, "point={point:?}, ndc={ndc:?}");
                assert!(ndc.y.abs() < 1.0, "point={point:?}, ndc={ndc:?}");
            }
        }
    }
}

mod page_layout_tests {
    use super::*;
    use crate::ui::pages::*;
    use bevy::{
        input::mouse::MouseScrollUnit,
        text::TextLayoutInfo,
        ui_widgets::{Scrollbar, ScrollbarThumb},
    };

    use super::test_support::*;
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
                        rect_in_viewport(rect, size.as_vec2())
                            && rect.max.y <= footer_rect.min.y + 1.0,
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
                app.world_mut().resource_mut::<MenuFocus>().index = index;
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
                        (node.content_size().y - node.size().y).max(0.0)
                            * node.inverse_scale_factor(),
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
                app.world_mut().resource_mut::<MenuFocus>().index = *index;
                app.update();
                assert_eq!(
                    app.world().get::<ScrollPosition>(area).unwrap().y,
                    range,
                    "Fixed button focus must not scroll panel: {tab:?}"
                );
            }
            if let Some((entity, _, index)) = adjustment {
                app.world_mut().resource_mut::<MenuFocus>().index = index;
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
        app.world_mut().resource_mut::<MenuFocus>().index = index;
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
            app.world_mut().resource_mut::<MenuFocus>().index = index;
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
                        rect_in_viewport(rect, size.as_vec2())
                            && rect.max.y <= footer_rect.min.y + 1.0,
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
                    .map(|(_, text, node, transform, _)| {
                        (text.0.clone(), node_rect(node, transform))
                    })
                    .collect();
                assert!(
                    invalid_fixed_text.is_empty(),
                    "Settings shell text must stay visible: {size:?} {tab:?} {invalid_fixed_text:?}"
                );
                let area_node = world.get::<ComputedNode>(target).unwrap();
                let area_rect =
                    node_rect(area_node, world.get::<UiGlobalTransform>(target).unwrap());
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
}

mod page_refresh_tests {
    use super::*;
    use crate::ui::pages::*;
    use bevy::{
        input::mouse::MouseScrollUnit,
        state::app::StatesPlugin,
        text::TextLayoutInfo,
        ui_widgets::{Scrollbar, ScrollbarThumb},
    };
    use bevy::{picking::hover::Hovered, ui::Pressed};

    use super::test_support::*;
    fn live_settings_app() -> App {
        let size = UVec2::new(960, 540);
        let mut app = crate::ui::tests::test_support::layout_app_with(size, |app| {
            app.add_plugins((
                bevy::input::InputPlugin,
                bevy_enhanced_input::prelude::EnhancedInputPlugin,
                StatesPlugin,
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
            .write_message(super::super::UiRequest { action });
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
            .find(|(value, _, _, _)| value.key == key)
            .unwrap();
        assert!(node.size().x > 0.0 && node.size().y > 0.0 && !layout.glyphs.is_empty());
        text.0.clone()
    }

    #[test]
    fn frame_rate_clicks_refresh_values_without_resetting_scroll_or_focus() {
        let mut app = live_settings_app();
        // 先建立此字段的真实说明与焦点，按钮调整时不能借重建重新滚入或回到顶部。
        app.world_mut().resource_mut::<MenuFocus>().index = 5;
        app.update();
        let (area, _) = scroll_settings_for_edit(&mut app);
        let identity = settings_identity(&mut app);
        for (direction, expected) in [(1, "90 FPS"), (1, "120 FPS"), (-1, "90 FPS")] {
            let world = app.world_mut();
            let button = world
                .query::<(Entity, &MenuButton)>()
                .iter(world)
                .find(|(_, button)| {
                    button.action == UiAction::Adjust(SettingKey::FrameRate, direction)
                })
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
                app.world().resource::<MenuFocus>().index,
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
        let folder = std::path::PathBuf::from("tmp/ui-scroll-edit-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&folder).unwrap();
        let saved = folder.join("settings.json");
        app.world_mut()
            .insert_resource(crate::settings::SettingsFile {
                path: saved.clone(),
            });
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
            .insert_resource(crate::settings::SettingsFile {
                path: folder.clone(),
            });
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
        app.world_mut().resource_mut::<MenuFocus>().index = 5;
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
        assert_eq!(app.world().resource::<MenuFocus>().index, 5);
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
        let mut app = crate::ui::tests::test_support::layout_app(UVec2::new(1440, 810));
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
}

mod page_structure_tests {
    use super::*;
    use crate::ui::pages::*;
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
            .insert_resource(MenuFocus { index: 5 })
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
        assert_eq!(app.world().resource::<MenuFocus>().index, 5);
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
        app.insert_resource(MenuFocus { index: 1 })
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
        app.world_mut().resource_mut::<MenuFocus>().index = 0;
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
}

mod pointer_tests {
    use super::test_support::{drain_sounds, menu_app as test_app, pointer_press, request};
    use super::*;
    use crate::audio::SoundCue;
    use crate::ui::pointer::*;
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
                        PrimaryPress {
                            pointer: bevy::picking::pointer::PointerId::Mouse,
                        },
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
        assert_eq!(app.world().resource::<MenuFocus>().index, 1);
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
        assert_eq!(app.world().resource::<MenuFocus>().index, 1);
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
        app.world_mut().resource_mut::<MenuFocus>().index = 2;
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
            PrimaryPress {
                pointer: bevy::picking::pointer::PointerId::Mouse,
            },
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
        app.world_mut().resource_mut::<MenuFocus>().index = 4;
        *app.world_mut().resource_mut::<MenuInputSource>() = MenuInputSource::Navigation;

        let action = UiAction::SelectTab(SettingsTab::Graphics);
        let mut hovered = app
            .world_mut()
            .spawn((MenuButton { action, index: 0 }, Hovered(true)))
            .id();
        app.update();
        assert_eq!(app.world().resource::<MenuFocus>().index, 4);
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
            assert_eq!(app.world().resource::<MenuFocus>().index, 4);
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
        assert_eq!(app.world().resource::<MenuFocus>().index, 0);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );

        app.world_mut().resource_mut::<MenuFocus>().index = 4;
        *app.world_mut().resource_mut::<MenuInputSource>() = MenuInputSource::Navigation;
        app.world_mut().entity_mut(hovered).insert((
            Pressed,
            PrimaryPress {
                pointer: bevy::picking::pointer::PointerId::Mouse,
            },
        ));
        pointer_press(app.world_mut(), hovered, PointerButton::Primary);
        app.update();
        assert_eq!(app.world().resource::<MenuFocus>().index, 0);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        let requests: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiRequest>>()
            .drain()
            .map(|request| request.action)
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
        use super::test_support::menu_app_with;
        use bevy::{
            camera::NormalizedRenderTarget,
            input::{
                ButtonState,
                keyboard::{Key, KeyboardInput},
            },
            input_focus::{
                InputDispatchPlugin, InputFocus, InputFocusPlugin,
                pointer_focus::PointerFocusPlugin, tab_navigation::TabIndex,
            },
            picking::{
                backend::HitData,
                pointer::{Location, PointerId},
            },
            ui_widgets::{Activate, ButtonPlugin},
            window::WindowRef,
        };
        #[derive(Resource, Default)]
        struct Activations {
            count: usize,
        }
        let mut app = menu_app_with(|app| {
            app.add_plugins((
                InputFocusPlugin,
                InputDispatchPlugin,
                PointerFocusPlugin,
                ButtonPlugin,
            ))
            .init_resource::<Activations>()
            .add_observer(|_: On<Activate>, mut activations: ResMut<Activations>| {
                activations.count += 1
            });
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
        assert_eq!(app.world().resource::<Activations>().count, 1);
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
        app.world_mut().resource_mut::<MenuFocus>().index = 1;
        key(
            &mut app,
            window,
            KeyCode::Enter,
            ButtonState::Pressed,
            false,
        );
        assert_eq!(app.world().resource::<MenuState>().tab, SettingsTab::Audio);
        assert_eq!(app.world().resource::<Activations>().count, 2);
        let requests: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<UiRequest>>()
            .drain()
            .map(|request| request.action)
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
        assert_eq!(app.world().resource::<Activations>().count, 2);
    }
}

mod requests_tests {
    use super::test_support::{drain_sounds, menu_app as test_app, pointer_press, request};
    use super::*;
    use crate::audio::AudioPreview;
    use crate::game_flow::{AppState, PlayState};
    use crate::ui::navigation::MenuContext;
    use crate::{audio::SoundCue, settings::GameSettings};
    use bevy::ui::Pressed;
    use bevy::window::PrimaryWindow;
    use std::path::PathBuf;
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
            app.world_mut().write_message(UiRequest { action });
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
        app.world_mut().resource_mut::<MenuFocus>().index = index;
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
        app.world_mut().write_message(UiRequest {
            action: UiAction::SetVolume(SettingKey::MasterVolume, 60),
        });
        app.world_mut().write_message(UiRequest {
            action: UiAction::Back,
        });
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
        assert_eq!(app.world().resource::<AudioPreview>().settings, None);
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tmp/ui-settings-tests");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        app.insert_resource(SettingsFile { path: path.clone() });
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
        assert_eq!(
            app.world().resource::<AudioPreview>().settings,
            Some(app.world().resource::<SettingsDraft>().audio)
        );
        request(&mut app, UiAction::ApplySettings);
        let committed = app.world().resource::<GameSettings>().audio;
        assert_eq!(committed.master_volume, 73);
        assert_eq!(committed.sfx_volume, 0);
        assert_eq!(committed.ui_volume, 49);
        assert_eq!(GameSettings::load(&path).audio, committed);
        assert_eq!(
            app.world().resource::<AudioPreview>().settings,
            Some(committed)
        );
        let saved = std::fs::read_to_string(&path).unwrap();

        request(&mut app, UiAction::RestoreDefaults);
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            100
        );
        assert_eq!(app.world().resource::<GameSettings>().audio, committed);
        assert_eq!(
            app.world().resource::<AudioPreview>().settings,
            Some(crate::settings::AudioSettings::default())
        );
        request(&mut app, UiAction::Back);
        assert_eq!(app.world().resource::<SettingsDraft>().audio, committed);
        assert_eq!(app.world().resource::<AudioPreview>().settings, None);
        request(&mut app, UiAction::OpenSettings);
        request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
        request(&mut app, UiAction::Adjust(SettingKey::MasterVolume, -1));
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            68
        );
        // 保存目标改为实际目录，触发可复现的 I/O 失败而不触及用户配置。
        app.insert_resource(SettingsFile { path: directory });
        request(&mut app, UiAction::ApplySettings);
        assert_eq!(app.world().resource::<GameSettings>().audio, committed);
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            68
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
        assert_eq!(
            app.world().resource::<AudioPreview>().settings,
            Some(app.world().resource::<SettingsDraft>().audio)
        );
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
        assert_eq!(app.world().resource::<AudioPreview>().settings, None);
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
        app.world_mut().write_message(UiRequest {
            action: UiAction::TestSfx,
        });
        app.world_mut().write_message(UiRequest {
            action: UiAction::TestSfx,
        });
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
        app.world_mut().write_message(UiRequest {
            action: UiAction::OpenSettings,
        });
        app.world_mut().write_message(UiRequest {
            action: UiAction::OpenHelp,
        });
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
        app.world_mut().entity_mut(old_back).insert(Pressed);
        pointer_press(app.world_mut(), old_back, PointerButton::Primary);
        app.world_mut().write_message(UiRequest {
            action: UiAction::Back,
        });
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
        app.world_mut()
            .insert_resource(SettingsFile { path: path.clone() });
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
        app.world_mut().insert_resource(SettingsFile {
            path: path.parent().unwrap().to_path_buf(),
        });
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
        app.world_mut().resource_mut::<MenuFocus>().index = 1;
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
        let original = app.world().resource::<MenuFocus>().index;
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
        assert_eq!(app.world().resource::<MenuFocus>().index, original);
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

mod scroll_tests {
    use super::test_support::*;
    use super::*;
    use crate::ui::scroll::*;
    use bevy::{
        camera::NormalizedRenderTarget,
        input::{mouse::MouseScrollUnit, touch::TouchPhase},
        picking::{
            backend::HitData,
            pointer::{Location, PointerId},
        },
    };
    use bevy::{
        picking::Pickable,
        ui_widgets::{Scrollbar, ScrollbarDragState, ScrollbarThumb},
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
            let page_size = (area_node.size().y - area_node.scrollbar_size.y)
                * area_node.inverse_scale_factor();
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
                (node_rect(app.world(), thumb).max.y - node_rect(app.world(), track).max.y).abs()
                    < 1.0
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
}

mod volume_tests {
    use super::test_support::pointer_press;
    use super::*;
    use crate::ui::volume::*;
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
            .map(|request| request.action)
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
        assert_eq!(app.world().resource::<MenuFocus>().index, 5);
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
}

mod widgets_tests {
    use super::test_support::*;
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
                .map(|request| request.action)
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
                .map(|request| request.action)
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
        use super::super::{
            MenuFocus, MenuInputSource, MenuPage, MenuState, SettingsTab, UiSystems,
        };
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
            .map(|request| request.action)
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
            app.world_mut().resource_mut::<MenuFocus>().index = 0;
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
}

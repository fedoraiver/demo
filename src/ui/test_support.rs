//! 真实菜单和字体布局的无窗口夹具，不安装窗口后端、渲染器或音频设备。

use super::{pages::page_scene, theme::*, *};
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
    app.world_mut().write_message(UiRequest(action));
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
    let mut app = crate::ui::test_support::layout_app(size);
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
pub(super) fn wheel_over(app: &mut App, target: Entity, unit: MouseScrollUnit, y: f32) -> Entity {
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

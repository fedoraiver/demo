//! 使用原生 BRP 处理器验证消息消费及截图载荷，保持无窗口、无渲染。

use bevy::{
    asset::{AssetPlugin, RenderAssetUsages},
    ecs::message::MessageCursor,
    input::{InputPlugin, mouse::AccumulatedMouseMotion},
    picking::{
        DefaultPickingPlugins,
        pointer::{PointerAction, PointerButton, PointerLocation},
    },
    reflect::TypePath,
    remote::{RemoteMethodSystemId, RemoteMethods},
    render::render_resource::{Extent3d, TextureDimension},
    window::RawHandleWrapper,
};
use serde_json::{Value, json};

use super::*;
use crate::{
    settings::{GameSettings, SettingKey},
    ui::UiAction,
};

fn fixture() -> App {
    let mut app = App::new();
    app.add_plugins(RemotePlugin::default());
    register_types(&mut app);
    app
}

fn primary_window_entity(app: &mut App) -> Entity {
    let world = app.world_mut();
    world
        .query_filtered::<Entity, With<PrimaryWindow>>()
        .single(world)
        .unwrap()
}

fn request(app: &mut App, method: &str, params: Value) -> Value {
    let Some(RemoteMethodSystemId::Instant(handler)) =
        app.world().resource::<RemoteMethods>().get(method).copied()
    else {
        panic!("missing instant BRP method: {method}");
    };
    app.world_mut()
        .run_system_with(handler, Some(params))
        .unwrap()
        .unwrap()
}

fn write_message<T: TypePath>(app: &mut App, value: Value) {
    assert!(
        request(
            app,
            "world.write_message",
            json!({"message": T::type_path(), "value": value}),
        )
        .is_null()
    );
}

#[test]
fn native_reads_game_resources_and_menu_actions() {
    let mut app = fixture();
    app.insert_resource(State::new(AppState::MainMenu))
        .init_resource::<GameSettings>()
        .register_type::<GameSettings>()
        .init_resource::<SettingsDraft>()
        .insert_resource(SessionLogInfo {
            id: "test-id".to_string(),
            path: "logs/test.log".to_string(),
        });
    let button = app
        .world_mut()
        .spawn(MenuButton {
            action: UiAction::Adjust(SettingKey::FrameRate, 1),
            index: 0,
        })
        .id();

    let mut read_resource = |resource: &str| {
        request(
            &mut app,
            "world.get_resources",
            json!({"resource": resource}),
        )["value"]
            .clone()
    };
    assert_eq!(
        read_resource(State::<AppState>::type_path()),
        json!("MainMenu")
    );
    let settings = read_resource(GameSettings::type_path());
    let draft = read_resource(SettingsDraft::type_path());
    assert_eq!(settings["max_fps"], draft["max_fps"]);
    assert_eq!(
        read_resource(SessionLogInfo::type_path()),
        json!({"id": "test-id", "path": "logs/test.log"})
    );
    let component = MenuButton::type_path();
    let button = request(
        &mut app,
        "world.get_components",
        json!({"entity": button, "components": [component], "strict": true}),
    );
    assert_eq!(
        button[component]["action"],
        json!({"Adjust": ["FrameRate", 1]})
    );
}

#[test]
fn synthetic_window_stays_focused_without_a_native_handle_and_closes_through_brp() {
    let mut app = fixture();
    app.add_plugins((MinimalPlugins, input_window_plugin()));
    let entity = primary_window_entity(&mut app);
    let window = app.world().get::<Window>(entity).unwrap();
    assert!(window.focused);
    assert!(!window.visible);
    assert_eq!(window.physical_size(), UVec2::new(1920, 1080));
    assert_eq!(window.resolution.scale_factor(), 1.0);
    assert!(app.world().get::<RawHandleWrapper>(entity).is_none());
    assert!(app.should_exit().is_none());

    write_message::<WindowCloseRequested>(&mut app, json!({"window": entity}));
    app.update();
    app.update();
    assert!(app.world().get_entity(entity).is_err());
    assert_eq!(app.should_exit(), Some(AppExit::Success));
}

#[test]
fn offscreen_camera_target_round_trips_into_a_native_screenshot_after_recreation() {
    let mut app = fixture();
    app.add_plugins((
        MinimalPlugins,
        AssetPlugin::default(),
        input_window_plugin(),
        InputPlugin,
        DefaultPickingPlugins,
    ))
    .init_asset::<Image>();
    register_offscreen_systems(&mut app);
    let camera = app
        .world_mut()
        .spawn((Camera::default(), IsDefaultUiCamera))
        .id();
    let unrelated_camera = app.world_mut().spawn(Camera::default()).id();
    app.update();
    assert_eq!(
        app.world().get::<RenderTarget>(camera).unwrap().as_image(),
        Some(&OFFSCREEN_IMAGE)
    );
    assert!(
        app.world()
            .get::<RenderTarget>(unrelated_camera)
            .unwrap()
            .as_image()
            .is_none()
    );
    let image = app
        .world()
        .resource::<Assets<Image>>()
        .get(&OFFSCREEN_IMAGE)
        .unwrap();
    assert_eq!(image.size(), OFFSCREEN_SIZE);
    assert_eq!(
        image.texture_descriptor.format,
        TextureFormat::Rgba8UnormSrgb
    );
    assert!(
        image
            .asset_usage
            .contains(RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD)
    );

    app.world_mut().entity_mut(camera).despawn();
    let camera = app
        .world_mut()
        .spawn((Camera::default(), IsDefaultUiCamera))
        .id();
    app.update();
    let component = RenderTarget::type_path();
    let target = request(
        &mut app,
        "world.get_components",
        json!({"entity": camera, "components": [component], "strict": true}),
    );
    let spawned = request(
        &mut app,
        "world.spawn_entity",
        json!({"components": {Screenshot::type_path(): target[component]}}),
    );
    let screenshot: Entity = serde_json::from_value(spawned["entity"].clone()).unwrap();
    assert_eq!(
        app.world()
            .get::<Screenshot>(screenshot)
            .unwrap()
            .0
            .as_image(),
        Some(&OFFSCREEN_IMAGE)
    );
}

#[test]
fn reflected_input_reaches_keyboard_camera_and_offscreen_picking_consumers() {
    let mut app = fixture();
    app.add_plugins((
        MinimalPlugins,
        input_window_plugin(),
        InputPlugin,
        DefaultPickingPlugins,
    ))
    .add_systems(First, retarget_mouse.in_set(PickingSystems::PostInput));
    let window = primary_window_entity(&mut app);
    app.update();

    write_message::<KeyboardInput>(
        &mut app,
        json!({
            "key_code": "KeyW",
            "logical_key": {"Character": "w"},
            "state": "Pressed",
            "repeat": false,
            "text": "w",
            "window": window,
        }),
    );
    let position = Vec2::new(120.0, 75.0);
    request(
        &mut app,
        "world.mutate_components",
        json!({
            "entity": window,
            "component": Window::type_path(),
            "path": "internal.physical_cursor_position",
            "value": [120.0, 75.0],
        }),
    );
    write_message::<WindowEvent>(
        &mut app,
        json!({
            "CursorMoved": {"window": window, "position": [120.0, 75.0], "delta": null},
        }),
    );
    write_message::<WindowEvent>(
        &mut app,
        json!({
            "MouseButtonInput": {"window": window, "button": "Left", "state": "Pressed"},
        }),
    );
    write_message::<WindowEvent>(
        &mut app,
        json!({
            "MouseWheel": {"window": window, "unit": "Line", "x": 0.0, "y": -1.0, "phase": "Moved"},
        }),
    );
    write_message::<WindowEvent>(
        &mut app,
        json!({
            "MouseButtonInput": {"window": window, "button": "Left", "state": "Released"},
        }),
    );
    write_message::<MouseMotion>(&mut app, json!({"delta": [12.0, -8.0]}));
    app.update();

    assert!(
        app.world()
            .resource::<ButtonInput<KeyCode>>()
            .pressed(KeyCode::KeyW)
    );
    assert_eq!(
        app.world().resource::<AccumulatedMouseMotion>().delta,
        Vec2::new(12.0, -8.0)
    );
    let keys = request(
        &mut app,
        "world.get_resources",
        json!({"resource": ButtonInput::<KeyCode>::type_path()}),
    );
    assert_eq!(keys["value"]["pressed"], json!(["KeyW"]));
    assert_eq!(
        app.world()
            .get::<Window>(window)
            .unwrap()
            .physical_cursor_position(),
        Some(position)
    );
    let pointer_messages = app.world().resource::<Messages<PointerInput>>();
    let mut cursor = MessageCursor::default();
    let events: Vec<_> = cursor.read(pointer_messages).collect();
    let target = NormalizedRenderTarget::Image(OFFSCREEN_IMAGE.into());
    assert_eq!(events.len(), 4);
    assert!(
        events
            .iter()
            .all(|event| event.location.position == position && event.location.target == target)
    );
    assert!(matches!(events[0].action, PointerAction::Move { delta } if delta == position));
    assert!(matches!(
        events[1].action,
        PointerAction::Press(PointerButton::Primary)
    ));
    assert!(matches!(
        events[2].action,
        PointerAction::Scroll { y: -1.0, .. }
    ));
    assert!(matches!(
        events[3].action,
        PointerAction::Release(PointerButton::Primary)
    ));
    let world = app.world_mut();
    let location = world
        .query::<&PointerLocation>()
        .single(world)
        .unwrap()
        .location()
        .unwrap();
    assert_eq!(location.target, target);
}

#[test]
fn native_screenshot_observer_serializes_matching_entity_and_pixel_data() {
    let mut app = fixture();
    let Some(RemoteMethodSystemId::Watching(observe)) = app
        .world()
        .resource::<RemoteMethods>()
        .get("world.observe+watch")
        .copied()
    else {
        panic!("missing native event observer");
    };
    let subscription = json!({"event": ScreenshotCaptured::type_path()});
    assert!(
        app.world_mut()
            .run_system_with(observe, Some(subscription.clone()))
            .unwrap()
            .unwrap()
            .is_none()
    );

    let spawned = request(
        &mut app,
        "world.spawn_entity",
        json!({
            "components": {Screenshot::type_path(): {"Window": "Primary"}},
        }),
    );
    let entity: Entity = serde_json::from_value(spawned["entity"].clone()).unwrap();
    assert!(matches!(
        app.world().get::<Screenshot>(entity).unwrap().0,
        bevy::camera::RenderTarget::Window(bevy::window::WindowRef::Primary)
    ));

    // 在真实事件边界代入回读图像，验证原生观察器可以完整传输尺寸和像素。
    let pixels = [1, 2, 3, 255, 80, 90, 100, 255];
    let image = Image::new(
        Extent3d {
            width: 2,
            height: 1,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        pixels.to_vec(),
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::MAIN_WORLD,
    );
    app.world_mut()
        .trigger(ScreenshotCaptured { entity, image });
    let events = app
        .world_mut()
        .run_system_with(observe, Some(subscription))
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(events[0]["entity"], spawned["entity"]);
    let image = &events[0]["image"];
    assert_eq!(image["data"], json!(pixels));
    let descriptor = &image["texture_descriptor"];
    assert_eq!(descriptor["size"]["width"], 2);
    assert_eq!(descriptor["size"]["height"], 1);
    assert_eq!(descriptor["format"], "rgba8unorm-srgb");
}

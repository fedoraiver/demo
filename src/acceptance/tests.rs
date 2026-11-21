//! 使用原生 BRP 处理器验证消息消费及截图载荷，保持无窗口、无渲染。

use bevy::{
    asset::RenderAssetUsages,
    ecs::message::MessageCursor,
    input::InputPlugin,
    picking::{
        DefaultPickingPlugins,
        pointer::{PointerAction, PointerButton, PointerInput},
    },
    reflect::TypePath,
    remote::{RemoteMethodSystemId, RemoteMethods},
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
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
fn reflected_input_reaches_keyboard_and_picking_consumers() {
    let mut app = fixture();
    app.add_plugins((
        MinimalPlugins,
        WindowPlugin::default(),
        InputPlugin,
        DefaultPickingPlugins,
    ));
    let window = {
        let world = app.world_mut();
        world
            .query_filtered::<Entity, With<PrimaryWindow>>()
            .single(world)
            .unwrap()
    };
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
    app.update();

    assert!(
        app.world()
            .resource::<ButtonInput<KeyCode>>()
            .pressed(KeyCode::KeyW)
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
    assert!(
        MessageCursor::default()
            .read(pointer_messages)
            .any(|event| {
                event.location.position == position
                    && matches!(event.action, PointerAction::Press(PointerButton::Primary))
            })
    );
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

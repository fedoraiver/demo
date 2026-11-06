//! 直接检查灰盒几何、物理身体、真实动作绑定与会话清理，不安装窗口或渲染器。

use std::time::Duration;

use avian3d::prelude::{CollisionLayers, LinearVelocity, Position};
use bevy::{
    asset::AssetPlugin,
    ecs::relationship::Relationship,
    input::{
        ButtonState, InputPlugin,
        keyboard::{Key, KeyboardInput},
    },
    scene::ScenePlugin,
    state::app::StatesPlugin,
    time::TimeUpdateStrategy,
    window::{CursorOptions, PrimaryWindow},
};
use bevy_enhanced_input::prelude::EnhancedInputPlugin;

use super::*;
use crate::{
    character::CharacterPlugin,
    first_person::{ControlsCharacter, FirstPersonPlugin},
    game_flow::GameFlowPlugin,
    item_interaction::{HeldBy, HeldTarget, ItemInteractionPlugin},
    physics::{GamePhysicsLayer, GamePhysicsPlugin},
};

fn scene_app(with_states: bool) -> App {
    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins,
        AssetPlugin::default(),
        ScenePlugin,
        TransformPlugin,
        InputPlugin,
        EnhancedInputPlugin,
    ))
    .init_asset::<Mesh>()
    .init_asset::<StandardMaterial>()
    .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO))
    .insert_resource(Time::<Fixed>::from_hz(60.0))
    .add_plugins((
        GamePhysicsPlugin,
        CharacterPlugin,
        ItemInteractionPlugin,
        FirstPersonPlugin,
        SceneAssemblyPlugin,
    ));
    if with_states {
        app.add_plugins((StatesPlugin, GameFlowPlugin));
    } else {
        crate::game_flow::configure_feature_order(&mut app);
    }
    // Window 仅提供捕获与动作路由所需的 ECS 数据，不安装窗口后端。
    app.world_mut().spawn((
        Name::new("Test input window"),
        Window {
            focused: true,
            ..default()
        },
        CursorOptions::default(),
        PrimaryWindow,
    ));
    app.finish();
    app.cleanup();
    app
}

fn fixed_steps(app: &mut App, count: usize) {
    app.insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
    for _ in 0..count {
        app.update();
    }
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
}

fn change_state(app: &mut App, state: AppState) {
    app.world_mut()
        .resource_mut::<NextState<AppState>>()
        .set(state);
    app.update();
}

fn key(app: &mut App, state: ButtonState) {
    let window = app
        .world_mut()
        .query_filtered::<Entity, With<PrimaryWindow>>()
        .single(app.world())
        .unwrap();
    app.world_mut().write_message(KeyboardInput {
        key_code: KeyCode::KeyE,
        logical_key: Key::Character("e".into()),
        state,
        text: None,
        repeat: false,
        window,
    });
}

#[test]
fn startup_spawns_complete_geometry_bodies_and_controller_without_external_assets() {
    let mut app = scene_app(false);
    app.world_mut().resource_mut::<PrototypeConfig>().ground_y = 2.0;
    app.update();
    let world = app.world_mut();
    let config = world.resource::<PrototypeConfig>().clone();
    let (character, character_pose, body, _) = world
        .query_filtered::<(Entity, &Transform, &RigidBody, &Collider), With<Character>>()
        .single(world)
        .unwrap();
    assert_eq!(*body, RigidBody::Dynamic);
    assert_eq!(
        character_pose.translation.y,
        config.ground_y + PLAYER_SPAWN_LIFT_M
    );
    let (controlled, controlled_camera) = world
        .query::<(&ControlsCharacter, &ControlsCamera)>()
        .single(world)
        .unwrap();
    assert_eq!(controlled.character, character);
    let camera = world
        .get::<FirstPersonCamera>(controlled_camera.camera)
        .unwrap();
    assert_eq!(camera.target, character);
    assert!(
        world
            .get::<IsDefaultUiCamera>(controlled_camera.camera)
            .is_some()
    );

    let (ground_pose, ground_collider, ground_mesh, layers) = world
        .query_filtered::<(&Transform, &Collider, &Mesh3d, &CollisionLayers), With<RigidBody>>()
        .iter(world)
        .find(|(_, _, _, layers)| layers.memberships.has_all(GamePhysicsLayer::World))
        .unwrap();
    let bounds = ground_collider.shape_scaled().compute_local_aabb();
    assert!((ground_pose.translation.y + bounds.maxs.y - config.ground_y).abs() < 0.001);
    assert!((bounds.extents().x - GROUND_SIZE_M).abs() < 0.001);
    assert!((bounds.extents().z - GROUND_SIZE_M).abs() < 0.001);
    assert_eq!(*layers, world_collision_layers());
    assert!(
        world
            .resource::<Assets<Mesh>>()
            .get(&ground_mesh.0)
            .is_some()
    );

    let items: Vec<_> = world
        .query_filtered::<(&Transform, &Collider, &RigidBody, &Mesh3d), With<Pickable>>()
        .iter(world)
        .collect();
    assert_eq!(items.len(), 3);
    for (pose, collider, body, mesh) in items {
        assert_eq!(*body, RigidBody::Dynamic);
        let bounds = collider.shape_scaled().compute_local_aabb();
        assert!((bounds.extents().x - 0.6).abs() < 0.001);
        assert!((pose.translation.y + bounds.mins.y - config.ground_y).abs() < 0.001);
        assert!(world.resource::<Assets<Mesh>>().get(&mesh.0).is_some());
    }
    assert_eq!(world.query::<&DirectionalLight>().iter(world).count(), 1);
    assert_eq!(world.query::<&Camera3d>().iter(world).count(), 1);
    for name in world.query::<&Name>().iter(world) {
        assert!(!name.as_str().is_empty());
    }
}

#[test]
fn default_scene_settles_on_ground_and_real_e_binding_picks_up_and_releases_nearest_cube() {
    let mut app = scene_app(false);
    app.update();
    fixed_steps(&mut app, 90);
    let character = app
        .world_mut()
        .query_filtered::<Entity, With<Character>>()
        .single(app.world())
        .unwrap();
    let pose = app.world().get::<Position>(character).unwrap();
    assert!(
        pose.y.abs() < 0.05,
        "Player must stand on the generated ground"
    );
    assert!(
        app.world()
            .get::<CharacterMotion>(character)
            .unwrap()
            .grounded
    );
    for position in app
        .world_mut()
        .query_filtered::<&Position, With<Item>>()
        .iter(app.world())
    {
        assert!((position.y - 0.3).abs() < 0.05);
    }

    key(&mut app, ButtonState::Pressed);
    fixed_steps(&mut app, 45);
    let (item, held) = app
        .world_mut()
        .query::<(Entity, &HeldBy)>()
        .single(app.world())
        .unwrap();
    assert_eq!(held.get(), character);
    assert!(app.world().get::<HeldTarget>(item).is_some());
    // 默认持物姿态须落在实际相机的竖直视锥内，避免替换模型后只剩箱顶可见。
    let (camera_pose, projection) = app
        .world_mut()
        .query_filtered::<(&Transform, &Projection), With<FirstPersonCamera>>()
        .single(app.world())
        .unwrap();
    let Projection::Perspective(projection) = projection else {
        panic!("The first-person camera must use perspective projection");
    };
    let center = camera_pose
        .compute_affine()
        .inverse()
        .transform_point3(app.world().get::<Transform>(item).unwrap().translation);
    assert!(center.z < 0.0);
    assert!(center.y.abs() < -center.z * (projection.fov * 0.5).tan());
    key(&mut app, ButtonState::Released);
    fixed_steps(&mut app, 1);
    key(&mut app, ButtonState::Pressed);
    fixed_steps(&mut app, 1);
    assert!(app.world().get::<HeldBy>(item).is_none());
    assert!(app.world().get::<HeldTarget>(item).is_none());
    assert_eq!(
        app.world().get::<RigidBody>(item),
        Some(&RigidBody::Dynamic)
    );
    assert!(app.world().get::<LinearVelocity>(item).is_some());
}

#[test]
fn pause_retains_session_and_return_to_menu_cleans_all_session_entities_before_restart() {
    let mut app = scene_app(true);
    app.update();
    assert_eq!(
        app.world_mut()
            .query::<&Character>()
            .iter(app.world())
            .count(),
        0
    );
    assert_eq!(
        app.world_mut()
            .query::<&Camera3d>()
            .iter(app.world())
            .count(),
        0
    );
    change_state(&mut app, AppState::Running);
    let session: Vec<_> = app
        .world_mut()
        .query_filtered::<Entity, With<DespawnOnEnter<AppState>>>()
        .iter(app.world())
        .collect();
    assert_eq!(session.len(), 8);
    let entity_count = app.world().entities().len();
    change_state(&mut app, AppState::Paused);
    change_state(&mut app, AppState::Running);
    assert_eq!(app.world().entities().len(), entity_count);
    for &entity in &session {
        assert!(app.world().get_entity(entity).is_ok());
    }

    change_state(&mut app, AppState::MainMenu);
    for entity in session {
        assert!(app.world().get_entity(entity).is_err());
    }
    assert_eq!(
        app.world_mut()
            .query::<&Character>()
            .iter(app.world())
            .count(),
        0
    );
    assert_eq!(
        app.world_mut().query::<&Item>().iter(app.world()).count(),
        0
    );
    change_state(&mut app, AppState::Running);
    assert_eq!(
        app.world_mut()
            .query::<&Character>()
            .iter(app.world())
            .count(),
        1
    );
    assert_eq!(
        app.world_mut().query::<&Item>().iter(app.world()).count(),
        3
    );
    assert_eq!(
        app.world_mut()
            .query::<&Camera3d>()
            .iter(app.world())
            .count(),
        1
    );
    assert_eq!(app.world().entities().len(), entity_count);
}

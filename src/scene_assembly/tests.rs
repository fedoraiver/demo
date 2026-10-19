//! 加载真实资产、BSN 和层级，并用最小 Avian 调度检查世界碰撞；不安装窗口和渲染器。

use std::time::{Duration, Instant};

use avian3d::prelude::{
    AngularVelocity, ColliderAabb, ColliderOf, CollisionLayers, ContactGraph, LinearVelocity,
    NoTranslationEasing, PhysicsTime, Position, RayHitData, Rotation, ShapeCastConfig,
    ShapeHitData, Sleeping, SpatialQuery, SpatialQueryFilter,
};
use bevy::{
    animation::{AnimationPlugin, RepeatAnimation, graph::AnimationNodeType},
    asset::AssetPlugin,
    camera::visibility::{InheritedVisibility, VisibilityPlugin},
    ecs::system::SystemState,
    gltf::GltfPlugin,
    input::{InputPlugin, mouse::MouseMotion},
    mesh::{MeshPlugin, skinning::SkinnedMesh},
    scene::ScenePlugin,
    time::TimeUpdateStrategy,
    window::{CursorOptions, PrimaryWindow},
    world_serialization::{WorldInstance, WorldSerializationPlugin},
};
use bevy_enhanced_input::prelude::{EnhancedInputPlugin, InputContextAppExt};

use super::*;
use crate::{
    character::CharacterPlugin, item_interaction::ItemInteractionPlugin, physics::GamePhysicsPlugin,
};
use crate::{
    character_animation::CharacterAnimationPlugin,
    first_person::ControlsCharacter,
    first_person::GameplayContext,
    first_person::{ControlsCamera, FirstPersonPlugin},
    item_interaction::HeldAttachment,
    item_interaction::{HeldBy, HeldTarget},
    physics::GamePhysicsLayer,
};

fn asset_app() -> App {
    build_asset_app(false, None, false)
}

fn physics_asset_app() -> App {
    build_asset_app(true, None, false)
}

fn build_asset_app(with_physics: bool, asset_path: Option<String>, with_session: bool) -> App {
    build_asset_app_with_camera(with_physics, asset_path, with_session, false)
}

fn build_asset_app_with_camera(
    with_physics: bool,
    asset_path: Option<String>,
    with_session: bool,
    with_camera: bool,
) -> App {
    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins,
        AssetPlugin {
            file_path: asset_path
                .unwrap_or_else(|| format!("{}/assets", env!("CARGO_MANIFEST_DIR"))),
            ..default()
        },
        WorldSerializationPlugin,
        ScenePlugin,
        MeshPlugin,
        GltfPlugin::default(),
        TransformPlugin,
        VisibilityPlugin,
        AnimationPlugin,
        InputPlugin,
        EnhancedInputPlugin,
    ))
    .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO))
    .init_resource::<PrototypeConfig>()
    .add_plugins((CharacterAnimationPlugin, SceneAssemblyPlugin));
    if !with_camera {
        app.add_input_context::<GameplayContext>();
    }
    if with_session {
        app.add_plugins(crate::game_flow::GameFlowPlugin)
            .init_resource::<Time<avian3d::prelude::Physics>>();
    }
    if with_physics {
        // 加载过程不推进固定步；不装落水恢复，穿地失败不能被回出生点掩盖。
        // 显式安装运动、物理和交互，坡道回归使用实际控制力。
        app.add_plugins((GamePhysicsPlugin, CharacterPlugin, ItemInteractionPlugin))
            .insert_resource(Time::<Fixed>::from_hz(60.0));
    } else if with_session {
        // 会话测试也注册角色意图的暂停清理；保持零固定步，不引入物理解算或设备控制。
        app.add_plugins(CharacterPlugin);
    }
    if with_camera {
        app.add_plugins(FirstPersonPlugin);
        // Window 只作为捕获与 Enhanced Input 所需的 ECS 数据，不安装原生窗口后端或渲染器。
        app.world_mut().spawn((
            Window {
                focused: true,
                ..default()
            },
            CursorOptions::default(),
            PrimaryWindow,
        ));
    }
    crate::game_flow::configure_feature_order(&mut app);
    app.finish();
    app.cleanup();
    app
}

/// 每次 update 只推进一个真实固定步，断言前不补跑姿态或碰撞同步系统。
fn fixed_steps(app: &mut App, count: usize) {
    app.insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
    for _ in 0..count {
        app.update();
    }
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
}

fn source_asset_entity(world: &mut World, source_asset: &str) -> Entity {
    world
        .query::<(Entity, &GltfExtras)>()
        .iter(world)
        .find_map(|(entity, extras)| {
            serde_json::from_str::<MapAsset>(&extras.value)
                .ok()
                .filter(|asset| asset.source_asset == source_asset)
                .map(|_| entity)
        })
        .expect("Expected an imported source asset")
}

fn static_collider_child(world: &World, parent: Entity) -> Entity {
    world
        .get::<Children>(parent)
        .unwrap()
        .into_iter()
        .copied()
        .find(|&entity| world.get::<IslandCollider>(entity).is_some())
        .expect("Expected a static collider child")
}

/// 核对真实 NPC 导入根与唯一碰撞子体，防止展示层级再次漏装或重复装配碰撞。
fn assert_npc_colliders(world: &mut World) -> Vec<Entity> {
    let config = world.resource::<PrototypeConfig>().clone();
    let npcs: Vec<_> = world
        .query_filtered::<Entity, With<DisplayNpc>>()
        .iter(world)
        .collect();
    assert_eq!(npcs.len(), 4);
    let mut colliders = Vec::new();
    for (asset, position, yaw) in [
        (
            "chr_dispatcher",
            Vec3::new(-10.2, 0.72, -2.75),
            std::f32::consts::PI,
        ),
        (
            "chr_pizza_clerk",
            Vec3::new(3.0, 0.9, -10.8),
            std::f32::consts::PI,
        ),
        (
            "chr_music_clerk",
            Vec3::new(13.7, 0.72, -0.8),
            std::f32::consts::PI,
        ),
        ("chr_resident", Vec3::new(7.5, 0.0, 3.0), -1.9),
    ] {
        let npc = source_asset_entity(world, asset);
        assert!(npcs.contains(&npc));
        let pose = world.get::<Transform>(npc).unwrap();
        assert!(pose.translation.abs_diff_eq(position, 0.001));
        assert!(pose.rotation.dot(Quat::from_rotation_y(yaw)).abs() > 0.9999);
        assert!(pose.scale.abs_diff_eq(Vec3::ONE, 0.001));
        let global = *world.get::<GlobalTransform>(npc).unwrap();
        let descendants: Vec<_> = world
            .query::<&Children>()
            .query(world)
            .iter_descendants(npc)
            .collect();
        let npc_colliders: Vec<_> = descendants
            .iter()
            .copied()
            .filter(|&entity| world.get::<Collider>(entity).is_some())
            .collect();
        assert_eq!(
            npc_colliders.len(),
            1,
            "NPC {asset} needs one body collider"
        );
        let collider_entity = npc_colliders[0];
        colliders.push(collider_entity);
        assert!(world.get::<IslandCollider>(collider_entity).is_some());
        assert_eq!(world.get::<ChildOf>(collider_entity).unwrap().parent(), npc);
        assert_eq!(
            world.get::<RigidBody>(collider_entity),
            Some(&RigidBody::Static)
        );
        assert_eq!(
            world.get::<CollisionLayers>(collider_entity),
            Some(&world_collision_layers())
        );
        assert_eq!(
            *world.get::<Transform>(collider_entity).unwrap(),
            Transform::IDENTITY
        );
        assert!(
            world
                .get::<GlobalTransform>(collider_entity)
                .unwrap()
                .affine()
                .abs_diff_eq(global.affine(), 0.001)
        );
        assert!(world.get::<RigidBody>(npc).is_none());
        assert!(world.get::<Collider>(npc).is_none());

        let compound = world
            .get::<Collider>(collider_entity)
            .unwrap()
            .shape()
            .as_compound()
            .expect("NPC body must use a capsule with its feet at the imported origin");
        assert_eq!(compound.shapes().len(), 1);
        let (offset, shape) = &compound.shapes()[0];
        let capsule = shape.as_capsule().expect("NPC body must remain a capsule");
        assert!((capsule.radius - config.character_radius).abs() < 0.001);
        assert!(
            (2.0 * (capsule.half_height() + capsule.radius) - config.character_height).abs()
                < 0.001
        );
        assert!(
            offset
                .translation
                .abs_diff_eq(Vec3::Y * config.character_height * 0.5, 0.001)
        );
        // NPC 只阻挡接触，导入模型及碰撞子体均不取得玩家控制或可搬运能力。
        for entity in std::iter::once(npc).chain(descendants) {
            assert!(world.get::<Character>(entity).is_none());
            assert!(world.get::<CharacterIntent>(entity).is_none());
            assert!(world.get::<CharacterMotion>(entity).is_none());
            assert!(world.get::<Pickable>(entity).is_none());
        }
    }
    colliders
}

/// 只有实际求解出的法向冲量才算撞上 NPC，AABB 重叠或预测接触不能代替阻挡。
fn npc_contact_solved(world: &World, npc_collider: Entity, other: Entity) -> bool {
    world
        .resource::<ContactGraph>()
        .get(npc_collider, other)
        .is_some_and(|(_, pair)| {
            pair.is_touching()
                && pair
                    .manifolds
                    .iter()
                    .any(|manifold| manifold.total_normal_impulse() > 0.001)
        })
}

/// 从已实例化网格读取世界边界，入口目标跟随真实地板位置而不是碰撞楔体的高度。
fn imported_mesh_bounds(world: &mut World, root: Entity, mesh_name: &str) -> (Vec3, Vec3) {
    let descendants: Vec<_> = world
        .query::<&Children>()
        .query(world)
        .iter_descendants(root)
        .collect();
    // glTF 逻辑名称位于父节点；带 Mesh3d 的原语子实体有独立的材质名称。
    let node = world
        .query::<(Entity, &Name)>()
        .iter(world)
        .find(|(entity, name)| descendants.contains(entity) && name.as_str().ends_with(mesh_name))
        .map(|(entity, _)| entity)
        .expect("Expected an imported mesh node");
    let mut mesh_entities = vec![node];
    mesh_entities.extend(
        world
            .query::<&Children>()
            .query(world)
            .iter_descendants(node),
    );
    let primitives: Vec<_> = world
        .query::<(Entity, &Mesh3d, &GlobalTransform)>()
        .iter(world)
        .filter(|(entity, _, _)| mesh_entities.contains(entity))
        .map(|(_, mesh, pose)| (mesh.0.clone(), *pose))
        .collect();
    assert!(!primitives.is_empty(), "Expected imported mesh primitives");
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    let meshes = world.resource::<Assets<Mesh>>();
    for (mesh, pose) in primitives {
        for triangle in meshes.get(&mesh).unwrap().triangles().unwrap() {
            for vertex in triangle.vertices {
                let point = pose.transform_point(vertex);
                min = min.min(point);
                max = max.max(point);
            }
        }
    }
    assert!(min.is_finite() && max.is_finite());
    (min, max)
}

/// 使用真实 Avian 空间索引及世界坐标；物品和人物不会遮住世界支撑面。
fn cast_world_ray(world: &mut World, origin: Vec3, max_distance: f32) -> Option<RayHitData> {
    let mut state = SystemState::<SpatialQuery>::new(world);
    state.get(world).unwrap().cast_ray(
        origin,
        Dir3::NEG_Y,
        max_distance,
        true,
        &SpatialQueryFilter::from_mask(GamePhysicsLayer::World),
    )
}

/// 用覆盖接触面的碰撞形状寻找支撑，避免中心射线漏过木框边缘或地板接缝。
fn cast_world_support(
    world: &mut World,
    collider: &Collider,
    position: Vec3,
    rotation: Quat,
) -> Option<ShapeHitData> {
    let mut state = SystemState::<SpatialQuery>::new(world);
    state.get(world).unwrap().cast_shape(
        collider,
        position + Vec3::Y * 0.1,
        rotation,
        Dir3::NEG_Y,
        &ShapeCastConfig::from_max_distance(0.2),
        &SpatialQueryFilter::from_mask(GamePhysicsLayer::World),
    )
}

fn wait_until(app: &mut App, mut ready: impl FnMut(&mut World) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        app.update();
        assert!(
            *app.world().resource::<ArtLoadState>() != ArtLoadState::Failed,
            "Asset or collider loading failed"
        );
        if ready(app.world_mut()) {
            return;
        }
        assert!(Instant::now() < deadline, "Asset loading timed out");
        std::thread::yield_now();
    }
}

/// 比较实际三角面而不只比较包围体，确保完整建筑结构保留玩法碰撞。
fn triangle_inventory(collider: &Collider) -> BTreeMap<[[i64; 3]; 3], usize> {
    let mesh = collider
        .shape()
        .as_trimesh()
        .expect("Expected an imported triangle collider");
    let mut triangles = BTreeMap::new();
    for triangle in mesh.indices() {
        let points = triangle.map(|index| {
            mesh.vertices()[index as usize]
                .to_array()
                .map(|value| (value * 100_000.0).round() as i64)
        });
        *triangles.entry(points).or_insert(0) += 1;
    }
    triangles
}

/// 对真实形状局部包围盒的八角求水平圆弧极值，得到包含整个连续转向的实体包络。
fn clear_turn_envelope(
    world: &mut World,
    character: Entity,
    parcel: Entity,
    turn: f32,
) -> Vec<Entity> {
    let attachment = *world.get::<HeldAttachment>(parcel).unwrap();
    let collider = world.get::<Collider>(parcel).unwrap();
    let bounds = collider.shape_scaled().compute_local_aabb();
    let origin = world.get::<Position>(character).unwrap().0;
    let rotation = world.get::<Rotation>(character).unwrap().0;
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    for x in [bounds.mins.x, bounds.maxs.x] {
        for y in [bounds.mins.y, bounds.maxs.y] {
            for z in [bounds.mins.z, bounds.maxs.z] {
                // shape_scaled 已包含真实尺度，与生产 ColliderTransform 一样只叠加局部位姿。
                let point = rotation
                    * (attachment.local_pose.translation
                        + attachment.local_pose.rotation * Vec3::new(x, y, z));
                let mut angles = vec![0.0, turn];
                // x/z 的驻点每隔半圈出现；连同两端可覆盖正、反向整段圆弧。
                for angle in [point.z.atan2(point.x), (-point.x).atan2(point.z)] {
                    for half_turn in -2..=2 {
                        let angle = angle + half_turn as f32 * std::f32::consts::PI;
                        if (turn.min(0.0)..=turn.max(0.0)).contains(&angle) {
                            angles.push(angle);
                        }
                    }
                }
                for angle in angles {
                    let point = origin + Quat::from_rotation_y(angle) * point;
                    min = min.min(point);
                    max = max.max(point);
                }
            }
        }
    }
    // 少量向外扩展只覆盖浮点舍入；不缩小真实箱体，也不放宽障碍判断。
    let size = max - min + Vec3::splat(0.00002);
    let envelope = Collider::cuboid(size.x, size.y, size.z);
    let mut query = SystemState::<SpatialQuery>::new(world);
    query.get(world).unwrap().shape_intersections(
        &envelope,
        (min + max) * 0.5,
        Quat::IDENTITY,
        &SpatialQueryFilter::from_excluded_entities([character, parcel, attachment.collider]),
    )
}

/// 失败诊断沿碰撞子体读取导入资产，实体 ID 在不同测试与会话中不能代表固定建筑。
fn island_collider_asset(world: &World, collider: Entity) -> Option<String> {
    let parent = world.get::<ChildOf>(collider)?.parent();
    let extras = world.get::<GltfExtras>(parent)?;
    serde_json::from_str::<MapAsset>(&extras.value)
        .ok()
        .map(|asset| asset.source_asset)
}

/// 检查真实输入返回时的关系、模型和镜头；不靠额外固定步修正本帧姿态。
fn assert_clear_turn_frame(
    app: &mut App,
    character: Entity,
    parcel: Entity,
    camera: Entity,
    visual: Entity,
    visual_local: Transform,
    turn: f32,
    fixed: bool,
) {
    use bevy::ecs::relationship::Relationship;

    let intersections = clear_turn_envelope(app.world_mut(), character, parcel, turn);
    assert!(
        intersections.is_empty(),
        "The complete near-building turn must be clear: model={:?}, holder={:?}, parcel={:?}, turn={turn}, intersections={intersections:?}, obstacle_assets={:?}",
        app.world().get::<ItemModel>(parcel),
        app.world().get::<Position>(character),
        app.world().get::<Position>(parcel),
        intersections
            .iter()
            .map(|&entity| (entity, island_collider_asset(app.world(), entity)))
            .collect::<Vec<_>>(),
    );
    let start_position = app.world().get::<Position>(character).unwrap().0;
    let start_rotation = app.world().get::<Rotation>(character).unwrap().0;
    let attachment = *app.world().get::<HeldAttachment>(parcel).unwrap();
    let collider = app.world().get::<Collider>(parcel).unwrap().clone();
    app.insert_resource(if fixed {
        TimeUpdateStrategy::FixedTimesteps(1)
    } else {
        TimeUpdateStrategy::ManualDuration(Duration::ZERO)
    });
    let before = app.world().resource::<Time<Fixed>>().elapsed();
    let camera_before = app.world().get::<Transform>(camera).unwrap().rotation;
    let sensitivity = app
        .world()
        .resource::<crate::settings::GameSettings>()
        .camera
        .mouse_sensitivity;
    app.world_mut().write_message(MouseMotion {
        delta: Vec2::X * (-turn / sensitivity),
    });
    app.update();
    if app.world().get::<HeldBy>(parcel).map(Relationship::get) != Some(character) {
        // 失败时沿实际阻挡体的导入父级报告资产，不能把运行实体 ID 当成固定地图身份。
        let mut state =
            SystemState::<crate::item_interaction::CarryRotationQuery>::new(app.world_mut());
        let blocker = state.get(app.world()).unwrap().yaw_path_blocker(
            &collider,
            start_position,
            start_rotation,
            turn,
            attachment.local_pose.into(),
            &[character, parcel],
        );
        let source = blocker.and_then(|entity| island_collider_asset(app.world(), entity));
        panic!(
            "A proven clear turn released the parcel: model={:?}, origin={start_position:?}, rotation={start_rotation:?}, turn={turn}, fixed={fixed}, blocker={blocker:?}, source={source:?}",
            app.world().get::<ItemModel>(parcel)
        );
    }
    let world = app.world();
    assert!(
        !world
            .get::<Transform>(camera)
            .unwrap()
            .rotation
            .abs_diff_eq(camera_before, 0.000001),
        "The real mouse action must actually turn the camera"
    );
    assert_eq!(
        world.get::<HeldBy>(parcel).map(Relationship::get),
        Some(character),
        "A proven clear turn must keep the parcel held: turn={turn}, fixed={fixed}"
    );
    let character_pose = world.get::<Transform>(character).unwrap();
    let parcel_pose = world.get::<Transform>(parcel).unwrap();
    let grip = world.get::<CarryGrip>(parcel).unwrap().0;
    assert!(
        parcel_pose
            .translation
            .abs_diff_eq(character_pose.transform_point(grip), 0.0001)
    );
    let expected_visual = GlobalTransform::from(*parcel_pose).mul_transform(visual_local);
    assert!(
        world
            .get::<GlobalTransform>(visual)
            .unwrap()
            .affine()
            .abs_diff_eq(expected_visual.affine(), 0.0001)
    );
    let expected_camera = world
        .get::<FirstPersonCamera>(camera)
        .unwrap()
        .transform(character_pose.translation);
    assert!(
        world
            .get::<Transform>(camera)
            .unwrap()
            .translation
            .abs_diff_eq(expected_camera.translation, 0.0001)
    );
    if fixed {
        assert!(world.resource::<Time<Fixed>>().elapsed() > before);
    } else {
        assert_eq!(world.resource::<Time<Fixed>>().elapsed(), before);
    }
}

#[path = "collision_tests.rs"]
mod collision_tests;

#[path = "turn_tests.rs"]
mod turn_tests;

#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;

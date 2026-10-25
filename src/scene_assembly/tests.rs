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

mod collision_tests {
    //! collision tests 的无窗口回归。

    use super::*;

    #[test]
    fn real_island_buildings_preserve_complete_world_collision_geometry() {
        let mut app = asset_app();
        wait_until(&mut app, |world| {
            world
                .query_filtered::<Entity, With<ActorsSpawned>>()
                .iter(world)
                .count()
                == 1
        });
        let world = app.world_mut();
        for asset in [
            "bld_courier_station",
            "bld_music_shop",
            "bld_pizza_shop",
            "bld_residential_a",
            "bld_residential_b",
        ] {
            let building = source_asset_entity(world, asset);
            let physical = static_collider_child(world, building);
            assert_eq!(
                world.get::<CollisionLayers>(physical),
                Some(&world_collision_layers()),
            );
            let descendants: Vec<_> = world
                .query::<&Children>()
                .query(world)
                .iter_descendants(building)
                .collect();
            assert_eq!(
                descendants
                    .iter()
                    .filter(|&&entity| world.get::<Collider>(entity).is_some())
                    .count(),
                1,
                "Each building needs only its complete world collider: {asset}",
            );
            let mesh_parts: Vec<_> = world
                .query::<(Entity, &Mesh3d)>()
                .iter(world)
                .filter(|(entity, _)| descendants.contains(entity))
                .map(|(entity, mesh)| (entity, mesh.0.clone()))
                .collect();
            // 独立遍历全部真实原语，确认墙体、地板和室内结构都仍包含在玩法碰撞中。
            let mut vertices = Vec::new();
            let mut indices = Vec::new();
            for (entity, mesh) in mesh_parts {
                let mut node = entity;
                let mut transforms = Vec::new();
                while node != building {
                    transforms.push(world.get::<Transform>(node).unwrap().to_matrix());
                    node = world.get::<ChildOf>(node).unwrap().parent();
                }
                let matrix = transforms
                    .into_iter()
                    .rev()
                    .fold(Mat4::IDENTITY, |parent, transform| parent * transform);
                for triangle in world
                    .resource::<Assets<Mesh>>()
                    .get(&mesh)
                    .unwrap()
                    .triangles()
                    .unwrap()
                {
                    let start = vertices.len() as u32;
                    vertices.extend(
                        triangle
                            .vertices
                            .map(|point| matrix.transform_point3(point)),
                    );
                    indices.push([start, start + 1, start + 2]);
                }
            }
            let expected = Collider::try_trimesh_with_config(
                vertices,
                indices,
                TrimeshFlags::MERGE_DUPLICATE_VERTICES | TrimeshFlags::FIX_INTERNAL_EDGES,
            )
            .unwrap();
            assert_eq!(
                triangle_inventory(world.get::<Collider>(physical).unwrap()),
                triangle_inventory(&expected),
                "World collision must contain every building primitive for {asset}",
            );
        }
        for entity in world
            .query_filtered::<Entity, With<IslandCollider>>()
            .iter(world)
        {
            assert_eq!(
                world.get::<CollisionLayers>(entity),
                Some(&world_collision_layers())
            );
        }
    }

    /// 真实站点驻足和行走时对比强制扫掠；相对开销避免把特定机器的 FPS 当成测试条件。
    #[test]
    fn station_character_ccd_avoids_expensive_stationary_and_walking_sweeps() {
        use avian3d::dynamics::solver::SolverDiagnostics;
        use avian3d::prelude::{CcdFilter, SweptCcd};
        let mut app = physics_asset_app();
        wait_until(&mut app, |world| {
            world.query::<&Character>().iter(world).count() == 1
        });
        fixed_steps(&mut app, 120);
        let character = app
            .world_mut()
            .query_filtered::<Entity, With<Character>>()
            .single(app.world())
            .unwrap();
        let configured = *app.world().get::<SweptCcd>(character).unwrap();
        for (activity, axes) in [("stationary", Vec2::ZERO), ("walking", Vec2::X)] {
            let mut measurements = Vec::new();
            for (label, ccd) in [
                ("configured", configured),
                (
                    "eager",
                    SweptCcd::default()
                        .with_filter(CcdFilter::ALL)
                        .with_threshold(0.0),
                ),
            ] {
                let position = Vec3::new(-9.0, 0.73, -1.3);
                {
                    let world = app.world_mut();
                    world.entity_mut(character).remove::<Sleeping>().insert(ccd);
                    world.get_mut::<Position>(character).unwrap().0 = position;
                    world.get_mut::<Transform>(character).unwrap().translation = position;
                    world.get_mut::<LinearVelocity>(character).unwrap().0 = Vec3::ZERO;
                    world
                        .get_mut::<CharacterIntent>(character)
                        .unwrap()
                        .movement = Vec2::ZERO;
                }
                fixed_steps(&mut app, 60);
                let mut ccd_time = Duration::ZERO;
                let mut constraints = 0;
                let mut min_x = f32::INFINITY;
                let mut max_x = f32::NEG_INFINITY;
                let before = Instant::now();
                for step in 0..120 {
                    // 使用实际移动控制力在平台往返，不能只改动画状态假装覆盖行走。
                    app.world_mut()
                        .get_mut::<CharacterIntent>(character)
                        .unwrap()
                        .movement = axes * if step % 60 < 30 { 1.0 } else { -1.0 };
                    fixed_steps(&mut app, 1);
                    let solver = app.world().resource::<SolverDiagnostics>();
                    ccd_time += solver.swept_ccd;
                    constraints += solver.contact_constraint_count;
                    assert!(!app.world().entity(character).contains::<Sleeping>());
                    let position = app.world().get::<Position>(character).unwrap().0;
                    min_x = min_x.min(position.x);
                    max_x = max_x.max(position.x);
                    assert!(
                        position.y > 0.65 && position.y < 0.9,
                        "Character left the platform: {position:?}"
                    );
                }
                eprintln!(
                    "Station CCD comparison: activity={activity}, mode={label}, update_us={}, ccd_us={}",
                    before.elapsed().as_micros() / 120,
                    ccd_time.as_micros() / 120
                );
                if axes != Vec2::ZERO {
                    assert!(
                        max_x - min_x > 1.0,
                        "Walking did not exercise character movement"
                    );
                }
                app.world_mut()
                    .get_mut::<CharacterIntent>(character)
                    .unwrap()
                    .movement = Vec2::ZERO;
                fixed_steps(&mut app, 60);
                // 优化不能靠移除碰撞或掉到沙地绕过计算；采样期间还逐步检查未休眠。
                assert!(constraints > 0);
                assert!(
                    app.world()
                        .get::<CharacterMotion>(character)
                        .unwrap()
                        .grounded
                );
                assert!((app.world().get::<Position>(character).unwrap().y - 0.72).abs() < 0.035);
                measurements.push(ccd_time);
            }
            assert!(measurements[1] > Duration::ZERO);
            assert!(
                measurements[0] < measurements[1] / 4,
                "Character sweeps regressed during {activity}: configured={:?}, eager={:?}",
                measurements[0],
                measurements[1]
            );
        }
    }

    #[test]
    fn real_island_physics_initializes_world_transforms_supports_all_items_and_enters_station() {
        let mut app = physics_asset_app();
        wait_until(&mut app, |world| {
            world
                .query_filtered::<Entity, With<ActorsSpawned>>()
                .iter(world)
                .count()
                == 1
        });
        let world = app.world_mut();
        let character = world
            .query_filtered::<Entity, With<Character>>()
            .single(world)
            .unwrap();
        let papers: Vec<_> = world
            .query::<(Entity, &ItemModel, &SpawnPoint)>()
            .iter(world)
            .filter(|(_, model, _)| **model != ItemModel::WoodenCrate)
            .map(|(entity, _, spawn)| (entity, spawn.0.translation))
            .collect();
        assert_eq!(papers.len(), 2);
        let wooden_crates: Vec<_> = world
            .query::<(Entity, &ItemModel)>()
            .iter(world)
            .filter(|(_, model)| **model == ItemModel::WoodenCrate)
            .map(|(entity, _)| entity)
            .collect();
        assert_eq!(wooden_crates.len(), 3);
        let terrain = source_asset_entity(world, "env_island_terrain");
        let terrain_collider = static_collider_child(world, terrain);
        let station = source_asset_entity(world, "bld_courier_station");
        let station_collider = static_collider_child(world, station);
        let (_, floor_max) = imported_mesh_bounds(world, station, "Floor_board_11");
        assert!((floor_max.y - 0.72).abs() < 0.001);
        assert!((floor_max.z + 0.6).abs() < 0.001);
        let dock = source_asset_entity(world, "env_dock");
        let dock_collider = static_collider_child(world, dock);
        let dock_pose = *world.get::<GlobalTransform>(dock).unwrap();
        assert!(
            dock_pose
                .translation()
                .abs_diff_eq(Vec3::new(-5.0, 0.15, 40.0), 0.001)
        );

        fixed_steps(&mut app, 1);

        let world = app.world_mut();
        let expected_collider_count = world
            .query_filtered::<Entity, With<IslandCollider>>()
            .iter(world)
            .count();
        let mut collider_count = 0;
        for (entity, body, position, rotation, global, collider_of, collider, aabb) in world
            .query_filtered::<(
                Entity,
                &RigidBody,
                &Position,
                &Rotation,
                &GlobalTransform,
                &ColliderOf,
                &Collider,
                &ColliderAabb,
            ), With<IslandCollider>>()
            .iter(world)
        {
            collider_count += 1;
            let (scale, expected_rotation, expected_position) =
                global.to_scale_rotation_translation();
            assert_eq!(*body, RigidBody::Static);
            assert_eq!(collider_of.body, entity);
            assert!(position.0.abs_diff_eq(expected_position, 0.001));
            assert!(rotation.0.dot(expected_rotation).abs() > 0.9999);
            assert!(collider.scale().abs_diff_eq(scale, 0.001));
            assert!(aabb.min.is_finite() && aabb.max.is_finite());
            assert!(aabb.min.cmple(aabb.max).all());
        }
        assert_eq!(collider_count, expected_collider_count);
        assert!(collider_count > 10);
        let terrain_hit = cast_world_ray(world, Vec3::new(-1.8, 4.0, 3.5), 5.0).unwrap();
        assert_eq!(terrain_hit.entity, terrain_collider);
        assert!((terrain_hit.distance - 4.0).abs() < 0.001);
        assert!(terrain_hit.normal.y > 0.99);

        // 码头根有独立世界位移；避开中心系船柱，第 15 块木板顶面为本地 y=-0.04。
        let dock_origin = dock_pose.transform_point(Vec3::new(0.9, 4.0, 4.5));
        let dock_hit = cast_world_ray(world, dock_origin, 5.0).unwrap();
        assert_eq!(dock_hit.entity, dock_collider);
        assert!((dock_hit.distance - 4.04).abs() < 0.001);
        assert!(dock_hit.normal.y > 0.99);
        assert!(
            world
                .get::<Position>(dock_collider)
                .unwrap()
                .0
                .abs_diff_eq(dock_pose.translation(), 0.001)
        );

        // 累计两秒实际求解：初始姿态通过时也必须持续获得地面支撑，不能只看加载结果。
        fixed_steps(&mut app, 119);
        let world = app.world_mut();
        let character_position = world.get::<Position>(character).unwrap().0;
        assert!(character_position.y.abs() < 0.035);
        assert!(world.get::<LinearVelocity>(character).unwrap().0.y.abs() < 0.1);
        let support = cast_world_ray(world, character_position + Vec3::Y * 0.5, 0.6).unwrap();
        assert_eq!(support.entity, terrain_collider);
        for (paper, spawn_position) in papers {
            let position = world.get::<Position>(paper).unwrap().0;
            assert!((position.y - 0.3).abs() < 0.035);
            assert!((position - spawn_position).xz().length() < 0.05);
            assert!(world.get::<LinearVelocity>(paper).unwrap().0.length() < 0.1);
            let support = cast_world_ray(world, position + Vec3::Y * 0.1, 0.5).unwrap();
            assert_eq!(support.entity, terrain_collider);
            assert!(support.normal.y > 0.99);
        }
        let mut settled_wood = Vec::new();
        for wooden_crate in wooden_crates {
            let position = world.get::<Position>(wooden_crate).unwrap().0;
            let rotation = *world.get::<Rotation>(wooden_crate).unwrap();
            let collider = world.get::<Collider>(wooden_crate).unwrap().clone();
            assert!(position.is_finite());
            let support = cast_world_support(world, &collider, position, rotation.0)
                .expect("Wooden crate must have world support under its full shape");
            assert_eq!(
                world.get::<RigidBody>(support.entity),
                Some(&RigidBody::Static)
            );
            assert!(world.get::<IslandCollider>(support.entity).is_some());
            assert!(
                support.normal1.y >= 0.65 && support.distance <= 0.15,
                "Wooden crate must rest on an upward world surface: entity={wooden_crate:?}, hit={support:?}"
            );
            assert!(
                world
                    .get::<LinearVelocity>(wooden_crate)
                    .unwrap()
                    .0
                    .length()
                    < 0.2
            );
            settled_wood.push((wooden_crate, position));
        }
        assert_eq!(
            world
                .query_filtered::<Entity, With<bevy::window::Window>>()
                .iter(world)
                .count(),
            0
        );

        // 复用实际玩家胶囊和控制力，跨过最高踏面与最后 18cm 门槛，再完整站入室内地板。
        let approach = Vec3::new(-9.0, 4.0, 2.2);
        let approach_support = cast_world_ray(world, approach, 5.0).unwrap();
        let start = approach - Vec3::Y * approach_support.distance + Vec3::Y * 0.03;
        assert!(start.y < 0.1);
        world
            .entity_mut(character)
            .insert((
                Position(start),
                Rotation(Quat::IDENTITY),
                Transform::from_translation(start),
                LinearVelocity(Vec3::ZERO),
                NoTranslationEasing,
            ))
            .remove::<Sleeping>();
        world
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        let entry_target_z = floor_max.z - 0.35;
        let minimum_floor_height = floor_max.y - 0.04;
        let mut entered_station = false;
        for _ in 0..90 {
            fixed_steps(&mut app, 1);
            let position = app.world().get::<Position>(character).unwrap().0;
            assert!(position.is_finite() && position.y > -0.05);
            if position.z <= entry_target_z {
                assert!(position.y >= minimum_floor_height);
                assert!((position.x + 9.0).abs() < 0.1);
                entered_station = true;
                break;
            }
        }
        let final_position = app.world().get::<Position>(character).unwrap().0;
        assert!(
            entered_station,
            "Character failed to enter the station floor: position={final_position:?}, target_z={entry_target_z}, minimum_y={minimum_floor_height}"
        );
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::ZERO;
        fixed_steps(&mut app, 30);
        let world = app.world_mut();
        let position = world.get::<Position>(character).unwrap().0;
        assert!(position.z <= entry_target_z);
        assert!(position.y >= minimum_floor_height);
        assert!(world.get::<LinearVelocity>(character).unwrap().0.length() < 0.1);
        // 木地板板间有缝隙，脚底球体能跨缝受支撑，中心射线不能代表角色接地。
        let radius = world.resource::<PrototypeConfig>().character_radius;
        let support = cast_world_support(
            world,
            &Collider::sphere(radius * 0.8),
            position + Vec3::Y * radius,
            Quat::IDENTITY,
        )
        .unwrap_or_else(|| panic!("No indoor support beneath character at {position:?}"));
        assert_eq!(support.entity, station_collider);
        assert!(support.normal1.y >= 0.65);
        assert!(
            (position.y - floor_max.y).abs() < 0.035,
            "Character must settle on the floor: position={position:?}, support={support:?}, floor={floor_max:?}"
        );
        assert!(world.get::<CharacterMotion>(character).unwrap().grounded);
        for (wooden_crate, settled_position) in settled_wood {
            let position = world.get::<Position>(wooden_crate).unwrap().0;
            assert!(position.distance(settled_position) < 0.08);
            assert!(
                world
                    .get::<LinearVelocity>(wooden_crate)
                    .unwrap()
                    .0
                    .length()
                    < 0.2
            );
        }
    }

    #[test]
    fn real_island_npc_blocks_player_control_force_without_moving() {
        let mut app = physics_asset_app();
        wait_until(&mut app, |world| {
            world.query::<&Character>().iter(world).count() == 1
        });
        fixed_steps(&mut app, 1);
        let world = app.world_mut();
        assert_npc_colliders(world);
        let npc = source_asset_entity(world, "chr_resident");
        let npc_collider = static_collider_child(world, npc);
        let npc_position = world.get::<Position>(npc_collider).unwrap().0;
        let npc_rotation = world.get::<Rotation>(npc_collider).unwrap().0;
        let character = world
            .query_filtered::<Entity, With<Character>>()
            .single(world)
            .unwrap();
        let start = npc_position + Vec3::new(0.0, 0.03, 2.0);
        let radius = world.resource::<PrototypeConfig>().character_radius;
        // 从居民前方的实际地形走向身体，使用正常运动控制力，不能靠瞬移到重叠位置验证。
        world
            .entity_mut(character)
            .insert((
                Position(start),
                Rotation(Quat::IDENTITY),
                Transform::from_translation(start),
                LinearVelocity(Vec3::ZERO),
                AngularVelocity(Vec3::ZERO),
                NoTranslationEasing,
            ))
            .remove::<Sleeping>();
        world
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        let mut touched_npc = false;
        for _ in 0..90 {
            fixed_steps(&mut app, 1);
            let world = app.world();
            let position = world.get::<Position>(character).unwrap().0;
            assert!(position.is_finite());
            assert!(
                position.z >= npc_position.z + 2.0 * radius - 0.04,
                "Player crossed the NPC body: {position:?}"
            );
            touched_npc |= npc_contact_solved(world, npc_collider, character);
            assert!(
                world
                    .get::<Position>(npc_collider)
                    .unwrap()
                    .0
                    .abs_diff_eq(npc_position, 0.0001)
            );
            assert!(
                world
                    .get::<Rotation>(npc_collider)
                    .unwrap()
                    .0
                    .dot(npc_rotation)
                    .abs()
                    > 0.99999
            );
        }
        let world = app.world();
        let position = world.get::<Position>(character).unwrap().0;
        assert!(
            touched_npc,
            "Player must make a solved contact with the real NPC collider"
        );
        assert!(
            start.z - position.z > 1.0,
            "Player control force must actually approach the NPC"
        );
        assert!((position.x - npc_position.x).abs() < 0.05);
        assert!(position.z <= npc_position.z + 2.0 * radius + 0.04);
        assert!(world.get::<LinearVelocity>(character).unwrap().0.z.abs() < 0.2);
        assert_npc_colliders(app.world_mut());
    }

    #[test]
    fn real_island_npc_blocks_free_and_actually_held_parcels() {
        use bevy::ecs::relationship::Relationship;

        for (held, model) in [
            (false, ItemModel::StandardParcel),
            (true, ItemModel::StandardParcel),
            (true, ItemModel::FragileParcel),
            (true, ItemModel::WoodenCrate),
        ] {
            let mut app = physics_asset_app();
            wait_until(&mut app, |world| {
                world.query::<&Character>().iter(world).count() == 1
            });
            fixed_steps(&mut app, 1);
            let world = app.world_mut();
            let npc = source_asset_entity(world, "chr_resident");
            let npc_collider = static_collider_child(world, npc);
            let npc_position = world.get::<Position>(npc_collider).unwrap().0;
            let npc_rotation = world.get::<Rotation>(npc_collider).unwrap().0;
            let character = world
                .query_filtered::<Entity, With<Character>>()
                .single(world)
                .unwrap();
            let parcel = world
                .query::<(Entity, &ItemModel)>()
                .iter(world)
                .find(|(_, item_model)| **item_model == model)
                .unwrap()
                .0;
            let character_start = npc_position + Vec3::new(0.0, 0.03, 2.0);
            let parcel_start = npc_position + Vec3::new(0.0, if held { 0.3 } else { 1.0 }, 1.1);
            world
                .entity_mut(character)
                .insert((
                    Position(character_start),
                    Rotation(Quat::IDENTITY),
                    Transform::from_translation(character_start),
                    LinearVelocity(Vec3::ZERO),
                    AngularVelocity(Vec3::ZERO),
                    NoTranslationEasing,
                ))
                .remove::<Sleeping>();
            world
                .entity_mut(parcel)
                .insert((
                    Position(parcel_start),
                    Rotation(Quat::IDENTITY),
                    Transform::from_translation(parcel_start),
                    LinearVelocity(if held { Vec3::ZERO } else { Vec3::NEG_Z * 4.0 }),
                    AngularVelocity(Vec3::ZERO),
                    NoTranslationEasing,
                ))
                .remove::<Sleeping>();
            if held {
                fixed_steps(&mut app, 20);
                // 使用资产原有的正常握点与真实交互入口，不能延长握点把箱子单独拉向 NPC。
                app.world_mut()
                    .get_mut::<CharacterIntent>(character)
                    .unwrap()
                    .interact_pending = true;
                fixed_steps(&mut app, 1);
                assert_eq!(app.world().get::<HeldBy>(parcel).unwrap().get(), character);
                fixed_steps(&mut app, 90);
                let raised = app.world().get::<Position>(parcel).unwrap().0;
                let holder_position = app.world().get::<Position>(character).unwrap().0;
                let holder = app.world().get::<HeldBy>(parcel).map(Relationship::get);
                let local_pose = app
                    .world()
                    .get::<HeldAttachment>(parcel)
                    .map(|attachment| attachment.local_pose);
                assert!(
                    raised.y > npc_position.y + 1.0,
                    "The held parcel must actually rise before the collision probe: model={model:?}, parcel={raised:?}, holder={holder:?}, holder_position={holder_position:?}, local_pose={local_pose:?}"
                );
                app.world_mut()
                    .get_mut::<CharacterIntent>(character)
                    .unwrap()
                    .movement = Vec2::Y;
            }
            let mut touched_npc = false;
            for _ in 0..if held { 90 } else { 30 } {
                fixed_steps(&mut app, 1);
                let world = app.world();
                let position = world.get::<Position>(parcel).unwrap().0;
                assert!(position.is_finite());
                assert!(
                    position.z > npc_position.z + 0.2,
                    "Parcel crossed the NPC body: held={held}, position={position:?}"
                );
                let parcel_collider = world
                    .get::<HeldAttachment>(parcel)
                    .map_or(parcel, |attachment| attachment.collider);
                touched_npc |= npc_contact_solved(world, npc_collider, parcel_collider);
                assert!(
                    world
                        .get::<Position>(npc_collider)
                        .unwrap()
                        .0
                        .abs_diff_eq(npc_position, 0.0001)
                );
                assert!(
                    world
                        .get::<Rotation>(npc_collider)
                        .unwrap()
                        .0
                        .dot(npc_rotation)
                        .abs()
                        > 0.99999
                );
                if held {
                    assert_eq!(world.get::<HeldBy>(parcel).unwrap().get(), character);
                    let character_position = world.get::<Position>(character).unwrap().0;
                    let character_rotation = world.get::<Rotation>(character).unwrap().0;
                    let grip = world.get::<CarryGrip>(parcel).unwrap().0;
                    if touched_npc {
                        assert!(
                            position
                                .abs_diff_eq(character_position + character_rotation * grip, 0.002),
                            "The blocked parcel must remain at the normal grip: model={model:?}, character={character_position:?}, parcel={position:?}"
                        );
                    }
                    assert!(
                        character_position.z > npc_position.z + 0.8,
                        "The player must stop behind the blocked parcel: model={model:?}, position={character_position:?}"
                    );
                    assert!(
                        !npc_contact_solved(world, npc_collider, character),
                        "The parcel must block movement before the player reaches the NPC: model={model:?}"
                    );
                } else {
                    assert!(world.get::<HeldBy>(parcel).is_none());
                }
            }
            let world = app.world();
            assert!(
                touched_npc,
                "Parcel must make a solved contact with the real NPC: held={held}"
            );
            if held {
                let position = world.get::<Position>(character).unwrap().0;
                let target = world.get::<HeldTarget>(parcel).unwrap().translation;
                assert!(
                    character_start.z - position.z > 0.35,
                    "The player must actually carry the parcel toward the NPC: model={model:?}"
                );
                assert!(
                    world
                        .get::<Position>(parcel)
                        .unwrap()
                        .0
                        .abs_diff_eq(target, 0.002),
                    "The whole carrying body must stop without grip compression: model={model:?}"
                );
                assert!(world.get::<LinearVelocity>(character).unwrap().z.abs() < 0.2);
                assert!(world.get::<RigidBody>(parcel).is_none());
                let collider = world.get::<HeldAttachment>(parcel).unwrap().collider;
                assert_eq!(world.get::<ColliderOf>(collider).unwrap().body, character);
                assert!(
                    world
                        .get::<avian3d::prelude::ColliderDisabled>(parcel)
                        .is_some()
                );
                assert!(world.get::<ChildOf>(parcel).is_none());
            } else {
                let position = world.get::<Position>(parcel).unwrap().0;
                assert!(
                    parcel_start.z - position.z > 0.3,
                    "The free parcel must actually move toward the NPC"
                );
            }
            assert_eq!(
                app.world_mut()
                    .query::<&bevy::window::Window>()
                    .iter(app.world())
                    .count(),
                0
            );
        }
    }

    #[test]
    fn stair_ramp_has_continuous_support_and_clearance_at_head_height() {
        let ramp = stair_ramp(Vec3::new(-1.85, 0.0, 0.0), Vec3::new(1.85, 0.54, 1.08));
        let front = ramp
            .cast_ray(
                Vec3::ZERO,
                Quat::IDENTITY,
                Vec3::new(0.0, 2.0, 1.2),
                Vec3::NEG_Y,
                3.0,
                true,
            )
            .unwrap();
        let back = ramp
            .cast_ray(
                Vec3::ZERO,
                Quat::IDENTITY,
                Vec3::new(0.0, 2.0, 0.1),
                Vec3::NEG_Y,
                3.0,
                true,
            )
            .unwrap();
        assert!(back.0 < front.0);
        assert!(front.1.y > 0.8 && back.1.y > 0.8);
        assert!(!ramp.intersects_ray(
            Vec3::ZERO,
            Quat::IDENTITY,
            Vec3::new(0.0, 1.5, 1.8),
            Vec3::NEG_Z,
            2.0
        ));
    }
}

mod turn_tests {
    //! turn tests 的无窗口回归。

    use super::*;

    /// 真实海岛跨菜单状态装配；同时检查异步等待、暂停与所有场景后代的退出清理。
    #[test]
    fn island_sessions_wait_for_assets_survive_pause_and_clean_up_on_menu_return() {
        use std::collections::HashSet;

        use crate::game_flow::PlayState;
        use bevy::ecs::resource::IsResource;

        let mut app = build_asset_app(false, None, true);
        app.update();
        let mut entities = app
            .world_mut()
            .query_filtered::<Entity, Without<IsResource>>();
        let initial: HashSet<_> = entities.iter(app.world()).collect();
        assert_eq!(
            *app.world().resource::<State<AppState>>().get(),
            AppState::MainMenu
        );
        assert!(
            app.world_mut()
                .query::<&Camera3d>()
                .iter(app.world())
                .next()
                .is_none()
        );

        // 先进入加载视图，再立即返回；不能遗留灯光或等待中的相机。
        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::InGame);
        app.update();
        assert!(
            app.world_mut()
                .query::<&Character>()
                .iter(app.world())
                .next()
                .is_none()
        );
        assert_eq!(
            app.world_mut()
                .query::<&LoadingCamera>()
                .iter(app.world())
                .count(),
            1
        );
        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::MainMenu);
        app.update();
        assert_eq!(entities.iter(app.world()).collect::<HashSet<_>>(), initial);

        // 资源全局加载完成后仍处于菜单，不得偷偷装配海岛或生成玩家。
        wait_until(&mut app, |world| {
            *world.resource::<ArtLoadState>() == ArtLoadState::Ready
        });
        assert!(
            app.world_mut()
                .query::<&IslandMap>()
                .iter(app.world())
                .next()
                .is_none()
        );

        // 资源 Ready 后确定地图已经请求、业务尚未装配，再暂停并取消这次加载。
        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::InGame);
        app.update();
        assert_eq!(
            app.world_mut()
                .query::<&IslandMap>()
                .iter(app.world())
                .count(),
            1
        );
        assert_eq!(
            app.world_mut()
                .query::<&Character>()
                .iter(app.world())
                .count(),
            0
        );
        app.world_mut()
            .resource_mut::<NextState<PlayState>>()
            .set(PlayState::Paused);
        for _ in 0..3 {
            app.update();
        }
        assert_eq!(
            app.world_mut()
                .query::<&Character>()
                .iter(app.world())
                .count(),
            0
        );
        assert_eq!(
            app.world_mut().query::<&Parcel>().iter(app.world()).count(),
            0
        );
        assert_eq!(
            app.world_mut()
                .query::<&LoadingCamera>()
                .iter(app.world())
                .count(),
            1
        );
        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::MainMenu);
        for _ in 0..3 {
            app.update();
        }
        assert_eq!(entities.iter(app.world()).collect::<HashSet<_>>(), initial);

        for _ in 0..2 {
            app.world_mut()
                .resource_mut::<NextState<AppState>>()
                .set(AppState::InGame);
            wait_until(&mut app, |world| {
                world.query::<&Character>().iter(world).count() == 1
                    && world.query::<&SkinnedMesh>().iter(world).count() > 0
            });
            let character = app
                .world_mut()
                .query_filtered::<Entity, With<Character>>()
                .single(app.world())
                .unwrap();
            let parcels: HashSet<_> = app
                .world_mut()
                .query_filtered::<Entity, With<Parcel>>()
                .iter(app.world())
                .collect();
            assert_eq!(parcels.len(), 5);
            let npc_colliders = assert_npc_colliders(app.world_mut());
            assert_eq!(
                app.world_mut()
                    .query::<&Camera3d>()
                    .iter(app.world())
                    .count(),
                1
            );
            let mut intent = app
                .world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap();
            intent.movement = Vec2::Y;
            intent.jump_pending = true;
            intent.interact_pending = true;
            app.world_mut()
                .resource_mut::<NextState<PlayState>>()
                .set(PlayState::Paused);
            app.update();
            let intent = app.world().get::<CharacterIntent>(character).unwrap();
            assert_eq!(intent.movement, Vec2::ZERO);
            assert!(!intent.jump_pending && !intent.interact_pending);
            assert!(
                app.world()
                    .resource::<Time<avian3d::prelude::Physics>>()
                    .is_paused()
            );
            assert_eq!(
                *app.world()
                    .resource::<State<crate::game_flow::PlayState>>()
                    .get(),
                crate::game_flow::PlayState::Paused
            );
            app.world_mut()
                .resource_mut::<NextState<PlayState>>()
                .set(PlayState::Running);
            app.update();
            assert!(app.world().get::<Character>(character).is_some());
            assert_eq!(
                app.world_mut()
                    .query::<&Character>()
                    .iter(app.world())
                    .count(),
                1
            );
            assert_eq!(
                app.world_mut()
                    .query_filtered::<Entity, With<Parcel>>()
                    .iter(app.world())
                    .collect::<HashSet<_>>(),
                parcels,
            );
            assert_eq!(
                app.world_mut()
                    .query::<&Camera3d>()
                    .iter(app.world())
                    .count(),
                1
            );
            assert_eq!(
                *app.world()
                    .resource::<State<crate::game_flow::PlayState>>()
                    .get(),
                crate::game_flow::PlayState::Running
            );
            assert_eq!(assert_npc_colliders(app.world_mut()), npc_colliders);

            app.world_mut()
                .resource_mut::<NextState<AppState>>()
                .set(AppState::MainMenu);
            // WorldInstance 等异步展开也要观察到清理后的根，不能仅检查业务组件数量。
            for _ in 0..3 {
                app.update();
            }
            for collider in npc_colliders {
                assert!(app.world().get_entity(collider).is_err());
            }
            assert_eq!(entities.iter(app.world()).collect::<HashSet<_>>(), initial);
        }
    }

    /// 真实地形和箱体模型参与逐帧同步，空旷地面上的视角转动不能误触发自动释放。
    #[test]
    fn real_island_open_area_turning_keeps_standard_and_fragile_parcels_held() {
        use bevy::ecs::relationship::Relationship;

        for model in [ItemModel::StandardParcel, ItemModel::FragileParcel] {
            let mut app = build_asset_app_with_camera(true, None, false, true);
            wait_until(&mut app, |world| {
                world.query::<&Character>().iter(world).count() == 1
            });
            fixed_steps(&mut app, 2);
            let world = app.world_mut();
            let character = world
                .query_filtered::<Entity, With<Character>>()
                .single(world)
                .unwrap();
            let parcel = world
                .query::<(Entity, &ItemModel)>()
                .iter(world)
                .find(|(_, item_model)| **item_model == model)
                .unwrap()
                .0;
            let position = world.get::<Position>(parcel).unwrap().0;
            // 日志首次复现位于出生纸箱附近，离建筑、NPC 和树干都很远，保留真实地形碰撞。
            let start = Vec3::new(position.x + 0.04, 0.03, position.z + 1.05);
            world
                .entity_mut(character)
                .insert((
                    Position(start),
                    Rotation(Quat::IDENTITY),
                    Transform::from_translation(start),
                    LinearVelocity(Vec3::ZERO),
                    AngularVelocity(Vec3::ZERO),
                ))
                .remove::<Sleeping>();
            fixed_steps(&mut app, 20);
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .interact_pending = true;
            fixed_steps(&mut app, 1);
            assert_eq!(app.world().get::<HeldBy>(parcel).unwrap().get(), character);
            // 拾取安全对齐属于初始化；开始观察输入后，只检查真实 app.update 帧末，不补跑系统。
            fixed_steps(&mut app, 30);
            assert_eq!(app.world().get::<HeldBy>(parcel).unwrap().get(), character);
            let world = app.world_mut();
            let controller = world
                .query::<(Entity, &ControlsCharacter)>()
                .iter(world)
                .find(|(_, controlled)| controlled.0 == character)
                .unwrap()
                .0;
            let camera = world.get::<ControlsCamera>(controller).unwrap().0;
            let descendants: Vec<_> = world
                .query::<&Children>()
                .query(world)
                .iter_descendants(parcel)
                .collect();
            let visual = descendants
                .into_iter()
                .find(|&entity| world.get::<Mesh3d>(entity).is_some())
                .expect("The actual parcel model must be instantiated");
            let root = GlobalTransform::from(*world.get::<Transform>(parcel).unwrap());
            let visual_local = world
                .get::<GlobalTransform>(visual)
                .unwrap()
                .reparented_to(&root);
            let source_collider = world.get::<Collider>(parcel).unwrap().clone();
            let held_pose = *world.get::<Transform>(parcel).unwrap();
            let grip = world.get::<CarryGrip>(parcel).unwrap().0;
            let half = source_collider.shape().as_cuboid().unwrap().half_extents;
            let radius = Vec2::new(grip.x, grip.z).length() + Vec2::new(half.x, half.z).length();
            let envelope = Collider::cuboid(2.0 * radius, 2.0 * half.y, 2.0 * radius);
            let holder_position = world.get::<Position>(character).unwrap().0;
            let proxy = world.get::<HeldAttachment>(parcel).unwrap().collider;
            let mut query = SystemState::<SpatialQuery>::new(world);
            let intersections = query.get(world).unwrap().shape_intersections(
                &source_collider,
                held_pose.translation,
                held_pose.rotation,
                &SpatialQueryFilter::from_mask(GamePhysicsLayer::World),
            );
            assert!(
                intersections.is_empty(),
                "The settled held parcel must start clear of all world colliders: model={model:?}, intersections={intersections:?}"
            );
            // 水平整圈扫过的所有箱角均包含在此实体包络中，证明全程没有其他物品或世界障碍。
            let arc_intersections = query.get(world).unwrap().shape_intersections(
                &envelope,
                holder_position + Vec3::Y * grip.y,
                Quat::IDENTITY,
                &SpatialQueryFilter::from_excluded_entities([character, parcel, proxy]),
            );
            assert!(
                arc_intersections.is_empty(),
                "The complete turn envelope must be clear of real obstacles: model={model:?}, intersections={arc_intersections:?}"
            );

            for fixed in [false, true] {
                app.insert_resource(if fixed {
                    TimeUpdateStrategy::FixedTimesteps(1)
                } else {
                    TimeUpdateStrategy::ManualDuration(Duration::ZERO)
                });
                let mut turns = Vec::new();
                let mut previous_angle = 0.0;
                for angle in [
                    0.113,
                    0.47,
                    0.791,
                    1.23,
                    1.666,
                    2.1,
                    2.739,
                    std::f32::consts::PI,
                    3.44,
                    4.029,
                    4.74,
                    5.186,
                    5.917,
                    6.113,
                    std::f32::consts::TAU,
                ] {
                    turns.push(angle - previous_angle);
                    previous_angle = angle;
                    // 每个非均匀始角覆盖亚像素微转、单像素、慢转、快速正反转和半圈。
                    turns.extend([
                        0.001,
                        -0.001,
                        0.003,
                        -0.003,
                        0.02,
                        -0.02,
                        0.2,
                        -0.2,
                        std::f32::consts::PI,
                        -std::f32::consts::PI,
                    ]);
                }
                let sensitivity = app
                    .world()
                    .resource::<crate::settings::GameSettings>()
                    .camera
                    .mouse_sensitivity;
                for turn in turns {
                    let delta = -turn / sensitivity;
                    let before = app.world().resource::<Time<Fixed>>().elapsed();
                    let camera_before = app.world().get::<Transform>(camera).unwrap().rotation;
                    app.world_mut().write_message(MouseMotion {
                        delta: Vec2::X * delta,
                    });
                    app.update();
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
                        "Turning in the open island area must not release the parcel: model={model:?}, fixed={fixed}, turn={turn}, pixels={delta}"
                    );
                    let character_pose = world.get::<Transform>(character).unwrap();
                    let parcel_pose = world.get::<Transform>(parcel).unwrap();
                    let grip = world.get::<CarryGrip>(parcel).unwrap().0;
                    assert!(
                        parcel_pose
                            .translation
                            .abs_diff_eq(character_pose.transform_point(grip), 0.0001)
                    );
                    let expected_visual =
                        GlobalTransform::from(*parcel_pose).mul_transform(visual_local);
                    assert!(
                        world
                            .get::<GlobalTransform>(visual)
                            .unwrap()
                            .affine()
                            .abs_diff_eq(expected_visual.affine(), 0.0001),
                        "The actual GLB mesh must follow the current held root pose"
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
            }
        }
    }

    /// 使用真实建筑侧墙、原始箱体与交互，对完整无障碍的微转和转离做回归。
    #[test]
    fn real_island_clear_turns_beside_building_walls_keep_all_parcels_held() {
        use bevy::ecs::relationship::Relationship;

        for model in [
            ItemModel::StandardParcel,
            ItemModel::FragileParcel,
            ItemModel::WoodenCrate,
        ] {
            let mut app = build_asset_app_with_camera(true, None, false, true);
            wait_until(&mut app, |world| {
                world.query::<&Character>().iter(world).count() == 1
            });
            fixed_steps(&mut app, 2);
            let world = app.world_mut();
            let character = world
                .query_filtered::<Entity, With<Character>>()
                .single(world)
                .unwrap();
            let parcel = world
                .query::<(Entity, &ItemModel)>()
                .iter(world)
                .find(|(_, item_model)| **item_model == model)
                .unwrap()
                .0;
            let controller = world
                .query::<(Entity, &ControlsCharacter)>()
                .iter(world)
                .find(|(_, controlled)| controlled.0 == character)
                .unwrap()
                .0;
            let camera = world.get::<ControlsCamera>(controller).unwrap().0;
            let descendants: Vec<_> = world
                .query::<&Children>()
                .query(world)
                .iter_descendants(parcel)
                .collect();
            let visual = descendants
                .into_iter()
                .find(|&entity| world.get::<Mesh3d>(entity).is_some())
                .unwrap();
            let root = GlobalTransform::from(*world.get::<Transform>(parcel).unwrap());
            let visual_local = world
                .get::<GlobalTransform>(visual)
                .unwrap()
                .reparented_to(&root);
            let bounds = world
                .get::<Collider>(parcel)
                .unwrap()
                .shape_scaled()
                .compute_local_aabb();
            for asset in ["bld_courier_station", "bld_music_shop"] {
                let world = app.world_mut();
                let building = source_asset_entity(world, asset);
                let building_z = world.get::<Transform>(building).unwrap().translation.z;
                // 外斜撑比墙板更突出；读取真实网格的世界外缘，为整段转离包络留下 6cm 净空。
                let (_, brace_max) = imported_mesh_bounds(world, building, "Side_external_brace_1");
                // 两栋商铺的真实外平台顶面为 Y=.56，不能在平台内部生成角色和箱体。
                let start = Vec3::new(brace_max.x - bounds.mins.x + 0.06, 0.59, building_z);
                let parcel_start = start + Vec3::new(0.0, -bounds.mins.y, -0.9);
                world
                    .entity_mut(character)
                    .insert((
                        Position(start),
                        Rotation(Quat::IDENTITY),
                        Transform::from_translation(start),
                        LinearVelocity(Vec3::ZERO),
                        AngularVelocity(Vec3::ZERO),
                        NoTranslationEasing,
                    ))
                    .remove::<Sleeping>();
                world
                    .entity_mut(parcel)
                    .insert((
                        Position(parcel_start),
                        Rotation(Quat::IDENTITY),
                        Transform::from_translation(parcel_start),
                        LinearVelocity(Vec3::ZERO),
                        AngularVelocity(Vec3::ZERO),
                        NoTranslationEasing,
                    ))
                    .remove::<Sleeping>();
                fixed_steps(&mut app, 20);
                let world = app.world_mut();
                let holder_position = world.get::<Position>(character).unwrap().0;
                let holder_rotation = world.get::<Rotation>(character).unwrap().0;
                let source_position = world.get::<Position>(parcel).unwrap().0;
                let source_rotation = world.get::<Rotation>(parcel).unwrap().0;
                let grip = world.get::<CarryGrip>(parcel).unwrap().0;
                let collider = world.get::<Collider>(parcel).unwrap().clone();
                let target_position = holder_position + holder_rotation * grip;
                let mut query = SystemState::<SpatialQuery>::new(world);
                let target_intersections = query.get(world).unwrap().shape_intersections(
                    &collider,
                    target_position,
                    holder_rotation,
                    &SpatialQueryFilter::from_excluded_entities([character, parcel]),
                );
                assert!(
                    target_intersections.is_empty(),
                    "The normal near-wall grip target must be genuinely clear: model={model:?}, asset={asset}, source={source_position:?}, source_rotation={source_rotation:?}, holder={holder_position:?}, holder_rotation={holder_rotation:?}, target={target_position:?}, intersections={target_intersections:?}, obstacle_assets={:?}",
                    target_intersections
                        .iter()
                        .map(|&entity| (entity, island_collider_asset(world, entity)))
                        .collect::<Vec<_>>(),
                );
                app.world_mut()
                    .get_mut::<CharacterIntent>(character)
                    .unwrap()
                    .interact_pending = true;
                fixed_steps(&mut app, 1);
                assert_eq!(
                    app.world().get::<HeldBy>(parcel).map(Relationship::get),
                    Some(character),
                    "The near-wall interaction must actually pick up the parcel: model={model:?}, asset={asset}, source={:?}, source_rotation={:?}, holder={:?}, holder_rotation={:?}",
                    app.world().get::<Position>(parcel),
                    app.world().get::<Rotation>(parcel),
                    app.world().get::<Position>(character),
                    app.world().get::<Rotation>(character),
                );
                fixed_steps(&mut app, 30);
                assert_eq!(
                    app.world().get::<HeldBy>(parcel).map(Relationship::get),
                    Some(character),
                    "Safe near-wall pickup must align: model={model:?}, asset={asset}, source={:?}, source_rotation={:?}, holder={:?}, holder_rotation={:?}",
                    app.world().get::<Position>(parcel),
                    app.world().get::<Rotation>(parcel),
                    app.world().get::<Position>(character),
                    app.world().get::<Rotation>(character),
                );
                for fixed in [false, true] {
                    for turn in [
                        0.001,
                        -0.001,
                        0.003,
                        -0.003,
                        0.02,
                        -0.02,
                        -0.2,
                        0.2,
                        -std::f32::consts::FRAC_PI_2,
                        std::f32::consts::FRAC_PI_2,
                    ] {
                        assert_clear_turn_frame(
                            &mut app,
                            character,
                            parcel,
                            camera,
                            visual,
                            visual_local,
                            turn,
                            fixed,
                        );
                    }
                }
                app.world_mut()
                    .get_mut::<CharacterIntent>(character)
                    .unwrap()
                    .interact_pending = true;
                fixed_steps(&mut app, 1);
                assert!(app.world().get::<HeldBy>(parcel).is_none());
            }
        }
    }

    /// 日志没有记录始角，围绕实际放下中心覆盖多种始角，并独立证明每段微转的净空。
    #[test]
    fn real_island_logged_building_side_microturns_keep_paper_parcels_held() {
        use bevy::ecs::relationship::Relationship;

        for (model, center) in [
            (
                ItemModel::StandardParcel,
                Vec3::new(-4.0382676, 1.2999693, -2.5877512),
            ),
            (
                ItemModel::FragileParcel,
                Vec3::new(17.734007, 1.2999692, 0.84188503),
            ),
        ] {
            let mut app = build_asset_app_with_camera(true, None, false, true);
            wait_until(&mut app, |world| {
                world.query::<&Character>().iter(world).count() == 1
            });
            fixed_steps(&mut app, 2);
            let world = app.world_mut();
            let character = world
                .query_filtered::<Entity, With<Character>>()
                .single(world)
                .unwrap();
            let parcel = world
                .query::<(Entity, &ItemModel)>()
                .iter(world)
                .find(|(_, item_model)| **item_model == model)
                .unwrap()
                .0;
            let source = world.get::<Position>(parcel).unwrap().0;
            let open_start = Vec3::new(source.x + 0.04, 0.03, source.z + 1.05);
            world
                .entity_mut(character)
                .insert((
                    Position(open_start),
                    Rotation(Quat::IDENTITY),
                    Transform::from_translation(open_start),
                    LinearVelocity(Vec3::ZERO),
                    AngularVelocity(Vec3::ZERO),
                    NoTranslationEasing,
                ))
                .remove::<Sleeping>();
            fixed_steps(&mut app, 20);
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .interact_pending = true;
            fixed_steps(&mut app, 31);
            assert_eq!(app.world().get::<HeldBy>(parcel).unwrap().get(), character);
            let world = app.world_mut();
            let controller = world
                .query::<(Entity, &ControlsCharacter)>()
                .iter(world)
                .find(|(_, controlled)| controlled.0 == character)
                .unwrap()
                .0;
            let camera = world.get::<ControlsCamera>(controller).unwrap().0;
            let descendants: Vec<_> = world
                .query::<&Children>()
                .query(world)
                .iter_descendants(parcel)
                .collect();
            let visual = descendants
                .into_iter()
                .find(|&entity| world.get::<Mesh3d>(entity).is_some())
                .unwrap();
            let root = GlobalTransform::from(*world.get::<Transform>(parcel).unwrap());
            let visual_local = world
                .get::<GlobalTransform>(visual)
                .unwrap()
                .reparented_to(&root);
            let local = world.get::<HeldAttachment>(parcel).unwrap().local_pose;
            let mut previous_angle = 0.0;
            for angle in [
                0.113,
                0.47,
                0.791,
                1.23,
                1.666,
                2.1,
                2.739,
                std::f32::consts::PI,
                3.44,
                4.029,
                4.74,
                5.186,
                5.917,
                6.113,
                std::f32::consts::TAU,
            ] {
                // 先在已证明空旷的出生区域改变始角，再保持局部握姿重放日志中的箱根位置。
                let rotation = app.world().get::<Rotation>(character).unwrap().0;
                app.world_mut().entity_mut(character).insert((
                    Position(open_start),
                    Transform::from_translation(open_start).with_rotation(rotation),
                ));
                assert_clear_turn_frame(
                    &mut app,
                    character,
                    parcel,
                    camera,
                    visual,
                    visual_local,
                    angle - previous_angle,
                    false,
                );
                previous_angle = angle;
                let rotation = app.world().get::<Rotation>(character).unwrap().0;
                let origin = center - rotation * local.translation;
                app.world_mut().entity_mut(character).insert((
                    Position(origin),
                    Transform::from_translation(origin).with_rotation(rotation),
                ));
                for turn in [0.003, -0.003] {
                    assert_clear_turn_frame(
                        &mut app,
                        character,
                        parcel,
                        camera,
                        visual,
                        visual_local,
                        turn,
                        false,
                    );
                }
            }
        }
    }
}

mod lifecycle_tests {
    //! lifecycle tests 的无窗口回归。

    use super::*;

    #[test]
    fn real_island_loading_assembles_independent_roots_and_solid_geometry() {
        let mut app = asset_app();
        // 尚无地图和实际碰撞时不能提前创建动态玩家。
        assert_eq!(
            app.world_mut()
                .query_filtered::<Entity, With<Character>>()
                .iter(app.world())
                .count(),
            0
        );
        wait_until(&mut app, |world| {
            world.query::<&Character>().iter(world).count() == 1
        });
        // 首次生成玩家的 update 返回后立即检查，不能等下一帧同步或模型动画准备掩盖闪现。
        {
            let world = app.world_mut();
            let visual = world
                .query_filtered::<Entity, With<CharacterVisual>>()
                .single(world)
                .unwrap();
            assert_eq!(world.get::<Visibility>(visual), Some(&Visibility::Hidden));
            let descendants: Vec<_> = world
                .query::<&Children>()
                .query(world)
                .iter_descendants(visual)
                .collect();
            for entity in descendants {
                if world.get::<Mesh3d>(entity).is_some() {
                    assert!(
                        !world.get::<InheritedVisibility>(entity).unwrap().get(),
                        "Newly spawned first-person character meshes must already be hidden"
                    );
                }
            }
        }
        wait_until(&mut app, |world| {
            let actors_ready = world
                .query_filtered::<Entity, With<ActorsSpawned>>()
                .iter(world)
                .count()
                == 1;
            let visuals_ready = world
                .query_filtered::<Entity, (With<CharacterVisual>, With<Children>)>()
                .iter(world)
                .count()
                == 1;
            if !actors_ready || !visuals_ready {
                return false;
            }
            let visual = world
                .query_filtered::<Entity, With<CharacterVisual>>()
                .single(world)
                .unwrap();
            // SpawnScene 位于 Update 之后，不能把子树出现误当成本帧已经完成动画绑定。
            let descendants: Vec<_> = world
                .query::<&Children>()
                .query(world)
                .iter_descendants(visual)
                .collect();
            descendants.iter().any(|&entity| {
                world.get::<AnimationGraphHandle>(entity).is_some()
                    && world.get::<AnimationPlayer>(entity).is_some_and(|player| {
                        player.playing_animations().count() == 16
                            && player
                                .playing_animations()
                                .any(|(_, active)| active.weight() > 0.0)
                    })
            })
        });
        let world = app.world_mut();
        assert_eq!(
            world
                .query_filtered::<Entity, With<bevy::window::Window>>()
                .iter(world)
                .count(),
            0
        );
        let character = world
            .query_filtered::<Entity, With<Character>>()
            .single(world)
            .unwrap();
        let root = world.get::<Transform>(character).unwrap();
        assert!(
            root.translation
                .abs_diff_eq(Vec3::new(-1.8, 0.03, 3.5), 0.001)
        );
        assert_eq!(world.get::<RigidBody>(character), Some(&RigidBody::Dynamic));
        assert!(world.get::<ChildOf>(character).is_none());
        let controller = world
            .query::<(&PlayerId, &ControlsCharacter, &ControlsCamera)>()
            .single(world)
            .unwrap();
        assert_eq!(controller.0.0, 1);
        assert_eq!(controller.1.0, character);
        assert_eq!(
            world
                .get::<FirstPersonCamera>(controller.2.0)
                .unwrap()
                .target,
            character
        );
        assert_eq!(
            world
                .query_filtered::<Entity, With<Camera3d>>()
                .iter(world)
                .count(),
            1
        );
        assert_eq!(
            world
                .query_filtered::<Entity, With<DisplayNpc>>()
                .iter(world)
                .count(),
            4
        );
        let npc_colliders = assert_npc_colliders(world);
        assert_eq!(
            world
                .query_filtered::<Entity, With<Parcel>>()
                .iter(world)
                .count(),
            5
        );
        for model in [
            ItemModel::StandardParcel,
            ItemModel::FragileParcel,
            ItemModel::WoodenCrate,
        ] {
            let expected = if model == ItemModel::WoodenCrate {
                3
            } else {
                1
            };
            let actual = world
                .query::<(
                    &ItemModel,
                    &RigidBody,
                    &Collider,
                    &Children,
                    &CarryGrip,
                    &SpawnPoint,
                )>()
                .iter(world)
                .filter(|(kind, ..)| **kind == model)
                .count();
            assert_eq!(actual, expected);
        }
        // 展示版主角和自由箱应移除；海水与草无碰撞，NPC 的独立身体碰撞已在上方核对。
        let imported: Vec<_> = world
            .query::<(Entity, &GltfExtras)>()
            .iter(world)
            .filter_map(|(entity, extras)| {
                serde_json::from_str::<MapAsset>(&extras.value)
                    .ok()
                    .map(|asset| (entity, asset))
            })
            .collect();
        for (entity, asset) in &imported {
            assert!(
                !matches!(
                    asset.source_asset.as_str(),
                    "chr_courier" | "prop_crate" | "prop_parcel_fragile"
                ),
                "Display dynamic instance was not removed"
            );
            if asset.source_asset == "env_ocean" || asset.source_asset == "prop_wild_grass_patch" {
                let descendants: Vec<_> = world
                    .query::<&Children>()
                    .query(world)
                    .iter_descendants(*entity)
                    .collect();
                assert!(
                    descendants
                        .iter()
                        .all(|&entity| world.get::<IslandCollider>(entity).is_none())
                );
            }
        }
        let terrain = imported
            .iter()
            .find(|(_, asset)| asset.source_asset == "env_island_terrain")
            .unwrap()
            .0;
        let collider_entity = world
            .get::<Children>(terrain)
            .unwrap()
            .into_iter()
            .copied()
            .find(|&entity| world.get::<IslandCollider>(entity).is_some())
            .unwrap();
        let collider = world.get::<Collider>(collider_entity).unwrap();
        assert_eq!(
            world.get::<CollisionLayers>(collider_entity),
            Some(&world_collision_layers())
        );
        let hit = collider
            .cast_ray(
                Vec3::ZERO,
                Quat::IDENTITY,
                Vec3::new(-1.8, 4.0, 3.5),
                Vec3::NEG_Y,
                5.0,
                true,
            )
            .unwrap();
        assert!((hit.0 - 4.0).abs() < 0.001);
        assert!(hit.1.y > 0.99);
        let stairs = imported
            .iter()
            .find(|(_, asset)| asset.source_asset == "env_stairs_railings")
            .unwrap()
            .0;
        let ramps = world
            .get::<Children>(stairs)
            .unwrap()
            .into_iter()
            .copied()
            .filter(|&entity| {
                world
                    .get::<Collider>(entity)
                    .is_some_and(|collider| collider.shape().as_convex_polyhedron().is_some())
            })
            .count();
        assert_eq!(ramps, 5);

        // 第一人称通过直属视觉根隐藏全部导入网格，不影响业务根和独立的可搬物。
        let visual = world
            .query_filtered::<Entity, With<CharacterVisual>>()
            .single(world)
            .unwrap();
        assert_eq!(world.get::<ChildOf>(visual).unwrap().parent(), character);
        let descendants: Vec<_> = world
            .query::<&Children>()
            .query(world)
            .iter_descendants(visual)
            .collect();
        let players: Vec<_> = descendants
            .iter()
            .copied()
            .filter(|&entity| world.get::<AnimationPlayer>(entity).is_some())
            .collect();
        assert_eq!(players.len(), 1);
        let player = players[0];
        // 所有片段持续关联，动作由权重选择；没有物理步的装配环境尚未接地，应使用 Fall。
        let animation_player = world.get::<AnimationPlayer>(player).unwrap();
        assert_eq!(animation_player.playing_animations().count(), 16);
        let (dominant_node, dominant_active) = animation_player
            .playing_animations()
            .max_by(|(_, a), (_, b)| a.weight().total_cmp(&b.weight()))
            .unwrap();
        assert!(dominant_active.weight() > 0.99);
        let graph = world
            .resource::<Assets<AnimationGraph>>()
            .get(&world.get::<AnimationGraphHandle>(player).unwrap().0)
            .unwrap();
        let AnimationNodeType::Clip(clip) = &graph[*dominant_node].node_type else {
            panic!("Expected the courier main animation to be a clip");
        };
        let courier = world
            .resource::<Assets<Gltf>>()
            .get(&world.get::<CourierVisual>(visual).unwrap().0)
            .unwrap();
        // 真正加载全部方向与持箱动作；GLB 改名或丢失曲线必须在无窗口回归中暴露。
        let clips = world.resource::<Assets<AnimationClip>>();
        for name in [
            "Idle",
            "Walk",
            "Walk_Backward",
            "Walk_Left",
            "Walk_Right",
            "Carry_Idle",
            "Carry_Walk",
            "Carry_Backward",
            "Carry_Left",
            "Carry_Right",
            "Jump",
            "Fall",
            "Carry_Jump",
            "Carry_Fall",
            "Land",
            "Carry_Land",
        ] {
            let clip = clips.get(&courier.named_animations[name]).unwrap();
            assert!(
                (clip.duration() - 0.8).abs() < 0.0001 && !clip.curves().is_empty(),
                "Courier animation {name} must retain a complete 0.8-second clip"
            );
        }
        assert!(!world.get::<CharacterMotion>(character).unwrap().grounded);
        assert_eq!(clip.id(), courier.named_animations["Fall"].id());
        for (node, active) in animation_player.playing_animations() {
            let AnimationNodeType::Clip(handle) = &graph[*node].node_type else {
                panic!("Expected the courier animation to be a clip");
            };
            // 起跳与落地保持一次性尾姿；其他动作保留循环，不因图中的排列位置判断。
            let one_shot = ["Jump", "Carry_Jump", "Land", "Carry_Land"]
                .iter()
                .any(|name| courier.named_animations[*name].id() == handle.id());
            assert_eq!(
                active.repeat_mode(),
                if one_shot {
                    RepeatAnimation::Never
                } else {
                    RepeatAnimation::Forever
                }
            );
        }
        assert!(
            world
                .resource::<Assets<AnimationClip>>()
                .get(clip)
                .is_some_and(
                    |animation| animation.duration() > 0.0 && !animation.curves().is_empty()
                )
        );
        // 骨骼实体必须被实例化并重映射到本主角子树，不能只加载到独立静态网格。
        let skinned_meshes: Vec<_> = descendants
            .iter()
            .filter_map(|&entity| world.get::<SkinnedMesh>(entity))
            .collect();
        assert!(!skinned_meshes.is_empty());
        for mesh in skinned_meshes {
            assert!(!mesh.joints.is_empty());
            for &joint in &mesh.joints {
                assert!(descendants.contains(&joint));
                assert!(world.get::<GlobalTransform>(joint).is_some());
            }
        }
        assert!(
            descendants
                .iter()
                .any(|&entity| world.get::<Mesh3d>(entity).is_some())
        );
        for &entity in &descendants {
            assert!(world.get::<RigidBody>(entity).is_none());
            assert!(world.get::<Collider>(entity).is_none());
        }
        assert_eq!(world.get::<Visibility>(visual), Some(&Visibility::Hidden));
        for entity in descendants {
            if world.get::<Mesh3d>(entity).is_some() {
                assert!(!world.get::<InheritedVisibility>(entity).unwrap().get());
            }
        }
        // 重复更新不能重复装配角色和物品。
        app.update();
        let world = app.world_mut();
        assert_eq!(
            world
                .query_filtered::<Entity, With<Character>>()
                .iter(world)
                .count(),
            1
        );
        assert_eq!(
            world
                .query_filtered::<Entity, With<Parcel>>()
                .iter(world)
                .count(),
            5
        );
        let map = world
            .query_filtered::<Entity, With<IslandMap>>()
            .single(world)
            .unwrap();
        let instance_id = **world.get::<WorldInstance>(map).unwrap();
        let collider_count = world
            .query_filtered::<Entity, With<IslandCollider>>()
            .iter(world)
            .count();
        // 复用真实实例 ID 重复通知，不能再次处理已移除的展示主角而使地图进入 Failed。
        world.trigger(WorldInstanceReady {
            entity: map,
            instance_id,
        });
        for _ in 0..5 {
            app.update();
            let world = app.world_mut();
            assert!(*world.resource::<ArtLoadState>() == ArtLoadState::Ready);
            assert!(world.get::<IslandPending>(map).is_none());
            assert_eq!(
                world
                    .query_filtered::<Entity, With<IslandCollider>>()
                    .iter(world)
                    .count(),
                collider_count
            );
            assert_eq!(assert_npc_colliders(world), npc_colliders);
            assert_eq!(
                world
                    .query_filtered::<Entity, With<Character>>()
                    .iter(world)
                    .count(),
                1
            );
            assert_eq!(
                world
                    .query_filtered::<Entity, With<Parcel>>()
                    .iter(world)
                    .count(),
                5
            );
        }
    }

    #[test]
    fn missing_art_assets_fail_without_spawning_gameplay_entities() {
        let empty_assets = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tmp")
            .join("scene-assets-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&empty_assets).unwrap();
        let mut app = build_asset_app(
            false,
            Some(empty_assets.to_string_lossy().into_owned()),
            false,
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            app.update();
            if *app.world().resource::<ArtLoadState>() == ArtLoadState::Failed {
                break;
            }
            assert!(Instant::now() < deadline, "Missing asset failure timed out");
            std::thread::yield_now();
        }
        // 失败后继续多帧也不能重试装配或产生不可游玩的半初始化玩家。
        for _ in 0..5 {
            app.update();
            let world = app.world_mut();
            assert!(*world.resource::<ArtLoadState>() == ArtLoadState::Failed);
            assert_eq!(
                world
                    .query_filtered::<Entity, Or<(With<Character>, With<Parcel>, With<IslandMap>)>>(
                    )
                    .iter(world)
                    .count(),
                0
            );
        }
    }
}

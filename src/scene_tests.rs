//! 加载真实资产、BSN 和层级，并用最小 Avian 调度检查世界碰撞；不安装窗口和渲染器。

use std::time::{Duration, Instant};

use avian3d::prelude::{
    ColliderAabb, ColliderOf, CollisionLayers, LinearVelocity, NoTranslationEasing, PhysicsTime,
    Position, RayHitData, Rotation, ShapeCastConfig, ShapeHitData, Sleeping, SpatialQuery,
    SpatialQueryFilter,
};
use bevy::{
    animation::{AnimationPlugin, graph::AnimationNodeType},
    asset::AssetPlugin,
    camera::visibility::{InheritedVisibility, VisibilityPlugin},
    ecs::system::SystemState,
    gltf::GltfPlugin,
    input::InputPlugin,
    mesh::{MeshPlugin, skinning::SkinnedMesh},
    scene::ScenePlugin,
    time::TimeUpdateStrategy,
    world_serialization::{WorldInstance, WorldSerializationPlugin},
};
use bevy_enhanced_input::prelude::{EnhancedInputPlugin, InputContextAppExt};

use super::*;
use crate::{
    art_assets::ArtAssetsPlugin,
    character_animation::CharacterAnimationPlugin,
    gameplay::{ControlsCharacter, GameplayPlugin},
    input::GameplayContext,
    physics::GamePhysicsLayer,
};

fn asset_app() -> App {
    build_asset_app(false, None, false)
}

fn physics_asset_app() -> App {
    build_asset_app(true, None, false)
}

fn build_asset_app(with_physics: bool, asset_path: Option<String>, with_session: bool) -> App {
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
    .add_input_context::<GameplayContext>()
    .add_plugins((
        ArtAssetsPlugin,
        CharacterAnimationPlugin,
        PrototypeScenePlugin,
    ));
    if with_session {
        app.add_plugins(crate::app_flow::AppFlowPlugin)
            .init_resource::<Time<avian3d::prelude::Physics>>();
    }
    if with_physics {
        // 加载过程不推进固定步；不装落水恢复，穿地失败不能被回出生点掩盖。
        // GameplayPlugin 只安装 ECS 运动和 DemoPhysicsPlugin，也让坡道回归使用实际控制力。
        app.add_plugins(GameplayPlugin)
            .insert_resource(Time::<Fixed>::from_hz(60.0));
    }
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

/// 真实海岛跨菜单状态装配；同时检查异步等待、暂停与所有场景后代的退出清理。
#[test]
fn island_sessions_wait_for_assets_survive_pause_and_clean_up_on_menu_return() {
    use std::collections::HashSet;

    use crate::{
        app_flow::PlayState,
        ui::{MenuPage, MenuState},
    };
    use bevy::ecs::resource::IsResource;

    let mut app = build_asset_app(false, None, true);
    app.update();
    let mut entities = app
        .world_mut()
        .query_filtered::<Entity, Without<IsResource>>();
    let initial: HashSet<_> = entities.iter(app.world()).collect();
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Main);
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
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
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
        assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Hidden);

        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::MainMenu);
        // WorldInstance 等异步展开也要观察到清理后的根，不能仅检查业务组件数量。
        for _ in 0..3 {
            app.update();
        }
        assert_eq!(entities.iter(app.world()).collect::<HashSet<_>>(), initial);
    }
}

/// 真实站点驻足和行走时对比旧扫掠；相对开销避免把特定机器的 FPS 当成测试条件。
#[test]
fn station_character_ccd_avoids_expensive_stationary_and_walking_sweeps() {
    use avian3d::dynamics::solver::SolverDiagnostics;
    use avian3d::prelude::SweptCcd;
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
        for (label, ccd) in [("configured", configured), ("legacy", SweptCcd::default())] {
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
            "Character sweeps regressed during {activity}: configured={:?}, legacy={:?}",
            measurements[0],
            measurements[1]
        );
    }
}

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
            world.get::<AnimationPlayer>(entity).is_some()
                && world.get::<AnimationGraphHandle>(entity).is_some()
                && world
                    .get::<AnimationTransitions>(entity)
                    .is_some_and(|transitions| transitions.get_main_animation().is_some())
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
        world.get::<OrbitCamera>(controller.2.0).unwrap().target,
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
    // 保留的场景里不能残留展示版主角和自由箱，NPC 子树也不附加碰撞。
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
        if asset.source_asset == "env_ocean"
            || asset.category == "characters"
            || asset.source_asset == "prop_wild_grass_patch"
        {
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
    let idle_node = world
        .get::<AnimationTransitions>(player)
        .unwrap()
        .get_main_animation()
        .unwrap();
    assert!(
        world
            .get::<AnimationPlayer>(player)
            .unwrap()
            .is_playing_animation(idle_node)
    );
    let graph = world
        .resource::<Assets<AnimationGraph>>()
        .get(&world.get::<AnimationGraphHandle>(player).unwrap().0)
        .unwrap();
    let AnimationNodeType::Clip(clip) = &graph[idle_node].node_type else {
        panic!("Expected the courier main animation to be a clip");
    };
    let courier = world
        .resource::<Assets<Gltf>>()
        .get(&world.get::<CourierVisual>(visual).unwrap().0)
        .unwrap();
    assert_eq!(clip.id(), courier.named_animations["Idle"].id());
    assert!(
        world
            .resource::<Assets<AnimationClip>>()
            .get(clip)
            .is_some_and(|animation| animation.duration() > 0.0 && !animation.curves().is_empty())
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
    world.entity_mut(visual).insert(Visibility::Hidden);
    app.update();
    for entity in descendants {
        if app.world().get::<Mesh3d>(entity).is_some() {
            assert!(
                !app.world()
                    .get::<InheritedVisibility>(entity)
                    .unwrap()
                    .get()
            );
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
        let (scale, expected_rotation, expected_position) = global.to_scale_rotation_translation();
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
                .query_filtered::<Entity, Or<(With<Character>, With<Parcel>, With<IslandMap>)>>()
                .iter(world)
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

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

/// 真实站点驻足和行走时对比零门槛配置；相对开销避免把特定机器的 FPS 当成测试条件。
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
                        position.abs_diff_eq(character_position + character_rotation * grip, 0.002),
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

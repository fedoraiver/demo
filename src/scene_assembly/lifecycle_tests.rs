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
                .query_filtered::<Entity, Or<(With<Character>, With<Parcel>, With<IslandMap>)>>()
                .iter(world)
                .count(),
            0
        );
    }
}

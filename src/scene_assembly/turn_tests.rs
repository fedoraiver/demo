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

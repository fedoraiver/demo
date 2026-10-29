//! 无窗口验证恢复姿态、关系、插值暂停和单次文件日志。

use crate::character::character_body;
use crate::item_interaction::parcel_body;
use std::{fs, sync::Arc, time::Duration};

use avian3d::prelude::*;

use bevy::{
    ecs::{
        relationship::{Relationship, RelationshipTarget},
        schedule::SingleThreadedExecutor,
    },
    log::{tracing, tracing_subscriber},
    time::TimeUpdateStrategy,
};

use crate::{
    character::{Character, CharacterIntent, CharacterMotion},
    game_flow::configure_feature_order,
    item_interaction::{HeldBy, HeldTarget, HoldingItems, Pickable},
    physics::{held_collision_layers, parcel_collision_layers},
    settings::PrototypeConfig,
};

use super::recovery::{ResumeInterpolation, WATER_RECOVERY_Y};
use super::*;

/// 只安装时间、变换与真实物理，不加载游戏场景、窗口、渲染器或输入设备。
fn test_app() -> App {
    let mut app = App::new();
    configure_feature_order(&mut app);
    app.add_plugins((
        MinimalPlugins,
        TransformPlugin,
        PhysicsPlugins::default(),
        BoundsRecoveryPlugin,
    ))
    .insert_resource(Gravity(Vec3::ZERO))
    .insert_resource(Time::<Fixed>::from_hz(60.0))
    .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
    app.finish();
    app.cleanup();
    app.update();
    app
}

/// 通过实际 app.update 覆盖固定物理和本帧插值，断言前不补跑额外同步系统。
fn fixed_step(app: &mut App) {
    app.insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
    app.update();
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
}

fn spawn_character(app: &mut App, position: Vec3, spawn: Transform) -> Entity {
    app.world_mut()
        .spawn((
            Character,
            CharacterIntent {
                movement: Vec2::Y,
                jump_pending: true,
                interact_pending: true,
            },
            CharacterMotion { grounded: true },
            SpawnPoint { pose: spawn },
            character_body(&PrototypeConfig::default()),
            Transform::from_translation(position),
        ))
        .id()
}

fn spawn_item(app: &mut App, position: Vec3, spawn: Transform) -> Entity {
    app.world_mut()
        .spawn((
            Pickable,
            SpawnPoint { pose: spawn },
            parcel_body(&PrototypeConfig::default()),
            Transform::from_translation(position),
        ))
        .id()
}

#[test]
fn character_recovery_clears_requests_and_releases_items_without_teleporting_them() {
    let mut app = test_app();
    let spawn = Transform::from_xyz(-1.8, 0.03, 3.5).with_rotation(Quat::from_rotation_y(0.4));
    let character = spawn_character(&mut app, Vec3::new(90.0, -2.0, -90.0), spawn);
    let item = spawn_item(
        &mut app,
        Vec3::new(92.0, 0.0, -90.0),
        Transform::from_xyz(-9.0, 1.0, -3.0),
    );
    app.world_mut().entity_mut(item).insert((
        <HeldBy as Relationship>::from(character),
        HeldTarget {
            translation: Vec3::ZERO,
            rotation: Quat::IDENTITY,
        },
        held_collision_layers(),
    ));
    app.update();
    app.world_mut()
        .get_mut::<LinearVelocity>(character)
        .unwrap()
        .0 = Vec3::new(50.0, -30.0, 20.0);
    app.world_mut()
        .get_mut::<AngularVelocity>(character)
        .unwrap()
        .0 = Vec3::splat(8.0);
    app.world_mut().get_mut::<LinearVelocity>(item).unwrap().0 = Vec3::X;

    fixed_step(&mut app);

    let world = app.world();
    assert!(
        world
            .get::<Position>(character)
            .unwrap()
            .0
            .abs_diff_eq(spawn.translation, 0.0001)
    );
    assert_eq!(
        world.get::<LinearVelocity>(character).unwrap().0,
        Vec3::ZERO
    );
    assert_eq!(
        world.get::<AngularVelocity>(character).unwrap().0,
        Vec3::ZERO
    );
    let intent = world.get::<CharacterIntent>(character).unwrap();
    assert_eq!(intent.movement, Vec2::Y);
    assert!(!intent.jump_pending && !intent.interact_pending);
    assert!(!world.get::<CharacterMotion>(character).unwrap().grounded);
    assert!(world.get::<HeldBy>(item).is_none());
    assert!(world.get::<HeldTarget>(item).is_none());
    assert!(
        world
            .get::<HoldingItems>(character)
            .is_none_or(RelationshipTarget::is_empty)
    );
    assert_eq!(
        world.get::<CollisionLayers>(item).unwrap(),
        &parcel_collision_layers()
    );
    // 角色恢复不会重置仍在海面上方的物品，物品继续保持自己的位置和动量。
    assert!(world.get::<Position>(item).unwrap().x > 91.0);
    assert!(
        world
            .get::<LinearVelocity>(item)
            .unwrap()
            .0
            .abs_diff_eq(Vec3::X, 0.0001)
    );
}

#[test]
fn item_recovers_its_own_pose_and_does_not_interpolate_across_the_island() {
    let mut app = test_app();
    let spawn = Transform::from_xyz(-12.0, 0.3, 7.0).with_rotation(Quat::from_rotation_y(1.2));
    let character_spawn = Transform::from_xyz(4.0, 0.03, 5.0);
    let character = spawn_character(&mut app, character_spawn.translation, character_spawn);
    let item = spawn_item(&mut app, Vec3::new(90.0, -2.0, -80.0), spawn);
    app.world_mut().entity_mut(item).insert((
        <HeldBy as Relationship>::from(character),
        HeldTarget {
            translation: Vec3::ZERO,
            rotation: Quat::IDENTITY,
        },
        held_collision_layers(),
    ));
    let offset = Vec3::new(0.0, 0.15, 0.0);
    let visual = app
        .world_mut()
        .spawn((Transform::from_translation(offset), ChildOf(item)))
        .id();
    app.update();
    app.world_mut().get_mut::<LinearVelocity>(item).unwrap().0 = Vec3::new(40.0, -20.0, 30.0);
    app.world_mut().get_mut::<AngularVelocity>(item).unwrap().0 = Vec3::splat(10.0);

    fixed_step(&mut app);

    for _ in 0..4 {
        // 连续零固定步帧检查实际呈现姿态，旧海中端点不得重新参与插值。
        app.update();
        let world = app.world();
        assert!(
            world
                .get::<Position>(item)
                .unwrap()
                .0
                .abs_diff_eq(spawn.translation, 0.0001)
        );
        assert!(
            world
                .get::<Transform>(item)
                .unwrap()
                .translation
                .abs_diff_eq(spawn.translation, 0.0001)
        );
        assert!(
            world
                .get::<Rotation>(item)
                .unwrap()
                .0
                .abs_diff_eq(spawn.rotation, 0.0001)
        );
        assert!(
            (world.get::<Transform>(item).unwrap().rotation * Vec3::NEG_Z)
                .abs_diff_eq(spawn.rotation * Vec3::NEG_Z, 0.0001)
        );
        assert!(
            world
                .get::<GlobalTransform>(visual)
                .unwrap()
                .translation()
                .abs_diff_eq(spawn.transform_point(offset), 0.0001)
        );
        assert_eq!(world.get::<LinearVelocity>(item).unwrap().0, Vec3::ZERO);
        assert_eq!(world.get::<AngularVelocity>(item).unwrap().0, Vec3::ZERO);
        assert!(world.get::<HeldBy>(item).is_none());
        assert!(world.get::<HeldTarget>(item).is_none());
        assert_eq!(
            world.get::<CollisionLayers>(item).unwrap(),
            &parcel_collision_layers()
        );
    }

    fixed_step(&mut app);
    let world = app.world();
    assert!(world.get::<NoTranslationEasing>(item).is_none());
    assert!(world.get::<NoRotationEasing>(item).is_none());
    assert!(world.get::<ResumeInterpolation>(item).is_none());
    assert!(
        world
            .get::<Position>(item)
            .unwrap()
            .0
            .abs_diff_eq(spawn.translation, 0.0001)
    );
    assert_eq!(world.get::<LinearVelocity>(item).unwrap().0, Vec3::ZERO);
    assert_eq!(world.get::<AngularVelocity>(item).unwrap().0, Vec3::ZERO);
}

#[test]
fn water_threshold_does_not_recover_dry_entities_or_remove_existing_easing_pause() {
    let mut app = test_app();
    let dry_position = Vec3::new(0.0, WATER_RECOVERY_Y, 0.0);
    let dry_item = spawn_item(&mut app, dry_position, Transform::from_xyz(12.0, 1.0, 0.0));
    let wet_item = spawn_item(
        &mut app,
        Vec3::new(30.0, WATER_RECOVERY_Y - 0.01, 0.0),
        Transform::from_xyz(-12.0, 1.0, 0.0),
    );
    app.world_mut()
        .entity_mut(wet_item)
        .insert(NoTranslationEasing);
    app.update();

    fixed_step(&mut app);
    fixed_step(&mut app);

    let world = app.world();
    assert!(
        world
            .get::<Position>(dry_item)
            .unwrap()
            .0
            .abs_diff_eq(dry_position, 0.0001)
    );
    assert!(world.get::<ResumeInterpolation>(dry_item).is_none());
    assert!(world.get::<NoTranslationEasing>(dry_item).is_none());
    assert!(world.get::<NoTranslationEasing>(wet_item).is_some());
    assert!(world.get::<NoRotationEasing>(wet_item).is_none());
    assert!(world.get::<ResumeInterpolation>(wet_item).is_none());
}

#[test]
fn water_recovery_logs_once_and_later_physics_steps_keep_velocity_cleared() {
    const CHILD_ENV: &str = "DEMO_WATER_RECOVERY_LOG_TEST_CHILD";
    // 其他落水测试会命中同一 tracing callsite；隔离共享兴趣缓存，保留局部日志设施。
    // 子进程只执行本无窗口测试，不安装全局 subscriber，也不修改父进程环境。
    if std::env::var_os(CHILD_ENV).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "bounds_recovery::tests::water_recovery_logs_once_and_later_physics_steps_keep_velocity_cleared",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Isolated water recovery test failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed;"),
            "Isolated recovery test did not execute exactly one test: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }

    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tmp/island-recovery-tests");
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{}.log", uuid::Uuid::new_v4()));
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(Arc::new(fs::File::create_new(&path).unwrap()))
        .finish();

    tracing::subscriber::with_default(subscriber, || {
        let mut app = test_app();
        // 落水日志只在 FixedUpdate 输出，单线程调度让本测试捕获线程内 subscriber。
        app.edit_schedule(FixedUpdate, |schedule| {
            schedule.set_executor(SingleThreadedExecutor::new());
        });
        let spawn = Transform::from_xyz(-12.0, 0.3, 7.0);
        let item = spawn_item(&mut app, Vec3::new(30.0, -2.0, 0.0), spawn);
        app.update();
        app.world_mut().get_mut::<LinearVelocity>(item).unwrap().0 = Vec3::splat(100.0);
        app.world_mut().get_mut::<AngularVelocity>(item).unwrap().0 = Vec3::splat(50.0);
        for _ in 0..6 {
            fixed_step(&mut app);
            assert!(
                app.world()
                    .get::<Position>(item)
                    .unwrap()
                    .0
                    .abs_diff_eq(spawn.translation, 0.0001)
            );
            assert_eq!(
                app.world().get::<LinearVelocity>(item).unwrap().0,
                Vec3::ZERO
            );
            assert_eq!(
                app.world().get::<AngularVelocity>(item).unwrap().0,
                Vec3::ZERO
            );
        }
    });

    let contents = fs::read_to_string(&path).unwrap();
    fs::remove_file(path).unwrap();
    let records: Vec<_> = contents
        .lines()
        .filter(|line| line.contains("Entity recovered after entering water"))
        .collect();
    assert_eq!(
        records.len(),
        1,
        "Unexpected recovery log count: {contents}"
    );
    let record = records[0];
    for field in [
        "demo::island_recovery",
        "entity=",
        "position_before=",
        "position_after=",
        "reason=\"water_recovery\"",
    ] {
        assert!(record.contains(field), "Missing {field}: {record}");
    }
}

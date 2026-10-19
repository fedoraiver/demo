//! 完整连续路径和真实空间索引回归，保留起点接触、薄墙及退化三角面的边界。

use super::{
    CarryRotationQuery,
    rotation_motion::{pivot_motion, pose_motion, rotation_motion},
    rotation_sweep::path_hits,
};
use crate::game_flow::configure_feature_order;
use crate::physics::world_collision_layers;
use avian3d::{
    parry::{
        math::Pose,
        query::{DefaultQueryDispatcher, NonlinearRigidMotion, QueryDispatcher, details},
    },
    prelude::*,
};
use bevy::prelude::*;
use bevy::{ecs::system::SystemState, time::TimeUpdateStrategy};
use std::f32::consts::{FRAC_PI_2, PI, TAU};

fn local_grip() -> ColliderTransform {
    ColliderTransform {
        translation: Vec3::new(0.0, 1.3, -1.0),
        ..default()
    }
}

fn motion_to(angle: f32) -> NonlinearRigidMotion {
    rotation_motion(
        Vec3::ZERO,
        Quat::IDENTITY,
        Quat::from_rotation_y(angle),
        local_grip(),
    )
    .unwrap()
}

fn intersects_at(
    motion: &NonlinearRigidMotion,
    collider: &Collider,
    obstacle: &Collider,
    pose: Pose,
    time: f32,
) -> bool {
    avian3d::parry::query::intersection_test(
        &motion.position_at_time(time),
        collider.shape_scaled().as_ref(),
        &pose,
        obstacle.shape_scaled().as_ref(),
    )
    .unwrap()
}

#[test]
fn half_turn_hits_thin_wall_between_clear_endpoints() {
    let motion = motion_to(PI);
    let collider = Collider::cuboid(0.04, 0.04, 0.04);
    let obstacle = Collider::cuboid(0.1, 0.4, 0.0002);
    // 不同薄墙落在任意中间角度；回归不能只用恰好落在常见采样点的障碍。
    for time in [0.071, 0.197, 0.371, 0.5, 0.731, 0.929] {
        let pose = Pose::from_parts(motion.position_at_time(time).translation, Quat::IDENTITY);
        assert!(!intersects_at(&motion, &collider, &obstacle, pose, 0.0));
        assert!(!intersects_at(&motion, &collider, &obstacle, pose, 1.0));
        assert!(intersects_at(&motion, &collider, &obstacle, pose, time));
        assert!(path_hits(&motion, &collider, &obstacle, pose), "{time}");
    }
}

#[test]
fn shortest_arc_crosses_angle_wrap_without_sweeping_opposite_side() {
    let motion = rotation_motion(
        Vec3::ZERO,
        Quat::from_rotation_y(170_f32.to_radians()),
        Quat::from_rotation_y(-170_f32.to_radians()),
        local_grip(),
    )
    .unwrap();
    let collider = Collider::cuboid(0.04, 0.04, 0.04);
    let obstacle = Collider::cuboid(0.04, 0.4, 0.04);
    let nearby = Pose::from_parts(Vec3::new(0.0, 1.3, 1.0), Quat::IDENTITY);
    let opposite = Pose::from_parts(Vec3::new(0.0, 1.3, -1.0), Quat::IDENTITY);
    assert!(path_hits(&motion, &collider, &obstacle, nearby));
    assert!(!path_hits(&motion, &collider, &obstacle, opposite));
}

#[test]
fn signed_half_turn_keeps_the_actual_input_direction() {
    let collider = Collider::cuboid(0.04, 0.04, 0.04);
    let obstacle = Collider::cuboid(0.1, 0.4, 0.0002);
    let left = Pose::from_parts(Vec3::new(-1.0, 1.3, 0.0), Quat::IDENTITY);
    let right = Pose::from_parts(Vec3::new(1.0, 1.3, 0.0), Quat::IDENTITY);
    for angle in [PI, -PI] {
        let motion =
            pivot_motion(Vec3::ZERO, Quat::IDENTITY, Vec3::Y * angle, local_grip()).unwrap();
        assert_eq!(path_hits(&motion, &collider, &obstacle, left), angle > 0.0);
        assert_eq!(path_hits(&motion, &collider, &obstacle, right), angle < 0.0);
    }
}

#[test]
fn full_turn_cannot_hide_collisions_behind_an_identical_end_pose() {
    let collider = Collider::cuboid(0.04, 0.04, 0.04);
    let obstacle = Collider::cuboid(0.1, 0.4, 0.0002);
    for angle in [TAU, -TAU] {
        let motion =
            pivot_motion(Vec3::ZERO, Quat::IDENTITY, Vec3::Y * angle, local_grip()).unwrap();
        for x in [-1.0, 1.0] {
            let pose = Pose::from_parts(Vec3::new(x, 1.3, 0.0), Quat::IDENTITY);
            assert!(!intersects_at(&motion, &collider, &obstacle, pose, 0.0));
            assert!(!intersects_at(&motion, &collider, &obstacle, pose, 1.0));
            assert!(path_hits(&motion, &collider, &obstacle, pose));
        }
    }
}

#[test]
fn existing_wall_contact_can_turn_away_but_not_into_the_wall() {
    let collider = Collider::cuboid(0.4, 0.4, 0.4);
    let wall = Collider::cuboid(0.001, 2.0, 4.0);
    // 保留轻微接触穿入，覆盖真实求解后的接触容差，向外转不应被原接触误判。
    let pose = Pose::from_parts(Vec3::new(-0.2004, 1.3, -1.0), Quat::IDENTITY);
    let away = motion_to(-FRAC_PI_2);
    let into = motion_to(FRAC_PI_2);
    assert!(intersects_at(&away, &collider, &wall, pose, 0.0));
    assert!(!path_hits(&away, &collider, &wall, pose));
    assert!(path_hits(&into, &collider, &wall, pose));
    // 普通 CCD 的物体厚度门槛会放过小角度新穿入，显式转向必须同样拦住。
    assert!(path_hits(&motion_to(0.005), &collider, &wall, pose));
    assert!(!path_hits(&motion_to(-0.005), &collider, &wall, pose));
}

#[test]
fn separating_start_contact_does_not_hide_later_collision() {
    let collider = Collider::cuboid(0.4, 0.4, 0.4);
    let wall = Collider::cuboid(0.001, 2.0, 4.0);
    let pose = Pose::from_parts(Vec3::new(-0.2004, 1.3, -1.0), Quat::IDENTITY);
    assert!(path_hits(&motion_to(-PI + 0.00001), &collider, &wall, pose));
}

#[test]
fn no_turn_returns_no_rotation_path_even_during_contact() {
    let yaw = Quat::from_rotation_y(0.7);
    assert!(rotation_motion(Vec3::ZERO, yaw, yaw, local_grip()).is_none());
    assert!(rotation_motion(Vec3::ZERO, yaw, -yaw, local_grip()).is_none());
}

#[test]
fn existing_ground_contact_remains_tangential_during_horizontal_turn() {
    let collider = Collider::cuboid(0.4, 0.4, 0.4);
    let local = ColliderTransform {
        translation: Vec3::new(0.0, 0.1999, -1.0),
        ..default()
    };
    let motion = rotation_motion(
        Vec3::ZERO,
        Quat::IDENTITY,
        Quat::from_rotation_y(1.2),
        local,
    )
    .unwrap();
    let ground_box = Collider::compound(vec![(
        Vec3::NEG_Y * 0.1,
        Quat::IDENTITY,
        Collider::cuboid(4.0, 0.2, 4.0),
    )]);
    let ground_mesh = Collider::trimesh(
        vec![
            Vec3::new(-2.0, 0.0, -2.0),
            Vec3::new(2.0, 0.0, -2.0),
            Vec3::new(2.0, 0.0, 2.0),
            Vec3::new(-2.0, 0.0, 2.0),
        ],
        vec![[0, 2, 1], [0, 3, 2]],
    );
    for ground in [ground_box, ground_mesh] {
        assert!(intersects_at(
            &motion,
            &collider,
            &ground,
            Pose::IDENTITY,
            0.0
        ));
        assert!(
            !path_hits(&motion, &collider, &ground, Pose::IDENTITY),
            "{:?}",
            ground.shape_scaled().shape_type(),
        );
    }
}

fn assert_clear_turn_above_mesh(collider: Collider, grip_z: f32) {
    let ground = Collider::trimesh(
        vec![
            Vec3::new(-20.0, 0.0, -20.0),
            Vec3::new(20.0, 0.0, -20.0),
            Vec3::new(20.0, 0.0, 20.0),
            Vec3::new(-20.0, 0.0, 20.0),
        ],
        vec![[0, 2, 1], [0, 3, 2]],
    );
    for origin in [
        Vec3::ZERO,
        Vec3::new(-0.6283571, -0.0000307, 3.2463346),
        Vec3::new(7.5, 0.0, 5.0),
    ] {
        for angle in [0.001, -0.001, 0.02, -0.02, FRAC_PI_2, -FRAC_PI_2, TAU, -TAU] {
            let motion = pivot_motion(
                origin,
                Quat::IDENTITY,
                Vec3::Y * angle,
                ColliderTransform {
                    translation: Vec3::new(0.0, 1.3, grip_z),
                    ..default()
                },
            )
            .unwrap();
            // 绕世界 Y 轴转动保持每个点的高度，箱底全程高于唯一的地面平面。
            assert_eq!(motion.angvel.cross(Vec3::Y), Vec3::ZERO);
            assert!(
                collider
                    .shape_scaled()
                    .compute_aabb(&motion.position_at_time(0.0))
                    .mins
                    .y
                    > 0.97
            );
            assert!(!intersects_at(
                &motion,
                &collider,
                &ground,
                Pose::IDENTITY,
                0.0,
            ));
            assert!(!intersects_at(
                &motion,
                &collider,
                &ground,
                Pose::IDENTITY,
                1.0,
            ));
            assert!(
                !path_hits(&motion, &collider, &ground, Pose::IDENTITY),
                "Clear turn above mesh was blocked: origin={origin:?}, angle={angle}, initial_contact={:?}, default_nonlinear={:?}",
                DefaultQueryDispatcher.contact(
                    &motion.position_at_time(0.0).inverse(),
                    collider.shape_scaled().as_ref(),
                    ground.shape_scaled().as_ref(),
                    0.0,
                ),
                DefaultQueryDispatcher.cast_shapes_nonlinear(
                    &motion,
                    collider.shape_scaled().as_ref(),
                    &NonlinearRigidMotion::constant_position(Pose::IDENTITY),
                    ground.shape_scaled().as_ref(),
                    0.0,
                    1.0,
                    true,
                ),
            );
        }
    }
}

#[test]
fn clear_convex_box_turn_above_planar_mesh_keeps_the_carry() {
    assert_clear_turn_above_mesh(Collider::cuboid(0.6, 0.6, 0.6), -0.48);
}

#[test]
fn clear_compound_box_turn_above_planar_mesh_keeps_the_carry() {
    assert_clear_turn_above_mesh(
        Collider::compound(vec![(
            Vec3::new(0.0, 0.01625, 0.01625),
            Quat::IDENTITY,
            Collider::cuboid(0.84, 0.6825, 0.8145),
        )]),
        -0.62,
    );
}

#[test]
fn new_triangle_contact_does_not_use_the_existing_contact_margin() {
    let collider = Collider::cuboid(0.4, 0.4, 0.4);
    let wall = Collider::trimesh(
        vec![
            Vec3::new(0.0, 0.0, -2.0),
            Vec3::new(0.0, 2.0, -2.0),
            Vec3::new(0.0, 1.0, 2.0),
        ],
        vec![[0, 1, 2]],
    );
    // 起点分离 0.2mm，终点新穿入 0.2mm；新碰撞不能套用已有接触的 1mm 余量。
    for rotation in [Quat::IDENTITY, Quat::from_rotation_y(1.0e-5)] {
        // 微小转角确保非线性分支也不能把新墙接触借作已有接触余量。
        let motion = pose_motion(
            Transform::from_xyz(0.2002, 1.0, 0.0),
            Transform::from_xyz(0.1998, 1.0, 0.0).with_rotation(rotation),
        )
        .unwrap();
        assert!(!intersects_at(
            &motion,
            &collider,
            &wall,
            Pose::IDENTITY,
            0.0,
        ));
        assert!(intersects_at(
            &motion,
            &collider,
            &wall,
            Pose::IDENTITY,
            1.0,
        ));
        assert!(path_hits(&motion, &collider, &wall, Pose::IDENTITY));
    }
}

#[test]
fn pickup_lifts_from_ground_but_cannot_pass_through_a_ceiling() {
    let collider = Collider::cuboid(0.6, 0.6, 0.6);
    let start = Transform::from_xyz(0.0, 0.2999, -0.9);
    let end = Transform::from_xyz(0.0, 1.8, -0.48);
    let motion = pose_motion(start, end).unwrap();
    let ground = Collider::compound(vec![(
        Vec3::NEG_Y * 0.1,
        Quat::IDENTITY,
        Collider::cuboid(4.0, 0.2, 4.0),
    )]);
    assert!(intersects_at(
        &motion,
        &collider,
        &ground,
        Pose::IDENTITY,
        0.0
    ));
    assert!(!path_hits(&motion, &collider, &ground, Pose::IDENTITY));
    let room = Collider::compound(vec![
        (
            Vec3::NEG_Y * 0.1,
            Quat::IDENTITY,
            Collider::cuboid(4.0, 0.2, 4.0),
        ),
        (
            Vec3::Y * 1.1,
            Quat::IDENTITY,
            Collider::cuboid(4.0, 0.1, 4.0),
        ),
    ]);
    assert!(!intersects_at(
        &motion,
        &collider,
        &room,
        Pose::IDENTITY,
        1.0
    ));
    assert!(path_hits(&motion, &collider, &room, Pose::IDENTITY));
}

#[test]
fn pickup_translation_and_rotation_hit_between_clear_endpoints() {
    let start = Transform::from_xyz(-1.0, 1.3, 0.0);
    let end = Transform::from_xyz(1.0, 1.3, 0.0).with_rotation(Quat::from_rotation_y(FRAC_PI_2));
    let motion = pose_motion(start, end).unwrap();
    let offset = Vec3::new(0.25, 0.0, 0.0);
    let collider = Collider::compound(vec![(
        offset,
        Quat::IDENTITY,
        Collider::cuboid(0.04, 0.04, 0.04),
    )]);
    let obstacle = Collider::cuboid(0.0002, 0.4, 0.1);
    let pose = Pose::from_parts(motion.position_at_time(0.371) * offset, Quat::IDENTITY);
    assert!(!intersects_at(&motion, &collider, &obstacle, pose, 0.0));
    assert!(!intersects_at(&motion, &collider, &obstacle, pose, 1.0));
    assert!(path_hits(&motion, &collider, &obstacle, pose));
}

#[test]
fn compound_geometry_and_local_rotation_follow_the_same_pivot() {
    let local = ColliderTransform {
        rotation: Rotation(Quat::from_rotation_y(0.3)),
        ..local_grip()
    };
    let motion = rotation_motion(
        Vec3::ZERO,
        Quat::IDENTITY,
        Quat::from_rotation_y(PI - 0.001),
        local,
    )
    .unwrap();
    let offset = Vec3::new(0.0, 0.0, 0.45);
    let collider = Collider::compound(vec![(
        offset,
        Quat::IDENTITY,
        Collider::cuboid(0.04, 0.04, 0.04),
    )]);
    let obstacle = Collider::cuboid(0.01, 0.3, 0.01);
    let pose = Pose::from_parts(motion.position_at_time(0.5) * offset, Quat::IDENTITY);
    assert!(!intersects_at(&motion, &collider, &obstacle, pose, 0.0));
    assert!(!intersects_at(&motion, &collider, &obstacle, pose, 1.0));
    assert!(path_hits(&motion, &collider, &obstacle, pose));
}

fn query_app() -> App {
    let mut app = App::new();
    configure_feature_order(&mut app);
    // 只运行固定物理与空间索引，不安装窗口后端或渲染插件。
    app.add_plugins((MinimalPlugins, TransformPlugin, PhysicsPlugins::default()))
        .insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
    app.finish();
    app.cleanup();
    app.update();
    app
}

fn spawn_obstacle(app: &mut App, position: Vec3) -> Entity {
    app.world_mut()
        .spawn((
            RigidBody::Static,
            Collider::cuboid(0.1, 0.4, 0.0002),
            Transform::from_translation(position),
            world_collision_layers(),
        ))
        .id()
}

fn query_blocked(app: &mut App, excluded: &[Entity]) -> bool {
    let mut state = SystemState::<CarryRotationQuery>::new(app.world_mut());
    state.get(app.world()).unwrap().rotation_path_blocked(
        &Collider::cuboid(0.04, 0.04, 0.04),
        Vec3::ZERO,
        Quat::IDENTITY,
        Quat::from_rotation_y(PI),
        local_grip(),
        excluded,
    )
}

#[test]
fn spatial_candidates_exclude_own_body_and_sensors() {
    let mut app = query_app();
    let middle = motion_to(PI).position_at_time(0.5).translation;
    let holder = spawn_obstacle(&mut app, Vec3::ZERO);
    let attached = app
        .world_mut()
        .spawn((
            Collider::cuboid(0.1, 0.4, 0.0002),
            ColliderOf { body: holder },
            ColliderTransform {
                translation: middle,
                ..default()
            },
            Transform::from_translation(middle),
            world_collision_layers(),
        ))
        .id();
    let sensor = spawn_obstacle(&mut app, middle);
    app.world_mut().entity_mut(sensor).insert(Sensor);
    app.update();
    assert_eq!(
        app.world().get::<ColliderOf>(attached).unwrap().body,
        holder
    );
    assert!(!query_blocked(&mut app, &[holder]));
    spawn_obstacle(&mut app, middle);
    app.update();
    assert!(query_blocked(&mut app, &[holder]));
}

#[test]
fn blocked_result_survives_static_and_dynamic_tree_traversal() {
    for dynamic_blocker in [false, true] {
        let mut app = query_app();
        let middle = motion_to(PI).position_at_time(0.5).translation;
        let blocker = spawn_obstacle(&mut app, middle);
        let clear = spawn_obstacle(&mut app, Vec3::new(-middle.x, middle.y, middle.z));
        let dynamic = if dynamic_blocker { blocker } else { clear };
        app.world_mut()
            .entity_mut(dynamic)
            .insert((RigidBody::Dynamic, GravityScale(0.0)));
        app.update();
        assert!(query_blocked(&mut app, &[]), "{dynamic_blocker}");
    }
}

#[test]
fn disabled_collider_changes_queries_without_an_extra_physics_step() {
    let mut app = query_app();
    let middle = motion_to(PI).position_at_time(0.5).translation;
    let obstacle = spawn_obstacle(&mut app, middle);
    app.update();
    assert!(query_blocked(&mut app, &[]));
    let simulated = app.world().resource::<Time<Fixed>>().elapsed();
    app.world_mut()
        .entity_mut(obstacle)
        .insert(ColliderDisabled);
    app.world_mut().flush();
    assert!(!query_blocked(&mut app, &[]));
    app.world_mut()
        .entity_mut(obstacle)
        .remove::<ColliderDisabled>();
    app.world_mut().flush();
    assert!(query_blocked(&mut app, &[]));
    assert_eq!(app.world().resource::<Time<Fixed>>().elapsed(), simulated);
}

#[test]
fn many_signed_turns_cover_both_sides_with_a_bounded_sweep() {
    let mut app = query_app();
    let left = spawn_obstacle(&mut app, Vec3::new(-1.0, 1.3, 0.0));
    let right = spawn_obstacle(&mut app, Vec3::new(1.0, 1.3, 0.0));
    app.update();
    let mut state = SystemState::<CarryRotationQuery>::new(app.world_mut());
    let query = state.get(app.world()).unwrap();
    let collider = Collider::cuboid(0.04, 0.04, 0.04);
    for angle in [1000.0 * TAU + 0.3, -1000.0 * TAU - 0.3] {
        assert!(query.yaw_path_blocked(
            &collider,
            Vec3::ZERO,
            Quat::IDENTITY,
            angle,
            local_grip(),
            &[left],
        ));
        assert!(query.yaw_path_blocked(
            &collider,
            Vec3::ZERO,
            Quat::IDENTITY,
            angle,
            local_grip(),
            &[right],
        ));
    }
}

#[test]
fn reported_blocker_matches_the_requested_turn_side() {
    let mut app = query_app();
    let left = spawn_obstacle(&mut app, Vec3::new(-1.0, 1.3, 0.0));
    let right = spawn_obstacle(&mut app, Vec3::new(1.0, 1.3, 0.0));
    app.update();
    let mut state = SystemState::<CarryRotationQuery>::new(app.world_mut());
    let query = state.get(app.world()).unwrap();
    let collider = Collider::cuboid(0.04, 0.04, 0.04);
    for (angle, expected) in [(PI, left), (-PI, right)] {
        assert_eq!(
            query.yaw_path_blocker(
                &collider,
                Vec3::ZERO,
                Quat::IDENTITY,
                angle,
                local_grip(),
                &[],
            ),
            Some(expected),
        );
        assert_eq!(
            query.yaw_path_blocker(
                &collider,
                Vec3::ZERO,
                Quat::IDENTITY,
                angle,
                local_grip(),
                &[expected],
            ),
            None,
        );
    }
}

fn wall_probe_boxes() -> [(Collider, f32, f32); 2] {
    [
        (Collider::cuboid(0.6, 0.6, 0.6), -0.48, 0.3),
        (
            Collider::compound(vec![(
                Vec3::new(0.0, 0.01625, 0.01625),
                Quat::IDENTITY,
                Collider::cuboid(0.84, 0.6825, 0.8145),
            )]),
            -0.62,
            0.42,
        ),
    ]
}

fn wall_probe_motion(origin: Vec3, grip_z: f32, angle: f32) -> NonlinearRigidMotion {
    pivot_motion(
        origin,
        Quat::IDENTITY,
        Vec3::Y * angle,
        ColliderTransform {
            translation: Vec3::new(0.0, 1.3, grip_z),
            ..default()
        },
    )
    .unwrap()
}

fn assert_clear_wall_probe(motion: &NonlinearRigidMotion, collider: &Collider, wall: &Collider) {
    assert!(!intersects_at(motion, collider, wall, Pose::IDENTITY, 0.0));
    assert!(!intersects_at(motion, collider, wall, Pose::IDENTITY, 1.0));
    let closest = collider.shape_scaled().as_support_map().map(|cube| {
        let triangle = wall.shape_scaled().as_trimesh().unwrap().triangle(0);
        let relative = motion.position_at_time(0.0);
        (
            DefaultQueryDispatcher.closest_points(
                &relative,
                &triangle,
                collider.shape_scaled().as_ref(),
                f32::MAX,
            ),
            details::closest_points_support_map_support_map(&relative, &triangle, cube, f32::MAX),
        )
    });
    assert!(
        !path_hits(motion, collider, wall, Pose::IDENTITY),
        "Clear wall path was blocked: shape={:?}, angle={}, start={:?}, closest_default_gjk={closest:?}, default_nonlinear={:?}",
        collider.shape_scaled().shape_type(),
        motion.angvel.y,
        motion.position_at_time(0.0),
        DefaultQueryDispatcher.cast_shapes_nonlinear(
            motion,
            collider.shape_scaled().as_ref(),
            &NonlinearRigidMotion::constant_position(Pose::IDENTITY),
            wall.shape_scaled().as_ref(),
            0.0,
            1.0,
            true,
        ),
    );
}

#[test]
fn near_wall_turning_away_from_large_triangle_has_no_contact() {
    let wall = Collider::trimesh(
        vec![
            Vec3::new(0.0, -20.0, -20.0),
            Vec3::new(0.0, 20.0, -20.0),
            Vec3::new(0.0, 0.0, 20.0),
        ],
        vec![[0, 1, 2]],
    );
    for (collider, grip_z, half_x) in wall_probe_boxes() {
        let origin = Vec3::new(half_x + 0.0002, 0.0, 0.0);
        let bounds = collider.shape_scaled().compute_local_aabb();
        assert!(bounds.maxs.z + grip_z < 0.0);
        // 全弧角度在 [-PI, 0]：每个点原局部 Z<0，绕 Y 转离时 X>=origin.x-half_x。
        assert!(origin.x - half_x > 0.00019);
        for angle in [-0.001, -0.1, -FRAC_PI_2, -PI + 0.00001] {
            assert_clear_wall_probe(&wall_probe_motion(origin, grip_z, angle), &collider, &wall);
        }
        // 同一微转反方向必须真正撞墙，不能通过忽略墙让无接触探针假通过。
        assert!(path_hits(
            &wall_probe_motion(origin, grip_z, 0.001),
            &collider,
            &wall,
            Pose::IDENTITY,
        ));
    }
}

fn finite_triangle_probe(vertices: [Vec3; 3]) {
    let wall = Collider::trimesh(vertices.to_vec(), vec![[0, 1, 2]]);
    assert!(vertices.iter().all(|point| point.z >= 0.0));
    for (collider, grip_z, _) in wall_probe_boxes() {
        let bounds = collider.shape_scaled().compute_local_aabb();
        let radius = [
            Vec2::new(bounds.mins.x, bounds.mins.z + grip_z),
            Vec2::new(bounds.mins.x, bounds.maxs.z + grip_z),
            Vec2::new(bounds.maxs.x, bounds.mins.z + grip_z),
            Vec2::new(bounds.maxs.x, bounds.maxs.z + grip_z),
        ]
        .into_iter()
        .map(|point| point.length())
        .fold(0.0_f32, f32::max);
        let origin = Vec3::new(0.0, 0.0, -radius - 0.02);
        // 绕 Y 的水平半径恒定，所有形状点全弧 Z<=-0.02，而真实三角片所有点 Z>=0。
        // 形状跨过墙的无限 X 平面也不能与有限片相交；这里证明整段，未用姿态采样作替代。
        assert!(origin.z + radius < -0.019);
        for angle in [0.001, -0.001, FRAC_PI_2, -PI, TAU] {
            assert_clear_wall_probe(&wall_probe_motion(origin, grip_z, angle), &collider, &wall);
        }
    }
}

#[test]
fn finite_triangle_edge_stays_clear_over_the_complete_turn() {
    finite_triangle_probe([
        Vec3::new(0.0, 0.0, 0.0),
        Vec3::new(0.0, 4.0, 0.0),
        Vec3::new(0.0, 2.0, 4.0),
    ]);
}

#[test]
fn finite_triangle_line_stays_clear_over_the_complete_turn() {
    finite_triangle_probe([
        Vec3::new(0.0, 0.0, 0.0),
        Vec3::new(0.0, 2.0, 0.0),
        Vec3::new(0.0, 4.0, 0.0),
    ]);
}

#[test]
fn finite_triangle_point_and_thin_line_stay_clear_over_the_complete_turn() {
    finite_triangle_probe([Vec3::new(0.0, 1.3, 0.0); 3]);
    finite_triangle_probe([
        Vec3::new(0.0, 0.0, 0.0),
        Vec3::new(0.0, 4.0, 0.0),
        Vec3::new(0.0, 2.0, 0.0000001),
    ]);
}

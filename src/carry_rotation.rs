//! 显式转向先检查箱体的完整旋转路径，已有接触允许向外分离。

use avian3d::{
    parry::{
        math::Pose,
        query::{
            ClosestPoints, Contact, DefaultQueryDispatcher, NonlinearRigidMotion, QueryDispatcher,
            ShapeCastHit, ShapeCastOptions, ShapeCastStatus, Unsupported, details,
        },
        shape::{Shape, SupportMap},
    },
    prelude::*,
};
use bevy::{ecs::system::SystemParam, prelude::*};

use crate::physics::held_collision_layers;

/// 复用 Avian 的空间索引取得邻近候选，再读取真实形状完成旋转窄阶段检查。
#[derive(SystemParam)]
pub(crate) struct CarryRotationQuery<'w, 's> {
    spatial: SpatialQuery<'w, 's>,
    obstacles: Query<
        'w,
        's,
        (
            &'static Position,
            &'static Rotation,
            &'static Collider,
            Option<&'static CollisionLayers>,
            Option<&'static ColliderOf>,
            Has<Sensor>,
        ),
        Without<ColliderDisabled>,
    >,
}

impl CarryRotationQuery<'_, '_> {
    /// 只判断转向新引入的阻挡；无转向时不把直走产生的接触当成释放原因。
    #[cfg(test)]
    pub(crate) fn rotation_path_blocked(
        &self,
        collider: &Collider,
        holder_origin: Vec3,
        current_yaw: Quat,
        target_yaw: Quat,
        local: ColliderTransform,
        excluded: &[Entity],
    ) -> bool {
        let Some(motion) = rotation_motion(holder_origin, current_yaw, target_yaw, local) else {
            return false;
        };
        self.pivot_path_blocker(collider, holder_origin, &motion, local, excluded)
            .is_some()
    }

    /// 布尔回归与生产查询共用同一条路径，不能另设测试专用碰撞规则。
    #[cfg(test)]
    pub(crate) fn yaw_path_blocked(
        &self,
        collider: &Collider,
        holder_origin: Vec3,
        start_yaw: Quat,
        signed_delta: f32,
        local: ColliderTransform,
        excluded: &[Entity],
    ) -> bool {
        self.yaw_path_blocker(
            collider,
            holder_origin,
            start_yaw,
            signed_delta,
            local,
            excluded,
        )
        .is_some()
    }

    /// 鼠标输入保留符号与整圈长度，返回实际阻挡实体供单次释放日志记录。
    pub(crate) fn yaw_path_blocker(
        &self,
        collider: &Collider,
        holder_origin: Vec3,
        start_yaw: Quat,
        signed_delta: f32,
        local: ColliderTransform,
        excluded: &[Entity],
    ) -> Option<Entity> {
        // 固定支点转过整圈后只会重访相同体积；限制查询圈数，仍覆盖全部实际路径。
        let sweep_delta = signed_delta.clamp(-std::f32::consts::TAU, std::f32::consts::TAU);
        let Some(motion) = pivot_motion(holder_origin, start_yaw, Vec3::Y * sweep_delta, local)
        else {
            return None;
        };
        self.pivot_path_blocker(collider, holder_origin, &motion, local, excluded)
    }

    fn pivot_path_blocker(
        &self,
        collider: &Collider,
        holder_origin: Vec3,
        motion: &NonlinearRigidMotion,
        local: ColliderTransform,
        excluded: &[Entity],
    ) -> Option<Entity> {
        let sphere = collider.shape_scaled().compute_local_bounding_sphere();
        let center = local.translation + local.rotation * sphere.center;
        // 整周球包络包含任意中间角度和复合形状的偏心部分；窄阶段再排除多余候选。
        let extent = Vec3::splat(center.length() + sphere.radius);
        let bounds = ColliderAabb {
            min: holder_origin - extent,
            max: holder_origin + extent,
        };
        self.motion_path_blocker(collider, motion, bounds, excluded)
    }

    /// 拾取对齐按世界位置直线插值和姿态短弧插值，整段检查与实际过渡保持一致。
    pub(crate) fn pose_path_blocked(
        &self,
        collider: &Collider,
        start: Transform,
        end: Transform,
        excluded: &[Entity],
    ) -> bool {
        let Some(motion) = pose_motion(start, end) else {
            return false;
        };
        let sphere = collider.shape_scaled().compute_local_bounding_sphere();
        // shape_scaled 已包含真实尺度；这里的半径同时覆盖复合形状偏心和所有中间朝向。
        let extent = Vec3::splat(sphere.center.length() + sphere.radius);
        let bounds = ColliderAabb {
            min: start.translation.min(end.translation) - extent,
            max: start.translation.max(end.translation) + extent,
        };
        self.motion_path_blocker(collider, &motion, bounds, excluded)
            .is_some()
    }

    fn motion_path_blocker(
        &self,
        collider: &Collider,
        motion: &NonlinearRigidMotion,
        bounds: ColliderAabb,
        excluded: &[Entity],
    ) -> Option<Entity> {
        let mut blocker = None;
        self.spatial
            .aabb_intersections_with_aabb_callback(bounds, |entity| {
                // Avian 分别遍历静态与动态空间树，停止一棵树后不能让另一棵树清除已有命中。
                if blocker.is_some() {
                    return false;
                }
                let Ok((position, rotation, obstacle, layers, owner, sensor)) =
                    self.obstacles.get(entity)
                else {
                    // 禁用的业务碰撞根不能参与，即使这一刻空间索引仍保留旧候选。
                    return true;
                };
                // ColliderOf 不依赖 ChildOf；必须排除持有者整套碰撞体，避免箱体撞到自己。
                if sensor
                    || excluded.contains(&entity)
                    || owner.is_some_and(|owner| excluded.contains(&owner.body))
                    || !held_collision_layers().interacts_with(layers.copied().unwrap_or_default())
                {
                    return true;
                }
                if path_hits(
                    motion,
                    collider,
                    obstacle,
                    Pose::from_parts(position.0, rotation.0),
                ) {
                    blocker = Some(entity);
                }
                blocker.is_none()
            });
        blocker
    }
}

/// 把整段转向归一化到一个时间单位；箱体既绕人物公转，也改变自身朝向。
#[cfg(test)]
fn rotation_motion(
    holder_origin: Vec3,
    current_yaw: Quat,
    target_yaw: Quat,
    local: ColliderTransform,
) -> Option<NonlinearRigidMotion> {
    pivot_motion(
        holder_origin,
        current_yaw,
        shortest_arc(current_yaw, target_yaw),
        local,
    )
}

fn pivot_motion(
    holder_origin: Vec3,
    start_yaw: Quat,
    angular: Vec3,
    local: ColliderTransform,
) -> Option<NonlinearRigidMotion> {
    if angular.length_squared() <= 1.0e-12 {
        return None;
    }
    let rotation = start_yaw * local.rotation.0;
    let position = holder_origin + start_yaw * local.translation;
    let local_pivot = rotation.inverse() * (holder_origin - position);
    Some(NonlinearRigidMotion::new(
        Pose::from_parts(position, rotation),
        local_pivot,
        Vec3::ZERO,
        angular,
    ))
}

fn pose_motion(start: Transform, end: Transform) -> Option<NonlinearRigidMotion> {
    let angular = shortest_arc(start.rotation, end.rotation);
    let linear = end.translation - start.translation;
    if angular.length_squared() <= 1.0e-12 && linear.length_squared() <= 1.0e-12 {
        return None;
    }
    Some(NonlinearRigidMotion::new(
        Pose::from_parts(start.translation, start.rotation),
        Vec3::ZERO,
        linear,
        angular,
    ))
}

fn shortest_arc(start: Quat, end: Quat) -> Vec3 {
    let mut delta = end * start.inverse();
    if delta.w < 0.0 {
        delta = -delta;
    }
    delta.to_scaled_axis()
}

fn path_hits(
    motion: &NonlinearRigidMotion,
    collider: &Collider,
    obstacle: &Collider,
    obstacle_pose: Pose,
) -> bool {
    let obstacle_motion = NonlinearRigidMotion::constant_position(obstacle_pose);
    let origin_pose = motion.position_at_time(0.0);
    let origin_relative = origin_pose.inv_mul(&obstacle_pose);
    let Ok(started_touching) = DefaultQueryDispatcher.intersection_test(
        &origin_relative,
        collider.shape_scaled().as_ref(),
        obstacle.shape_scaled().as_ref(),
    ) else {
        return true;
    };
    let initial_plane = if started_touching {
        DefaultQueryDispatcher
            .contact(
                &origin_relative,
                collider.shape_scaled().as_ref(),
                obstacle.shape_scaled().as_ref(),
                0.0,
            )
            .ok()
            .flatten()
            .map(|contact| ExistingContactPlane {
                point: obstacle_pose * contact.point2,
                normal: origin_pose.rotation * contact.normal1,
            })
    } else {
        None
    };
    let dispatcher = CarryPathDispatcher { initial_plane };
    // 每段仍连续扫完整区间；把大于半圈的输入拆段，避免底层根搜索跨过整圈重复姿态。
    let sections = (motion.angvel.length() / std::f32::consts::PI)
        .ceil()
        .max(1.0) as u32;
    (0..sections).any(|section| {
        dispatcher
            .cast_shapes_nonlinear(
                motion,
                collider.shape_scaled().as_ref(),
                &obstacle_motion,
                obstacle.shape_scaled().as_ref(),
                section as f32 / sections as f32,
                (section + 1) as f32 / sections as f32,
                !started_touching,
            )
            // 不支持的形状不能作为路径已安全的证据，避免直接转入障碍。
            .map_or(true, |hit| hit.is_some())
    })
}

/// 显式改姿态必须拦住轻微新穿入，不能复用默认 CCD 允许整块物体厚度的推进门槛。
struct CarryPathDispatcher {
    initial_plane: Option<ExistingContactPlane>,
}

/// 复合地面会逐片分派，保留真实起点的接触平面，让相邻共面片共享同一支撑接触。
#[derive(Clone, Copy)]
struct ExistingContactPlane {
    point: Vec3,
    normal: Vec3,
}

impl QueryDispatcher for CarryPathDispatcher {
    fn intersection_test(
        &self,
        pose: &Pose,
        first: &dyn Shape,
        second: &dyn Shape,
    ) -> Result<bool, Unsupported> {
        DefaultQueryDispatcher.intersection_test(pose, first, second)
    }

    fn distance(
        &self,
        pose: &Pose,
        first: &dyn Shape,
        second: &dyn Shape,
    ) -> Result<f32, Unsupported> {
        DefaultQueryDispatcher.distance(pose, first, second)
    }

    fn contact(
        &self,
        pose: &Pose,
        first: &dyn Shape,
        second: &dyn Shape,
        prediction: f32,
    ) -> Result<Option<Contact>, Unsupported> {
        DefaultQueryDispatcher.contact(pose, first, second, prediction)
    }

    fn closest_points(
        &self,
        pose: &Pose,
        first: &dyn Shape,
        second: &dyn Shape,
        maximum: f32,
    ) -> Result<ClosestPoints, Unsupported> {
        // 三角片专用点对可能只是支撑顶点的投影，不能作为非线性根搜索的真实最近分离轴。
        if ((first.as_triangle().is_some() && second.as_cuboid().is_some())
            || (first.as_cuboid().is_some() && second.as_triangle().is_some()))
            && let (Some(first_map), Some(second_map)) =
                (first.as_support_map(), second.as_support_map())
        {
            return Ok(details::closest_points_support_map_support_map(
                pose, first_map, second_map, maximum,
            ));
        }
        DefaultQueryDispatcher.closest_points(pose, first, second, maximum)
    }

    fn cast_shapes(
        &self,
        pose: &Pose,
        velocity: Vec3,
        first: &dyn Shape,
        second: &dyn Shape,
        options: ShapeCastOptions,
    ) -> Result<Option<ShapeCastHit>, Unsupported> {
        DefaultQueryDispatcher.cast_shapes(pose, velocity, first, second, options)
    }

    fn cast_shapes_nonlinear(
        &self,
        first_motion: &NonlinearRigidMotion,
        first: &dyn Shape,
        second_motion: &NonlinearRigidMotion,
        second: &dyn Shape,
        start: f32,
        end: f32,
        stop_at_penetration: bool,
    ) -> Result<Option<ShapeCastHit>, Unsupported> {
        if first_motion.angvel == Vec3::ZERO && second_motion.angvel == Vec3::ZERO {
            let first_pose = first_motion.position_at_time(start);
            let second_pose = second_motion.position_at_time(start);
            // 纯平移复用完整线性 CCD，避免非线性 GJK 对复合箱与退化地面片产生假命中。
            return DefaultQueryDispatcher
                .cast_shapes(
                    &first_pose.inv_mul(&second_pose),
                    first_pose.rotation.inverse() * (second_motion.linvel - first_motion.linvel),
                    first,
                    second,
                    ShapeCastOptions {
                        stop_at_penetration,
                        ..ShapeCastOptions::with_max_time_of_impact(end - start)
                    },
                )
                .map(|hit| {
                    hit.map(|mut hit| {
                        hit.time_of_impact += start;
                        hit
                    })
                });
        }
        if let (Some(first_map), Some(second_map)) =
            (first.as_support_map(), second.as_support_map())
        {
            let mut time = start;
            let initial_plane = if stop_at_penetration {
                None
            } else {
                self.initial_plane
            };
            // 起点分离也用零余量证明整段安全，三角片的数值假命中不能触发自动放下。
            if stays_outside_triangle_plane(
                first_motion,
                first,
                second_motion,
                second,
                start,
                end,
                initial_plane,
            ) || stays_outside_triangle_plane(
                second_motion,
                second,
                first_motion,
                first,
                start,
                end,
                initial_plane,
            ) {
                return Ok(None);
            }
            // 整体在起点接触不代表每个子片都接触；新子片不能借用另一个面的分离余量。
            let can_separate = !stop_at_penetration
                && DefaultQueryDispatcher.intersection_test(
                    &first_motion
                        .position_at_time(0.0)
                        .inv_mul(&second_motion.position_at_time(0.0)),
                    first,
                    second,
                )?;
            while can_separate {
                let first_pose = first_motion.position_at_time(time);
                let second_pose = second_motion.position_at_time(time);
                let Some(contact) = DefaultQueryDispatcher.contact(
                    &first_pose.inv_mul(&second_pose),
                    first,
                    second,
                    0.0,
                )?
                else {
                    break;
                };
                let normal = first_pose.rotation * contact.normal1;
                let closing = (first_motion.linvel - second_motion.linvel).dot(normal)
                    + maximum_rotation_closing(first_motion, first_map, first_pose, normal)
                    + maximum_rotation_closing(second_motion, second_map, second_pose, -normal);
                let curvature = rotation_curvature(first_motion, first, normal)
                    + rotation_curvature(second_motion, second, normal);
                let remaining = end - time;
                // 对所有支撑点的法向位移给出连续上界；证明整段不增加穿入后才允许原接触。
                if closing * remaining + 0.5 * curvature * remaining.powi(2) <= CONTACT_MARGIN {
                    return Ok(None);
                }
                let opening = if closing < 0.0 && curvature > 0.0 {
                    (-closing / curvature).min(remaining)
                } else {
                    0.0
                };
                if opening > 0.0 && time + opening > time {
                    // 该区间的所有点都向外分离，不是跳过几个采样姿态；离开后仍连续扫剩余弧。
                    time += opening;
                    continue;
                }
                return Ok(Some(ShapeCastHit {
                    time_of_impact: time,
                    witness1: contact.point1,
                    witness2: contact.point2,
                    normal1: contact.normal1,
                    normal2: contact.normal2,
                    status: ShapeCastStatus::PenetratingOrWithinTargetDist,
                }));
            }
            Ok(details::cast_shapes_nonlinear_support_map_support_map(
                self,
                first_motion,
                first_map,
                first,
                second_motion,
                second_map,
                second,
                time,
                end,
                details::NonlinearShapeCastMode::StopAtPenetration,
            ))
        } else if let Some(composite) = first.as_composite_shape() {
            // 把同一方向规则传入每个子形状，地面网格与偏心木箱不能退回默认厚度门槛。
            Ok(details::cast_shapes_nonlinear_composite_shape_shape(
                self,
                first_motion,
                composite,
                second_motion,
                second,
                start,
                end,
                stop_at_penetration,
            ))
        } else if let Some(composite) = second.as_composite_shape() {
            Ok(details::cast_shapes_nonlinear_shape_composite_shape(
                self,
                first_motion,
                first,
                second_motion,
                composite,
                start,
                end,
                stop_at_penetration,
            ))
        } else {
            Err(Unsupported)
        }
    }
}

/// 这是接触数值余量，不代表允许跨过薄墙；薄墙路径仍按真实形状连续求交。
const CONTACT_MARGIN: f32 = 0.001;

/// 最大法向速度来自支撑映射，覆盖整个形状而非单个接触点。
fn maximum_rotation_closing(
    motion: &NonlinearRigidMotion,
    shape: &dyn SupportMap,
    pose: Pose,
    normal: Vec3,
) -> f32 {
    let direction = pose.rotation.inverse() * normal.cross(motion.angvel);
    if direction.length_squared() == 0.0 {
        return 0.0;
    }
    (shape.local_support_point(direction) - motion.local_center).dot(direction)
}

/// 法向速度的变化率上界；绕法线转动时为零，所以水平转向不会误判平地切向接触。
fn rotation_curvature(motion: &NonlinearRigidMotion, shape: &dyn Shape, normal: Vec3) -> f32 {
    let sphere = shape.compute_local_bounding_sphere();
    let radius = (sphere.center - motion.local_center).length() + sphere.radius;
    normal.cross(motion.angvel).length() * motion.angvel.length() * radius
}

/// 共面三角片边缘不是新台阶；用真实平面证明整段不增加穿入，避免网格接缝产生侧向假命中。
fn stays_outside_triangle_plane(
    surface_motion: &NonlinearRigidMotion,
    surface: &dyn Shape,
    moving_motion: &NonlinearRigidMotion,
    moving: &dyn Shape,
    start: f32,
    end: f32,
    initial_plane: Option<ExistingContactPlane>,
) -> bool {
    if surface_motion.linvel != Vec3::ZERO || surface_motion.angvel != Vec3::ZERO {
        return false;
    }
    let Some(triangle) = surface.as_triangle() else {
        return false;
    };
    let Some(shape) = moving.as_support_map() else {
        return false;
    };
    let Some(local_normal) = triangle.normal() else {
        return false;
    };
    let surface_pose = surface_motion.position_at_time(start);
    let moving_pose = moving_motion.position_at_time(start);
    let plane_origin = surface_pose * triangle.a;
    let mut normal = surface_pose.rotation * local_normal;
    let center = moving_pose * moving.compute_local_bounding_sphere().center;
    if (center - plane_origin).dot(normal) < 0.0 {
        normal = -normal;
    }
    // 只有整个障碍的真实原接触平面可共享毫米余量；其他平面必须证明严格保持分离。
    let margin = if initial_plane.is_some_and(|plane| {
        plane.normal.dot(normal).abs() >= 1.0 - 1.0e-5
            && (plane.point - plane_origin).dot(normal).abs() <= CONTACT_MARGIN
    }) {
        CONTACT_MARGIN
    } else {
        0.0
    };
    let plane = ExistingContactPlane {
        point: plane_origin,
        normal,
    };
    let curvature = rotation_curvature(moving_motion, moving, normal);
    if let Some(cuboid) = moving.as_cuboid() {
        // 凸箱的八个极点覆盖整个形状；每点净距配自己的速度，避免混用不同角点的最坏值。
        (0..8).all(|vertex| {
            let direction = Vec3::new(
                if vertex & 1 == 0 { -1.0 } else { 1.0 },
                if vertex & 2 == 0 { -1.0 } else { 1.0 },
                if vertex & 4 == 0 { -1.0 } else { 1.0 },
            );
            plane_interval_is_clear(
                moving_motion,
                PlaneSupport::Vertex(cuboid.local_support_point(direction)),
                plane,
                curvature,
                margin,
                start,
                end,
                12,
            )
        })
    } else {
        plane_interval_is_clear(
            moving_motion,
            PlaneSupport::Shape(shape),
            plane,
            curvature,
            margin,
            start,
            end,
            12,
        )
    }
}

#[derive(Clone, Copy)]
enum PlaneSupport<'a> {
    Shape(&'a dyn SupportMap),
    Vertex(Vec3),
}

/// 长弧的二次上界过宽时细分证明区间；不能把几个无碰撞姿态当成整段安全。
fn plane_interval_is_clear(
    motion: &NonlinearRigidMotion,
    support: PlaneSupport<'_>,
    plane: ExistingContactPlane,
    curvature: f32,
    margin: f32,
    start: f32,
    end: f32,
    depth: u8,
) -> bool {
    let pose = motion.position_at_time(start);
    let (point, closing) = match support {
        PlaneSupport::Shape(shape) => (
            pose * shape.local_support_point(pose.rotation.inverse() * -plane.normal),
            motion.linvel.dot(-plane.normal)
                + maximum_rotation_closing(motion, shape, pose, -plane.normal),
        ),
        PlaneSupport::Vertex(vertex) => {
            let radius = pose.rotation * (vertex - motion.local_center);
            let velocity = motion.linvel + motion.angvel.cross(radius);
            (pose * vertex, velocity.dot(-plane.normal))
        }
    };
    let clearance = (point - plane.point).dot(plane.normal);
    if clearance < -margin {
        return false;
    }
    let remaining = end - start;
    let change = closing * remaining + 0.5 * curvature * remaining.powi(2);
    // 净距的凹二次下界在两端取最小值，因此这里证明整段，而非只检查实际终点姿态。
    if clearance - change >= -margin {
        return true;
    }
    let middle = (start + end) * 0.5;
    // 不能证明或浮点区间不能继续细分时，调用方仍执行完整非线性求交。
    depth > 0
        && middle > start
        && middle < end
        && plane_interval_is_clear(
            motion,
            support,
            plane,
            curvature,
            margin,
            start,
            middle,
            depth - 1,
        )
        && plane_interval_is_clear(
            motion,
            support,
            plane,
            curvature,
            margin,
            middle,
            end,
            depth - 1,
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::world_collision_layers;
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
        let end =
            Transform::from_xyz(1.0, 1.3, 0.0).with_rotation(Quat::from_rotation_y(FRAC_PI_2));
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

    fn assert_clear_wall_probe(
        motion: &NonlinearRigidMotion,
        collider: &Collider,
        wall: &Collider,
    ) {
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
                details::closest_points_support_map_support_map(
                    &relative,
                    &triangle,
                    cube,
                    f32::MAX,
                ),
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
                assert_clear_wall_probe(
                    &wall_probe_motion(origin, grip_z, angle),
                    &collider,
                    &wall,
                );
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
                assert_clear_wall_probe(
                    &wall_probe_motion(origin, grip_z, angle),
                    &collider,
                    &wall,
                );
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
}

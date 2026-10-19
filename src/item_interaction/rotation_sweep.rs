//! 以严格连续求交处理新阻挡，并允许真实已有接触沿分离方向运动。

use super::triangle_plane::{
    CONTACT_MARGIN, maximum_rotation_closing, rotation_curvature, stays_outside_triangle_plane,
};
use avian3d::{
    parry::{
        math::Pose,
        query::{
            ClosestPoints, Contact, DefaultQueryDispatcher, NonlinearRigidMotion, QueryDispatcher,
            ShapeCastHit, ShapeCastOptions, ShapeCastStatus, Unsupported, details,
        },
        shape::Shape,
    },
    prelude::Collider,
};
use bevy::prelude::*;

pub(super) fn path_hits(
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
pub(super) struct ExistingContactPlane {
    pub(super) point: Vec3,
    pub(super) normal: Vec3,
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

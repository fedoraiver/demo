//! 通过支撑映射与区间位移上界证明三角平面不会引入新穿入，无法证明则回退完整求交。

use super::rotation_sweep::ExistingContactPlane;
use avian3d::parry::{
    math::Pose,
    query::NonlinearRigidMotion,
    shape::{Shape, SupportMap},
};
use bevy::prelude::*;

/// 以米计的接触数值余量，不代表允许跨过薄墙；薄墙路径仍按真实形状连续求交。
pub(super) const CONTACT_MARGIN: f32 = 0.001;
// 单位法线点积距平行的无量纲误差，只用于辨认可共享余量的原接触平面。
const CONTACT_PLANE_NORMAL_DOT_TOLERANCE: f32 = 1.0e-5;
// 证明区间最多二分的层数；无法证明安全时仍回退完整连续求交。
const MAX_PLANE_PROOF_SUBDIVISION_DEPTH: u8 = 12;

/// 最大法向速度来自支撑映射，覆盖整个形状而非单个接触点。
pub(super) fn maximum_rotation_closing(
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
pub(super) fn rotation_curvature(
    motion: &NonlinearRigidMotion,
    shape: &dyn Shape,
    normal: Vec3,
) -> f32 {
    let sphere = shape.compute_local_bounding_sphere();
    let radius = (sphere.center - motion.local_center).length() + sphere.radius;
    normal.cross(motion.angvel).length() * motion.angvel.length() * radius
}

/// 共面三角片边缘不是新台阶；用真实平面证明整段不增加穿入，避免网格接缝产生侧向假命中。
pub(super) fn stays_outside_triangle_plane(
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
        plane.normal.dot(normal).abs() >= 1.0 - CONTACT_PLANE_NORMAL_DOT_TOLERANCE
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
                MAX_PLANE_PROOF_SUBDIVISION_DEPTH,
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
            MAX_PLANE_PROOF_SUBDIVISION_DEPTH,
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

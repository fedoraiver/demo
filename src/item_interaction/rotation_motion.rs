//! 将有向转向和拾取姿态过渡表达为归一化时间内的连续刚体运动。

use avian3d::{
    parry::{math::Pose, query::NonlinearRigidMotion},
    prelude::ColliderTransform,
};
use bevy::prelude::*;

// 一段归一化运动的最小有效变化；角位移与线位移分别使用弧度平方和米平方。
const MIN_ANGULAR_DISPLACEMENT_SQUARED_RAD2: f32 = 1.0e-12;
const MIN_LINEAR_DISPLACEMENT_SQUARED_M2: f32 = 1.0e-12;

/// 把整段转向归一化到一个时间单位；箱体既绕人物公转，也改变自身朝向。
#[cfg(test)]
pub(super) fn rotation_motion(
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

pub(super) fn pivot_motion(
    holder_origin: Vec3,
    start_yaw: Quat,
    angular: Vec3,
    local: ColliderTransform,
) -> Option<NonlinearRigidMotion> {
    if angular.length_squared() <= MIN_ANGULAR_DISPLACEMENT_SQUARED_RAD2 {
        return None;
    }
    let rotation = start_yaw * local.rotation;
    let position = holder_origin + start_yaw * local.translation;
    let local_pivot = rotation.inverse() * (holder_origin - position);
    Some(NonlinearRigidMotion::new(
        Pose::from_parts(position, rotation),
        local_pivot,
        Vec3::ZERO,
        angular,
    ))
}

pub(super) fn pose_motion(start: Transform, end: Transform) -> Option<NonlinearRigidMotion> {
    let angular = shortest_arc(start.rotation, end.rotation);
    let linear = end.translation - start.translation;
    if angular.length_squared() <= MIN_ANGULAR_DISPLACEMENT_SQUARED_RAD2
        && linear.length_squared() <= MIN_LINEAR_DISPLACEMENT_SQUARED_M2
    {
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

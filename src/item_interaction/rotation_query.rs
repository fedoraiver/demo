//! 使用 Avian 空间索引筛选邻近障碍，再对真实形状执行完整路径检查。

#[cfg(test)]
use super::rotation_motion::rotation_motion;
use super::{
    rotation_motion::{pivot_motion, pose_motion},
    rotation_sweep::path_hits,
};
use crate::physics::held_collision_layers;
use avian3d::{
    parry::{math::Pose, query::NonlinearRigidMotion},
    prelude::*,
};
use bevy::{ecs::system::SystemParam, prelude::*};

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

//! 固定步读取角色意图并施加控制力，接地与速度观察直接读取 Avian 状态。

use avian3d::prelude::*;
use bevy::prelude::*;

use super::{Character, CharacterIntent, CharacterMotion};
use crate::{
    item_interaction::{HeldBy, HeldCollider},
    settings::PrototypeConfig,
};

const GROUND_PROBE_RADIUS_RATIO: f32 = 0.8;
const GROUND_PROBE_DISTANCE_M: f32 = 0.12;
const GROUND_PROBE_MAX_RISING_SPEED_MPS: f32 = 0.5;
const GROUND_SUPPORT_MIN_NORMAL_Y: f32 = 0.65;
const VELOCITY_LOG_SAMPLE_INTERVAL_SECONDS: f64 = 0.5;

/// 脚底附近的小球向下探测支撑面；墙面法线和上升中的角色不能算接地。
pub(super) fn update_grounded(
    config: Res<PrototypeConfig>,
    spatial_query: SpatialQuery,
    colliders: Query<(
        Option<&CollisionLayers>,
        Has<HeldBy>,
        Has<HeldCollider>,
        Has<Sensor>,
    )>,
    mut characters: Query<
        (
            Entity,
            &Position,
            &LinearVelocity,
            Option<&CollisionLayers>,
            &mut CharacterMotion,
        ),
        With<Character>,
    >,
) {
    let probe = Collider::sphere(config.character_radius * GROUND_PROBE_RADIUS_RATIO);
    for (entity, position, velocity, layers, mut motion) in &mut characters {
        let filter = SpatialQueryFilter::from_excluded_entities([entity]);
        let character_layers = layers.copied().unwrap_or_default();
        let mut grounded = false;
        if velocity.y <= GROUND_PROBE_MAX_RISING_SPEED_MPS {
            // 空间查询只按目标所属层过滤；支撑还必须满足双方碰撞掩码并排除持握物和传感器。
            // 遍历所有命中，避免最近的侧墙挡住稍远的有效地面。
            spatial_query.shape_hits_callback(
                &probe,
                position.0 + Vec3::Y * config.character_radius,
                Quat::IDENTITY,
                Dir3::NEG_Y,
                &ShapeCastConfig::from_max_distance(GROUND_PROBE_DISTANCE_M),
                &filter,
                |hit| {
                    if let Ok((layers, held, held_proxy, sensor)) = colliders.get(hit.entity) {
                        // 手持的实际碰撞代理没有 HeldBy，不能被脚底探测误判为外部支撑。
                        grounded |= !held
                            && !held_proxy
                            && !sensor
                            && character_layers.interacts_with(layers.copied().unwrap_or_default())
                            && hit.normal1.y >= GROUND_SUPPORT_MIN_NORMAL_Y;
                    }
                    !grounded
                },
            );
        }
        if grounded != motion.grounded {
            info!(target: "demo::gameplay",
                ?entity,
                before = motion.grounded,
                after = grounded,
                vertical_velocity = velocity.y,
                reason = "support_probe",
                "Character grounded state changed"
            );
            if grounded {
                info!(target: "demo::gameplay",
                    ?entity,
                    landing_velocity = velocity.y,
                    reason = "ground_contact",
                    "Character landed"
                );
            }
            motion.grounded = grounded;
        }
    }
}

/// 用有上限的加速度趋近目标水平速度，保留碰撞和外部冲量造成的实际运动。
pub(super) fn move_characters(
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    mut characters: Query<
        (Forces, &Transform, &CharacterIntent, &CharacterMotion),
        With<Character>,
    >,
) {
    for (mut forces, transform, intent, motion) in &mut characters {
        let axes = intent.movement.clamp_length_max(1.0);
        // 空中松键保留惯性，地面松键使用较快的主动刹车。
        if !motion.grounded && axes == Vec2::ZERO {
            continue;
        }
        let limit = if !motion.grounded {
            config.air_acceleration
        } else if axes == Vec2::ZERO {
            config.braking_acceleration
        } else {
            config.acceleration
        };
        let target = transform.rotation * Vec3::new(axes.x, 0.0, -axes.y) * config.move_speed;
        let velocity = forces.linear_velocity();
        let horizontal = Vec3::new(velocity.x, 0.0, velocity.z);
        let acceleration = ((target - horizontal) / time.delta_secs()).clamp_length_max(limit);
        forces.apply_linear_acceleration(acceleration);
    }
}

/// 跳跃只消费一次，通过冲量改变速度；重力和位置积分全部交给 Avian。
pub(super) fn jump_characters(
    config: Res<PrototypeConfig>,
    mut characters: Query<
        (
            Entity,
            Forces,
            &ComputedMass,
            &mut CharacterIntent,
            &mut CharacterMotion,
        ),
        With<Character>,
    >,
) {
    for (entity, mut forces, mass, mut intent, mut motion) in &mut characters {
        if !std::mem::take(&mut intent.jump_pending) {
            continue;
        }
        if motion.grounded {
            let speed_before = forces.linear_velocity().y;
            forces
                .apply_linear_impulse(Vec3::Y * mass.value() * (config.jump_speed - speed_before));
            motion.grounded = false;
            info!(target: "demo::gameplay",
                ?entity,
                before = "grounded",
                after = "airborne",
                jump_speed = config.jump_speed,
                reason = "jump_action",
                "Character jumped"
            );
        } else {
            info!(target: "demo::gameplay", ?entity, reason = "already_airborne", "Jump request ignored");
        }
    }
}

/// 采样物理解算后的实际速度，便于检查加速度、刹车和碰撞反馈。
pub(super) fn log_character_velocity(
    time: Res<Time<Fixed>>,
    mut next_log_time: Local<f64>,
    characters: Query<(Entity, &LinearVelocity, &CharacterMotion), With<Character>>,
) {
    if time.elapsed_secs_f64() < *next_log_time {
        return;
    }
    *next_log_time = time.elapsed_secs_f64() + VELOCITY_LOG_SAMPLE_INTERVAL_SECONDS;
    for (entity, velocity, motion) in &characters {
        debug!(target: "demo::gameplay", ?entity, velocity = ?velocity.0, grounded = motion.grounded,
            reason = "physics_sample", "Character velocity sampled");
    }
}

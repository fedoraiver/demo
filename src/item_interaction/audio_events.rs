//! 从已解算的物品接触与持续握持误差产生反馈消息，不打开音频设备。

use super::{CarryGrip, HeldBy, Parcel};
use crate::{
    audio::{SoundCue, SoundRequest},
    character::Character,
    settings::PrototypeConfig,
};
use avian3d::prelude::*;
use bevy::{ecs::relationship::Relationship, prelude::*};
use std::collections::{HashMap, HashSet};

/// 反馈注册由物品交互插件调用；独立回归只组合这部分真实系统以隔离物理设备依赖。
pub(super) fn register_feedback(app: &mut App) {
    use crate::game_flow::{FixedGameplaySystems, gameplay_running};
    app.add_message::<SoundRequest>()
        .add_systems(
            FixedUpdate,
            warn_hold_strain
                .after(FixedGameplaySystems::Target)
                .run_if(gameplay_running),
        )
        .add_systems(
            FixedPostUpdate,
            emit_parcel_land
                .after(PhysicsSystems::StepSimulation)
                .run_if(gameplay_running),
        );
}

/// 预测接触可能早于撞击；每步检查支撑冲量，并锁存到完全离开支撑，避免漏声或静置重复。
#[derive(Default)]
struct LandingContacts {
    supported: HashSet<Entity>,
    reported: HashSet<Entity>,
}

fn emit_parcel_land(
    contacts: Res<ContactGraph>,
    parcels: Query<(), (With<Parcel>, Without<HeldBy>)>,
    mut state: Local<LandingContacts>,
    mut sounds: MessageWriter<SoundRequest>,
) {
    state.supported.clear();
    for pair in contacts
        .iter_active_touching()
        .chain(contacts.iter_sleeping_touching())
    {
        for (parcel, first) in [(pair.collider1, true), (pair.collider2, false)] {
            if !parcels.contains(parcel) {
                continue;
            }
            let mut landed = false;
            for manifold in &pair.manifolds {
                let support_y = if first {
                    -manifold.normal.y
                } else {
                    manifold.normal.y
                };
                if support_y >= 0.65 {
                    state.supported.insert(parcel);
                    landed |= manifold.total_normal_impulse() >= 1.8;
                }
            }
            if landed && state.reported.insert(parcel) {
                sounds.write(SoundRequest::new(SoundCue::ParcelLand, parcel));
                info!(target: "demo::audio_events",
                    ?parcel,
                    event = "parcel_land",
                    reason = "support_impact",
                    "Audio cue emitted"
                );
            }
        }
    }
    let LandingContacts {
        supported,
        reported,
    } = &mut *state;
    reported.retain(|parcel| supported.contains(parcel));
}

/// 用滞回与持续时间区分正常拾取拉近、瞬时惯性和持续受阻；每次失稳只提示一次。
#[derive(Default)]
pub(super) struct HoldStrain {
    holder: Option<Entity>,
    age: f32,
    strained_for: f32,
    warned: bool,
}

/// 持续偏离实际握点时提示一次，误差恢复后允许下一次告警。
pub(super) fn warn_hold_strain(
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    holders: Query<(&Position, &Transform), With<Character>>,
    parcels: Query<(Entity, &HeldBy, &Position, Option<&CarryGrip>), With<Parcel>>,
    mut strain: Local<HashMap<Entity, HoldStrain>>,
    mut sounds: MessageWriter<SoundRequest>,
) {
    strain.retain(|entity, _| parcels.contains(*entity));
    for (parcel, held_by, position, grip) in &parcels {
        let Ok((holder_position, holder_transform)) = holders.get(held_by.get()) else {
            strain.remove(&parcel);
            continue;
        };
        // 告警按物品实际持握偏移计算目标位置。
        let offset = grip.map_or(config.hold_offset, |grip| grip.0);
        let target = holder_position.0 + holder_transform.rotation * offset;
        let distance = position.0.distance(target);
        let state = strain.entry(parcel).or_default();
        // 同一包裹切换持有者时也重启宽限，不能沿用上一持有者的警告锁存。
        if state.holder != Some(held_by.get()) {
            *state = HoldStrain {
                holder: Some(held_by.get()),
                ..default()
            };
        }
        state.age += time.delta_secs();
        if distance < 0.45 {
            state.strained_for = 0.0;
            state.warned = false;
        } else if distance > 0.65 && state.age >= 0.5 {
            state.strained_for += time.delta_secs();
            if state.strained_for >= 0.35 && !state.warned {
                state.warned = true;
                sounds.write(SoundRequest::new(SoundCue::InstabilityWarning, parcel));
                info!(target: "demo::audio_events",
                    ?parcel,
                    event = "instability_warning",
                    distance,
                    reason = "sustained_hold_error",
                    "Audio cue emitted"
                );
            }
        } else {
            state.strained_for = 0.0;
        }
    }
}

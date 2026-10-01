//! 玩法只发出已发生的反馈消息；无窗口测试不安装 Kira 或打开音频设备。

use std::collections::{HashMap, HashSet};

use avian3d::prelude::*;
use bevy::prelude::*;

use crate::{
    app_flow::gameplay_running,
    gameplay::{Character, GameplaySystems, HeldBy, Parcel, PrototypeConfig},
};
use bevy::ecs::relationship::Relationship;

/// 稳定事件标识与音频清单对应；未来玩法在业务成功或失败时发送，不能从按键猜测结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SoundCue {
    MenuHover,
    MenuConfirm,
    MenuCancel,
    ParcelPickup,
    ParcelRelease,
    ParcelHandoff,
    ParcelLand,
    CartCollision,
    CharacterBounce,
    InstabilityWarning,
    DeliverySuccess,
    DeliveryFailure,
}

impl SoundCue {
    pub(crate) const ALL: [Self; 12] = [
        Self::MenuHover,
        Self::MenuConfirm,
        Self::MenuCancel,
        Self::ParcelPickup,
        Self::ParcelRelease,
        Self::ParcelHandoff,
        Self::ParcelLand,
        Self::CartCollision,
        Self::CharacterBounce,
        Self::InstabilityWarning,
        Self::DeliverySuccess,
        Self::DeliveryFailure,
    ];

    /// 与 manifest 的 event_ids 使用同一英文标识，便于日志与资产对应。
    pub(crate) const fn id(self) -> &'static str {
        match self {
            Self::MenuHover => "menu_hover",
            Self::MenuConfirm => "menu_confirm",
            Self::MenuCancel => "menu_cancel",
            Self::ParcelPickup => "parcel_pickup",
            Self::ParcelRelease => "parcel_release",
            Self::ParcelHandoff => "parcel_handoff",
            Self::ParcelLand => "parcel_land",
            Self::CartCollision => "cart_collision",
            Self::CharacterBounce => "character_bounce",
            Self::InstabilityWarning => "instability_warning",
            Self::DeliverySuccess => "delivery_success",
            Self::DeliveryFailure => "delivery_failure",
        }
    }
}

/// 业务实体只用于日志和节流，不持有其组件引用，实体销毁后消息仍可被消费。
#[derive(Message, Clone, Copy, Debug)]
pub(crate) struct SoundRequest {
    pub cue: SoundCue,
    pub source: Entity,
}

impl SoundRequest {
    pub(crate) fn new(cue: SoundCue, source: Entity) -> Self {
        Self { cue, source }
    }
}

/// 消息与物理反馈收集独立于设备播放，使玩法最小 App 保持无窗口、无音频输出。
pub(crate) struct SoundEventsPlugin;

impl Plugin for SoundEventsPlugin {
    fn build(&self, app: &mut App) {
        app.add_message::<SoundRequest>()
            .add_systems(
                FixedUpdate,
                // 复用会话条件；没有状态资源的最小物理测试仍能收集玩法反馈。
                warn_hold_strain
                    .after(GameplaySystems::Simulate)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedPostUpdate,
                emit_parcel_land
                    .after(PhysicsSystems::StepSimulation)
                    .run_if(gameplay_running),
            );
    }
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
                info!(
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
struct HoldStrain {
    holder: Option<Entity>,
    age: f32,
    strained_for: f32,
    warned: bool,
}

fn warn_hold_strain(
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    holders: Query<(&Position, &Transform), With<Character>>,
    parcels: Query<(Entity, &HeldBy, &Position), With<Parcel>>,
    mut strain: Local<HashMap<Entity, HoldStrain>>,
    mut sounds: MessageWriter<SoundRequest>,
) {
    strain.retain(|entity, _| parcels.contains(*entity));
    for (parcel, held_by, position) in &parcels {
        let Ok((holder_position, holder_transform)) = holders.get(held_by.get()) else {
            strain.remove(&parcel);
            continue;
        };
        let target = holder_position.0 + holder_transform.rotation * config.hold_offset;
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
                info!(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_flow::{AppState, PlayState};

    #[test]
    fn gameplay_feedback_stays_silent_in_main_menu_and_pause() {
        let mut app = App::new();
        app.init_resource::<PrototypeConfig>()
            .init_resource::<ContactGraph>()
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .insert_resource(State::new(AppState::MainMenu))
            .insert_resource(State::new(PlayState::Running))
            .add_plugins(SoundEventsPlugin);
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        let holder = app
            .world_mut()
            .spawn((Character, Position::default(), Transform::default()))
            .id();
        app.world_mut().spawn((
            Parcel,
            <HeldBy as Relationship>::from(holder),
            Position(Vec3::X * 5.0),
        ));
        let parcel = app.world_mut().spawn(Parcel).id();
        let ground = app.world_mut().spawn_empty().id();
        // 只提供已解算的接触数据，验证收集系统的会话门槛，不安装物理或输出设备。
        let mut point = ContactPoint::new(Vec3::ZERO, Vec3::ZERO, Vec3::ZERO, 0.0);
        point.normal_impulse = 2.0;
        app.world_mut()
            .resource_mut::<ContactGraph>()
            .add_edge_with(ContactEdge::new(parcel, ground), |pair| {
                pair.flags.insert(ContactPairFlags::TOUCHING);
                pair.manifolds = vec![ContactManifold::new([point], -Vec3::Y)];
            });
        for _ in 0..20 {
            app.world_mut().run_schedule(FixedUpdate);
            app.world_mut().run_schedule(FixedPostUpdate);
        }
        assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());

        app.insert_resource(State::new(AppState::InGame));
        app.world_mut().run_schedule(FixedUpdate);
        app.world_mut().run_schedule(FixedPostUpdate);
        let cues: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .map(|request| request.cue)
            .collect();
        assert_eq!(cues, [SoundCue::ParcelLand]);

        app.insert_resource(State::new(PlayState::Paused));
        for _ in 0..20 {
            app.world_mut().run_schedule(FixedUpdate);
            app.world_mut().run_schedule(FixedPostUpdate);
        }
        assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());
        app.insert_resource(State::new(PlayState::Running));
        for _ in 0..10 {
            app.world_mut().run_schedule(FixedUpdate);
            app.world_mut().run_schedule(FixedPostUpdate);
        }
        let cues: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .map(|request| request.cue)
            .collect();
        assert_eq!(cues, [SoundCue::InstabilityWarning]);
    }

    #[test]
    fn sustained_strain_warns_once_and_recovery_rearms() {
        let mut app = App::new();
        app.init_resource::<PrototypeConfig>()
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .add_message::<SoundRequest>()
            .add_systems(FixedUpdate, warn_hold_strain);
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        let holder = app
            .world_mut()
            .spawn((Character, Position::default(), Transform::default()))
            .id();
        let parcel = app
            .world_mut()
            .spawn((
                Parcel,
                <HeldBy as Relationship>::from(holder),
                Position(Vec3::X * 5.0),
            ))
            .id();
        for _ in 0..20 {
            app.world_mut().run_schedule(FixedUpdate);
        }
        let cues: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .collect();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].cue, SoundCue::InstabilityWarning);
        let target = app.world().resource::<PrototypeConfig>().hold_offset;
        app.world_mut().get_mut::<Position>(parcel).unwrap().0 = target;
        app.world_mut().run_schedule(FixedUpdate);
        app.world_mut().get_mut::<Position>(parcel).unwrap().0 = Vec3::X * 5.0;
        for _ in 0..10 {
            app.world_mut().run_schedule(FixedUpdate);
        }
        assert_eq!(
            app.world_mut()
                .resource_mut::<Messages<SoundRequest>>()
                .drain()
                .count(),
            1
        );
        app.world_mut().entity_mut(parcel).remove::<HeldBy>();
        app.world_mut().run_schedule(FixedUpdate);
        assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());
    }
}

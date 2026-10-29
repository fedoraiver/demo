//! 依据真实速度、接地和持有状态混合动作，并保持方向与跳跃阶段相位。

use avian3d::prelude::LinearVelocity;
use bevy::{ecs::relationship::RelationshipTarget, prelude::*};

use crate::{
    character::{Character, CharacterMotion},
    item_interaction::HoldingItems,
};

pub(super) const WALK_SPEED_THRESHOLD: f32 = 0.15;
pub(super) const FULL_WALK_BLEND_SPEED: f32 = 0.65;
pub(super) const BLEND_TIME_CONSTANT: f32 = 0.075;
pub(super) const AIRBORNE_DELAY: f32 = 0.06;
// 起跳覆盖接地标记与首次确认离地分属两项判定，速度单位均为米／秒。
pub(super) const TAKEOFF_MIN_VERTICAL_SPEED_MPS: f32 = 0.5;
pub(super) const AIRBORNE_MIN_VERTICAL_SPEED_MPS: f32 = 0.5;
pub(super) const RISING_ENTER_SPEED_MPS: f32 = 0.35;
const FALLING_ENTER_SPEED_MPS: f32 = -0.25;
const DOMINANT_ANIMATION_WEIGHT_HYSTERESIS: f32 = 0.1;
// 资产以 0.8 秒完成双步；前后每步约 0.6 米，横移每步约 0.44 米。
// 步频依实际物理速度计算，修改玩法目标速度不应直接改变该美术标定。
pub(super) const GAIT_CYCLE_DURATION: f32 = 0.8;
pub(super) const FORWARD_REFERENCE_SPEED: f32 = 1.5;
pub(super) const SIDEWAYS_REFERENCE_SPEED: f32 = 1.1;
pub(super) const ANIMATION_COUNT: usize = 16;
pub(super) const JUMP_VISUAL_DURATION: f32 = 0.24;
pub(super) const LAND_VISUAL_DURATION: f32 = 0.22;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub(super) enum CourierAnimationState {
    Idle,
    Walk,
    WalkBackward,
    WalkLeft,
    WalkRight,
    CarryIdle,
    CarryWalk,
    CarryBackward,
    CarryLeft,
    CarryRight,
    Jump,
    Fall,
    CarryJump,
    CarryFall,
    Land,
    CarryLand,
}

impl CourierAnimationState {
    pub(super) const ALL: [Self; ANIMATION_COUNT] = [
        Self::Idle,
        Self::Walk,
        Self::WalkBackward,
        Self::WalkLeft,
        Self::WalkRight,
        Self::CarryIdle,
        Self::CarryWalk,
        Self::CarryBackward,
        Self::CarryLeft,
        Self::CarryRight,
        Self::Jump,
        Self::Fall,
        Self::CarryJump,
        Self::CarryFall,
        Self::Land,
        Self::CarryLand,
    ];

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Walk => "Walk",
            Self::WalkBackward => "Walk_Backward",
            Self::WalkLeft => "Walk_Left",
            Self::WalkRight => "Walk_Right",
            Self::CarryIdle => "Carry_Idle",
            Self::CarryWalk => "Carry_Walk",
            Self::CarryBackward => "Carry_Backward",
            Self::CarryLeft => "Carry_Left",
            Self::CarryRight => "Carry_Right",
            Self::Jump => "Jump",
            Self::Fall => "Fall",
            Self::CarryJump => "Carry_Jump",
            Self::CarryFall => "Carry_Fall",
            Self::Land => "Land",
            Self::CarryLand => "Carry_Land",
        }
    }

    pub(super) fn is_locomotion(self) -> bool {
        matches!(self as usize, 1..=4 | 6..=9)
    }

    pub(super) fn is_jump_phase(self) -> bool {
        matches!(self as usize, 10..=15)
    }

    pub(super) fn is_one_shot(self) -> bool {
        matches!(
            self,
            Self::Jump | Self::CarryJump | Self::Land | Self::CarryLand
        )
    }
}

/// 跳跃阶段只决定视觉采样；接地和竖直速度仍由真实物理模拟提供。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CourierJumpPhase {
    Grounded,
    Rising,
    Falling,
    Landing,
}

impl CourierJumpPhase {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Grounded => "grounded",
            Self::Rising => "rising",
            Self::Falling => "falling",
            Self::Landing => "landing",
        }
    }
}

/// 动作节点属于本次生成的图，不依赖 glTF 文件中的动画排列索引。
#[derive(Clone, Copy)]
pub(super) struct CourierAnimationNodes {
    pub(super) indices: [AnimationNodeIndex; ANIMATION_COUNT],
    pub(super) durations: [f32; ANIMATION_COUNT],
}

impl CourierAnimationNodes {
    pub(super) fn node(self, state: CourierAnimationState) -> AnimationNodeIndex {
        self.indices[state as usize]
    }
}

/// 只保存视觉混合与步相位；速度、朝向、接地及持有状态仍由业务组件提供。
#[derive(Component)]
pub(super) struct CourierAnimation {
    pub(super) character: Entity,
    pub(super) nodes: CourierAnimationNodes,
    pub(super) weights: [f32; ANIMATION_COUNT],
    pub(super) gait_phase: f32,
    pub(super) grounded: bool,
    pub(super) ungrounded_time: f32,
    pub(super) rising: bool,
    pub(super) airborne_confirmed: bool,
    pub(super) jump_phase: CourierJumpPhase,
    pub(super) jump_elapsed: f32,
    pub(super) fall_elapsed: f32,
    pub(super) landing_elapsed: f32,
    // 日志使用带滞回的主动作名；视觉输出始终读取完整连续权重。
    pub(super) current: CourierAnimationState,
}

impl CourierAnimation {
    pub(super) fn update_grounded(&mut self, motion: &CharacterMotion, velocity: Vec3, delta: f32) {
        // 起跳当帧的向上速度优先于尚未刷新的接地标记，不能多播一帧站姿。
        if velocity.y > TAKEOFF_MIN_VERTICAL_SPEED_MPS {
            self.grounded = false;
            self.ungrounded_time = 0.0;
        } else if motion.grounded {
            self.grounded = true;
            self.ungrounded_time = 0.0;
        } else {
            self.ungrounded_time += delta;
            // 真实起跳立即接入空中姿态；台阶或接地探测的短暂丢失保留地面动作。
            if velocity.y > TAKEOFF_MIN_VERTICAL_SPEED_MPS || self.ungrounded_time >= AIRBORNE_DELAY
            {
                self.grounded = false;
            }
        }
        // 最高点附近保留此前姿态，避免垂直速度的小幅噪声使动作来回切换。
        if velocity.y > RISING_ENTER_SPEED_MPS {
            self.rising = true;
        } else if velocity.y < FALLING_ENTER_SPEED_MPS {
            self.rising = false;
        }
        // 首次绑定可能早于第一次支撑探测；只有明确竖直运动或持续离地才允许落地缓冲。
        // 真实高处坠落即使从零速度开始，也会在无支撑达到过滤时限后被确认。
        if !self.grounded
            && (velocity.y.abs() > AIRBORNE_MIN_VERTICAL_SPEED_MPS
                || self.ungrounded_time >= AIRBORNE_DELAY)
        {
            self.airborne_confirmed = true;
        }
        let next = if !self.grounded {
            if self.rising {
                CourierJumpPhase::Rising
            } else {
                CourierJumpPhase::Falling
            }
        } else {
            match self.jump_phase {
                CourierJumpPhase::Rising | CourierJumpPhase::Falling if self.airborne_confirmed => {
                    CourierJumpPhase::Landing
                }
                CourierJumpPhase::Landing
                    if self.landing_elapsed + delta < LAND_VISUAL_DURATION =>
                {
                    CourierJumpPhase::Landing
                }
                _ => CourierJumpPhase::Grounded,
            }
        };
        if next != self.jump_phase {
            // 各阶段保存独立进度，旧动作淡出时保留尾姿；拿放不能重置同阶段的时钟。
            match next {
                CourierJumpPhase::Rising => self.jump_elapsed = 0.0,
                CourierJumpPhase::Falling => self.fall_elapsed = 0.0,
                CourierJumpPhase::Landing => self.landing_elapsed = 0.0,
                CourierJumpPhase::Grounded => self.landing_elapsed = LAND_VISUAL_DURATION,
            }
            self.jump_phase = next;
        } else {
            match next {
                CourierJumpPhase::Rising => {
                    self.jump_elapsed = (self.jump_elapsed + delta).min(JUMP_VISUAL_DURATION)
                }
                CourierJumpPhase::Falling => self.fall_elapsed += delta,
                CourierJumpPhase::Landing => {
                    self.landing_elapsed = (self.landing_elapsed + delta).min(LAND_VISUAL_DURATION)
                }
                CourierJumpPhase::Grounded => {}
            }
        }
        if self.grounded {
            self.airborne_confirmed = false;
        }
    }

    pub(super) fn jump_sample_time(&self, state: CourierAnimationState, duration: f32) -> f32 {
        match state {
            CourierAnimationState::Jump | CourierAnimationState::CarryJump => {
                (self.jump_elapsed / JUMP_VISUAL_DURATION).min(1.0) * duration
            }
            CourierAnimationState::Fall | CourierAnimationState::CarryFall => {
                self.fall_elapsed.rem_euclid(duration)
            }
            CourierAnimationState::Land | CourierAnimationState::CarryLand => {
                (self.landing_elapsed / LAND_VISUAL_DURATION).min(1.0) * duration
            }
            _ => unreachable!("only jump phases have phase sample times"),
        }
    }
}

pub(super) struct AnimationTarget {
    pub(super) weights: [f32; ANIMATION_COUNT],
    pub(super) cycles_per_second: f32,
}

pub(super) fn has_held_item(holding: Option<&HoldingItems>) -> bool {
    holding.is_some_and(|items| items.iter().next().is_some())
}

/// 将真实速度转到角色局部空间：前方是 -Z，鼠标转向后同帧即可得到新的混合方向。
pub(super) fn animation_target(
    velocity: Vec3,
    rotation: Quat,
    grounded: bool,
    rising: bool,
    carrying: bool,
) -> AnimationTarget {
    let mut weights = [0.0; ANIMATION_COUNT];
    if !grounded {
        let state = match (carrying, rising) {
            (false, true) => CourierAnimationState::Jump,
            (false, false) => CourierAnimationState::Fall,
            (true, true) => CourierAnimationState::CarryJump,
            (true, false) => CourierAnimationState::CarryFall,
        };
        weights[state as usize] = 1.0;
        return AnimationTarget {
            weights,
            cycles_per_second: 0.0,
        };
    }
    let local = rotation.inverse() * Vec3::new(velocity.x, 0.0, velocity.z);
    let local_velocity = Vec2::new(local.x, -local.z);
    let speed = local_velocity.length();
    let movement = ((speed - WALK_SPEED_THRESHOLD)
        / (FULL_WALK_BLEND_SPEED - WALK_SPEED_THRESHOLD))
        .clamp(0.0, 1.0);
    let movement = movement * movement * (3.0 - 2.0 * movement);
    let idle = if carrying {
        CourierAnimationState::CarryIdle
    } else {
        CourierAnimationState::Idle
    };
    weights[idle as usize] = 1.0 - movement;
    if movement == 0.0 {
        return AnimationTarget {
            weights,
            cycles_per_second: 0.0,
        };
    }
    // 先按资产标定步长修正方向，保证横移与前进混合后的脚轨迹仍沿真实速度。
    let scaled = local_velocity / Vec2::new(SIDEWAYS_REFERENCE_SPEED, FORWARD_REFERENCE_SPEED);
    let directions = [
        scaled.y.max(0.0),
        (-scaled.y).max(0.0),
        (-scaled.x).max(0.0),
        scaled.x.max(0.0),
    ];
    let direction_sum: f32 = directions.iter().sum();
    let directions = directions.map(|weight| weight / direction_sum);
    let first = if carrying {
        CourierAnimationState::CarryWalk
    } else {
        CourierAnimationState::Walk
    } as usize;
    for (index, direction) in directions.iter().enumerate() {
        weights[first + index] = direction * movement;
    }
    // 对角线混合会缩短步幅，不能只使用基准速度的算术平均，否则斜走明显滑脚。
    let reference_velocity = Vec2::new(
        (directions[3] - directions[2]) * SIDEWAYS_REFERENCE_SPEED,
        (directions[0] - directions[1]) * FORWARD_REFERENCE_SPEED,
    );
    AnimationTarget {
        weights,
        cycles_per_second: speed / (reference_velocity.length() * GAIT_CYCLE_DURATION),
    }
}

pub(super) fn dominant_animation(
    weights: &[f32; ANIMATION_COUNT],
    previous: CourierAnimationState,
) -> CourierAnimationState {
    CourierAnimationState::ALL
        .into_iter()
        .fold(previous, |current, candidate| {
            if weights[candidate as usize]
                > weights[current as usize] + DOMINANT_ANIMATION_WEIGHT_HYSTERESIS
            {
                candidate
            } else {
                current
            }
        })
}

/// Update 位于固定模拟与呈现同步之后；零固定步帧也使用本帧朝向和已有真实速度。
pub(super) fn sync_courier_animation(
    mut commands: Commands,
    time: Res<Time>,
    characters: Query<
        (
            &LinearVelocity,
            &Transform,
            &CharacterMotion,
            Option<&HoldingItems>,
        ),
        With<Character>,
    >,
    mut players: Query<(Entity, &mut AnimationPlayer, &mut CourierAnimation)>,
) {
    let delta = time.delta_secs();
    // 指数平滑与渲染帧率无关：时间常数为 75 ms，约 225 ms 接近目标权重。
    let blend = 1.0 - (-delta / BLEND_TIME_CONSTANT).exp();
    for (player_entity, mut player, mut animation) in &mut players {
        let Ok((velocity, transform, motion, holding)) = characters.get(animation.character) else {
            player.stop_all();
            commands
                .entity(player_entity)
                .remove::<(CourierAnimation, AnimationGraphHandle)>();
            warn!(target: "demo::character_animation", ?player_entity,
                character = ?animation.character, reason = "character_missing",
                "Courier animation detached");
            continue;
        };
        let previous_jump_phase = animation.jump_phase;
        animation.update_grounded(motion, velocity.0, delta);
        if animation.jump_phase != previous_jump_phase {
            info!(target: "demo::character_animation", ?player_entity,
                character = ?animation.character,
                phase_before = previous_jump_phase.name(), phase_after = animation.jump_phase.name(),
                reason = "physical_jump_phase_changed", "Courier jump phase changed");
        }
        let mut target = animation_target(
            velocity.0,
            transform.rotation,
            animation.grounded,
            animation.rising,
            has_held_item(holding),
        );
        if animation.jump_phase == CourierJumpPhase::Landing {
            // 真正空中转接地才播放一次缓冲；短暂探测噪声不会打断方向步相位。
            let state = if has_held_item(holding) {
                CourierAnimationState::CarryLand
            } else {
                CourierAnimationState::Land
            };
            target.weights = [0.0; ANIMATION_COUNT];
            target.weights[state as usize] = 1.0;
            target.cycles_per_second = 0.0;
        }
        animation.gait_phase =
            (animation.gait_phase + delta * target.cycles_per_second).rem_euclid(1.0);
        for state in CourierAnimationState::ALL {
            let index = state as usize;
            let current_weight = animation.weights[index];
            animation.weights[index] =
                current_weight + (target.weights[index] - current_weight) * blend;
            let active = player.play(animation.nodes.node(state));
            active.set_weight(animation.weights[index]);
            if state.is_locomotion() {
                // 统一归一化步相位跨方向与持箱片段同步；PostUpdate 不再独立推进它们。
                // 片段只有骨骼姿态、没有动画事件，seek 不会跳过玩法或脚步事件。
                active
                    .set_speed(0.0)
                    .set_seek_time(animation.gait_phase * animation.nodes.durations[index]);
            } else if state.is_jump_phase() {
                // Bevy 即使 speed=0 也会把 duration 端点环回到 0；暂停自动推进后显式采样，
                // 才能保持非循环动作的最后一帧，并让空手与持箱沿用同一阶段进度。
                active.pause().set_speed(0.0).set_seek_time(
                    animation.jump_sample_time(state, animation.nodes.durations[index]),
                );
            }
        }
        let next = dominant_animation(&target.weights, animation.current);
        if next != animation.current {
            info!(target: "demo::character_animation", ?player_entity,
                character = ?animation.character,
                animation_before = animation.current.name(), animation_after = next.name(),
                reason = "velocity_grounding_or_holding_changed", "Courier animation changed");
            animation.current = next;
        }
    }
}

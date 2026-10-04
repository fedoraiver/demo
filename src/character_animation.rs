//! 快递员视觉动画读取实际物理速度、同帧朝向与持有关系，不驱动业务根运动。

use avian3d::prelude::LinearVelocity;
use bevy::{
    animation::RepeatAnimation, app::AnimationSystems, ecs::relationship::RelationshipTarget,
    prelude::*, world_serialization::WorldInstanceReady,
};

use crate::{
    app_flow::gameplay_running,
    gameplay::{Character, CharacterMotion, HoldingItems},
};

const WALK_SPEED_THRESHOLD: f32 = 0.15;
const FULL_WALK_BLEND_SPEED: f32 = 0.65;
const BLEND_TIME_CONSTANT: f32 = 0.075;
const AIRBORNE_DELAY: f32 = 0.06;
// 资产以 0.8 秒完成双步；前后每步约 0.6 米，横移每步约 0.44 米。
// 步频依实际物理速度计算，修改玩法目标速度不应直接改变该美术标定。
const GAIT_CYCLE_DURATION: f32 = 0.8;
const FORWARD_REFERENCE_SPEED: f32 = 1.5;
const SIDEWAYS_REFERENCE_SPEED: f32 = 1.1;
const ANIMATION_COUNT: usize = 16;
const JUMP_VISUAL_DURATION: f32 = 0.24;
const LAND_VISUAL_DURATION: f32 = 0.22;
const SOLE_CLEARANCE: f32 = 0.003;
const SOLE_MARKER_NAMES: [&str; 8] = [
    "Courier_Sole_L_0",
    "Courier_Sole_L_1",
    "Courier_Sole_L_2",
    "Courier_Sole_L_3",
    "Courier_Sole_R_0",
    "Courier_Sole_R_1",
    "Courier_Sole_R_2",
    "Courier_Sole_R_3",
];

/// 挂在 Character 直属视觉根上的 glTF 引用；只有标记的快递员接入玩法动画。
#[derive(Component, Clone, Default, FromTemplate)]
#[require(Transform)]
pub struct CourierVisual(pub Handle<Gltf>);

/// 等待 glTF 场景和命名动画都可用，避免异步子资产先完成时错过初始化。
#[derive(Component)]
struct CourierAnimationPending;

/// 导出鞋底四角作为骨骼子节点；接地补偿只抬视觉根，不改物理或持握来源。
#[derive(Component, Clone, Copy)]
struct CourierFootGrounding {
    character: Entity,
    animation_player: Entity,
    sole_markers: [Entity; 8],
    base_translation: Vec3,
    offset: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
enum CourierAnimationState {
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
    const ALL: [Self; ANIMATION_COUNT] = [
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

    fn name(self) -> &'static str {
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

    fn is_locomotion(self) -> bool {
        matches!(self as usize, 1..=4 | 6..=9)
    }

    fn is_jump_phase(self) -> bool {
        matches!(self as usize, 10..=15)
    }

    fn is_one_shot(self) -> bool {
        matches!(
            self,
            Self::Jump | Self::CarryJump | Self::Land | Self::CarryLand
        )
    }
}

/// 跳跃阶段只决定视觉采样；接地和竖直速度仍由真实物理模拟提供。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CourierJumpPhase {
    Grounded,
    Rising,
    Falling,
    Landing,
}

impl CourierJumpPhase {
    fn name(self) -> &'static str {
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
struct CourierAnimationNodes {
    indices: [AnimationNodeIndex; ANIMATION_COUNT],
    durations: [f32; ANIMATION_COUNT],
}

impl CourierAnimationNodes {
    fn node(self, state: CourierAnimationState) -> AnimationNodeIndex {
        self.indices[state as usize]
    }
}

/// 只保存视觉混合与步相位；速度、朝向、接地及持有状态仍由业务组件提供。
#[derive(Component)]
struct CourierAnimation {
    character: Entity,
    nodes: CourierAnimationNodes,
    weights: [f32; ANIMATION_COUNT],
    gait_phase: f32,
    grounded: bool,
    ungrounded_time: f32,
    rising: bool,
    airborne_confirmed: bool,
    jump_phase: CourierJumpPhase,
    jump_elapsed: f32,
    fall_elapsed: f32,
    landing_elapsed: f32,
    // 日志使用带滞回的主动作名；视觉输出始终读取完整连续权重。
    current: CourierAnimationState,
}

impl CourierAnimation {
    fn update_grounded(&mut self, motion: &CharacterMotion, velocity: Vec3, delta: f32) {
        // 起跳当帧的向上速度优先于尚未刷新的接地标记，不能多播一帧站姿。
        if velocity.y > 0.5 {
            self.grounded = false;
            self.ungrounded_time = 0.0;
        } else if motion.grounded {
            self.grounded = true;
            self.ungrounded_time = 0.0;
        } else {
            self.ungrounded_time += delta;
            // 真实起跳立即接入空中姿态；台阶或接地探测的短暂丢失保留地面动作。
            if velocity.y > 0.5 || self.ungrounded_time >= AIRBORNE_DELAY {
                self.grounded = false;
            }
        }
        // 最高点附近保留此前姿态，避免垂直速度的小幅噪声使动作来回切换。
        if velocity.y > 0.35 {
            self.rising = true;
        } else if velocity.y < -0.25 {
            self.rising = false;
        }
        // 首次绑定可能早于第一次支撑探测；只有明确竖直运动或持续离地才允许落地缓冲。
        // 真实高处坠落即使从零速度开始，也会在无支撑达到过滤时限后被确认。
        if !self.grounded && (velocity.y.abs() > 0.5 || self.ungrounded_time >= AIRBORNE_DELAY) {
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

    fn jump_sample_time(&self, state: CourierAnimationState, duration: f32) -> f32 {
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

struct AnimationTarget {
    weights: [f32; ANIMATION_COUNT],
    cycles_per_second: f32,
}

/// 注册场景就绪后的动画绑定，以及固定模拟和同帧呈现朝向同步后的动作混合。
pub(crate) struct CharacterAnimationPlugin;

impl Plugin for CharacterAnimationPlugin {
    fn build(&self, app: &mut App) {
        app.add_observer(mark_courier_animation_ready)
            .add_systems(
                Update,
                // RunFixedMainLoop 已同步本帧角色朝向；链保证新绑定对混合系统立即可见。
                (initialize_ready_couriers, sync_courier_animation)
                    .chain()
                    .run_if(gameplay_running),
            )
            .add_systems(
                PostUpdate,
                // 必须读取本帧已求值的骨骼局部姿态，并在最终变换传播前写回视觉补偿。
                compensate_courier_sole_penetration
                    .after(AnimationSystems)
                    .before(TransformSystems::Propagate)
                    .run_if(gameplay_running),
            );
    }
}

fn mark_courier_animation_ready(
    ready: On<WorldInstanceReady>,
    mut commands: Commands,
    couriers: Query<(), With<CourierVisual>>,
) {
    if couriers.contains(ready.entity) {
        commands
            .entity(ready.entity)
            .insert(CourierAnimationPending);
    }
}

/// 场景就绪后只遍历该视觉根的子树，避免把 NPC 或其他模型的播放器接到主角上。
fn initialize_ready_couriers(
    mut commands: Commands,
    roots: Query<(Entity, &CourierVisual, &ChildOf, &Transform), With<CourierAnimationPending>>,
    characters: Query<
        (
            &LinearVelocity,
            &Transform,
            &CharacterMotion,
            Option<&HoldingItems>,
        ),
        With<Character>,
    >,
    children: Query<&Children>,
    names: Query<&Name>,
    gltfs: Res<Assets<Gltf>>,
    clips: Res<Assets<AnimationClip>>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
    mut players: Query<&mut AnimationPlayer>,
) {
    for (visual_root, visual, parent, visual_transform) in &roots {
        let character = parent.parent();
        let Ok((velocity, transform, motion, holding)) = characters.get(character) else {
            warn!(target: "demo::character_animation", ?visual_root, ?character,
                reason = "invalid_character_parent", "Courier animation binding skipped");
            commands
                .entity(visual_root)
                .remove::<CourierAnimationPending>();
            continue;
        };
        let Some(gltf) = gltfs.get(&visual.0) else {
            continue;
        };
        let named_clips: Result<Vec<_>, _> = CourierAnimationState::ALL
            .iter()
            .map(|state| {
                gltf.named_animations
                    .get(state.name())
                    .cloned()
                    .ok_or(state.name())
            })
            .collect();
        let named_clips = match named_clips {
            Ok(named_clips) => named_clips,
            Err(animation_name) => {
                error!(target: "demo::character_animation", ?visual_root, ?character,
                    animation_name, reason = "missing_named_animation",
                    "Courier animation binding failed");
                commands
                    .entity(visual_root)
                    .remove::<CourierAnimationPending>();
                continue;
            }
        };
        // 命名句柄存在不代表异步片段已经入库；等待所有时长后再建立统一相位。
        let durations: Option<Vec<_>> = named_clips
            .iter()
            .map(|handle| clips.get(handle).map(AnimationClip::duration))
            .collect();
        let Some(durations) = durations else {
            continue;
        };
        if let Some(index) = durations
            .iter()
            .position(|duration| !duration.is_finite() || *duration <= 0.0)
        {
            error!(target: "demo::character_animation", ?visual_root, ?character,
                animation_name = CourierAnimationState::ALL[index].name(),
                duration = durations[index], reason = "invalid_animation_duration",
                "Courier animation binding failed");
            commands
                .entity(visual_root)
                .remove::<CourierAnimationPending>();
            continue;
        }
        let (graph, indices) = AnimationGraph::from_clips(named_clips);
        let nodes = CourierAnimationNodes {
            indices: indices
                .try_into()
                .expect("all named animations were loaded"),
            durations: durations
                .try_into()
                .expect("all animation durations were loaded"),
        };
        let graph_handle = graphs.add(graph);
        let rising = velocity.y > 0.35;
        let grounded = motion.grounded && velocity.y <= 0.5;
        let jump_phase = if grounded {
            CourierJumpPhase::Grounded
        } else if rising {
            CourierJumpPhase::Rising
        } else {
            CourierJumpPhase::Falling
        };
        let target = animation_target(
            velocity.0,
            transform.rotation,
            grounded,
            rising,
            has_held_item(holding),
        );
        let current = dominant_animation(&target.weights, CourierAnimationState::Idle);
        let mut player_count = 0;
        let mut first_player = None;
        for descendant in children.iter_descendants(visual_root) {
            let Ok(mut player) = players.get_mut(descendant) else {
                continue;
            };
            // 全部片段保持关联；方向变化和拾取不重播，避免左右脚相位突然归零。
            player.stop_all();
            for state in CourierAnimationState::ALL {
                let active = player.play(nodes.node(state));
                active.repeat().set_weight(target.weights[state as usize]);
                if state.is_locomotion() {
                    active.set_speed(0.0);
                } else if state.is_jump_phase() {
                    active.pause().set_speed(0.0);
                    if state.is_one_shot() {
                        active.set_repeat(RepeatAnimation::Never);
                    }
                }
            }
            commands.entity(descendant).remove::<AnimationTransitions>();
            commands.entity(descendant).insert((
                AnimationGraphHandle(graph_handle.clone()),
                CourierAnimation {
                    character,
                    nodes,
                    weights: target.weights,
                    gait_phase: 0.0,
                    grounded,
                    ungrounded_time: 0.0,
                    rising,
                    airborne_confirmed: !grounded && velocity.y.abs() > 0.5,
                    jump_phase,
                    jump_elapsed: 0.0,
                    fall_elapsed: 0.0,
                    landing_elapsed: LAND_VISUAL_DURATION,
                    current,
                },
            ));
            player_count += 1;
            first_player.get_or_insert(descendant);
        }
        commands
            .entity(visual_root)
            .remove::<CourierAnimationPending>();
        if player_count == 0 {
            warn!(target: "demo::character_animation", ?visual_root, ?character,
                reason = "animation_player_missing", "Courier animation binding skipped");
        } else {
            // 名字只用于资源契约绑定；逐帧系统持有实体身份，不扫描名字或整个世界。
            let sole_markers: Option<Vec<_>> = SOLE_MARKER_NAMES
                .iter()
                .map(|marker_name| {
                    children.iter_descendants(visual_root).find(|entity| {
                        names
                            .get(*entity)
                            .is_ok_and(|name| name.as_str() == *marker_name)
                    })
                })
                .collect();
            let foot_grounding_enabled = sole_markers.is_some();
            if let Some(sole_markers) = sole_markers {
                commands.entity(visual_root).insert(CourierFootGrounding {
                    character,
                    animation_player: first_player.expect("a courier player was bound"),
                    sole_markers: sole_markers
                        .try_into()
                        .expect("all sole markers were found"),
                    base_translation: visual_transform.translation,
                    offset: 0.0,
                });
            } else {
                warn!(target: "demo::character_animation", ?visual_root, ?character,
                    reason = "sole_markers_missing", "Courier foot grounding unavailable");
            }
            info!(target: "demo::character_animation", ?visual_root, ?character,
                player_count, clip_count = ANIMATION_COUNT, animation_after = current.name(),
                forward_reference_speed = FORWARD_REFERENCE_SPEED,
                sideways_reference_speed = SIDEWAYS_REFERENCE_SPEED,
                blend_time_constant = BLEND_TIME_CONSTANT,
                foot_grounding_enabled, sole_clearance = SOLE_CLEARANCE,
                reason = "world_instance_ready",
                "Courier animation initialized");
        }
    }
}

/// 方向混合可能把弯腿插值成更直的腿；逐帧按真实鞋底边界修正最终视觉高度。
fn compensate_courier_sole_penetration(
    mut commands: Commands,
    time: Res<Time>,
    roots: Query<Entity, With<CourierFootGrounding>>,
    animations: Query<&CourierAnimation>,
    mut transforms: ParamSet<(
        TransformHelper,
        Query<(&mut Transform, &mut CourierFootGrounding)>,
    )>,
) {
    let release_blend = 1.0 - (-time.delta_secs() / BLEND_TIME_CONSTANT).exp();
    for visual_root in &roots {
        let grounding = {
            let mut visual_transforms = transforms.p1();
            let Ok((_, grounding)) = visual_transforms.get_mut(visual_root) else {
                continue;
            };
            *grounding
        };
        let desired = if let Ok(animation) = animations.get(grounding.animation_player) {
            // 与动作路由复用同一个过滤后的接地状态，台阶短暂丢失探测不撤销鞋底约束。
            if animation.grounded {
                let helper = transforms.p0();
                let character_transform = helper.compute_global_transform(grounding.character).ok();
                let marker_min: Option<f32> = grounding
                    .sole_markers
                    .iter()
                    .map(|entity| {
                        helper
                            .compute_global_transform(*entity)
                            .ok()
                            .map(|transform| transform.translation().y)
                    })
                    .try_fold(f32::INFINITY, |minimum, height| {
                        height.map(|height| minimum.min(height))
                    });
                match (character_transform, marker_min) {
                    (Some(character_transform), Some(marker_min)) => {
                        // 角色只有水平转向，父链的尺度仍需换算到局部 Y；扣掉旧补偿防止累积。
                        let world_y_per_local_y =
                            character_transform.affine().transform_vector3(Vec3::Y).y;
                        let uncorrected_min = marker_min - grounding.offset * world_y_per_local_y;
                        Some(
                            ((character_transform.translation().y + SOLE_CLEARANCE
                                - uncorrected_min)
                                / world_y_per_local_y)
                                .max(0.0),
                        )
                    }
                    _ => None,
                }
            } else {
                Some(0.0)
            }
        } else {
            None
        };
        let Some(desired) = desired else {
            commands
                .entity(visual_root)
                .remove::<CourierFootGrounding>();
            warn!(target: "demo::character_animation", ?visual_root,
                character = ?grounding.character, reason = "grounding_hierarchy_missing",
                "Courier foot grounding detached");
            continue;
        };
        let offset = if desired > grounding.offset {
            desired
        } else {
            grounding.offset + (desired - grounding.offset) * release_blend
        };
        let mut visual_transforms = transforms.p1();
        if let Ok((mut transform, mut grounding)) = visual_transforms.get_mut(visual_root) {
            grounding.offset = offset;
            transform.translation = grounding.base_translation + Vec3::Y * offset;
        }
    }
}

fn has_held_item(holding: Option<&HoldingItems>) -> bool {
    holding.is_some_and(|items| items.iter().next().is_some())
}

/// 将真实速度转到角色局部空间：前方是 -Z，鼠标转向后同帧即可得到新的混合方向。
fn animation_target(
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

fn dominant_animation(
    weights: &[f32; ANIMATION_COUNT],
    previous: CourierAnimationState,
) -> CourierAnimationState {
    CourierAnimationState::ALL
        .into_iter()
        .fold(previous, |current, candidate| {
            if weights[candidate as usize] > weights[current as usize] + 0.1 {
                candidate
            } else {
                current
            }
        })
}

/// Update 位于固定模拟与呈现同步之后；零固定步帧也使用本帧朝向和已有真实速度。
fn sync_courier_animation(
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use bevy::{
        animation::{AnimatedBy, AnimationTargetId, animated_field, graph::AnimationNodeType},
        ecs::relationship::Relationship,
        world_serialization::{WorldAsset, WorldInstanceSpawner},
    };

    use crate::{camera::CharacterVisual, gameplay::HeldBy};

    fn animation_app() -> App {
        let mut app = App::new();
        // 使用真实图求值、播放器与目标更新；只安装资产和任务池，不创建窗口或渲染器。
        app.add_plugins((
            TaskPoolPlugin::default(),
            AssetPlugin::default(),
            AnimationPlugin,
            TransformPlugin,
        ))
        .init_resource::<Assets<Gltf>>()
        .init_resource::<Assets<WorldAsset>>()
        .init_resource::<Time>()
        .add_plugins(CharacterAnimationPlugin);
        app.finish();
        app.cleanup();
        app
    }

    fn courier_asset(app: &mut App) -> Handle<Gltf> {
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        let mut named = Vec::new();
        for state in CourierAnimationState::ALL {
            let mut clip = AnimationClip::default();
            clip.set_duration(GAIT_CYCLE_DURATION);
            named.push((state.name().into(), clips.add(clip)));
        }
        let gltf = Gltf {
            scenes: default(),
            named_scenes: default(),
            meshes: default(),
            named_meshes: default(),
            materials: default(),
            named_materials: default(),
            nodes: default(),
            named_nodes: default(),
            skins: default(),
            named_skins: default(),
            default_scene: None,
            // 排列故意与动作图不同，确保生产代码按名字绑定。
            animations: named.iter().rev().map(|(_, clip)| clip.clone()).collect(),
            named_animations: named.into_iter().collect(),
            source: None,
        };
        app.world_mut().resource_mut::<Assets<Gltf>>().add(gltf)
    }

    fn spawn_courier(app: &mut App, asset: Handle<Gltf>) -> (Entity, Entity, Entity) {
        let character = app
            .world_mut()
            .spawn((
                Character,
                LinearVelocity::ZERO,
                Transform::default(),
                CharacterMotion { grounded: true },
            ))
            .id();
        let visual = app
            .world_mut()
            .spawn((CourierVisual(asset), CharacterVisual, ChildOf(character)))
            .id();
        let armature = app
            .world_mut()
            .spawn((Transform::default(), ChildOf(visual)))
            .id();
        let player = app
            .world_mut()
            .spawn((
                AnimationPlayer::default(),
                Transform::default(),
                ChildOf(armature),
            ))
            .id();
        for name in SOLE_MARKER_NAMES {
            app.world_mut().spawn((
                Name::new(name),
                Transform::from_xyz(0.0, 0.012, 0.0),
                ChildOf(player),
            ));
        }
        (character, visual, player)
    }

    fn notify_ready(app: &mut App, visual: Entity) {
        // 用最小空世界取得有效实例标识，不加载窗口或完整游戏。
        let asset = app
            .world_mut()
            .resource_mut::<Assets<WorldAsset>>()
            .add(WorldAsset::new(World::new()));
        let instance_id = WorldInstanceSpawner::default()
            .spawn_sync(app.world_mut(), asset.id())
            .unwrap();
        app.world_mut().trigger(WorldInstanceReady {
            entity: visual,
            instance_id,
        });
    }

    fn step(app: &mut App, seconds: f32) {
        app.world_mut()
            .resource_mut::<Time>()
            .advance_by(Duration::from_secs_f32(seconds));
        app.update();
    }

    fn weight(app: &App, player: Entity, state: CourierAnimationState) -> f32 {
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        app.world()
            .get::<AnimationPlayer>(player)
            .unwrap()
            .animation(animation.nodes.node(state))
            .unwrap()
            .weight()
    }

    fn set_velocity(app: &mut App, character: Entity, velocity: Vec3) {
        app.world_mut()
            .get_mut::<LinearVelocity>(character)
            .unwrap()
            .0 = velocity;
    }

    fn phase_seek(app: &App, player: Entity, state: CourierAnimationState) -> f32 {
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        app.world()
            .get::<AnimationPlayer>(player)
            .unwrap()
            .animation(animation.nodes.node(state))
            .unwrap()
            .seek_time()
    }

    fn jump_pose_bone(app: &mut App, asset: &Handle<Gltf>, player: Entity) -> Entity {
        let target_id = AnimationTargetId::from_name(&Name::new("jump_pose"));
        let named = app
            .world()
            .resource::<Assets<Gltf>>()
            .get(asset)
            .unwrap()
            .named_animations
            .clone();
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        // 全部片段覆盖同一字段，让断言检查真实图求值后的动态姿态，而非只检查播放器权重。
        for state in CourierAnimationState::ALL {
            let heights = match state {
                CourierAnimationState::Jump | CourierAnimationState::CarryJump => [0.0, 0.2, 0.25],
                CourierAnimationState::Fall | CourierAnimationState::CarryFall => [0.25, 0.2, 0.25],
                CourierAnimationState::Land | CourierAnimationState::CarryLand => {
                    [-0.12, -0.10, 0.0]
                }
                _ => [0.0; 3],
            };
            clips
                .get_mut(&named[state.name()])
                .unwrap()
                .add_curve_to_target(
                    target_id,
                    AnimatableCurve::new(
                        animated_field!(Transform::translation),
                        UnevenSampleAutoCurve::new([
                            (0.0, Vec3::Y * heights[0]),
                            (0.4, Vec3::Y * heights[1]),
                            (0.8, Vec3::Y * heights[2]),
                        ])
                        .unwrap(),
                    ),
                );
        }
        app.world_mut()
            .spawn((
                target_id,
                AnimatedBy(player),
                Transform::default(),
                ChildOf(player),
            ))
            .id()
    }

    fn assert_gait_phase(app: &App, player: Entity, expected: f32) {
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        let active = app.world().get::<AnimationPlayer>(player).unwrap();
        assert!((animation.gait_phase - expected).abs() < 1.0e-5);
        for state in CourierAnimationState::ALL {
            if state.is_locomotion() {
                let index = state as usize;
                let actual = active
                    .animation(animation.nodes.node(state))
                    .unwrap()
                    .seek_time()
                    / animation.nodes.durations[index];
                assert!((actual - expected).abs() < 1.0e-5);
            }
        }
        let sum: f32 = active
            .playing_animations()
            .map(|(_, clip)| clip.weight())
            .sum();
        assert!((sum - 1.0).abs() < 1.0e-5);
    }

    #[test]
    fn actual_local_velocity_blends_cardinal_diagonal_and_carry_directions() {
        use CourierAnimationState::*;
        for (velocity, direction) in [
            (Vec3::NEG_Z, Walk),
            (Vec3::Z, WalkBackward),
            (Vec3::NEG_X, WalkLeft),
            (Vec3::X, WalkRight),
        ] {
            let target = animation_target(velocity * 3.0, Quat::IDENTITY, true, false, false);
            assert_eq!(target.weights[direction as usize], 1.0);
        }
        let diagonal = animation_target(
            Vec3::new(-3.0, 10.0, -3.0),
            Quat::IDENTITY,
            true,
            false,
            true,
        );
        assert!(diagonal.weights[CarryWalk as usize] > 0.0);
        assert!(diagonal.weights[CarryLeft as usize] > 0.0);
        assert!((diagonal.weights.iter().sum::<f32>() - 1.0).abs() < 1.0e-6);
        let forward_weight = diagonal.weights[CarryWalk as usize];
        let left_weight = diagonal.weights[CarryLeft as usize];
        assert!(
            (forward_weight * FORWARD_REFERENCE_SPEED - left_weight * SIDEWAYS_REFERENCE_SPEED)
                .abs()
                < 1.0e-6
        );
        let vertical = animation_target(Vec3::Y * 5.0, Quat::IDENTITY, true, false, false);
        assert_eq!(vertical.weights[Idle as usize], 1.0);
    }

    #[test]
    fn bevy_evaluates_continuous_blend_and_shared_phase_on_a_bone() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let target_id = AnimationTargetId::from_name(&Name::new("foot"));
        let named = app
            .world()
            .resource::<Assets<Gltf>>()
            .get(&asset)
            .unwrap()
            .named_animations
            .clone();
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        for state in CourierAnimationState::ALL {
            let vector = match state {
                CourierAnimationState::Walk | CourierAnimationState::CarryWalk => Vec3::NEG_Z,
                CourierAnimationState::WalkBackward | CourierAnimationState::CarryBackward => {
                    Vec3::Z
                }
                CourierAnimationState::WalkLeft | CourierAnimationState::CarryLeft => Vec3::NEG_X,
                CourierAnimationState::WalkRight | CourierAnimationState::CarryRight => Vec3::X,
                _ => Vec3::ZERO,
            };
            clips
                .get_mut(&named[state.name()])
                .unwrap()
                .add_curve_to_target(
                    target_id,
                    AnimatableCurve::new(
                        animated_field!(Transform::translation),
                        UnevenSampleAutoCurve::new([
                            (0.0, Vec3::ZERO),
                            (0.4, vector),
                            (0.8, Vec3::ZERO),
                        ])
                        .unwrap(),
                    ),
                );
        }
        let (character, visual, player) = spawn_courier(&mut app, asset);
        let foot = app
            .world_mut()
            .spawn((
                target_id,
                AnimatedBy(player),
                Transform::default(),
                ChildOf(player),
            ))
            .id();
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        notify_ready(&mut app, visual);
        // 新图的资产事件在帧末发布，先完成零时长绑定帧再检查下一帧真实骨骼求值。
        step(&mut app, 0.0);
        step(&mut app, 0.2);
        assert_gait_phase(&app, player, 0.25);
        assert!(
            app.world()
                .get::<Transform>(foot)
                .unwrap()
                .translation
                .abs_diff_eq(Vec3::NEG_Z * 0.5, 1.0e-5)
        );

        set_velocity(&mut app, character, Vec3::X * SIDEWAYS_REFERENCE_SPEED);
        step(&mut app, 0.1);
        assert_gait_phase(&app, player, 0.375);
        let expected = (Vec3::NEG_Z * weight(&app, player, CourierAnimationState::Walk)
            + Vec3::X * weight(&app, player, CourierAnimationState::WalkRight))
            * 0.75;
        assert!(
            app.world()
                .get::<Transform>(foot)
                .unwrap()
                .translation
                .abs_diff_eq(expected, 1.0e-5)
        );
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
    }

    #[test]
    fn evaluated_direction_blend_keeps_sole_above_physics_feet_without_accumulating() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let hip_id = AnimationTargetId::from_name(&Name::new("hip"));
        let named = app
            .world()
            .resource::<Assets<Gltf>>()
            .get(&asset)
            .unwrap()
            .named_animations
            .clone();
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        // 两个单动作都抬脚，但旋转插值使弯腿变直，真实复现方向混合的穿地来源。
        for state in CourierAnimationState::ALL {
            let angle = match state {
                CourierAnimationState::Walk => 0.35,
                CourierAnimationState::WalkRight => -0.35,
                _ => 0.0,
            };
            let rotation = Quat::from_rotation_x(angle);
            clips
                .get_mut(&named[state.name()])
                .unwrap()
                .add_curve_to_target(
                    hip_id,
                    AnimatableCurve::new(
                        animated_field!(Transform::rotation),
                        UnevenSampleAutoCurve::new([(0.0, rotation), (0.8, rotation)]).unwrap(),
                    ),
                );
        }
        let (character, visual, player) = spawn_courier(&mut app, asset);
        let hip = app
            .world_mut()
            .spawn((
                hip_id,
                AnimatedBy(player),
                Transform::from_xyz(0.0, 0.97, 0.0),
                ChildOf(player),
            ))
            .id();
        let foot = app
            .world_mut()
            .spawn((Transform::from_xyz(0.0, -1.0, 0.0), ChildOf(hip)))
            .id();
        let mut marker_query = app.world_mut().query::<(Entity, &Name)>();
        let markers: Vec<_> = marker_query
            .iter(app.world())
            .filter(|(_, name)| name.as_str().starts_with("Courier_Sole_"))
            .map(|(entity, _)| entity)
            .collect();
        for (index, entity) in markers.iter().enumerate() {
            app.world_mut().entity_mut(*entity).insert((
                Transform::from_xyz(
                    if index % 2 == 0 { -0.1 } else { 0.1 },
                    0.0,
                    if index % 4 < 2 { -0.03 } else { 0.03 },
                ),
                ChildOf(foot),
            ));
        }
        set_velocity(
            &mut app,
            character,
            Vec3::new(SIDEWAYS_REFERENCE_SPEED, 0.0, -FORWARD_REFERENCE_SPEED),
        );
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        let offset = app.world().get::<Transform>(visual).unwrap().translation.y;
        assert!((offset - 0.033).abs() < 1.0e-5);
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
        for _ in 0..8 {
            step(&mut app, 1.0 / 120.0);
            // 检查实际帧末 GlobalTransform，不能补跑传播或改用上一帧骨骼姿态。
            for marker in &markers {
                assert!(
                    app.world()
                        .get::<GlobalTransform>(*marker)
                        .unwrap()
                        .translation()
                        .y
                        >= SOLE_CLEARANCE - 1.0e-5
                );
            }
            assert!(
                (app.world().get::<Transform>(visual).unwrap().translation.y - offset).abs()
                    < 1.0e-5
            );
        }
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        step(&mut app, 1.0 / 60.0);
        assert!(app.world().get::<Transform>(visual).unwrap().translation.y < offset);
        assert!(app.world().get::<Transform>(visual).unwrap().translation.y > 0.0);
    }

    #[test]
    fn mouse_facing_is_read_on_frame_without_a_fixed_step() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        set_velocity(&mut app, character, Vec3::NEG_Z * 3.0);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        assert_eq!(weight(&app, player, CourierAnimationState::Walk), 1.0);

        app.world_mut()
            .get_mut::<Transform>(character)
            .unwrap()
            .rotation = Quat::from_rotation_y(std::f32::consts::FRAC_PI_2);
        step(&mut app, 1.0 / 120.0);
        // 不补跑固定模拟；本次 app.update 返回就能看见新方向以及连续过渡。
        assert!(weight(&app, player, CourierAnimationState::WalkRight) > 0.0);
        assert!(weight(&app, player, CourierAnimationState::Walk) > 0.0);
        assert_eq!(
            app.world().get::<CourierAnimation>(player).unwrap().current,
            CourierAnimationState::WalkRight
        );
    }

    #[test]
    fn direction_and_holding_changes_preserve_synchronized_gait_phase() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        notify_ready(&mut app, visual);
        step(&mut app, 0.2);
        assert_gait_phase(&app, player, 0.25);

        set_velocity(&mut app, character, Vec3::X * SIDEWAYS_REFERENCE_SPEED);
        step(&mut app, 0.1);
        assert_gait_phase(&app, player, 0.375);
        let item = app
            .world_mut()
            .spawn(<HeldBy as Relationship>::from(character))
            .id();
        step(&mut app, 0.05);
        assert_gait_phase(&app, player, 0.4375);
        assert!(weight(&app, player, CourierAnimationState::WalkRight) > 0.0);
        assert!(weight(&app, player, CourierAnimationState::CarryRight) > 0.0);

        app.world_mut().entity_mut(item).remove::<HeldBy>();
        set_velocity(&mut app, character, Vec3::ZERO);
        step(&mut app, 0.05);
        assert_gait_phase(&app, player, 0.4375);
        assert!(weight(&app, player, CourierAnimationState::Idle) > 0.0);
        assert!(weight(&app, player, CourierAnimationState::CarryRight) > 0.0);
    }

    #[test]
    fn air_states_filter_grounding_noise_and_freeze_walking_phase() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        notify_ready(&mut app, visual);
        step(&mut app, 0.1);
        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = false;
        step(&mut app, 0.02);
        assert!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .grounded
        );
        assert_eq!(weight(&app, player, CourierAnimationState::Fall), 0.0);

        set_velocity(&mut app, character, Vec3::new(0.0, 5.0, -1.5));
        step(&mut app, 0.01);
        assert_eq!(
            app.world().get::<CourierAnimation>(player).unwrap().current,
            CourierAnimationState::Jump
        );
        assert_gait_phase(&app, player, 0.15);
        set_velocity(&mut app, character, Vec3::new(0.0, -0.1, -1.5));
        step(&mut app, 0.01);
        assert_eq!(
            app.world().get::<CourierAnimation>(player).unwrap().current,
            CourierAnimationState::Jump
        );
        set_velocity(&mut app, character, Vec3::new(0.0, -1.0, -1.5));
        app.world_mut()
            .spawn(<HeldBy as Relationship>::from(character));
        step(&mut app, 0.05);
        assert_eq!(
            app.world().get::<CourierAnimation>(player).unwrap().current,
            CourierAnimationState::CarryFall
        );
        assert_gait_phase(&app, player, 0.15);

        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = true;
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        step(&mut app, 0.02);
        assert!(weight(&app, player, CourierAnimationState::CarryLand) > 0.0);
        assert!(weight(&app, player, CourierAnimationState::CarryFall) > 0.0);
        assert_gait_phase(&app, player, 0.15);
        step(&mut app, LAND_VISUAL_DURATION);
        assert!(weight(&app, player, CourierAnimationState::CarryWalk) > 0.0);
        assert_gait_phase(&app, player, 0.425);
    }

    #[test]
    fn upward_velocity_overrides_raw_grounding_and_jump_pose_moves_once_then_holds() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset.clone());
        let bone = jump_pose_bone(&mut app, &asset, player);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        set_velocity(&mut app, character, Vec3::Y * 5.0);
        // 有意保留 raw grounded=true，复现起跳首帧接地数据尚未刷新的边界。
        step(&mut app, 0.01);
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        assert!(!animation.grounded);
        assert_eq!(animation.jump_phase, CourierJumpPhase::Rising);
        assert_eq!(phase_seek(&app, player, CourierAnimationState::Jump), 0.0);
        step(&mut app, 0.12);
        assert!((phase_seek(&app, player, CourierAnimationState::Jump) - 0.4).abs() < 1.0e-5);
        assert!(app.world().get::<Transform>(bone).unwrap().translation.y > 0.1);

        let item = app
            .world_mut()
            .spawn(<HeldBy as Relationship>::from(character))
            .id();
        step(&mut app, 0.03);
        for state in [
            CourierAnimationState::Jump,
            CourierAnimationState::CarryJump,
        ] {
            assert!((phase_seek(&app, player, state) - 0.5).abs() < 1.0e-5);
        }
        step(&mut app, 0.5);
        let end_height = app.world().get::<Transform>(bone).unwrap().translation.y;
        assert!((end_height - 0.25).abs() < 0.001);
        step(&mut app, 0.4);
        for state in [
            CourierAnimationState::Jump,
            CourierAnimationState::CarryJump,
        ] {
            // 实际 AnimationPlugin 执行后仍停在最后一帧，不能被内部自动推进环回第一帧。
            assert_eq!(phase_seek(&app, player, state), GAIT_CYCLE_DURATION);
        }
        assert!(
            (app.world().get::<Transform>(bone).unwrap().translation.y - end_height).abs() < 0.001
        );

        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = false;
        set_velocity(&mut app, character, Vec3::Y * -0.1);
        step(&mut app, 0.01);
        assert_eq!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .jump_phase,
            CourierJumpPhase::Rising
        );
        set_velocity(&mut app, character, Vec3::Y * -0.5);
        step(&mut app, 0.01);
        assert_eq!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .jump_phase,
            CourierJumpPhase::Falling
        );
        step(&mut app, 0.08);
        app.world_mut().entity_mut(item).remove::<HeldBy>();
        step(&mut app, 0.03);
        for state in [
            CourierAnimationState::Fall,
            CourierAnimationState::CarryFall,
        ] {
            assert!((phase_seek(&app, player, state) - 0.11).abs() < 1.0e-5);
        }
        assert_eq!(
            phase_seek(&app, player, CourierAnimationState::Jump),
            GAIT_CYCLE_DURATION
        );
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
    }

    #[test]
    fn initial_raw_grounded_frame_with_upward_velocity_binds_jump_immediately() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset.clone());
        let bone = jump_pose_bone(&mut app, &asset, player);
        set_velocity(&mut app, character, Vec3::Y * 5.0);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        assert_eq!(weight(&app, player, CourierAnimationState::Jump), 1.0);
        assert!(
            !app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .grounded
        );
        step(&mut app, 0.12);
        assert!((app.world().get::<Transform>(bone).unwrap().translation.y - 0.2).abs() < 1.0e-5);
    }

    #[test]
    fn first_support_probe_does_not_fake_landing_but_sustained_initial_air_does() {
        for unsupported_time in [0.0, AIRBORNE_DELAY + 0.01] {
            let mut app = animation_app();
            let asset = courier_asset(&mut app);
            let (character, visual, player) = spawn_courier(&mut app, asset.clone());
            let bone = jump_pose_bone(&mut app, &asset, player);
            // 两种初态都有 raw grounded=false 和零竖直速度：尚未探测支撑与高处刚开始坠落。
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = false;
            notify_ready(&mut app, visual);
            step(&mut app, 0.0);
            if unsupported_time > 0.0 {
                step(&mut app, unsupported_time);
            }
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = true;
            step(&mut app, 0.01);
            let animation = app.world().get::<CourierAnimation>(player).unwrap();
            if unsupported_time == 0.0 {
                assert_eq!(animation.jump_phase, CourierJumpPhase::Grounded);
                for _ in 0..12 {
                    step(&mut app, 1.0 / 60.0);
                    assert_eq!(weight(&app, player, CourierAnimationState::Land), 0.0);
                    assert_eq!(weight(&app, player, CourierAnimationState::CarryLand), 0.0);
                    // 使用真实图输出，确保首次支撑探测不会出现落地缓冲的负向姿态曲线。
                    assert!(app.world().get::<Transform>(bone).unwrap().translation.y >= 0.0);
                }
            } else {
                assert_eq!(animation.jump_phase, CourierJumpPhase::Landing);
                step(&mut app, 0.1);
                assert!(weight(&app, player, CourierAnimationState::Land) > 0.0);
                assert!(app.world().get::<Transform>(bone).unwrap().translation.y < 0.0);
            }
        }
    }

    #[test]
    fn landing_buffers_once_and_carry_changes_preserve_its_progress() {
        for carrying in [false, true] {
            let mut app = animation_app();
            let asset = courier_asset(&mut app);
            let (character, visual, player) = spawn_courier(&mut app, asset.clone());
            let bone = jump_pose_bone(&mut app, &asset, player);
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = false;
            set_velocity(&mut app, character, Vec3::Y * -2.0);
            let item = carrying.then(|| {
                app.world_mut()
                    .spawn(<HeldBy as Relationship>::from(character))
                    .id()
            });
            notify_ready(&mut app, visual);
            step(&mut app, 0.0);
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = true;
            set_velocity(&mut app, character, Vec3::ZERO);
            step(&mut app, 0.01);
            assert_eq!(
                app.world()
                    .get::<CourierAnimation>(player)
                    .unwrap()
                    .jump_phase,
                CourierJumpPhase::Landing
            );
            let land = if carrying {
                CourierAnimationState::CarryLand
            } else {
                CourierAnimationState::Land
            };
            assert!(weight(&app, player, land) > 0.0);
            assert_eq!(phase_seek(&app, player, land), 0.0);
            step(&mut app, 0.1);
            assert!(app.world().get::<Transform>(bone).unwrap().translation.y < 0.0);
            if let Some(item) = item {
                app.world_mut().entity_mut(item).remove::<HeldBy>();
            } else {
                app.world_mut()
                    .spawn(<HeldBy as Relationship>::from(character));
            }
            step(&mut app, 0.05);
            for state in [
                CourierAnimationState::Land,
                CourierAnimationState::CarryLand,
            ] {
                assert!(
                    (phase_seek(&app, player, state)
                        - 0.15 / LAND_VISUAL_DURATION * GAIT_CYCLE_DURATION)
                        .abs()
                        < 1.0e-5
                );
            }
            step(&mut app, 0.08);
            assert_eq!(
                app.world()
                    .get::<CourierAnimation>(player)
                    .unwrap()
                    .jump_phase,
                CourierJumpPhase::Grounded
            );
            for _ in 0..12 {
                step(&mut app, 1.0 / 60.0);
                assert_eq!(phase_seek(&app, player, land), GAIT_CYCLE_DURATION);
                assert_eq!(
                    app.world()
                        .get::<CourierAnimation>(player)
                        .unwrap()
                        .jump_phase,
                    CourierJumpPhase::Grounded
                );
            }
            // 一帧接地探测噪声后回到地面，也不能重复起播刚结束的落地动作。
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = false;
            step(&mut app, 0.02);
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = true;
            step(&mut app, 0.02);
            assert_eq!(
                app.world()
                    .get::<CourierAnimation>(player)
                    .unwrap()
                    .jump_phase,
                CourierJumpPhase::Grounded
            );
            assert_eq!(phase_seek(&app, player, land), GAIT_CYCLE_DURATION);
        }
    }

    #[test]
    fn pause_gate_freezes_jump_clock_and_evaluated_pose_without_restarting_on_resume() {
        use crate::app_flow::{AppState, PlayState};
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset.clone());
        let bone = jump_pose_bone(&mut app, &asset, player);
        set_velocity(&mut app, character, Vec3::Y * 5.0);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        step(&mut app, 0.06);
        let seek = phase_seek(&app, player, CourierAnimationState::Jump);
        let pose = *app.world().get::<Transform>(bone).unwrap();
        app.insert_resource(State::new(AppState::InGame))
            .insert_resource(State::new(PlayState::Paused));
        step(&mut app, 0.5);
        assert_eq!(phase_seek(&app, player, CourierAnimationState::Jump), seek);
        assert_eq!(*app.world().get::<Transform>(bone).unwrap(), pose);
        app.insert_resource(State::new(PlayState::Running));
        step(&mut app, 0.01);
        assert!(
            (phase_seek(&app, player, CourierAnimationState::Jump)
                - 0.07 / JUMP_VISUAL_DURATION * GAIT_CYCLE_DURATION)
                .abs()
                < 1.0e-5
        );
    }

    #[test]
    fn smooth_blend_and_stride_rate_are_independent_of_render_frame_rate() {
        fn simulate(hz: u32) -> ([f32; ANIMATION_COUNT], f32) {
            let mut app = animation_app();
            let asset = courier_asset(&mut app);
            let (character, visual, player) = spawn_courier(&mut app, asset);
            notify_ready(&mut app, visual);
            step(&mut app, 0.0);
            set_velocity(&mut app, character, Vec3::NEG_Z * 4.5);
            for _ in 0..hz / 4 {
                step(&mut app, 1.0 / hz as f32);
            }
            let animation = app.world().get::<CourierAnimation>(player).unwrap();
            assert_gait_phase(&app, player, 0.9375);
            (animation.weights, animation.gait_phase)
        }
        let (at_60, phase_60) = simulate(60);
        let (at_120, phase_120) = simulate(120);
        for index in 0..ANIMATION_COUNT {
            assert!((at_60[index] - at_120[index]).abs() < 1.0e-5);
        }
        assert!((phase_60 - phase_120).abs() < 1.0e-5);
    }

    #[test]
    fn only_courier_subtree_binds_named_clips() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (_, visual, player) = spawn_courier(&mut app, asset.clone());
        let npc = app.world_mut().spawn_empty().id();
        let npc_visual = app.world_mut().spawn(ChildOf(npc)).id();
        let npc_player = app
            .world_mut()
            .spawn((AnimationPlayer::default(), ChildOf(npc_visual)))
            .id();
        let invalid_visual = app
            .world_mut()
            .spawn((CourierVisual(asset.clone()), ChildOf(npc)))
            .id();
        let invalid_player = app
            .world_mut()
            .spawn((AnimationPlayer::default(), ChildOf(invalid_visual)))
            .id();
        for root in [visual, npc_visual, invalid_visual] {
            notify_ready(&mut app, root);
        }
        step(&mut app, 0.0);
        for other in [npc_player, invalid_player] {
            assert!(app.world().get::<CourierAnimation>(other).is_none());
            assert!(app.world().get::<AnimationGraphHandle>(other).is_none());
        }
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        let graph_handle = app.world().get::<AnimationGraphHandle>(player).unwrap();
        let graph = app
            .world()
            .resource::<Assets<AnimationGraph>>()
            .get(&graph_handle.0)
            .unwrap();
        let gltf = app.world().resource::<Assets<Gltf>>().get(&asset).unwrap();
        for state in CourierAnimationState::ALL {
            let AnimationNodeType::Clip(clip) = &graph[animation.nodes.node(state)].node_type
            else {
                panic!("expected a clip node");
            };
            assert_eq!(clip.id(), gltf.named_animations[state.name()].id());
        }
        assert!(app.world().get::<AnimationTransitions>(player).is_none());
    }

    #[test]
    fn pending_scene_waits_for_gltf_and_clip_assets() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let gltf = app
            .world_mut()
            .resource_mut::<Assets<Gltf>>()
            .remove(&asset)
            .unwrap();
        let (_, visual, player) = spawn_courier(&mut app, asset.clone());
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        let clip_handle = gltf.named_animations["Walk_Right"].clone();
        let clip = app
            .world_mut()
            .resource_mut::<Assets<AnimationClip>>()
            .remove(&clip_handle)
            .unwrap();
        app.world_mut()
            .resource_mut::<Assets<Gltf>>()
            .insert(asset.id(), gltf)
            .unwrap();
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        app.world_mut()
            .resource_mut::<Assets<AnimationClip>>()
            .insert(clip_handle.id(), clip)
            .unwrap();
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_some());
        assert!(app.world().get::<CourierAnimationPending>(visual).is_none());
    }

    #[test]
    fn missing_named_clip_fails_binding_without_partial_player_state() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        app.world_mut()
            .resource_mut::<Assets<Gltf>>()
            .get_mut(&asset)
            .unwrap()
            .named_animations
            .remove("Carry_Right");
        let (_, visual, player) = spawn_courier(&mut app, asset);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        assert!(app.world().get::<CourierAnimationPending>(visual).is_none());
        assert_eq!(
            app.world()
                .get::<AnimationPlayer>(player)
                .unwrap()
                .playing_animations()
                .count(),
            0
        );
    }

    #[test]
    fn missing_character_detaches_surviving_player() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        // 模拟视觉被外部重挂后旧角色销毁，播放器不能继续读取失效关联。
        app.world_mut().entity_mut(visual).remove::<ChildOf>();
        app.world_mut().despawn(character);
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        assert!(app.world().get::<AnimationGraphHandle>(player).is_none());
        assert!(app.world().get::<CourierFootGrounding>(visual).is_none());
        assert_eq!(
            app.world()
                .get::<AnimationPlayer>(player)
                .unwrap()
                .playing_animations()
                .count(),
            0
        );
    }
}

//! 快递员视觉动画读取实际物理速度和持有关系，不驱动角色业务根的运动。

use std::time::Duration;

use avian3d::prelude::LinearVelocity;
use bevy::{
    ecs::relationship::RelationshipTarget, prelude::*, world_serialization::WorldInstanceReady,
};

use crate::{
    app_flow::gameplay_running,
    gameplay::{Character, HoldingItems},
};

const WALK_SPEED_THRESHOLD: f32 = 0.15;
const TRANSITION_DURATION: Duration = Duration::from_millis(180);

/// 挂在 Character 直属视觉根上的 glTF 引用；只有标记的快递员接入玩法动画。
#[derive(Component, Clone, Default, FromTemplate)]
pub struct CourierVisual(pub Handle<Gltf>);

/// 等待 glTF 场景和命名动画都可用，避免异步子资产先完成时错过初始化。
#[derive(Component)]
struct CourierAnimationPending;

/// 动作节点属于本次生成的图，不依赖 glTF 文件中的动画排列索引。
#[derive(Clone, Copy)]
struct CourierAnimationNodes {
    idle: AnimationNodeIndex,
    walk: AnimationNodeIndex,
    carry_idle: AnimationNodeIndex,
}

impl CourierAnimationNodes {
    fn node(self, state: CourierAnimationState) -> AnimationNodeIndex {
        match state {
            CourierAnimationState::Idle => self.idle,
            CourierAnimationState::Walk => self.walk,
            CourierAnimationState::CarryIdle => self.carry_idle,
        }
    }
}

/// 只保存播放器关联和当前动作；速度与持物状态仍由业务组件提供。
#[derive(Component)]
struct CourierAnimation {
    character: Entity,
    nodes: CourierAnimationNodes,
    current: CourierAnimationState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CourierAnimationState {
    Idle,
    Walk,
    CarryIdle,
}

impl CourierAnimationState {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Walk => "Walk",
            Self::CarryIdle => "Carry_Idle",
        }
    }
}

/// 注册场景就绪后的动画绑定，以及固定模拟结束后逐帧读取状态的动画切换。
pub(crate) struct CharacterAnimationPlugin;

impl Plugin for CharacterAnimationPlugin {
    fn build(&self, app: &mut App) {
        app.add_observer(mark_courier_animation_ready).add_systems(
            Update,
            // 初始化插入的关联和过渡组件须在同帧切换系统运行前可见。
            (initialize_ready_couriers, sync_courier_animation)
                .chain()
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
    roots: Query<(Entity, &CourierVisual, &ChildOf), With<CourierAnimationPending>>,
    characters: Query<(&LinearVelocity, Option<&HoldingItems>), With<Character>>,
    children: Query<&Children>,
    gltfs: Res<Assets<Gltf>>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
    mut players: Query<&mut AnimationPlayer>,
) {
    for (visual_root, visual, parent) in &roots {
        let character = parent.parent();
        let Ok((velocity, holding)) = characters.get(character) else {
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
        let named_clip = |name: &'static str| gltf.named_animations.get(name).cloned().ok_or(name);
        let clips = (|| {
            Ok::<_, &'static str>([
                named_clip("Idle")?,
                named_clip("Walk")?,
                named_clip("Carry_Idle")?,
            ])
        })();
        let clips = match clips {
            Ok(clips) => clips,
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
        let (graph, indices) = AnimationGraph::from_clips(clips);
        let nodes = CourierAnimationNodes {
            idle: indices[0],
            walk: indices[1],
            carry_idle: indices[2],
        };
        let graph_handle = graphs.add(graph);
        let current = choose_animation(velocity.0, holding);
        let mut player_count = 0;
        for descendant in children.iter_descendants(visual_root) {
            let Ok(mut player) = players.get_mut(descendant) else {
                continue;
            };
            let mut transitions = AnimationTransitions::new();
            transitions
                .play(&mut player, nodes.node(current), Duration::ZERO)
                .repeat();
            commands.entity(descendant).insert((
                AnimationGraphHandle(graph_handle.clone()),
                transitions,
                CourierAnimation {
                    character,
                    nodes,
                    current,
                },
            ));
            player_count += 1;
        }
        commands
            .entity(visual_root)
            .remove::<CourierAnimationPending>();
        if player_count == 0 {
            warn!(target: "demo::character_animation", ?visual_root, ?character,
                reason = "animation_player_missing", "Courier animation binding skipped");
        } else {
            info!(target: "demo::character_animation", ?visual_root, ?character,
                player_count, animation_after = current.name(), reason = "world_instance_ready",
                "Courier animation initialized");
        }
    }
}

/// 没有 Carry_Walk 资源时，持物优先使用 Carry_Idle，保留双手搬运姿态。
fn choose_animation(velocity: Vec3, holding: Option<&HoldingItems>) -> CourierAnimationState {
    if holding.is_some_and(|items| items.iter().next().is_some()) {
        CourierAnimationState::CarryIdle
    } else if Vec2::new(velocity.x, velocity.z).length_squared()
        > WALK_SPEED_THRESHOLD * WALK_SPEED_THRESHOLD
    {
        CourierAnimationState::Walk
    } else {
        CourierAnimationState::Idle
    }
}

/// Update 位于固定模拟之后；没有固定步的帧沿用真实速度，不按输入意图播放步行。
fn sync_courier_animation(
    mut commands: Commands,
    characters: Query<(&LinearVelocity, Option<&HoldingItems>), With<Character>>,
    mut players: Query<(
        Entity,
        &mut AnimationPlayer,
        &mut AnimationTransitions,
        &mut CourierAnimation,
    )>,
) {
    for (player_entity, mut player, mut transitions, mut animation) in &mut players {
        let Ok((velocity, holding)) = characters.get(animation.character) else {
            player.stop_all();
            commands.entity(player_entity).remove::<(
                CourierAnimation,
                AnimationGraphHandle,
                AnimationTransitions,
            )>();
            warn!(target: "demo::character_animation", ?player_entity,
                character = ?animation.character, reason = "character_missing",
                "Courier animation detached");
            continue;
        };
        let next = choose_animation(velocity.0, holding);
        if next == animation.current {
            continue;
        }
        transitions
            .play(&mut player, animation.nodes.node(next), TRANSITION_DURATION)
            .repeat();
        info!(target: "demo::character_animation", ?player_entity,
            character = ?animation.character,
            animation_before = animation.current.name(), animation_after = next.name(),
            reason = "velocity_or_holding_changed", "Courier animation changed");
        animation.current = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::{
        animation::graph::AnimationNodeType,
        ecs::relationship::Relationship,
        world_serialization::{WorldAsset, WorldInstanceSpawner},
    };

    use crate::{camera::CharacterVisual, gameplay::HeldBy};

    fn animation_app() -> App {
        let mut app = App::new();
        app.init_resource::<Assets<Gltf>>()
            .init_resource::<Assets<AnimationClip>>()
            .init_resource::<Assets<AnimationGraph>>()
            .init_resource::<Assets<WorldAsset>>()
            .add_plugins(CharacterAnimationPlugin);
        app
    }

    fn courier_asset(app: &mut App) -> Handle<Gltf> {
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        let idle = clips.add(AnimationClip::default());
        let walk = clips.add(AnimationClip::default());
        let carry = clips.add(AnimationClip::default());
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
            animations: vec![carry.clone(), walk.clone(), idle.clone()],
            named_animations: [
                ("Carry_Idle".into(), carry),
                ("Walk".into(), walk),
                ("Idle".into(), idle),
            ]
            .into_iter()
            .collect(),
            source: None,
        };
        app.world_mut().resource_mut::<Assets<Gltf>>().add(gltf)
    }

    fn spawn_courier(app: &mut App, asset: Handle<Gltf>) -> (Entity, Entity, Entity) {
        let character = app
            .world_mut()
            .spawn((Character, LinearVelocity::ZERO))
            .id();
        let visual = app
            .world_mut()
            .spawn((CourierVisual(asset), CharacterVisual, ChildOf(character)))
            .id();
        let armature = app.world_mut().spawn(ChildOf(visual)).id();
        let player = app
            .world_mut()
            .spawn((AnimationPlayer::default(), ChildOf(armature)))
            .id();
        (character, visual, player)
    }

    fn notify_ready(app: &mut App, visual: Entity) {
        // 用最小空世界取得有效实例标识；不加载窗口、渲染器或完整游戏。
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

    fn current_state(app: &App, player: Entity) -> CourierAnimationState {
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        let node = animation.nodes.node(animation.current);
        assert_eq!(
            app.world()
                .get::<AnimationTransitions>(player)
                .unwrap()
                .get_main_animation(),
            Some(node)
        );
        assert!(
            app.world()
                .get::<AnimationPlayer>(player)
                .unwrap()
                .is_playing_animation(node)
        );
        animation.current
    }

    #[test]
    fn actions_use_horizontal_physics_velocity_and_real_holding_relationship() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        notify_ready(&mut app, visual);
        app.update();
        assert_eq!(current_state(&app, player), CourierAnimationState::Idle);

        app.world_mut()
            .get_mut::<LinearVelocity>(character)
            .unwrap()
            .0 = Vec3::new(0.0, 6.0, 0.0);
        app.update();
        assert_eq!(current_state(&app, player), CourierAnimationState::Idle);

        app.world_mut()
            .get_mut::<LinearVelocity>(character)
            .unwrap()
            .0 = Vec3::new(0.1, 0.0, 0.12);
        app.update();
        assert_eq!(current_state(&app, player), CourierAnimationState::Walk);

        let item = app
            .world_mut()
            .spawn(<HeldBy as Relationship>::from(character))
            .id();
        app.update();
        assert_eq!(
            current_state(&app, player),
            CourierAnimationState::CarryIdle
        );
        app.world_mut().entity_mut(item).remove::<HeldBy>();
        app.update();
        assert_eq!(current_state(&app, player), CourierAnimationState::Walk);
        app.world_mut()
            .get_mut::<LinearVelocity>(character)
            .unwrap()
            .0 = Vec3::ZERO;
        app.update();
        assert_eq!(current_state(&app, player), CourierAnimationState::Idle);
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
        app.update();
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
        for (state, name) in [
            (CourierAnimationState::Idle, "Idle"),
            (CourierAnimationState::Walk, "Walk"),
            (CourierAnimationState::CarryIdle, "Carry_Idle"),
        ] {
            let AnimationNodeType::Clip(clip) = &graph[animation.nodes.node(state)].node_type
            else {
                panic!("expected a clip node");
            };
            assert_eq!(clip.id(), gltf.named_animations[name].id());
        }
    }

    #[test]
    fn unchanged_frames_preserve_player_progress() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (_, visual, player) = spawn_courier(&mut app, asset);
        notify_ready(&mut app, visual);
        app.update();
        let idle = app
            .world()
            .get::<CourierAnimation>(player)
            .unwrap()
            .nodes
            .idle;
        app.world_mut()
            .get_mut::<AnimationPlayer>(player)
            .unwrap()
            .animation_mut(idle)
            .unwrap()
            .set_seek_time(0.65);
        for _ in 0..3 {
            app.update();
            let active = app.world().get::<AnimationPlayer>(player).unwrap();
            assert_eq!(active.animation(idle).unwrap().seek_time(), 0.65);
            assert_eq!(active.playing_animations().count(), 1);
            assert_eq!(
                app.world()
                    .get::<AnimationTransitions>(player)
                    .unwrap()
                    .get_main_animation(),
                Some(idle)
            );
        }
    }

    #[test]
    fn ready_scene_waits_for_gltf_asset() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let gltf = app
            .world_mut()
            .resource_mut::<Assets<Gltf>>()
            .remove(&asset)
            .unwrap();
        let (_, visual, player) = spawn_courier(&mut app, asset.clone());
        notify_ready(&mut app, visual);
        app.update();
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        app.world_mut()
            .resource_mut::<Assets<Gltf>>()
            .insert(asset.id(), gltf)
            .unwrap();
        app.update();
        assert_eq!(current_state(&app, player), CourierAnimationState::Idle);
        assert!(app.world().get::<CourierAnimationPending>(visual).is_none());
    }

    #[test]
    fn missing_character_detaches_surviving_player() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        notify_ready(&mut app, visual);
        app.update();
        // 模拟视觉被外部重挂后旧角色销毁，播放器不能继续读取失效关联。
        app.world_mut().entity_mut(visual).remove::<ChildOf>();
        app.world_mut().despawn(character);
        app.update();
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        assert!(app.world().get::<AnimationGraphHandle>(player).is_none());
        assert!(app.world().get::<AnimationTransitions>(player).is_none());
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

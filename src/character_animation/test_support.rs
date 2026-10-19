//! 真实动画图的最小无窗口装配与断言辅助。

pub(super) use std::time::Duration;

pub(super) use crate::character::{Character, CharacterMotion};
pub(super) use avian3d::prelude::LinearVelocity;

use super::*;
pub(super) use bevy::{
    animation::{AnimatedBy, AnimationTargetId, animated_field, graph::AnimationNodeType},
    ecs::relationship::Relationship,
    world_serialization::{WorldAsset, WorldInstanceReady, WorldInstanceSpawner},
};

pub(super) use crate::{first_person::CharacterVisual, item_interaction::HeldBy};

pub(super) fn animation_app() -> App {
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

pub(super) fn courier_asset(app: &mut App) -> Handle<Gltf> {
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

pub(super) fn spawn_courier(app: &mut App, asset: Handle<Gltf>) -> (Entity, Entity, Entity) {
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

pub(super) fn notify_ready(app: &mut App, visual: Entity) {
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

pub(super) fn step(app: &mut App, seconds: f32) {
    app.world_mut()
        .resource_mut::<Time>()
        .advance_by(Duration::from_secs_f32(seconds));
    app.update();
}

pub(super) fn weight(app: &App, player: Entity, state: CourierAnimationState) -> f32 {
    let animation = app.world().get::<CourierAnimation>(player).unwrap();
    app.world()
        .get::<AnimationPlayer>(player)
        .unwrap()
        .animation(animation.nodes.node(state))
        .unwrap()
        .weight()
}

pub(super) fn set_velocity(app: &mut App, character: Entity, velocity: Vec3) {
    app.world_mut()
        .get_mut::<LinearVelocity>(character)
        .unwrap()
        .0 = velocity;
}

pub(super) fn phase_seek(app: &App, player: Entity, state: CourierAnimationState) -> f32 {
    let animation = app.world().get::<CourierAnimation>(player).unwrap();
    app.world()
        .get::<AnimationPlayer>(player)
        .unwrap()
        .animation(animation.nodes.node(state))
        .unwrap()
        .seek_time()
}

pub(super) fn jump_pose_bone(app: &mut App, asset: &Handle<Gltf>, player: Entity) -> Entity {
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
            CourierAnimationState::Land | CourierAnimationState::CarryLand => [-0.12, -0.10, 0.0],
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

pub(super) fn assert_gait_phase(app: &App, player: Entity, expected: f32) {
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

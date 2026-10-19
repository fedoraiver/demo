//! 无窗口覆盖主角动画的 binding 行为。

use super::test_support::*;
use super::*;

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
        let AnimationNodeType::Clip(clip) = &graph[animation.nodes.node(state)].node_type else {
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

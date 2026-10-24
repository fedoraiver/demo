use bevy::{
    animation::{RepeatAnimation, graph::AnimationNodeType},
    asset::AssetPlugin,
    camera::CameraProjection,
    scene::ScenePlugin,
    state::app::StatesPlugin,
    world_serialization::{WorldAsset, WorldInstanceSpawner},
};

use super::*;

/// 用真实 BSN 相机声明验证状态清理，最小 App 不安装窗口后端或渲染器。
#[test]
fn leaving_main_menu_removes_backdrop_camera_and_preserves_other_camera() {
    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins,
        AssetPlugin::default(),
        ScenePlugin,
        StatesPlugin,
    ))
    .init_state::<AppState>();
    app.update();
    let other_camera = app.world_mut().spawn(Camera3d::default()).id();
    let root = app
        .world_mut()
        .spawn_scene(bsn! {
            MenuBackdrop
            DespawnOnExit::<AppState>(AppState::MainMenu)
            Transform
            Children [
                @menu_camera()
            ]
        })
        .unwrap()
        .id();
    let menu_camera = app.world().get::<Children>(root).unwrap()[0];
    assert!(app.world().get::<IsDefaultUiCamera>(menu_camera).is_some());
    assert!(app.world().get::<PrimaryEguiContext>(menu_camera).is_some());

    app.world_mut()
        .resource_mut::<NextState<AppState>>()
        .set(AppState::InGame);
    app.update();

    assert!(app.world().get_entity(root).is_err());
    assert!(app.world().get_entity(menu_camera).is_err());
    assert!(app.world().get::<Camera3d>(other_camera).is_some());
}

/// 无窗口检查具名资产约定，GLB 再导出可以改变排列但不能移除菜单持箱动作。
#[test]
fn courier_asset_contains_carry_clip_and_independent_parcel() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let bytes = std::fs::read(root.join(COURIER_PATH)).unwrap();
    assert_eq!(&bytes[..4], b"glTF");
    let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let gltf: serde_json::Value = serde_json::from_slice(&bytes[20..20 + json_len]).unwrap();
    assert_eq!(
        gltf["animations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|animation| animation["name"] == COURIER_ANIMATION)
            .count(),
        1
    );
    assert_eq!(gltf["scenes"].as_array().unwrap().len(), 1);
    assert!(
        gltf["skins"]
            .as_array()
            .is_some_and(|skins| !skins.is_empty())
    );
    assert!(root.join("models/props/prop_parcel_standard.glb").is_file());
}

/// 真实 Observer 和图绑定覆盖场景先就绪、父 GLB 后到达，以及动画导出排列变化。
#[test]
fn courier_menu_resolves_named_clip_after_scene_and_asset_are_ready() {
    let mut app = App::new();
    // 只安装资产与动画调度，不安装窗口、渲染器或完整游戏。
    app.add_plugins((
        TaskPoolPlugin::default(),
        AssetPlugin::default(),
        AnimationPlugin,
    ))
    .init_resource::<Assets<Gltf>>()
    .init_resource::<Assets<WorldAsset>>()
    .init_resource::<Time>()
    .add_observer(mark_courier_animation_ready)
    .add_systems(Update, play_courier_animation);
    app.finish();
    app.cleanup();
    let gltf_handle = app.world().resource::<Assets<Gltf>>().reserve_handle();
    let carry_clip = app
        .world()
        .resource::<Assets<AnimationClip>>()
        .reserve_handle();
    let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
    let backward_clip = clips.add(AnimationClip::default());
    let walk_clip = clips.add(AnimationClip::default());
    let root = app
        .world_mut()
        .spawn(CourierAnimation {
            gltf: gltf_handle.clone(),
        })
        .id();
    let armature = app.world_mut().spawn(ChildOf(root)).id();
    let player = app
        .world_mut()
        .spawn((AnimationPlayer::default(), ChildOf(armature)))
        .id();
    let world_asset = app
        .world_mut()
        .resource_mut::<Assets<WorldAsset>>()
        .add(WorldAsset::new(World::new()));
    let instance_id = WorldInstanceSpawner::default()
        .spawn_sync(app.world_mut(), world_asset.id())
        .unwrap();
    app.world_mut().trigger(WorldInstanceReady {
        entity: root,
        instance_id,
    });
    app.update();
    assert!(app.world().get::<CourierAnimationPending>(root).is_some());
    assert!(app.world().get::<AnimationGraphHandle>(player).is_none());
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
        // Carry_Idle 故意排在第三个，不能把索引 0 的倒走片段接到展示角色上。
        animations: vec![backward_clip.clone(), walk_clip.clone(), carry_clip.clone()],
        named_animations: [
            ("Carry_Backward".into(), backward_clip),
            ("Walk".into(), walk_clip),
            (COURIER_ANIMATION.into(), carry_clip.clone()),
        ]
        .into_iter()
        .collect(),
        source: None,
    };
    app.world_mut()
        .resource_mut::<Assets<Gltf>>()
        .insert(gltf_handle.id(), gltf)
        .unwrap();
    app.update();
    assert!(app.world().get::<CourierAnimationPending>(root).is_some());
    assert!(app.world().get::<AnimationGraphHandle>(player).is_none());
    let mut clip = AnimationClip::default();
    clip.set_duration(0.8);
    app.world_mut()
        .resource_mut::<Assets<AnimationClip>>()
        .insert(carry_clip.id(), clip)
        .unwrap();
    app.update();
    assert!(app.world().get::<CourierAnimationPending>(root).is_none());
    assert!(app.world().get::<AnimationPlayer>(root).is_none());
    let graph_handle = app
        .world()
        .get::<AnimationGraphHandle>(player)
        .unwrap()
        .0
        .clone();
    let graph = app
        .world()
        .resource::<Assets<AnimationGraph>>()
        .get(&graph_handle)
        .unwrap();
    let playing = app.world().get::<AnimationPlayer>(player).unwrap();
    let active: Vec<_> = playing.playing_animations().collect();
    assert_eq!(active.len(), 1);
    let (node, active) = active[0];
    assert!(matches!(active.repeat_mode(), RepeatAnimation::Forever));
    let AnimationNodeType::Clip(bound_clip) = &graph[*node].node_type else {
        panic!("Menu courier must play a named animation clip");
    };
    assert_eq!(bound_clip.id(), carry_clip.id());
    // pending 已消费，后续帧不能重复生成动画图或重置正在播放的动作。
    app.update();
    assert_eq!(
        app.world()
            .get::<AnimationGraphHandle>(player)
            .unwrap()
            .0
            .id(),
        graph_handle.id()
    );
    assert_eq!(app.world().resource::<Assets<AnimationGraph>>().len(), 1);
}

/// 投影检查只验证固定构图的数学边界，真实光照、遮挡与材质仍由用户验收。
#[test]
fn camera_frames_courier_and_station_on_right_at_wide_and_narrow_aspects() {
    let view = camera_transform().to_matrix().inverse();
    for aspect in [16.0 / 9.0, 4.0 / 3.0] {
        let projection = PerspectiveProjection {
            fov: 46.0_f32.to_radians(),
            aspect_ratio: aspect,
            near: 0.1,
            far: 1000.0,
            ..default()
        }
        .get_clip_from_view();
        for point in [
            COURIER_POSITION,
            COURIER_POSITION + Vec3::Y * 1.91,
            STATION_POSITION + Vec3::Y * 2.0,
        ] {
            let clip = projection * view * point.extend(1.0);
            let ndc = clip.truncate() / clip.w;
            assert!(ndc.x > 0.0 && ndc.x < 1.0, "point={point:?}, ndc={ndc:?}");
            assert!(ndc.y.abs() < 1.0, "point={point:?}, ndc={ndc:?}");
        }
    }
}

//! 主菜单的独立海岛展示舞台；只复用美术模型，不创建玩法角色或物理实体。

use bevy::{
    asset::{HandleTemplate, UntypedAssetLoadFailedEvent},
    core_pipeline::tonemapping::Tonemapping,
    prelude::*,
    world_serialization::WorldInstanceReady,
};
use bevy_inspector_egui::bevy_egui::PrimaryEguiContext;

use crate::app_flow::AppState;

const COURIER_PATH: &str = "models/characters/chr_courier.glb";
const COURIER_ANIMATION: &str = "Carry_Idle";
const COURIER_POSITION: Vec3 = Vec3::new(3.2, 0.02, 2.6);
const STATION_POSITION: Vec3 = Vec3::new(4.5, 0.02, -4.5);

/// 标记整个展示舞台的根，状态退出时连同相机、灯光和模型一起清理。
#[derive(Component, Default, Clone)]
struct MenuBackdrop;

/// 持有 GLB 父资产，展示动作按名字绑定，不依赖导出后的动画排列顺序。
#[derive(Component, FromTemplate)]
struct CourierAnimation {
    // 资产句柄使用 Bevy 的专用模板，不依赖要求 Unpin 的默认克隆模板。
    #[template(HandleTemplate<Gltf>)]
    gltf: Handle<Gltf>,
}

/// 子场景就绪后继续等待父 GLB 与命名片段，避免异步加载顺序漏掉展示动画。
#[derive(Component)]
struct CourierAnimationPending;

/// 注册主菜单展示舞台与资产失败日志，暂停菜单继续使用玩法相机。
pub(super) fn register(app: &mut App) {
    app.add_systems(OnEnter(AppState::MainMenu), spawn_backdrop)
        .add_systems(Update, (play_courier_animation, log_asset_failures));
}

fn spawn_backdrop(mut commands: Commands, asset_server: Res<AssetServer>) {
    // 组合地图没有动画，独立角色的父 GLB 提供命名动作表。
    let gltf = asset_server.load(COURIER_PATH);

    let backdrop = commands
        .spawn_scene(bsn! {
            #MenuBackdrop
            MenuBackdrop
            template_value(DespawnOnExit(AppState::MainMenu))
            Transform
            Visibility
            Children [
                menu_camera(),
                (
                    #MenuDaylight
                    DirectionalLight {
                        illuminance: 12_000.0,
                        shadow_maps_enabled: true,
                    }
                    template_value(Transform::from_xyz(-8.0, 14.0, 9.0)
                        .looking_at(Vec3::ZERO, Vec3::Y))
                ),
                // 地形与海水保持原来的相对位置，把北岸移到据点后方形成真实海岸线。
                model("MenuIsland", "models/environment/env_island_terrain.glb#Scene0",
                    Vec3::new(-8.0, 0.0, 31.0), 0.0),
                model("MenuOcean", "models/environment/env_ocean.glb#Scene0",
                    Vec3::new(-8.0, 0.0, 31.0), 0.0),
                model("MenuCourierStation", "models/buildings/bld_courier_station.glb#Scene0",
                    STATION_POSITION, -0.12),
                (
                    #MenuCourier
                    WorldAssetRoot("models/characters/chr_courier.glb#Scene0")
                    CourierAnimation { gltf: {HandleTemplate::Handle(gltf)} }
                    Transform {
                        translation: COURIER_POSITION,
                        rotation: {Quat::from_rotation_y(2.85)},
                    }
                    on(mark_courier_animation_ready)
                    // 包裹是独立资产；动作没有根运动，附件保持角色本地的持握位置。
                    Children [model("MenuCarriedParcel",
                        "models/props/prop_parcel_standard.glb#Scene0",
                        Vec3::new(0.0, 1.3, -0.48), 0.0)]
                ),
                model("MenuPalmBehindStation", "models/environment/prop_palm_leaning.glb#Scene0",
                    Vec3::new(9.5, 0.02, -7.0), -0.5),
                model("MenuPalmAtShore", "models/environment/prop_palm_crooked.glb#Scene0",
                    Vec3::new(1.0, 0.02, -9.0), 0.8),
                model("MenuYoungPalm", "models/environment/prop_palm_young.glb#Scene0",
                    Vec3::new(11.0, 0.02, -2.0), -0.3),
                model("MenuGrass", "models/environment/prop_wild_grass_patch.glb#Scene0",
                    Vec3::new(7.5, 0.02, -1.0), 0.4),
                model("MenuParcelOnSand", "models/props/prop_parcel_fragile.glb#Scene0",
                    Vec3::new(5.0, 0.32, 1.5), -0.2),
                model("MenuCrate", "models/props/prop_crate.glb#Scene0",
                    Vec3::new(6.0, 0.37, 1.0), 0.15),
            ]
        })
        .id();

    info!(target: "demo::ui::backdrop", ?backdrop, state = "main_menu",
        character_asset = COURIER_PATH, reason = "state_enter",
        "Menu backdrop spawned");
}

/// 镜头与环境光只属于菜单；左半边留给菜单，角色和物流站在右侧。
fn menu_camera() -> impl Scene {
    bsn! {
        #MenuCamera
        Camera3d
        Camera {
            clear_color: {ClearColorConfig::Custom(Color::srgb(0.50, 0.68, 0.79))},
        }
        IsDefaultUiCamera
        PrimaryEguiContext
        AmbientLight {
            color: {Color::srgb(1.0, 0.95, 0.84)},
            brightness: 450.0,
        }
        template_value(Projection::Perspective(PerspectiveProjection {
            fov: 46.0_f32.to_radians(),
            ..default()
        }))
        template_value(Tonemapping::AcesFitted)
        template_value(camera_transform())
    }
}

fn camera_transform() -> Transform {
    Transform::from_xyz(-2.0, 4.2, 10.0).looking_at(Vec3::new(0.0, 1.5, -4.0), Vec3::Y)
}

/// 可复用的 BSN 模型声明；Bevy 0.19 的 WorldAssetRoot 即原 SceneRoot。
fn model(name: &'static str, path: &'static str, position: Vec3, yaw: f32) -> impl Scene {
    bsn! {
        Name(name)
        WorldAssetRoot(path)
        Transform {
            translation: position,
            rotation: {Quat::from_rotation_y(yaw)},
        }
    }
}

fn mark_courier_animation_ready(
    ready: On<WorldInstanceReady>,
    mut commands: Commands,
    animations: Query<(), With<CourierAnimation>>,
) {
    if animations.contains(ready.entity) {
        commands
            .entity(ready.entity)
            .insert(CourierAnimationPending);
    }
}

/// 仅遍历已展开的展示角色子树，命名资产尚未就绪时保留 pending 供下一帧重试。
fn play_courier_animation(
    mut commands: Commands,
    animations: Query<(Entity, &CourierAnimation), With<CourierAnimationPending>>,
    gltfs: Res<Assets<Gltf>>,
    clips: Res<Assets<AnimationClip>>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
    children: Query<&Children>,
    mut players: Query<&mut AnimationPlayer>,
) {
    for (entity, animation) in &animations {
        let Some(gltf) = gltfs.get(&animation.gltf) else {
            continue;
        };
        let Some(clip) = gltf.named_animations.get(COURIER_ANIMATION) else {
            error!(target: "demo::ui::backdrop", ?entity, path = COURIER_PATH,
                animation = COURIER_ANIMATION, reason = "animation_clip_missing",
                "Menu courier animation could not start");
            commands.entity(entity).remove::<CourierAnimationPending>();
            continue;
        };
        if !clips.contains(clip) {
            continue;
        }
        let (graph, node) = AnimationGraph::from_clip(clip.clone());
        let graph = graphs.add(graph);
        let mut player_count = 0;
        // GLB 的 AnimationPlayer 在骨架子实体上，不能把动画组件加到展示根上代替。
        for descendant in children.iter_descendants(entity) {
            if let Ok(mut player) = players.get_mut(descendant) {
                player.play(node).repeat();
                commands
                    .entity(descendant)
                    .insert(AnimationGraphHandle(graph.clone()));
                player_count += 1;
            }
        }
        commands.entity(entity).remove::<CourierAnimationPending>();
        if player_count == 0 {
            warn!(target: "demo::ui::backdrop", ?entity,
                path = COURIER_PATH, reason = "animation_player_missing",
                "Menu courier animation could not start");
        } else {
            info!(target: "demo::ui::backdrop", ?entity,
                animation = COURIER_ANIMATION, player_count, reason = "named_animation_ready",
                "Menu courier animation started");
        }
    }
}

fn log_asset_failures(mut failures: MessageReader<UntypedAssetLoadFailedEvent>) {
    for failure in failures.read() {
        let path = failure.path.path().to_string_lossy();
        if path.starts_with("models/") || path.starts_with("ui/") {
            error!(target: "demo::ui::backdrop", path = %failure.path,
                error = %failure.error, reason = "asset_load_failed",
                "Menu asset failed to load");
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy::{
        animation::{RepeatAnimation, graph::AnimationNodeType},
        asset::AssetPlugin,
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
                template_value(DespawnOnExit(AppState::MainMenu))
                Transform
                Children [menu_camera()]
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
            let projection = Mat4::perspective_rh(46.0_f32.to_radians(), aspect, 0.1, 1000.0);
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
}

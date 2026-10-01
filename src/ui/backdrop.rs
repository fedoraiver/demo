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
const COURIER_POSITION: Vec3 = Vec3::new(3.2, 0.02, 2.6);
const STATION_POSITION: Vec3 = Vec3::new(4.5, 0.02, -4.5);

/// 标记整个展示舞台的根，状态退出时连同相机、灯光和模型一起清理。
#[derive(Component, Default, Clone)]
struct MenuBackdrop;

/// 在角色 GLB 展开完成后，把展示动作接到其内部 AnimationPlayer。
#[derive(Component, FromTemplate)]
struct CourierAnimation {
    // 资产句柄使用 Bevy 的专用模板，不依赖要求 Unpin 的默认克隆模板。
    #[template(HandleTemplate<AnimationGraph>)]
    graph: Handle<AnimationGraph>,
    node: AnimationNodeIndex,
}

/// 注册主菜单展示舞台与资产失败日志，暂停菜单继续使用玩法相机。
pub(super) fn register(app: &mut App) {
    app.add_systems(OnEnter(AppState::MainMenu), spawn_backdrop)
        .add_systems(Update, log_asset_failures);
}

fn spawn_backdrop(
    mut commands: Commands,
    asset_server: Res<AssetServer>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
) {
    // 已检查原始 GLB：索引 0 是 Carry_Idle。组合地图没有动画，因此使用独立角色。
    let (graph, node) = AnimationGraph::from_clip(
        asset_server.load(GltfAssetLabel::Animation(0).from_asset(COURIER_PATH)),
    );
    let graph = graphs.add(graph);

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
                    CourierAnimation { graph: {HandleTemplate::Handle(graph)}, node }
                    Transform {
                        translation: COURIER_POSITION,
                        rotation: {Quat::from_rotation_y(2.85)},
                    }
                    on(play_courier_animation)
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

fn play_courier_animation(
    ready: On<WorldInstanceReady>,
    mut commands: Commands,
    animations: Query<&CourierAnimation>,
    children: Query<&Children>,
    mut players: Query<&mut AnimationPlayer>,
) {
    let Ok(animation) = animations.get(ready.entity) else {
        return;
    };
    let mut player_count = 0;
    // GLB 的 AnimationPlayer 在骨架子实体上，不能把动画组件加到展示根上代替。
    for descendant in children.iter_descendants(ready.entity) {
        if let Ok(mut player) = players.get_mut(descendant) {
            player.play(animation.node).repeat();
            commands
                .entity(descendant)
                .insert(AnimationGraphHandle(animation.graph.clone()));
            player_count += 1;
        }
    }

    if player_count == 0 {
        warn!(target: "demo::ui::backdrop", entity = ?ready.entity,
            path = COURIER_PATH, reason = "animation_player_missing",
            "Menu courier animation could not start");
    } else {
        info!(target: "demo::ui::backdrop", entity = ?ready.entity,
            animation = "Carry_Idle", player_count, reason = "world_instance_ready",
            "Menu courier animation started");
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
    use bevy::{asset::AssetPlugin, scene::ScenePlugin, state::app::StatesPlugin};

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

    /// 无窗口检查实际资产约定，防止 GLB 再导出后动作索引与菜单声明不一致。
    #[test]
    // 美术资产沿用仓库的忽略规则；干净源码检出不包含 GLB，显式准备资产后再运行。
    #[ignore = "Requires local art assets under assets/models"]
    fn courier_asset_contains_carry_clip_and_independent_parcel() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
        let bytes = std::fs::read(root.join(COURIER_PATH)).unwrap();
        assert_eq!(&bytes[..4], b"glTF");
        let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let gltf: serde_json::Value = serde_json::from_slice(&bytes[20..20 + json_len]).unwrap();
        assert_eq!(gltf["animations"][0]["name"], "Carry_Idle");
        assert_eq!(gltf["scenes"].as_array().unwrap().len(), 1);
        assert!(
            gltf["skins"]
                .as_array()
                .is_some_and(|skins| !skins.is_empty())
        );
        assert!(root.join("models/props/prop_parcel_standard.glb").is_file());
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

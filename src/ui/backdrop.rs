//! 主菜单的独立海岛展示舞台；只复用美术模型，不创建玩法角色或物理实体。

use bevy::{
    asset::{HandleTemplate, UntypedAssetLoadFailedEvent},
    core_pipeline::tonemapping::Tonemapping,
    prelude::*,
    world_serialization::WorldInstanceReady,
};
use bevy_inspector_egui::bevy_egui::PrimaryEguiContext;

use crate::game_flow::AppState;

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
#[path = "backdrop_tests.rs"]
mod tests;

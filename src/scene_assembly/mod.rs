//! 用 BSN 装配纯色地面、玩家与可搬方块，所有会话实体返回主菜单时清理。

use avian3d::prelude::{Collider, RigidBody};
use bevy::prelude::*;
use bevy_inspector_egui::bevy_egui::PrimaryEguiContext;

use crate::{
    character::{Character, CharacterIntent, CharacterMotion, character_body},
    first_person::{
        ControlsCamera, FirstPersonCamera, MouseLookState, PlayerId, spawn_keyboard_controller,
    },
    game_flow::AppState,
    item_interaction::{CarryGrip, Item, Pickable, item_body},
    physics::world_collision_layers,
    settings::PrototypeConfig,
};

const GROUND_SIZE_M: f32 = 40.0;
const GROUND_THICKNESS_M: f32 = 1.0;
const PLAYER_SPAWN_LIFT_M: f32 = 0.03;

/// 直接由几何体生成灰盒会话，不等待外部模型或地图加载。
pub(crate) struct SceneAssemblyPlugin;

impl Plugin for SceneAssemblyPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PrototypeConfig>()
            .insert_resource(ClearColor(Color::srgb(0.12, 0.14, 0.17)))
            .insert_resource(GlobalAmbientLight {
                color: Color::WHITE,
                brightness: 250.0,
                ..default()
            })
            .add_systems(
                Startup,
                spawn_session.run_if(not(resource_exists::<State<AppState>>)),
            )
            // 仅新会话离开主菜单时生成；暂停恢复保留实体与现有物理状态。
            .add_systems(OnExit(AppState::MainMenu), spawn_session);
    }
}

fn spawn_session(
    mut commands: Commands,
    config: Res<PrototypeConfig>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let ground_mesh = meshes.add(Cuboid::new(
        GROUND_SIZE_M,
        GROUND_THICKNESS_M,
        GROUND_SIZE_M,
    ));
    let ground_material = materials.add(StandardMaterial {
        base_color: Color::srgb(0.32, 0.35, 0.39),
        perceptual_roughness: 1.0,
        ..default()
    });
    let ground_transform =
        Transform::from_xyz(0.0, config.ground_y - GROUND_THICKNESS_M * 0.5, 0.0);
    let ground = commands
        .spawn_scene(bsn! {
            Name("Greybox ground")
            DespawnOnEnter::<AppState>(AppState::MainMenu)
            Mesh3d(ground_mesh)
            MeshMaterial3d::<StandardMaterial>(ground_material)
            ground_transform
            RigidBody::Static
            Collider::cuboid(GROUND_SIZE_M, GROUND_THICKNESS_M, GROUND_SIZE_M)
            world_collision_layers()
        })
        .id();

    let player_position = Vec3::new(0.0, config.ground_y + PLAYER_SPAWN_LIFT_M, 2.0);
    let character = commands
        .spawn_scene(bsn! {
            Name("Player")
            DespawnOnEnter::<AppState>(AppState::MainMenu)
            Character
            CharacterIntent
            CharacterMotion { grounded: false }
            Transform::from_translation(player_position)
            Visibility
        })
        .insert(character_body(&config))
        .id();
    let controller = spawn_keyboard_controller(&mut commands, PlayerId { id: 1 }, character);
    commands
        .entity(controller)
        .insert(DespawnOnEnter(AppState::MainMenu));

    let first_person = FirstPersonCamera::new(character);
    let camera_transform = first_person.transform(player_position);
    // 镜头运行状态不提供 BSN 克隆模板，结构声明后直接插入这两个组件。
    let camera = commands
        .spawn_scene(bsn! {
            Name("First-person camera")
            DespawnOnEnter::<AppState>(AppState::MainMenu)
            Camera3d
            IsDefaultUiCamera
            PrimaryEguiContext
            camera_transform
        })
        .insert((first_person, MouseLookState::default()))
        .id();
    commands
        .entity(controller)
        .insert(ControlsCamera { camera });

    let cube_size = config.item_half_height * 2.0;
    let cube_mesh = meshes.add(Cuboid::new(cube_size, cube_size, cube_size));
    // 方块底面使用默认握点，中心抬高半边长，使平视时能看到持物。
    let carry_grip = CarryGrip {
        offset: config.hold_offset + Vec3::Y * config.item_half_height,
    };
    for (index, (x, z, color)) in [
        (0.0, 0.7, Color::srgb(0.75, 0.76, 0.78)),
        (-1.3, -1.0, Color::srgb(0.50, 0.54, 0.58)),
        (1.3, -1.0, Color::srgb(0.65, 0.67, 0.70)),
    ]
    .into_iter()
    .enumerate()
    {
        let material = materials.add(StandardMaterial {
            base_color: color,
            perceptual_roughness: 1.0,
            ..default()
        });
        let position = Vec3::new(x, config.ground_y + config.item_half_height, z);
        let item = commands
            .spawn_scene(bsn! {
                Name({format!("Greybox cube {}", index + 1)})
                DespawnOnEnter::<AppState>(AppState::MainMenu)
                Item
                Pickable
                carry_grip
                Mesh3d({cube_mesh.clone()})
                MeshMaterial3d::<StandardMaterial>(material)
                Transform::from_translation(position)
            })
            .insert(item_body(&config))
            .id();
        info!(target: "demo::scene", ?item, ?position, size = cube_size,
            reason = "session_started", "Greybox cube spawned");
    }

    let daylight = commands
        .spawn_scene(bsn! {
            Name("Greybox daylight")
            DespawnOnEnter::<AppState>(AppState::MainMenu)
            DirectionalLight { illuminance: 12_000.0, shadow_maps_enabled: true }
            Transform::from_xyz(6.0, 10.0, 8.0).looking_at(Vec3::ZERO, Vec3::Y)
        })
        .id();
    info!(target: "demo::scene", ?ground, ?character, ?controller, ?camera, ?daylight,
        position = ?player_position, ground_y = config.ground_y,
        reason = "session_started", "Greybox session spawned");
}

#[cfg(test)]
mod tests;

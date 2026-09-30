//! 原型场景与占位资产；业务实体保持独立，后续只需替换视觉子实体。

use bevy::prelude::*;

use crate::{
    camera::{ControlsCamera, MouseLookState, OrbitCamera},
    gameplay::{
        Character, CharacterIntent, CharacterMotion, Parcel, Pickable, PlayerId, PrototypeConfig,
    },
    input::spawn_keyboard_controller,
};

/// 生成平地、占位角色、木箱和与控制者关联的自由视角镜头。
pub struct PrototypeScenePlugin;

impl Plugin for PrototypeScenePlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(ClearColor(Color::srgb(0.72, 0.84, 0.94)))
            .insert_resource(GlobalAmbientLight {
                color: Color::WHITE,
                brightness: 250.0,
                ..default()
            })
            .add_systems(Startup, spawn_scene);
    }
}

/// 创建业务根实体和可替换的视觉子实体；角色根位置对应脚底，木箱根对应中心。
fn spawn_scene(
    mut commands: Commands,
    config: Res<PrototypeConfig>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    commands.spawn((
        Name::new("Prototype ground"),
        Mesh3d(meshes.add(Plane3d::default().mesh().size(200.0, 200.0))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.55, 0.66, 0.47),
            perceptual_roughness: 1.0,
            ..default()
        })),
        Transform::from_xyz(0.0, config.ground_y, 0.0),
    ));

    commands.spawn((
        Name::new("Prototype daylight"),
        DirectionalLight {
            illuminance: 12_000.0,
            shadow_maps_enabled: true,
            ..default()
        },
        Transform::from_xyz(6.0, 10.0, 8.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));

    let character = commands
        .spawn((
            Name::new("Prototype character"),
            Character,
            CharacterIntent::default(),
            CharacterMotion {
                grounded: true,
                ..default()
            },
            Transform::from_xyz(0.0, config.ground_y, 0.0),
            Visibility::default(),
        ))
        .id();

    commands.spawn((
        Name::new("Placeholder body"),
        Mesh3d(meshes.add(Capsule3d::new(0.32, 0.8))),
        MeshMaterial3d(materials.add(Color::srgb(0.12, 0.35, 0.74))),
        Transform::from_xyz(0.0, 0.72, 0.0),
        ChildOf(character),
    ));
    commands.spawn((
        Name::new("Placeholder head"),
        Mesh3d(meshes.add(Sphere::new(0.24))),
        MeshMaterial3d(materials.add(Color::srgb(0.94, 0.77, 0.59))),
        Transform::from_xyz(0.0, 1.65, 0.0),
        ChildOf(character),
    ));
    // 角色的局部 -Z 是前方，标记帮助观察移动后朝向是否正确。
    commands.spawn((
        Name::new("Placeholder facing marker"),
        Mesh3d(meshes.add(Cuboid::new(0.16, 0.12, 0.16))),
        MeshMaterial3d(materials.add(Color::srgb(0.99, 0.70, 0.18))),
        Transform::from_xyz(0.0, 1.64, -0.24),
        ChildOf(character),
    ));

    let player_id = PlayerId(1);
    let controller = spawn_keyboard_controller(&mut commands, player_id, character);
    let parcel_position = Vec3::new(0.0, config.ground_y + config.parcel_half_height, -1.3);
    let parcel = commands
        .spawn((
            Name::new("Prototype parcel"),
            Parcel,
            Pickable,
            Transform::from_translation(parcel_position),
            Visibility::default(),
        ))
        .id();
    let crate_size = config.parcel_half_height * 2.0;
    commands.spawn((
        Name::new("Placeholder wooden crate"),
        Mesh3d(meshes.add(Cuboid::from_length(crate_size))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::srgb(0.48, 0.27, 0.11),
            perceptual_roughness: 0.95,
            ..default()
        })),
        Transform::default(),
        ChildOf(parcel),
    ));
    let strip_mesh = meshes.add(Cuboid::new(crate_size + 0.02, 0.07, crate_size + 0.02));
    let strip_material = materials.add(Color::srgb(0.71, 0.47, 0.22));
    for height in [-crate_size * 0.3, crate_size * 0.3] {
        commands.spawn((
            Name::new("Placeholder crate strip"),
            Mesh3d(strip_mesh.clone()),
            MeshMaterial3d(strip_material.clone()),
            Transform::from_xyz(0.0, height, 0.0),
            ChildOf(parcel),
        ));
    }

    let start_position = Vec3::new(0.0, config.ground_y, 0.0);
    let orbit = OrbitCamera::new(character);
    let camera_transform = orbit.transform(start_position);
    let camera = commands
        .spawn((
            Name::new("Prototype orbit camera"),
            Camera3d::default(),
            orbit,
            MouseLookState::default(),
            camera_transform,
        ))
        .id();
    commands.entity(controller).insert(ControlsCamera(camera));
    info!(target: "demo::camera", ?camera, ?character, ?controller,
        position = ?camera_transform.translation, reason = "scene_startup",
        "Orbit camera spawned");

    info!(
        target: "demo::scene",
        player_id = player_id.0,
        ?character,
        ?controller,
        position = ?start_position,
        reason = "scene_startup",
        "Character and local controller spawned"
    );
    info!(
        target: "demo::scene",
        ?parcel,
        position = ?parcel_position,
        reason = "scene_startup",
        "Wooden crate spawned"
    );
    info!(target: "demo::scene", config = ?*config, "Prototype scene initialized");
}

#[cfg(test)]
mod tests {
    use super::*;

    use bevy_enhanced_input::prelude::{EnhancedInputPlugin, InputContextAppExt};

    use crate::{gameplay::ControlsCharacter, input::GameplayContext};

    #[test]
    fn startup_assembles_independent_roots_with_replaceable_visuals() {
        // 只注册资源与输入上下文，然后直接运行场景调度，不加载窗口或渲染插件。
        let mut app = App::new();
        app.init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .init_resource::<PrototypeConfig>()
            .add_plugins(EnhancedInputPlugin)
            .add_input_context::<GameplayContext>()
            .add_plugins(PrototypeScenePlugin);
        app.finish();
        app.cleanup();
        app.world_mut().run_schedule(Startup);

        let world = app.world_mut();
        let character = world
            .query_filtered::<Entity, With<Character>>()
            .single(world)
            .unwrap();
        let parcel = world
            .query_filtered::<Entity, With<Parcel>>()
            .single(world)
            .unwrap();
        let (player_id, controlled_character) = world
            .query_filtered::<(&PlayerId, &ControlsCharacter), With<GameplayContext>>()
            .single(world)
            .map(|(id, controlled)| (*id, controlled.0))
            .unwrap();
        assert_eq!(player_id, PlayerId(1));
        assert_eq!(controlled_character, character);
        assert!(world.get::<Pickable>(parcel).is_some());

        for root in [character, parcel] {
            assert!(world.get::<ChildOf>(root).is_none());
            assert!(world.get::<Mesh3d>(root).is_none());
            let children = world.get::<Children>(root).unwrap();
            assert!(!children.is_empty());
            for &child in children {
                assert_eq!(world.get::<ChildOf>(child).unwrap().parent(), root);
                assert!(world.get::<Mesh3d>(child).is_some());
                assert!(world.get::<Character>(child).is_none());
                assert!(world.get::<Parcel>(child).is_none());
            }
        }
        let config = world.resource::<PrototypeConfig>();
        assert_eq!(
            world.get::<Transform>(character).unwrap().translation.y,
            config.ground_y
        );
        assert_eq!(
            world.get::<Transform>(parcel).unwrap().translation.y,
            config.ground_y + config.parcel_half_height
        );
        assert_eq!(
            world
                .query_filtered::<&OrbitCamera, With<Camera3d>>()
                .single(world)
                .unwrap()
                .target,
            character
        );
        let controlled_camera = world
            .query_filtered::<&ControlsCamera, With<GameplayContext>>()
            .single(world)
            .unwrap()
            .0;
        assert_eq!(
            world.get::<OrbitCamera>(controlled_camera).unwrap().target,
            character
        );
    }
}

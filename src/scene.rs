//! 原型场景与占位资产；业务实体保持独立，后续只需替换视觉子实体。

use bevy::prelude::*;

use crate::{
    gameplay::{
        Character, CharacterIntent, CharacterMotion, Parcel, Pickable, PlayerId, PrototypeConfig,
    },
    input::spawn_keyboard_controller,
};

/// 生成平地、占位角色和木箱，并提供固定角度的跟随镜头。
pub struct PrototypeScenePlugin;

impl Plugin for PrototypeScenePlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(ClearColor(Color::srgb(0.72, 0.84, 0.94)))
            .insert_resource(GlobalAmbientLight {
                color: Color::WHITE,
                brightness: 250.0,
                ..default()
            })
            .add_systems(Startup, spawn_scene)
            .add_systems(Update, follow_camera);
    }
}

/// 每个相机单独保存目标，后续多个本地视角无需依赖唯一玩家查询。
#[derive(Component)]
struct CameraFollow {
    target: Entity,
    offset: Vec3,
    look_height: f32,
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

    let camera_offset = Vec3::new(0.0, 6.0, 8.0);
    let look_height = 0.8;
    let start_position = Vec3::new(0.0, config.ground_y, 0.0);
    commands.spawn((
        Name::new("Prototype follow camera"),
        Camera3d::default(),
        CameraFollow {
            target: character,
            offset: camera_offset,
            look_height,
        },
        Transform::from_translation(start_position + camera_offset)
            .looking_at(start_position + Vec3::Y * look_height, Vec3::Y),
    ));

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

/// 更新各相机的目标位置；显式互斥过滤避免读写 Transform 的查询冲突。
fn follow_camera(
    characters: Query<&Transform, With<Character>>,
    mut cameras: Query<(&CameraFollow, &mut Transform), Without<Character>>,
) {
    for (follow, mut camera_transform) in &mut cameras {
        let Ok(character_transform) = characters.get(follow.target) else {
            continue;
        };
        let position = character_transform.translation;
        camera_transform.translation = position + follow.offset;
        camera_transform.look_at(position + Vec3::Y * follow.look_height, Vec3::Y);
    }
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
        app.world_mut().run_schedule(Update);

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
                .query_filtered::<&CameraFollow, With<Camera3d>>()
                .single(world)
                .unwrap()
                .target,
            character
        );
    }

    #[test]
    fn cameras_follow_their_own_characters() {
        let mut app = App::new();
        app.add_systems(Update, follow_camera);
        let first_position = Vec3::new(3.0, 1.0, -2.0);
        let second_position = Vec3::new(-4.0, 0.0, 7.0);
        let first_character = app
            .world_mut()
            .spawn((Character, Transform::from_translation(first_position)))
            .id();
        let second_character = app
            .world_mut()
            .spawn((Character, Transform::from_translation(second_position)))
            .id();
        let offset = Vec3::new(0.0, 6.0, 8.0);
        let first_camera = app
            .world_mut()
            .spawn((
                CameraFollow {
                    target: first_character,
                    offset,
                    look_height: 0.8,
                },
                Transform::default(),
            ))
            .id();
        let second_camera = app
            .world_mut()
            .spawn((
                CameraFollow {
                    target: second_character,
                    offset,
                    look_height: 0.8,
                },
                Transform::default(),
            ))
            .id();

        app.update();

        for (camera, position) in [
            (first_camera, first_position),
            (second_camera, second_position),
        ] {
            let transform = app.world().get::<Transform>(camera).unwrap();
            assert_eq!(transform.translation, position + offset);
            let expected_direction = (position + Vec3::Y * 0.8 - transform.translation).normalize();
            assert!(transform.forward().dot(expected_direction) > 0.999);
        }
    }
}

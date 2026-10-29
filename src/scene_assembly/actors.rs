//! 用 BSN 装配角色与可交互物品。

use super::*;

pub(super) fn courier_visual(scene: Handle<WorldAsset>, gltf: Handle<Gltf>) -> impl Scene {
    // 玩家在 Update 装配，早于下一帧相机可见性同步；先隐藏自身，避免首帧进入眼位。
    bsn! {
        Name("Courier visual") CharacterVisual CourierVisual { gltf } WorldAssetRoot(scene)
        Visibility::Hidden
    }
}

pub(super) fn courier_scene(
    pose: Transform,
    scene: Handle<WorldAsset>,
    gltf: Handle<Gltf>,
) -> impl Scene {
    bsn! {
        Name("Courier")
        Character
        CharacterIntent
        CharacterMotion { grounded: false }
        SpawnPoint { pose }
        pose
        Visibility
        Children [@courier_visual(scene, gltf)]
    }
}

pub(super) fn carryable_scene(
    item: Item,
    pose: Transform,
    scene: Handle<WorldAsset>,
) -> impl Scene {
    let grip = Vec3::new(
        0.0,
        1.3,
        if item == Item::WoodenCrate {
            -0.62
        } else {
            -0.48
        },
    );
    bsn! {
        Name({item.name()})
        Pickable
        CarryGrip { offset: grip }
        item
        SpawnPoint { pose }
        pose
        Visibility
        Children [Name("Carryable visual") WorldAssetRoot(scene)]
    }
}

pub(super) fn spawn_actors(
    mut commands: Commands,
    maps: Query<(Entity, &IslandReady), Without<ActorsSpawned>>,
    config: Res<PrototypeConfig>,
    assets: Res<ArtAssets>,
    gltfs: Res<Assets<Gltf>>,
    loading_camera: Query<Entity, With<LoadingCamera>>,
) {
    for (map, placement) in &maps {
        let courier = &gltfs
            .get(&assets.courier)
            .expect("Ready courier must be loaded")
            .scenes[0];
        // BSN 负责实体结构；已有无窗口物理回归的 Bundle 工厂继续统一刚体参数。
        let character = commands
            .spawn_scene(courier_scene(
                placement.player,
                courier.clone(),
                assets.courier.clone(),
            ))
            .insert((character_body(&config), DespawnOnEnter(AppState::MainMenu)))
            .id();
        let controller = spawn_keyboard_controller(&mut commands, PlayerId { id: 1 }, character);
        commands
            .entity(controller)
            .insert(DespawnOnEnter(AppState::MainMenu));
        for item_placement in &placement.items {
            let scene = gltfs
                .get(assets.item(item_placement.item))
                .expect("Ready item must be loaded")
                .scenes[0]
                .clone();
            let mut entity = commands.spawn_scene(carryable_scene(
                item_placement.item,
                item_placement.pose,
                scene,
            ));
            entity.insert((item_body(&config), DespawnOnEnter(AppState::MainMenu)));
            if item_placement.item == Item::WoodenCrate {
                // 木箱边框超出纸箱尺寸，中心偏移来自导出几何，视觉与碰撞使用相同米制比例。
                entity.insert(Collider::compound(vec![(
                    Vec3::new(0.0, 0.01625, 0.01625),
                    Quat::IDENTITY,
                    Collider::cuboid(0.84, 0.6825, 0.8145),
                )]));
            }
            let item = entity.id();
            info!(target: "demo::scene", ?item, kind = item_placement.item.name(), position = ?item_placement.pose.translation,
                reason = "island_ready", "Carryable item spawned");
        }
        let first_person = FirstPersonCamera::new(character);
        let camera_transform = first_person.transform(placement.player.translation);
        let camera = loading_camera
            .single()
            .expect("One loading camera must exist");
        commands.entity(camera).remove::<LoadingCamera>().insert((
            Name::new("Courier first-person camera"),
            first_person,
            MouseLookState::default(),
            camera_transform,
        ));
        commands
            .entity(controller)
            .insert(ControlsCamera { camera });
        commands.entity(map).insert(ActorsSpawned);
        info!(target: "demo::camera", ?camera, ?character, ?controller,
            position = ?camera_transform.translation, reason = "island_ready", "First-person camera spawned");
        info!(target: "demo::scene", ?character, ?controller, player_id = 1,
            position = ?placement.player.translation, reason = "island_ready", "Character and local controller spawned");
    }
}

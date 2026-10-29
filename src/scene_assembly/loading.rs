//! 等待场景和碰撞准备完成，再提交动态实体。

use super::*;

const ENTRY_FLOOR_MAX_HEIGHT_GAP_M: f32 = 0.3;
const ENTRY_FLOOR_MAX_EDGE_DISTANCE_M: f32 = 1.0;
const ENTRY_FLOOR_RAMP_OVERLAP_M: f32 = 0.05;
const PLAYER_SPAWN_LIFT_M: f32 = 0.03;

pub(super) fn lighting_scene() -> impl Scene {
    bsn! {
        Name("Island daylight")
        DespawnOnEnter::<AppState>(AppState::MainMenu)
        DirectionalLight { illuminance: 12_000.0, shadow_maps_enabled: true }
        Transform::from_xyz(6.0, 10.0, 8.0).looking_at(Vec3::ZERO, Vec3::Y)
    }
}

pub(super) fn spawn_lighting(mut commands: Commands) {
    commands.spawn_scene(lighting_scene());
    // 加载期间提供一个相机；准备好后复用同一实体，避免短暂出现两台主相机。
    commands.spawn_scene(bsn! {
        Name("Island loading camera")
        Camera3d
        IsDefaultUiCamera
        bevy_inspector_egui::bevy_egui::PrimaryEguiContext
        DespawnOnEnter::<AppState>(AppState::MainMenu)
        LoadingCamera
        Transform::from_xyz(-1.8, 6.0, 11.5).looking_at(Vec3::new(-1.8, 0.8, 3.5), Vec3::Y)
    });
}

#[derive(Component, Default, Clone)]
pub(super) struct LoadingCamera;

pub(super) fn island_scene(scene: Handle<WorldAsset>) -> impl Scene {
    bsn! {
        Name("Courier island") IslandMap WorldAssetRoot(scene)
        DespawnOnEnter::<AppState>(AppState::MainMenu)
    }
}

pub(super) fn begin_island(
    mut commands: Commands,
    assets: Res<ArtAssets>,
    gltfs: Res<Assets<Gltf>>,
    mut state: ResMut<ArtLoadState>,
    maps: Query<(), With<IslandMap>>,
) {
    if *state != ArtLoadState::Ready || !maps.is_empty() {
        return;
    }
    let Some(scene) = gltfs
        .get(&assets.island)
        .and_then(|gltf| gltf.scenes.first())
    else {
        *state = ArtLoadState::Failed;
        error!(target: "demo::scene", reason = "missing_map_scene", "Island initialization failed");
        return;
    };
    let entity = commands.spawn_scene(island_scene(scene.clone())).id();
    info!(target: "demo::scene", ?entity, reason = "assets_ready", "Island scene requested");
}

pub(super) fn mark_island_ready(
    ready: On<WorldInstanceReady>,
    mut commands: Commands,
    maps: Query<(), (With<IslandMap>, Without<IslandReady>)>,
) {
    if maps.contains(ready.entity) {
        commands.entity(ready.entity).insert(IslandPending);
    }
}

/// 在资源 CPU 几何可用时构建碰撞；全部成功后才提交，失败时不创建动态玩家。
pub(super) fn prepare_island(
    mut commands: Commands,
    maps: Query<Entity, With<IslandPending>>,
    children: Query<&Children>,
    metadata: Query<(&GltfExtras, &Transform)>,
    nodes: Query<(&Transform, Option<&Name>, Option<&Mesh3d>)>,
    meshes: Res<Assets<Mesh>>,
    config: Res<PrototypeConfig>,
    mut state: ResMut<ArtLoadState>,
) {
    if *state != ArtLoadState::Ready {
        return;
    }
    for map in &maps {
        let mut player = None;
        let mut items = Vec::new();
        let mut remove = Vec::new();
        let mut npcs = Vec::new();
        let mut colliders = Vec::new();
        let mut ramps = Vec::new();
        let mut floors = Vec::new();
        let mut ramp_count = 0;
        let mut terrain_found = false;
        for instance in children.iter_descendants(map) {
            let Ok((extras, pose)) = metadata.get(instance) else {
                continue;
            };
            let Ok(asset) = serde_json::from_str::<MapAsset>(&extras.value) else {
                continue;
            };
            match asset.source_asset.as_str() {
                "chr_courier" => {
                    player = Some(*pose);
                    remove.push(instance);
                }
                "prop_parcel_standard" | "prop_parcel_fragile" | "prop_crate" => {
                    if asset.source_asset == "prop_crate" {
                        // 展示位置穿进站点墙体与柜台；整体移入柜台和货架之间的净空，保留布局和朝向。
                        let mut pose = *pose;
                        pose.translation += Vec3::new(0.8, 0.165, -2.06);
                        items.push(ItemPlacement {
                            model: ItemModel::WoodenCrate,
                            pose,
                        });
                    }
                    remove.push(instance);
                }
                _ if asset.category == "characters" => npcs.push(instance),
                _ => {
                    let mut geometry = CollisionGeometry::default();
                    if let Err(error) = collect_geometry(
                        instance,
                        Mat4::IDENTITY,
                        false,
                        "",
                        &asset.source_asset,
                        &children,
                        &nodes,
                        &meshes,
                        &mut geometry,
                    ) {
                        *state = ArtLoadState::Failed;
                        error!(target: "demo::scene", ?instance, asset = asset.source_asset,
                            %error, reason = "collision_geometry_failed", "Island initialization failed");
                        return;
                    }
                    if let Some(bounds) = geometry.floor_bounds {
                        floors.push(transform_bounds(bounds, pose.to_matrix()));
                    }
                    if !geometry.indices.is_empty() {
                        match Collider::try_trimesh_with_config(
                            geometry.vertices,
                            geometry.indices,
                            TrimeshFlags::MERGE_DUPLICATE_VERTICES
                                | TrimeshFlags::FIX_INTERNAL_EDGES,
                        ) {
                            Ok(collider) => colliders.push((instance, collider)),
                            Err(error) => {
                                *state = ArtLoadState::Failed;
                                error!(target: "demo::scene", ?instance, asset = asset.source_asset,
                                    %error, reason = "collider_build_failed", "Island initialization failed");
                                return;
                            }
                        }
                        terrain_found |= asset.source_asset == "env_island_terrain";
                    }
                    for (min, max) in geometry.ramps.into_values() {
                        ramps.push((instance, *pose, min, max));
                    }
                }
            }
        }
        let Some(mut player) = player.filter(|_| terrain_found) else {
            *state = ArtLoadState::Failed;
            error!(target: "demo::scene", reason = "missing_player_or_terrain", "Island initialization failed");
            return;
        };
        for (parent, pose, mut min, mut max) in ramps {
            let inverse = pose.to_matrix().inverse();
            let center_x = (min.x + max.x) * 0.5;
            let floor = floors
                .iter()
                .map(|&bounds| transform_bounds(bounds, inverse))
                .filter(|(floor_min, floor_max)| {
                    (floor_min.x..=floor_max.x).contains(&center_x)
                        && (0.0..=ENTRY_FLOOR_MAX_HEIGHT_GAP_M).contains(&(floor_max.y - max.y))
                        && (floor_max.z - min.z).abs() < ENTRY_FLOOR_MAX_EDGE_DISTANCE_M
                })
                .min_by(|(_, a), (_, b)| (a.z - min.z).abs().total_cmp(&(b.z - min.z).abs()));
            let Some((_, floor_max)) = floor else {
                *state = ArtLoadState::Failed;
                error!(target: "demo::scene", ?parent, reason = "missing_entry_floor", "Island initialization failed");
                return;
            };
            // 台阶与地板间仍有空隙和 18cm 高差；连接实际前缘并重叠 5cm，避免走入室内时腾空。
            min.z = floor_max.z - ENTRY_FLOOR_RAMP_OVERLAP_M;
            max.y = floor_max.y;
            colliders.push((parent, stair_ramp(min, max)));
            ramp_count += 1;
        }
        player.translation.y += PLAYER_SPAWN_LIFT_M;
        for (model, offset) in [
            (ItemModel::StandardParcel, Vec3::new(0.0, 0.3, -1.3)),
            (ItemModel::FragileParcel, Vec3::new(1.2, 0.3, -1.3)),
        ] {
            items.push(ItemPlacement {
                model,
                pose: Transform::from_translation(player.translation + offset),
            });
        }
        let collider_count = colliders.len() + npcs.len();
        for (parent, collider) in colliders {
            // 碰撞日志保留导入来源，避免不同建筑和平台都只显示同一个通用名称。
            let source = nodes
                .get(parent)
                .ok()
                .and_then(|(_, name, _)| name)
                .map_or("unnamed", Name::as_str);
            let name = Name::new(format!("Island static collider ({source})"));
            commands.spawn_scene(bsn! {
                name
                IslandCollider
                RigidBody::Static
                collider
                world_collision_layers()
                ChildOf(parent)
            });
        }
        for &entity in &remove {
            commands.entity(entity).despawn();
        }
        for &entity in &npcs {
            commands.entity(entity).insert(DisplayNpc);
            // 展示 NPC 保持固定站位；World 层同时阻挡玩家、自由箱体与整体持箱。
            // 独立碰撞子体沿用模型脚底原点，保留导入姿态并随地图层级清理。
            let npc_shape = character_collider(&config);
            let collider = commands
                .spawn_scene(bsn! {
                    Name("Display NPC collider")
                    IslandCollider
                    Transform
                    RigidBody::Static
                    npc_shape
                    world_collision_layers()
                    ChildOf(entity)
                })
                .id();
            info!(target: "demo::scene", npc = ?entity, ?collider,
                height = config.character_height, radius = config.character_radius,
                reason = "npc_collision_ready", "Display NPC collider initialized");
        }
        commands
            .entity(map)
            .remove::<IslandPending>()
            .insert(IslandReady { player, items });
        info!(target: "demo::scene", ?map, collider_count, ramp_count,
            npc_count = npcs.len(), npc_collider_count = npcs.len(), replaced_instances = remove.len(),
            reason = "map_geometry_ready", "Island colliders ready");
    }
}

//! BSN 组合业务实体和视觉层级；地图实例化并完成静态碰撞后才生成动态玩家。

use std::collections::BTreeMap;

use avian3d::prelude::{Collider, RigidBody, TrimeshFlags};
use bevy::{prelude::*, world_serialization::WorldInstanceReady};
use serde::Deserialize;

use crate::{
    art_assets::{ArtAssets, ArtLoadState, ItemModel},
    camera::{CharacterVisual, ControlsCamera, MouseLookState, OrbitCamera},
    character_animation::CourierVisual,
    gameplay::{
        CarryGrip, Character, CharacterIntent, CharacterMotion, Parcel, Pickable, PlayerId,
        PrototypeConfig,
    },
    input::spawn_keyboard_controller,
    island_recovery::SpawnPoint,
    physics::{character_body, parcel_body, world_collision_layers},
};

/// 完整海岛装配和导入边界；输入、模拟、动作和落水规则分别由各自插件处理。
pub struct PrototypeScenePlugin;

impl Plugin for PrototypeScenePlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(ClearColor(Color::srgb(0.72, 0.84, 0.94)))
            .insert_resource(GlobalAmbientLight {
                color: Color::WHITE,
                brightness: 250.0,
                ..default()
            })
            .add_systems(Startup, spawn_lighting)
            .add_observer(mark_island_ready)
            // 每一步应用延迟标记与碰撞命令，下一步才能观察完整的装配结果。
            .add_systems(Update, (begin_island, prepare_island, spawn_actors).chain());
    }
}

#[derive(Component, Default, Clone)]
struct IslandMap;
#[derive(Component)]
struct IslandPending;
#[derive(Component)]
struct ActorsSpawned;

/// 展示 NPC 保留在地图内，不挂玩家运动和输入组件。
#[derive(Component)]
pub(crate) struct DisplayNpc;

/// 静态碰撞独立于美术网格，随原始实例层级清理，不改动其视觉姿态。
#[derive(Component, Default, Clone)]
pub(crate) struct IslandCollider;

#[derive(Clone)]
struct ItemPlacement {
    model: ItemModel,
    pose: Transform,
}

#[derive(Component)]
struct IslandReady {
    player: Transform,
    items: Vec<ItemPlacement>,
}

/// source_asset 仅在导入边界转换为业务组件，玩法系统不依赖模型名称。
#[derive(Deserialize)]
struct MapAsset {
    source_asset: String,
    category: String,
}

fn lighting_scene() -> impl Scene {
    bsn! {
        Name("Island daylight")
        DirectionalLight { illuminance: 12_000.0, shadow_maps_enabled: true }
        template_value(Transform::from_xyz(6.0, 10.0, 8.0).looking_at(Vec3::ZERO, Vec3::Y))
    }
}

fn spawn_lighting(mut commands: Commands) {
    commands.spawn_scene(lighting_scene());
    // 加载期间提供一个相机；准备好后复用同一实体，避免短暂出现两台主相机。
    commands.spawn_scene(bsn! {
        Name("Island loading camera")
        Camera3d
        LoadingCamera
        template_value(Transform::from_xyz(-1.8, 6.0, 11.5).looking_at(Vec3::new(-1.8, 0.8, 3.5), Vec3::Y))
    });
}

#[derive(Component, Default, Clone)]
struct LoadingCamera;

fn island_scene(scene: Handle<WorldAsset>) -> impl Scene {
    bsn! { Name("Courier island") IslandMap WorldAssetRoot(scene) }
}

fn begin_island(
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

fn mark_island_ready(
    ready: On<WorldInstanceReady>,
    mut commands: Commands,
    maps: Query<(), (With<IslandMap>, Without<IslandReady>)>,
) {
    if maps.contains(ready.entity) {
        commands.entity(ready.entity).insert(IslandPending);
    }
}

/// 在资源 CPU 几何可用时构建碰撞；全部成功后才提交，失败时不创建动态玩家。
fn prepare_island(
    mut commands: Commands,
    maps: Query<Entity, With<IslandPending>>,
    children: Query<&Children>,
    metadata: Query<(&GltfExtras, &Transform)>,
    nodes: Query<(&Transform, Option<&Name>, Option<&Mesh3d>)>,
    meshes: Res<Assets<Mesh>>,
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
                        && (0.0..=0.3).contains(&(floor_max.y - max.y))
                        && (floor_max.z - min.z).abs() < 1.0
                })
                .min_by(|(_, a), (_, b)| (a.z - min.z).abs().total_cmp(&(b.z - min.z).abs()));
            let Some((_, floor_max)) = floor else {
                *state = ArtLoadState::Failed;
                error!(target: "demo::scene", ?parent, reason = "missing_entry_floor", "Island initialization failed");
                return;
            };
            // 台阶与地板间仍有空隙和 18cm 高差；连接实际前缘并重叠 5cm，避免走入室内时腾空。
            min.z = floor_max.z - 0.05;
            max.y = floor_max.y;
            colliders.push((parent, stair_ramp(min, max)));
            ramp_count += 1;
        }
        player.translation.y += 0.03;
        for (model, offset) in [
            (ItemModel::StandardParcel, Vec3::new(0.0, 0.3, -1.3)),
            (ItemModel::FragileParcel, Vec3::new(1.2, 0.3, -1.3)),
        ] {
            items.push(ItemPlacement {
                model,
                pose: Transform::from_translation(player.translation + offset),
            });
        }
        let collider_count = colliders.len();
        for (parent, collider) in colliders {
            commands.spawn_scene(bsn! {
                Name("Island static collider")
                IslandCollider
                template_value(RigidBody::Static)
                template_value(collider)
                template_value(world_collision_layers())
                ChildOf(parent)
            });
        }
        for &entity in &remove {
            commands.entity(entity).despawn();
        }
        for &entity in &npcs {
            commands.entity(entity).insert(DisplayNpc);
        }
        commands
            .entity(map)
            .remove::<IslandPending>()
            .insert(IslandReady { player, items });
        info!(target: "demo::scene", ?map, collider_count, ramp_count,
            npc_count = npcs.len(), replaced_instances = remove.len(),
            reason = "map_geometry_ready", "Island colliders ready");
    }
}

#[derive(Default)]
struct CollisionGeometry {
    vertices: Vec<Vec3>,
    indices: Vec<[u32; 3]>,
    ramps: BTreeMap<String, (Vec3, Vec3)>,
    floor_bounds: Option<(Vec3, Vec3)>,
}

/// 包围体沿实例变换转换坐标，供不同美术根之间的入口连接匹配。
fn transform_bounds((min, max): (Vec3, Vec3), matrix: Mat4) -> (Vec3, Vec3) {
    let mut lower = Vec3::splat(f32::INFINITY);
    let mut upper = Vec3::splat(f32::NEG_INFINITY);
    for x in [min.x, max.x] {
        for y in [min.y, max.y] {
            for z in [min.z, max.z] {
                let point = matrix.transform_point3(Vec3::new(x, y, z));
                lower = lower.min(point);
                upper = upper.max(point);
            }
        }
    }
    (lower, upper)
}

/// 坐标累积使用本地 Transform，不假设场景就绪事件时已完成本帧 GlobalTransform 传播。
fn collect_geometry(
    entity: Entity,
    parent_matrix: Mat4,
    include_transform: bool,
    part_name: &str,
    asset: &str,
    children: &Query<&Children>,
    nodes: &Query<(&Transform, Option<&Name>, Option<&Mesh3d>)>,
    meshes: &Assets<Mesh>,
    geometry: &mut CollisionGeometry,
) -> Result<(), String> {
    let (transform, name, mesh) = nodes.get(entity).map_err(|error| error.to_string())?;
    // glTF 原语是命名节点的子实体；碰撞分类沿用父节点的美术部件名，忽略原语名。
    let part_name = if mesh.is_none() {
        name.map_or(part_name, |name| name.as_str())
    } else {
        part_name
    };
    let matrix = if include_transform {
        parent_matrix * transform.to_matrix()
    } else {
        parent_matrix
    };
    if let Some(mesh) = mesh {
        let ramp = stair_group(asset, part_name);
        if ramp.is_some() || solid_mesh(asset, part_name) {
            let mesh = meshes
                .get(&mesh.0)
                .ok_or_else(|| "Collision mesh unavailable".to_owned())?;
            for triangle in mesh.triangles().map_err(|error| error.to_string())? {
                let vertices = triangle
                    .vertices
                    .map(|point| matrix.transform_point3(point));
                if asset.starts_with("bld_")
                    && (part_name.contains("Floor_board_") || part_name.contains("Hut floor board"))
                {
                    let bounds = geometry.floor_bounds.get_or_insert((
                        Vec3::splat(f32::INFINITY),
                        Vec3::splat(f32::NEG_INFINITY),
                    ));
                    for &point in &vertices {
                        bounds.0 = bounds.0.min(point);
                        bounds.1 = bounds.1.max(point);
                    }
                }
                if let Some(group) = &ramp {
                    let bounds = geometry
                        .ramps
                        .entry(group.clone())
                        .or_insert((Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY)));
                    for point in vertices {
                        bounds.0 = bounds.0.min(point);
                        bounds.1 = bounds.1.max(point);
                    }
                } else {
                    let start = geometry.vertices.len() as u32;
                    geometry.vertices.extend(vertices);
                    geometry.indices.push([start, start + 1, start + 2]);
                }
            }
        }
    }
    if let Ok(children_of_entity) = children.get(entity) {
        for &child in children_of_entity {
            collect_geometry(
                child, matrix, true, part_name, asset, children, nodes, meshes, geometry,
            )?;
        }
    }
    Ok(())
}

/// 模型命名只在美术导入边界解释，草、海水、叶片和人物不会成为隐形障碍。
fn solid_mesh(asset: &str, name: &str) -> bool {
    if asset.starts_with("bld_") || asset == "env_island_terrain" || asset == "env_dock" {
        return true;
    }
    if asset == "env_stairs_railings" {
        return stair_group(asset, name).is_none();
    }
    if asset.starts_with("prop_palm_") {
        return name.contains("Bent trunk segment");
    }
    matches!(
        asset,
        "prop_mailbox" | "prop_bench" | "prop_planter" | "prop_street_lamp" | "prop_dock_bollard"
    )
}

fn stair_group(asset: &str, name: &str) -> Option<String> {
    if asset != "env_stairs_railings" || !(name.contains("_step_") || name.contains("Home_steps_"))
    {
        return None;
    }
    name.rsplit_once('_').map(|(group, _)| group.to_owned())
}

fn stair_ramp(min: Vec3, max: Vec3) -> Collider {
    let front = max.z + 0.36;
    let bottom = min.y - 0.05;
    // 楔体顶从地面升到平台，向前延长一踏面；所有当前入口朝导出坐标 +Z。
    Collider::convex_hull(vec![
        Vec3::new(min.x, bottom, front),
        Vec3::new(max.x, bottom, front),
        Vec3::new(min.x, bottom, min.z),
        Vec3::new(max.x, bottom, min.z),
        Vec3::new(min.x, max.y, min.z),
        Vec3::new(max.x, max.y, min.z),
        Vec3::new(min.x, min.y, front),
        Vec3::new(max.x, min.y, front),
    ])
    .expect("Stair bounds must produce a non-degenerate ramp")
}

fn courier_visual(scene: Handle<WorldAsset>, gltf: Handle<Gltf>) -> impl Scene {
    bsn! { Name("Courier visual") CharacterVisual CourierVisual(gltf) WorldAssetRoot(scene) }
}

fn courier_scene(pose: Transform, scene: Handle<WorldAsset>, gltf: Handle<Gltf>) -> impl Scene {
    bsn! {
        Name("Courier")
        Character
        CharacterIntent
        CharacterMotion { grounded: false }
        SpawnPoint(pose)
        template_value(pose)
        Visibility
        Children [courier_visual(scene, gltf)]
    }
}

fn carryable_scene(model: ItemModel, pose: Transform, scene: Handle<WorldAsset>) -> impl Scene {
    let grip = Vec3::new(
        0.0,
        1.3,
        if model == ItemModel::WoodenCrate {
            -0.62
        } else {
            -0.48
        },
    );
    bsn! {
        Name({model.name()})
        Parcel
        Pickable
        CarryGrip(grip)
        template_value(model)
        SpawnPoint(pose)
        template_value(pose)
        Visibility
        Children [(Name("Carryable visual") WorldAssetRoot(scene))]
    }
}

fn spawn_actors(
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
            .insert(character_body(&config))
            .id();
        let controller = spawn_keyboard_controller(&mut commands, PlayerId(1), character);
        for item in &placement.items {
            let scene = gltfs
                .get(assets.item(item.model))
                .expect("Ready item must be loaded")
                .scenes[0]
                .clone();
            let mut entity = commands.spawn_scene(carryable_scene(item.model, item.pose, scene));
            entity.insert(parcel_body(&config));
            if item.model == ItemModel::WoodenCrate {
                // 木箱边框超出纸箱尺寸，中心偏移来自导出几何，视觉与碰撞使用相同米制比例。
                entity.insert(Collider::compound(vec![(
                    Vec3::new(0.0, 0.01625, 0.01625),
                    Quat::IDENTITY,
                    Collider::cuboid(0.84, 0.6825, 0.8145),
                )]));
            }
            let parcel = entity.id();
            info!(target: "demo::scene", ?parcel, model = item.model.name(), position = ?item.pose.translation,
                reason = "island_ready", "Carryable item spawned");
        }
        let orbit = OrbitCamera::new(character);
        let camera_transform = orbit.transform(placement.player.translation);
        let camera = loading_camera
            .single()
            .expect("One loading camera must exist");
        commands.entity(camera).remove::<LoadingCamera>().insert((
            Name::new("Courier orbit camera"),
            orbit,
            MouseLookState::default(),
            camera_transform,
        ));
        commands.entity(controller).insert(ControlsCamera(camera));
        commands.entity(map).insert(ActorsSpawned);
        info!(target: "demo::camera", ?camera, ?character, ?controller,
            position = ?camera_transform.translation, perspective = "third_person", reason = "island_ready", "Orbit camera spawned");
        info!(target: "demo::scene", ?character, ?controller, player_id = 1,
            position = ?placement.player.translation, reason = "island_ready", "Character and local controller spawned");
    }
}

#[cfg(test)]
#[path = "scene_tests.rs"]
mod tests;

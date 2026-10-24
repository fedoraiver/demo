//! 从场景网格构建碰撞几何与入口斜坡。

use super::*;

#[derive(Default)]
pub(super) struct CollisionGeometry {
    pub(super) vertices: Vec<Vec3>,
    pub(super) indices: Vec<[u32; 3]>,
    pub(super) ramps: BTreeMap<String, (Vec3, Vec3)>,
    pub(super) floor_bounds: Option<(Vec3, Vec3)>,
}

/// 包围体沿实例变换转换坐标，供不同美术根之间的入口连接匹配。
pub(super) fn transform_bounds((min, max): (Vec3, Vec3), matrix: Mat4) -> (Vec3, Vec3) {
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
pub(super) fn collect_geometry(
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
pub(super) fn solid_mesh(asset: &str, name: &str) -> bool {
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

pub(super) fn stair_group(asset: &str, name: &str) -> Option<String> {
    if asset != "env_stairs_railings" || !(name.contains("_step_") || name.contains("Home_steps_"))
    {
        return None;
    }
    name.rsplit_once('_').map(|(group, _)| group.to_owned())
}

pub(super) fn stair_ramp(min: Vec3, max: Vec3) -> Collider {
    let front = max.z + 0.36;
    let bottom = min.y - 0.05;
    // 楔体顶从地面升到平台，向前延长一踏面；所有当前入口朝导出坐标 +Z。
    Collider::convex_hull(&[
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

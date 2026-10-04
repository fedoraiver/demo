//! 只检测建筑外壳遮挡并请求材质淡化，镜头位置与方向继续由原有跟随系统决定。

use std::collections::HashSet;

use avian3d::prelude::{Collider, ShapeCastConfig, SpatialQuery, SpatialQueryFilter};
use bevy::{ecs::relationship::Relationship, prelude::*};

use crate::{
    camera::OrbitCamera,
    gameplay::{Character, HeldBy},
    physics::GamePhysicsLayer,
};

const OCCLUSION_RADIUS: f32 = 0.12;
const NEAR_CAMERA_FADE_RADIUS: f32 = 0.25;

/// 外壳查询几何关联所属建筑，命中只请求半透明，不修正镜头。
#[derive(Component, Clone, Copy)]
pub(crate) struct CameraShell(pub Entity);

/// 在美术导入边界标记外壳原语，运行时不再依赖模型部件名称。
#[derive(Component, Clone, Copy)]
pub(crate) struct BuildingShellVisual(pub Entity);

/// 各有效第三人称相机本帧的遮挡并集；每次显示同步从空集合重建。
#[derive(Resource, Default)]
pub(crate) struct OccludedBuildings {
    pub(crate) buildings: HashSet<Entity>,
    pub(crate) active_cameras: usize,
}

/// 每台相机只记住上一帧的建筑需求，用于记录离散变化，不保存实际距离。
#[derive(Component, Default)]
pub(crate) struct CameraOcclusion {
    buildings: HashSet<Entity>,
}

/// 插值完成后读取业务根 Transform；此时模型子节点 GlobalTransform 尚未传播。
/// 本系统没有 Transform 写入权限，建筑或硬障碍都不会改变相机姿态。
pub(crate) fn detect_building_occlusion(
    spatial_query: SpatialQuery,
    characters: Query<&Transform, With<Character>>,
    held_items: Query<(&HeldBy, &Transform)>,
    shells: Query<&CameraShell>,
    mut occluded: ResMut<OccludedBuildings>,
    mut cameras: Query<(Entity, &OrbitCamera, &mut CameraOcclusion)>,
    mut detected: Local<HashSet<Entity>>,
) {
    occluded.buildings.clear();
    occluded.active_cameras = 0;
    let filter = SpatialQueryFilter::default().with_mask(GamePhysicsLayer::CameraQuery);
    let probe = Collider::sphere(OCCLUSION_RADIUS);
    let near_camera_probe = Collider::sphere(NEAR_CAMERA_FADE_RADIUS);

    for (camera, orbit, mut state) in &mut cameras {
        detected.clear();
        let character = characters
            .get(orbit.target)
            .ok()
            .filter(|_| orbit.is_third_person());
        if let Some(character) = character {
            occluded.active_cameras += 1;
            let ideal = orbit.transform(character.translation);
            // 保护人物下半身、胸口和头部；持物使用实际插值位置，不使用理想握持位置。
            for height in [0.5, 1.2, 1.8] {
                collect_shell_occlusion(
                    &spatial_query,
                    &shells,
                    &filter,
                    &probe,
                    ideal.translation,
                    character.translation + Vec3::Y * height,
                    &mut detected,
                );
            }
            for (holder, item) in &held_items {
                if holder.get() == orbit.target {
                    collect_shell_occlusion(
                        &spatial_query,
                        &shells,
                        &filter,
                        &probe,
                        ideal.translation,
                        item.translation,
                        &mut detected,
                    );
                }
            }
            // 镜头靠近或落入外壳时只淡化该建筑，继续保留原来的固定距离跟随。
            spatial_query.shape_intersections_callback(
                &near_camera_probe,
                ideal.translation,
                Quat::IDENTITY,
                &filter,
                |entity| {
                    if let Ok(shell) = shells.get(entity) {
                        detected.insert(shell.0);
                    }
                    true
                },
            );
        }
        let reason = if character.is_some() {
            "visibility_query"
        } else {
            "inactive_third_person_target"
        };
        for &building in state.buildings.difference(&detected) {
            info!(target: "demo::camera", ?camera, target_entity = ?orbit.target, ?building,
                occluded_before = true, occluded_after = false, reason,
                "Camera building occlusion changed");
        }
        for &building in detected.difference(&state.buildings) {
            info!(target: "demo::camera", ?camera, target_entity = ?orbit.target, ?building,
                occluded_before = false, occluded_after = true, reason,
                "Camera building occlusion changed");
        }
        occluded.buildings.extend(detected.iter().copied());
        // 交换并复用集合容量；每帧无需重新分配每台相机的需求缓冲。
        std::mem::swap(&mut state.buildings, &mut detected);
    }
}

fn collect_shell_occlusion(
    spatial_query: &SpatialQuery,
    shells: &Query<&CameraShell>,
    filter: &SpatialQueryFilter,
    probe: &Collider,
    camera: Vec3,
    target: Vec3,
    buildings: &mut HashSet<Entity>,
) {
    let offset = target - camera;
    if let Ok(direction) = Dir3::new(offset) {
        // 小球扫掠覆盖木板接缝和身体边缘；中心射线穿过细缝不能证明整个人物可见。
        // 遍历所有外壳命中，允许前后两栋建筑同时遮挡同一个人物。
        spatial_query.shape_hits_callback(
            probe,
            camera,
            Quat::IDENTITY,
            direction,
            &ShapeCastConfig::from_max_distance(offset.length()),
            filter,
            |hit| {
                if let Ok(shell) = shells.get(hit.entity) {
                    buildings.insert(shell.0);
                }
                true
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use avian3d::{interpolation::TransformEasingSystems, prelude::*};
    use bevy::{time::TimeUpdateStrategy, transform::TransformPlugin};

    use crate::{camera::follow_orbit_camera, physics::camera_query_layers};

    use super::*;

    fn app() -> (App, Entity, Entity) {
        // 最小物理/变换调度，不安装渲染、窗口或完整游戏插件。
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, TransformPlugin, PhysicsPlugins::default()))
            .insert_resource(Gravity(Vec3::ZERO))
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
                1.0 / 60.0,
            )))
            .init_resource::<OccludedBuildings>()
            .add_systems(
                RunFixedMainLoop,
                (follow_orbit_camera, detect_building_occlusion)
                    .chain()
                    .in_set(RunFixedMainLoopSystems::AfterFixedMainLoop)
                    .after(TransformEasingSystems::Ease)
                    .before(TransformEasingSystems::UpdateEasingTick),
            );
        app.finish();
        app.cleanup();
        let character = app
            .world_mut()
            .spawn((Character, Transform::default()))
            .id();
        let orbit = OrbitCamera::new(character);
        let ideal = orbit.transform(Vec3::ZERO);
        let camera = app.world_mut().spawn((orbit, ideal)).id();
        (app, character, camera)
    }

    fn initialize(app: &mut App) {
        app.update();
        app.update();
        app.update();
    }

    fn shell(app: &mut App, owner: Entity, center: Vec3, size: Vec3) -> Entity {
        app.world_mut()
            .spawn((
                CameraShell(owner),
                RigidBody::Static,
                Collider::cuboid(size.x, size.y, size.z),
                camera_query_layers(),
                Transform::from_translation(center),
            ))
            .id()
    }

    #[test]
    fn world_obstacles_and_shell_overlap_never_change_camera_pose() {
        let (mut app, character, camera) = app();
        let building = app.world_mut().spawn_empty().id();
        shell(
            &mut app,
            building,
            Vec3::new(0.0, 3.5, 4.0),
            Vec3::new(8.0, 8.0, 0.1),
        );
        let ideal = app
            .world()
            .get::<OrbitCamera>(camera)
            .unwrap()
            .transform(Vec3::ZERO);
        let hard = app
            .world_mut()
            .spawn((
                RigidBody::Static,
                Collider::cuboid(8.0, 8.0, 0.2),
                crate::physics::world_collision_layers(),
                Transform::from_xyz(0.0, 3.0, 2.0),
            ))
            .id();
        initialize(&mut app);
        assert_eq!(*app.world().get::<Transform>(camera).unwrap(), ideal);
        assert!(
            app.world()
                .resource::<OccludedBuildings>()
                .buildings
                .contains(&building)
        );
        // 镜头中心位于另一块透明外壳内时仍保持相同姿态，只增加淡化需求。
        let near_building = app.world_mut().spawn_empty().id();
        shell(
            &mut app,
            near_building,
            ideal.translation,
            Vec3::new(8.0, 8.0, 0.1),
        );
        initialize(&mut app);
        assert_eq!(*app.world().get::<Transform>(camera).unwrap(), ideal);
        assert!(
            app.world()
                .resource::<OccludedBuildings>()
                .buildings
                .contains(&near_building)
        );
        app.world_mut().despawn(hard);
        app.update();
        assert_eq!(*app.world().get::<Transform>(camera).unwrap(), ideal);
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
    }

    #[test]
    fn held_item_occlusion_and_camera_union_survive_one_missing_target() {
        let (mut app, character, camera) = app();
        let building = app.world_mut().spawn_empty().id();
        // 小板只挡住手中物品的射线，不挡人物三个取样点。
        shell(
            &mut app,
            building,
            Vec3::new(2.0, 3.5, 4.0),
            Vec3::new(0.5, 1.0, 0.1),
        );
        initialize(&mut app);
        assert!(
            app.world()
                .resource::<OccludedBuildings>()
                .buildings
                .is_empty()
        );
        app.world_mut().spawn((
            <HeldBy as Relationship>::from(character),
            Transform::from_xyz(4.0, 1.0, 0.0),
        ));
        app.update();
        assert!(
            app.world()
                .resource::<OccludedBuildings>()
                .buildings
                .contains(&building)
        );
        let second = app
            .world_mut()
            .spawn((OrbitCamera::new(character), Transform::default()))
            .id();
        app.world_mut().despawn(camera);
        app.update();
        assert_eq!(
            app.world().resource::<OccludedBuildings>().active_cameras,
            1
        );
        assert!(
            app.world()
                .resource::<OccludedBuildings>()
                .buildings
                .contains(&building)
        );
        app.world_mut().despawn(character);
        app.update();
        assert!(
            app.world()
                .resource::<OccludedBuildings>()
                .buildings
                .is_empty()
        );
        assert!(
            app.world()
                .get::<CameraOcclusion>(second)
                .unwrap()
                .buildings
                .is_empty()
        );
    }

    #[test]
    fn narrow_board_seam_does_not_hide_actual_shell_occlusion() {
        let (mut app, _, camera) = app();
        let building = app.world_mut().spawn_empty().id();
        // 两块板之间留两厘米竖缝，人物中心射线都能穿过，但身体仍被墙挡住。
        for x in [-0.51, 0.51] {
            shell(
                &mut app,
                building,
                Vec3::new(x, 3.5, 4.0),
                Vec3::new(1.0, 8.0, 0.1),
            );
        }
        initialize(&mut app);
        assert!(
            app.world()
                .resource::<OccludedBuildings>()
                .buildings
                .contains(&building)
        );
        let ideal = app
            .world()
            .get::<OrbitCamera>(camera)
            .unwrap()
            .transform(Vec3::ZERO);
        assert!(
            app.world()
                .get::<Transform>(camera)
                .unwrap()
                .translation
                .abs_diff_eq(ideal.translation, 0.00001)
        );
    }

    #[test]
    fn zero_fixed_step_presentation_still_detects_presented_target_position() {
        let (mut app, character, camera) = app();
        let building = app.world_mut().spawn_empty().id();
        shell(
            &mut app,
            building,
            Vec3::new(0.0, 3.5, 4.0),
            Vec3::new(8.0, 8.0, 0.1),
        );
        initialize(&mut app);
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
        // 角色在本帧呈现中移动；不补跑物理或手动调用被测系统。
        app.world_mut()
            .get_mut::<Transform>(character)
            .unwrap()
            .translation
            .x = 15.0;
        app.update();
        assert!(
            app.world()
                .resource::<OccludedBuildings>()
                .buildings
                .is_empty()
        );
        assert!(app.world().get::<Transform>(camera).unwrap().translation.x > 14.0);
    }
}

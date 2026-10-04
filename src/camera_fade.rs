//! 建筑外壳的实例级材质淡化；外壳遮挡需求由检测系统提供。

use std::collections::{HashMap, HashSet};

use bevy::{asset::AssetId, prelude::*};

use crate::{
    camera::OrbitCamera,
    camera_obstruction::{BuildingShellVisual, OccludedBuildings},
    gameplay::Character,
};

const OCCLUDED_FACTOR: f32 = 0.20;
const FADE_SECONDS: f32 = 0.15;
const CLEAR_GRACE_SECONDS: f32 = 0.25;
const RESTORE_SECONDS: f32 = 0.35;

/// 渐变属于建筑实例，不写入相机或共享的美术材质。
#[derive(Component)]
pub(crate) struct BuildingFadeState {
    factor: f32,
    clear_elapsed: f32,
    occluded: bool,
}

impl Default for BuildingFadeState {
    fn default() -> Self {
        Self {
            factor: 1.0,
            clear_elapsed: 0.0,
            occluded: false,
        }
    }
}

impl BuildingFadeState {
    /// 跨越宽限边界的帧只用剩余时间恢复，避免低帧率时提前恢复。
    fn advance(&mut self, occluded: bool, delta: f32) {
        self.occluded = occluded;
        if occluded {
            self.clear_elapsed = 0.0;
            self.factor =
                (self.factor - (1.0 - OCCLUDED_FACTOR) * delta / FADE_SECONDS).max(OCCLUDED_FACTOR);
        } else {
            let restore_delta =
                (delta - (CLEAR_GRACE_SECONDS - self.clear_elapsed).max(0.0)).max(0.0);
            self.clear_elapsed = (self.clear_elapsed + delta).min(CLEAR_GRACE_SECONDS);
            self.factor =
                (self.factor + (1.0 - OCCLUDED_FACTOR) * restore_delta / RESTORE_SECONDS).min(1.0);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct MaterialKey {
    building: Entity,
    original: AssetId<StandardMaterial>,
}

struct CachedMaterial {
    // 强句柄覆盖副本使用期；外壳暂时换成副本时不能丢失原材质。
    original: Handle<StandardMaterial>,
    faded: Handle<StandardMaterial>,
}

/// 同栋同原材质复用副本；正常恢复后保留缓存，直到实例或材质关联消失。
#[derive(Resource, Default)]
pub(crate) struct ShellMaterialCache {
    materials: HashMap<MaterialKey, CachedMaterial>,
}

/// 只恢复本系统仍拥有的绑定，避免覆盖检查器或其他系统换上的新句柄。
#[derive(Component)]
pub(crate) struct ShellMaterialBinding {
    building: Entity,
    original: Handle<StandardMaterial>,
    faded: Handle<StandardMaterial>,
}

/// 初始化无窗口也可使用的材质资源，并让销毁清理独立于暂停条件执行。
pub(crate) fn init(app: &mut App) {
    app.init_resource::<Assets<StandardMaterial>>()
        .init_resource::<Time<Virtual>>()
        .init_resource::<ShellMaterialCache>()
        .add_systems(Last, cleanup_fade_materials);
}

fn faded_material(
    building: Entity,
    original: &Handle<StandardMaterial>,
    cache: &mut ShellMaterialCache,
    materials: &mut Assets<StandardMaterial>,
) -> Option<Handle<StandardMaterial>> {
    let key = MaterialKey {
        building,
        original: original.id(),
    };
    if let Some(cached) = cache.materials.get(&key)
        && materials.contains(cached.faded.id())
    {
        return Some(cached.faded.clone());
    }
    let mut material = materials.get(original)?.clone();
    // 仅副本进入混合渲染；地板、家具及其他实例使用的原材质保持原样。
    material.alpha_mode = AlphaMode::Blend;
    let faded = materials.add(material);
    cache.materials.insert(
        key,
        CachedMaterial {
            original: original.clone(),
            faded: faded.clone(),
        },
    );
    Some(faded)
}

/// 在本帧建筑遮挡并集确定后，统一更新外壳材质。
pub(crate) fn update_building_fades(
    mut commands: Commands,
    time: Res<Time<Virtual>>,
    occluded: Res<OccludedBuildings>,
    entities: Query<()>,
    mut states: Query<&mut BuildingFadeState>,
    mut shells: Query<(
        Entity,
        &BuildingShellVisual,
        &mut MeshMaterial3d<StandardMaterial>,
        Option<&ShellMaterialBinding>,
    )>,
    mut cache: ResMut<ShellMaterialCache>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let buildings: HashSet<_> = shells
        .iter()
        .filter_map(|(_, shell, _, _)| entities.contains(shell.0).then_some(shell.0))
        .collect();
    let mut factors = HashMap::with_capacity(buildings.len());
    for building in buildings {
        let mut new_state = BuildingFadeState::default();
        let existing = states.get_mut(building).ok();
        let mut state = match existing {
            Some(state) => state,
            None => {
                update_state(building, &mut new_state, &occluded, time.delta_secs());
                factors.insert(building, new_state.factor);
                commands.entity(building).insert(new_state);
                continue;
            }
        };
        update_state(building, &mut state, &occluded, time.delta_secs());
        factors.insert(building, state.factor);
    }

    for (entity, shell, mut current, binding) in &mut shells {
        let Some(&factor) = factors.get(&shell.0) else {
            continue;
        };
        if factor >= 1.0 {
            if let Some(binding) = binding {
                if current.0.id() == binding.faded.id() {
                    current.0 = binding.original.clone();
                }
                commands.entity(entity).remove::<ShellMaterialBinding>();
            }
            continue;
        }

        // 外部换句柄或外壳换所属实例时，以当前真实原材质重新建立关联。
        let original = binding
            .filter(|binding| current.0.id() == binding.faded.id())
            .map_or_else(|| current.0.clone(), |binding| binding.original.clone());
        let Some(original_alpha) = materials
            .get(&original)
            .map(|material| material.base_color.alpha())
        else {
            continue;
        };
        let Some(faded) = faded_material(shell.0, &original, &mut cache, &mut materials) else {
            continue;
        };
        // 采用原 alpha 的比例，原本半透明的玻璃不能被淡化成更不透明。
        let alpha = original_alpha * factor;
        if materials
            .get(&faded)
            .is_some_and(|material| material.base_color.alpha() != alpha)
            && let Some(mut material) = materials.get_mut(&faded)
        {
            material.base_color.set_alpha(alpha);
        }
        if current.0.id() != faded.id() {
            current.0 = faded.clone();
        }
        if binding.is_none_or(|binding| {
            binding.building != shell.0
                || binding.original.id() != original.id()
                || binding.faded.id() != faded.id()
        }) {
            commands.entity(entity).insert(ShellMaterialBinding {
                building: shell.0,
                original,
                faded,
            });
        }
    }
}

fn update_state(
    building: Entity,
    state: &mut BuildingFadeState,
    occluded: &OccludedBuildings,
    delta: f32,
) {
    let before_occluded = state.occluded;
    let before_factor = state.factor;
    if occluded.active_cameras == 0 {
        *state = BuildingFadeState::default();
        if before_occluded || before_factor < 1.0 {
            info!(target: "demo::camera", ?building,
                alpha_factor_before = before_factor, alpha_factor_after = 1.0,
                reason = "no_active_third_person_camera", "Building camera fade changed");
        }
        return;
    }
    state.advance(occluded.buildings.contains(&building), delta);
    if before_occluded != state.occluded {
        info!(target: "demo::camera", ?building,
            occluded_before = before_occluded, occluded_after = state.occluded,
            alpha_factor_before = before_factor, alpha_factor_after = state.factor,
            reason = "camera_obstruction_changed", "Building camera fade changed");
    }
    if before_factor < 1.0 && state.factor >= 1.0 {
        info!(target: "demo::camera", ?building,
            alpha_factor_before = before_factor, alpha_factor_after = state.factor,
            reason = "clearance_grace_completed", "Building camera fade changed");
    }
}

type ManagedShells<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        Option<&'static BuildingShellVisual>,
        Option<&'static ShellMaterialBinding>,
        Option<&'static mut MeshMaterial3d<StandardMaterial>>,
    ),
    Or<(With<BuildingShellVisual>, With<ShellMaterialBinding>)>,
>;

/// 暂停仍核对拥有权和实体生存期，但不推进正常渐变计时。
fn cleanup_fade_materials(
    mut commands: Commands,
    entities: Query<()>,
    cameras: Query<&OrbitCamera>,
    characters: Query<(), With<Character>>,
    occluded: Res<OccludedBuildings>,
    mut shells: ManagedShells,
    mut states: Query<(Entity, &mut BuildingFadeState)>,
    mut cache: ResMut<ShellMaterialCache>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let restore_all = occluded.active_cameras == 0
        || !cameras
            .iter()
            .any(|camera| camera.is_third_person() && characters.contains(camera.target));
    let mut live_keys = HashSet::new();
    let mut live_buildings = HashSet::new();
    for (entity, shell, binding, mut current) in &mut shells {
        let live_shell = shell.filter(|shell| entities.contains(shell.0));
        if let Some(binding) = binding {
            let owned = current
                .as_ref()
                .is_some_and(|current| current.0.id() == binding.faded.id());
            let associated = live_shell.is_some_and(|shell| shell.0 == binding.building);
            if restore_all || !associated || !owned {
                if owned && let Some(current) = current.as_mut() {
                    current.0 = binding.original.clone();
                }
                commands.entity(entity).remove::<ShellMaterialBinding>();
            }
        }
        if let Some(shell) = live_shell {
            live_buildings.insert(shell.0);
            if let Some(current) = current.as_ref() {
                let original = binding
                    .filter(|binding| {
                        binding.building == shell.0 && current.0.id() == binding.faded.id()
                    })
                    .map_or(current.0.id(), |binding| binding.original.id());
                live_keys.insert(MaterialKey {
                    building: shell.0,
                    original,
                });
            }
        }
    }
    for (building, mut state) in &mut states {
        if !live_buildings.contains(&building) {
            commands.entity(building).remove::<BuildingFadeState>();
        } else if restore_all && (state.occluded || state.factor < 1.0) {
            let before = state.factor;
            *state = BuildingFadeState::default();
            info!(target: "demo::camera", ?building,
                alpha_factor_before = before, alpha_factor_after = 1.0,
                reason = "third_person_target_unavailable", "Building camera fade changed");
        }
    }
    cache.materials.retain(|key, cached| {
        let keep = entities.contains(key.building)
            && live_keys.contains(key)
            && materials.contains(cached.original.id());
        if !keep {
            materials.remove(cached.faded.id());
        }
        keep
    });
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[derive(Resource)]
    struct FadeRunning(bool);

    fn app() -> (App, Entity) {
        let mut app = App::new();
        init(&mut app);
        app.init_resource::<OccludedBuildings>()
            .insert_resource(FadeRunning(true))
            .add_systems(
                Update,
                update_building_fades.run_if(|running: Res<FadeRunning>| running.0),
            );
        let target = app.world_mut().spawn(Character).id();
        app.world_mut().spawn(OrbitCamera::new(target));
        app.world_mut()
            .resource_mut::<OccludedBuildings>()
            .active_cameras = 1;
        (app, target)
    }

    fn tick(app: &mut App, seconds: f32) {
        app.world_mut()
            .resource_mut::<Time<Virtual>>()
            .advance_by(Duration::from_secs_f32(seconds));
        app.update();
    }

    fn source_material(app: &mut App, alpha: f32) -> Handle<StandardMaterial> {
        app.world_mut()
            .resource_mut::<Assets<StandardMaterial>>()
            .add(StandardMaterial {
                base_color: Color::srgba(0.4, 0.3, 0.2, alpha),
                alpha_mode: AlphaMode::Mask(0.3),
                metallic: 0.17,
                perceptual_roughness: 0.73,
                double_sided: true,
                ..default()
            })
    }

    fn shell(app: &mut App, building: Entity, material: &Handle<StandardMaterial>) -> Entity {
        app.world_mut()
            .spawn((
                BuildingShellVisual(building),
                MeshMaterial3d(material.clone()),
            ))
            .id()
    }

    fn handle(app: &App, mesh: Entity) -> Handle<StandardMaterial> {
        app.world()
            .get::<MeshMaterial3d<StandardMaterial>>(mesh)
            .unwrap()
            .0
            .clone()
    }

    fn alpha(app: &App, mesh: Entity) -> f32 {
        app.world()
            .resource::<Assets<StandardMaterial>>()
            .get(&handle(app, mesh))
            .unwrap()
            .base_color
            .alpha()
    }

    fn occlude(app: &mut App, buildings: impl IntoIterator<Item = Entity>) {
        app.world_mut()
            .resource_mut::<OccludedBuildings>()
            .buildings = buildings.into_iter().collect();
    }

    fn approximately(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.00001,
            "{actual} != {expected}"
        );
    }

    #[test]
    fn shared_material_isolated_by_instance_and_precisely_restored() {
        let (mut app, _) = app();
        let original = source_material(&mut app, 0.6);
        let first = app.world_mut().spawn_empty().id();
        let second = app.world_mut().spawn_empty().id();
        let wall = shell(&mut app, first, &original);
        let roof = shell(&mut app, first, &original);
        let other_wall = shell(&mut app, second, &original);
        let parcel = app.world_mut().spawn(MeshMaterial3d(original.clone())).id();
        occlude(&mut app, [first]);
        tick(&mut app, FADE_SECONDS);

        let faded = handle(&app, wall);
        assert_ne!(faded.id(), original.id());
        assert_eq!(handle(&app, roof).id(), faded.id());
        assert_eq!(handle(&app, other_wall).id(), original.id());
        assert_eq!(handle(&app, parcel).id(), original.id());
        approximately(alpha(&app, wall), 0.6 * OCCLUDED_FACTOR);
        let materials = app.world().resource::<Assets<StandardMaterial>>();
        let untouched = materials.get(&original).unwrap();
        let copy = materials.get(&faded).unwrap();
        approximately(untouched.base_color.alpha(), 0.6);
        assert_eq!(untouched.alpha_mode, AlphaMode::Mask(0.3));
        assert_eq!(copy.alpha_mode, AlphaMode::Blend);
        assert_eq!(copy.metallic, untouched.metallic);
        assert_eq!(copy.perceptual_roughness, untouched.perceptual_roughness);
        assert_eq!(copy.double_sided, untouched.double_sided);
        assert_eq!(copy.base_color.with_alpha(0.6), untouched.base_color);

        occlude(&mut app, []);
        tick(&mut app, CLEAR_GRACE_SECONDS + RESTORE_SECONDS);
        assert_eq!(handle(&app, wall).id(), original.id());
        assert_eq!(handle(&app, roof).id(), original.id());
        assert!(app.world().get::<ShellMaterialBinding>(wall).is_none());
        occlude(&mut app, [first]);
        tick(&mut app, FADE_SECONDS);
        assert_eq!(handle(&app, wall).id(), faded.id());
        assert_eq!(
            app.world().resource::<ShellMaterialCache>().materials.len(),
            1
        );
    }

    #[test]
    fn clearance_grace_and_reentry_use_current_progress() {
        let (mut app, _) = app();
        let original = source_material(&mut app, 1.0);
        let building = app.world_mut().spawn_empty().id();
        let wall = shell(&mut app, building, &original);
        occlude(&mut app, [building]);
        tick(&mut app, FADE_SECONDS);
        let faded = handle(&app, wall);
        occlude(&mut app, []);
        tick(&mut app, 0.20);
        approximately(alpha(&app, wall), OCCLUDED_FACTOR);
        tick(&mut app, 0.10);
        approximately(
            alpha(&app, wall),
            OCCLUDED_FACTOR + (1.0 - OCCLUDED_FACTOR) * 0.05 / RESTORE_SECONDS,
        );
        occlude(&mut app, [building]);
        tick(&mut app, 0.05);
        approximately(alpha(&app, wall), OCCLUDED_FACTOR);
        assert_eq!(handle(&app, wall).id(), faded.id());
    }

    #[test]
    fn missing_active_cameras_and_destroyed_targets_restore_immediately() {
        let (mut app, target) = app();
        let original = source_material(&mut app, 1.0);
        let building = app.world_mut().spawn_empty().id();
        let wall = shell(&mut app, building, &original);
        occlude(&mut app, [building]);
        tick(&mut app, FADE_SECONDS);
        app.world_mut()
            .resource_mut::<OccludedBuildings>()
            .active_cameras = 0;
        tick(&mut app, 0.0);
        assert_eq!(handle(&app, wall).id(), original.id());

        app.world_mut()
            .resource_mut::<OccludedBuildings>()
            .active_cameras = 1;
        tick(&mut app, FADE_SECONDS);
        assert_ne!(handle(&app, wall).id(), original.id());
        app.world_mut().resource_mut::<FadeRunning>().0 = false;
        app.world_mut().despawn(target);
        tick(&mut app, 0.0);
        assert_eq!(handle(&app, wall).id(), original.id());
        assert!(app.world().get::<ShellMaterialBinding>(wall).is_none());
    }

    #[test]
    fn external_material_change_is_rebound_and_not_overwritten_during_cleanup() {
        let (mut app, _) = app();
        let original = source_material(&mut app, 1.0);
        let replacement = source_material(&mut app, 0.8);
        let building = app.world_mut().spawn_empty().id();
        let wall = shell(&mut app, building, &original);
        let roof = shell(&mut app, building, &original);
        occlude(&mut app, [building]);
        tick(&mut app, FADE_SECONDS);
        app.world_mut()
            .get_mut::<MeshMaterial3d<StandardMaterial>>(wall)
            .unwrap()
            .0 = replacement.clone();
        tick(&mut app, 0.0);
        approximately(alpha(&app, wall), 0.8 * OCCLUDED_FACTOR);
        assert_ne!(handle(&app, wall).id(), handle(&app, roof).id());
        occlude(&mut app, []);
        tick(&mut app, CLEAR_GRACE_SECONDS + RESTORE_SECONDS);
        assert_eq!(handle(&app, wall).id(), replacement.id());
        assert_eq!(handle(&app, roof).id(), original.id());

        occlude(&mut app, [building]);
        tick(&mut app, FADE_SECONDS);
        app.world_mut().resource_mut::<FadeRunning>().0 = false;
        app.world_mut()
            .get_mut::<MeshMaterial3d<StandardMaterial>>(wall)
            .unwrap()
            .0 = original.clone();
        tick(&mut app, 0.0);
        assert_eq!(handle(&app, wall).id(), original.id());
        assert!(app.world().get::<ShellMaterialBinding>(wall).is_none());
    }

    #[test]
    fn pause_preserves_progress_but_marker_removal_still_cleans_up() {
        let (mut app, _) = app();
        let original = source_material(&mut app, 1.0);
        let building = app.world_mut().spawn_empty().id();
        let wall = shell(&mut app, building, &original);
        occlude(&mut app, [building]);
        tick(&mut app, 0.05);
        let before = alpha(&app, wall);
        let faded = handle(&app, wall);
        app.world_mut().resource_mut::<FadeRunning>().0 = false;
        tick(&mut app, 1.0);
        approximately(alpha(&app, wall), before);
        app.world_mut()
            .entity_mut(wall)
            .remove::<BuildingShellVisual>();
        tick(&mut app, 0.0);
        assert_eq!(handle(&app, wall).id(), original.id());
        assert!(
            !app.world()
                .resource::<Assets<StandardMaterial>>()
                .contains(faded.id())
        );
        assert!(app.world().get::<BuildingFadeState>(building).is_none());
    }

    #[test]
    fn orphaned_shell_and_deleted_mesh_release_cached_copies() {
        let (mut app, _) = app();
        let original = source_material(&mut app, 1.0);
        let first = app.world_mut().spawn_empty().id();
        let second = app.world_mut().spawn_empty().id();
        let wall = shell(&mut app, first, &original);
        let roof = shell(&mut app, second, &original);
        occlude(&mut app, [first, second]);
        tick(&mut app, FADE_SECONDS);
        let first_copy = handle(&app, wall);
        let second_copy = handle(&app, roof);
        assert_ne!(first_copy.id(), second_copy.id());
        app.world_mut().resource_mut::<FadeRunning>().0 = false;
        app.world_mut().despawn(first);
        app.world_mut().despawn(roof);
        tick(&mut app, 0.0);
        assert_eq!(handle(&app, wall).id(), original.id());
        assert!(
            app.world()
                .resource::<ShellMaterialCache>()
                .materials
                .is_empty()
        );
        let materials = app.world().resource::<Assets<StandardMaterial>>();
        assert!(materials.contains(original.id()));
        assert!(!materials.contains(first_copy.id()));
        assert!(!materials.contains(second_copy.id()));
    }
}

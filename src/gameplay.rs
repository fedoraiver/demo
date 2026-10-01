//! 固定步把角色意图转换为力与冲量，物理持握保留箱子的碰撞和动量。

use avian3d::prelude::*;
use bevy::{ecs::relationship::RelationshipTarget, prelude::*};
use std::collections::HashSet;

use crate::physics::{DemoPhysicsPlugin, held_collision_layers, parcel_collision_layers};

/// 独立于运行时实体标识的玩家身份，便于后续多人输入路由。
#[derive(Component, Reflect, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[reflect(Component)]
pub struct PlayerId(pub u64);

/// 控制者当前操作的角色；输入设备和角色状态分别存储。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct ControlsCharacter(#[entities] pub Entity);

/// 具有移动和跳跃能力的角色。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct Character;

/// 来自控制者的玩法意图；输入状态跨帧保留，供固定步模拟读取。
///
/// PreUpdate 与 FixedUpdate 不一一对应：移动轴持续有效，跳跃和交互请求只消费一次。
/// 输入 Observer 仅更新意图，不按输入事件次数积分位置，避免运动速度依赖渲染帧率。
#[derive(Component, Reflect, Default)]
#[reflect(Component)]
pub struct CharacterIntent {
    /// 角色局部水平输入轴：x 表示左右横移，y 表示前后移动。
    pub movement: Vec2,
    pub jump_pending: bool,
    pub interact_pending: bool,
}

/// 接地状态由物理查询派生；实际速度直接读取 Avian 的 LinearVelocity。
#[derive(Component, Reflect, Default)]
#[reflect(Component)]
pub struct CharacterMotion {
    pub grounded: bool,
}

/// 快递身份，当前使用木箱作为占位模型。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct Parcel;

/// 允许被拾取的能力标签。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct Pickable;

/// 物体的持有者；只由交互系统插入或移除。
#[derive(Component)]
#[relationship(relationship_target = HoldingItems)]
pub struct HeldBy(Entity);

/// Bevy 根据 HeldBy 自动维护的反向索引，业务代码只读取。
#[derive(Component)]
#[relationship_target(relationship = HeldBy)]
pub struct HoldingItems(Vec<Entity>);

/// 手前的目标姿态；呈现同步只更新目标，箱子的实际位置仍由物理解算。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub(crate) struct HeldTarget {
    pub translation: Vec3,
    pub rotation: Quat,
}

/// 原型的运动、平地和持箱参数。
#[derive(Resource, Reflect, Clone, Debug)]
#[reflect(Resource)]
pub struct PrototypeConfig {
    pub move_speed: f32,
    pub acceleration: f32,
    pub braking_acceleration: f32,
    pub air_acceleration: f32,
    pub jump_speed: f32,
    pub gravity: f32,
    pub pickup_radius: f32,
    pub hold_offset: Vec3,
    pub ground_y: f32,
    pub parcel_half_height: f32,
    pub character_mass: f32,
    pub character_height: f32,
    pub character_radius: f32,
    pub parcel_mass: f32,
    pub hold_frequency: f32,
    pub hold_damping_ratio: f32,
    pub hold_max_force: f32,
}

impl Default for PrototypeConfig {
    fn default() -> Self {
        Self {
            move_speed: 4.5,
            acceleration: 30.0,
            braking_acceleration: 45.0,
            air_acceleration: 6.0,
            jump_speed: 5.0,
            gravity: 9.81,
            pickup_radius: 1.8,
            hold_offset: Vec3::new(0.0, 1.0, -0.9),
            ground_y: 0.0,
            parcel_half_height: 0.3,
            character_mass: 75.0,
            character_height: 1.9,
            character_radius: 0.32,
            parcel_mass: 3.0,
            hold_frequency: 3.0,
            hold_damping_ratio: 1.0,
            hold_max_force: 450.0,
        }
    }
}

/// 注册固定步控制、交互与物理解算后的状态观察；不加载游戏窗口。
pub struct GameplayPlugin;

/// 固定步先同步朝向，再准备力、冲量和持握目标，随后由 Avian 求解。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GameplaySystems {
    Simulate,
}

impl Plugin for GameplayPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<PlayerId>()
            .register_type::<ControlsCharacter>()
            .register_type::<Character>()
            .register_type::<CharacterIntent>()
            .register_type::<CharacterMotion>()
            .register_type::<Parcel>()
            .register_type::<Pickable>()
            .register_type::<HeldTarget>()
            .register_type::<PrototypeConfig>()
            .init_resource::<PrototypeConfig>()
            .add_plugins(DemoPhysicsPlugin)
            .add_systems(
                FixedUpdate,
                (
                    update_grounded,
                    move_characters,
                    jump_characters,
                    handle_interaction,
                    release_orphaned_items,
                    sync_held_objects,
                    apply_grip_forces,
                )
                    // 拿放的关系与碰撞层命令必须在本步施力前可见。
                    .chain()
                    .in_set(GameplaySystems::Simulate),
            )
            .add_systems(
                FixedPostUpdate,
                (update_grounded, log_character_velocity)
                    .chain()
                    .after(PhysicsSystems::Writeback),
            );
    }
}

/// 脚底附近的小球向下探测支撑面；墙面法线和上升中的角色不能算接地。
fn update_grounded(
    config: Res<PrototypeConfig>,
    spatial_query: SpatialQuery,
    colliders: Query<(Option<&CollisionLayers>, Has<HeldBy>, Has<Sensor>)>,
    mut characters: Query<
        (
            Entity,
            &Position,
            &LinearVelocity,
            Option<&CollisionLayers>,
            &mut CharacterMotion,
        ),
        With<Character>,
    >,
) {
    let probe = Collider::sphere(config.character_radius * 0.8);
    for (entity, position, velocity, layers, mut motion) in &mut characters {
        let filter = SpatialQueryFilter::from_excluded_entities([entity]);
        let character_layers = layers.copied().unwrap_or_default();
        let mut grounded = false;
        if velocity.y <= 0.5 {
            // 空间查询只按目标所属层过滤；支撑还必须满足双方碰撞掩码并排除持握物和传感器。
            // 遍历所有命中，避免最近的侧墙挡住稍远的有效地面。
            spatial_query.shape_hits_callback(
                &probe,
                position.0 + Vec3::Y * config.character_radius,
                Quat::IDENTITY,
                Dir3::NEG_Y,
                &ShapeCastConfig::from_max_distance(0.12),
                &filter,
                |hit| {
                    if let Ok((layers, held, sensor)) = colliders.get(hit.entity) {
                        grounded |= !held
                            && !sensor
                            && character_layers.interacts_with(layers.copied().unwrap_or_default())
                            && hit.normal1.y >= 0.65;
                    }
                    !grounded
                },
            );
        }
        if grounded != motion.grounded {
            info!(
                ?entity,
                before = motion.grounded,
                after = grounded,
                vertical_velocity = velocity.y,
                reason = "support_probe",
                "Character grounded state changed"
            );
            if grounded {
                info!(
                    ?entity,
                    landing_velocity = velocity.y,
                    reason = "ground_contact",
                    "Character landed"
                );
            }
            motion.grounded = grounded;
        }
    }
}

/// 用有上限的加速度趋近目标水平速度，保留碰撞和外部冲量造成的实际运动。
fn move_characters(
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    mut characters: Query<
        (Forces, &Transform, &CharacterIntent, &CharacterMotion),
        With<Character>,
    >,
) {
    for (mut forces, transform, intent, motion) in &mut characters {
        let axes = intent.movement.clamp_length_max(1.0);
        // 空中松键保留惯性，地面松键使用较快的主动刹车。
        if !motion.grounded && axes == Vec2::ZERO {
            continue;
        }
        let limit = if !motion.grounded {
            config.air_acceleration
        } else if axes == Vec2::ZERO {
            config.braking_acceleration
        } else {
            config.acceleration
        };
        let target = transform.rotation * Vec3::new(axes.x, 0.0, -axes.y) * config.move_speed;
        let velocity = forces.linear_velocity();
        let horizontal = Vec3::new(velocity.x, 0.0, velocity.z);
        let acceleration = ((target - horizontal) / time.delta_secs()).clamp_length_max(limit);
        forces.apply_linear_acceleration(acceleration);
    }
}

/// 跳跃只消费一次，通过冲量改变速度；重力和位置积分全部交给 Avian。
fn jump_characters(
    config: Res<PrototypeConfig>,
    mut characters: Query<
        (
            Entity,
            Forces,
            &ComputedMass,
            &mut CharacterIntent,
            &mut CharacterMotion,
        ),
        With<Character>,
    >,
) {
    for (entity, mut forces, mass, mut intent, mut motion) in &mut characters {
        if !std::mem::take(&mut intent.jump_pending) {
            continue;
        }
        if motion.grounded {
            let speed_before = forces.linear_velocity().y;
            forces
                .apply_linear_impulse(Vec3::Y * mass.value() * (config.jump_speed - speed_before));
            motion.grounded = false;
            info!(
                ?entity,
                before = "grounded",
                after = "airborne",
                jump_speed = config.jump_speed,
                reason = "jump_action",
                "Character jumped"
            );
        } else {
            info!(?entity, reason = "already_airborne", "Jump request ignored");
        }
    }
}

/// 拾取建立物理持握关系；释放只解除控制，保留刚体姿态、线速度和角速度。
fn handle_interaction(
    mut commands: Commands,
    config: Res<PrototypeConfig>,
    spatial_query: SpatialQuery,
    mut reserved: Local<HashSet<Entity>>,
    mut characters: Query<
        (
            Entity,
            &Position,
            &Transform,
            &mut CharacterIntent,
            Option<&HoldingItems>,
        ),
        (With<Character>, Without<Pickable>),
    >,
    pickables: Query<(Entity, &Position), (With<Pickable>, Without<HeldBy>, Without<Character>)>,
    held_items: Query<
        (&Position, &LinearVelocity, &AngularVelocity),
        (With<Pickable>, With<HeldBy>, Without<Character>),
    >,
) {
    reserved.clear();
    for (character, position, transform, mut intent, holding) in &mut characters {
        if !std::mem::take(&mut intent.interact_pending) {
            continue;
        }
        if let Some(item) = holding.and_then(|items| items.iter().next()) {
            if let Ok((item_position, velocity, angular_velocity)) = held_items.get(item) {
                commands
                    .entity(item)
                    .remove::<(HeldBy, HeldTarget)>()
                    .insert(parcel_collision_layers());
                info!(?character, ?item, position = ?item_position.0, velocity = ?velocity.0,
                    angular_velocity = ?angular_velocity.0, before = "held", after = "free",
                    reason = "interact_action_release", "Wooden crate released");
            }
            continue;
        }
        let origin = position.0 + Vec3::Y * config.hold_offset.y;
        let nearest = pickables
            .iter()
            .filter(|(item, _)| !reserved.contains(item))
            .filter_map(|(item, item_position)| {
                let distance = position.0.distance_squared(item_position.0);
                if distance > config.pickup_radius.powi(2) {
                    return None;
                }
                // 碰撞世界也约束拾取视线，不能隔着墙抓取箱子。
                let offset = item_position.0 - origin;
                if let Ok(direction) = Dir3::new(offset)
                    && let Some(hit) = spatial_query.cast_ray(
                        origin,
                        direction,
                        offset.length(),
                        true,
                        &SpatialQueryFilter::from_excluded_entities([character]),
                    )
                    && hit.entity != item
                {
                    return None;
                }
                Some((item, distance))
            })
            .min_by(|(_, a), (_, b)| a.total_cmp(b));
        if let Some((item, distance_squared)) = nearest {
            // 同批次延迟命令尚未应用，预留集合防止两个角色同时占用一件物体。
            reserved.insert(item);
            commands.entity(item).insert((
                HeldBy(character),
                HeldTarget {
                    translation: position.0 + transform.rotation * config.hold_offset,
                    rotation: transform.rotation,
                },
                held_collision_layers(),
            ));
            info!(
                ?character,
                ?item,
                before = "free",
                after = "held",
                distance = distance_squared.sqrt(),
                reason = "interact_action_pickup",
                "Wooden crate picked up"
            );
        } else {
            info!(
                ?character,
                reason = "no_visible_pickable_in_range",
                "No pickable item in range"
            );
        }
    }
}

/// 持有者销毁或关系被外部解除后清理目标，恢复自由碰撞；刚体始终继续模拟。
fn release_orphaned_items(
    mut commands: Commands,
    characters: Query<(), With<Character>>,
    items: Query<(Entity, Option<&HeldBy>), With<HeldTarget>>,
) {
    for (item, held_by) in &items {
        let reason = match held_by {
            Some(held_by) if characters.contains(held_by.0) => continue,
            Some(_) => "holder_missing",
            None => "holding_relation_removed",
        };
        commands
            .entity(item)
            .remove::<(HeldBy, HeldTarget)>()
            .insert(parcel_collision_layers());
        info!(
            ?item,
            before = "held",
            after = "free",
            reason,
            "Wooden crate released"
        );
    }
}

/// 固定步和本帧显示复用同一目标计算，不瞬移箱子，也不积分或消费请求。
pub(crate) fn sync_held_objects(
    config: Res<PrototypeConfig>,
    characters: Query<&Transform, (With<Character>, Without<Pickable>)>,
    mut items: Query<(&HeldBy, &mut HeldTarget), (With<Pickable>, Without<Character>)>,
) {
    for (held_by, mut target) in &mut items {
        if let Ok(character) = characters.get(held_by.0) {
            target.translation = character.translation + character.rotation * config.hold_offset;
            target.rotation = character.rotation;
        }
    }
}

/// 弹簧阻尼手约束施加有限的力与转动驱动，碰撞求解仍能阻挡箱体。
fn apply_grip_forces(
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    gravity: Res<Gravity>,
    mut characters: Query<(Forces, &Transform), (With<Character>, Without<Pickable>)>,
    mut items: Query<(Forces, &ComputedMass, &HeldBy), (With<Pickable>, Without<Character>)>,
) {
    let omega = std::f32::consts::TAU * config.hold_frequency;
    let stiffness = omega * omega;
    let damping = 2.0 * config.hold_damping_ratio * omega;
    // 隐式弹簧系数避免固定步较长时的高频振荡，实际力仍由质量换算并限制。
    let denominator = 1.0 + damping * time.delta_secs() + stiffness * time.delta_secs().powi(2);
    for (mut item, mass, held_by) in &mut items {
        let Ok((mut holder, transform)) = characters.get_mut(held_by.0) else {
            continue;
        };
        // 模拟读取 Position 而非已经插值的显示目标，防止呈现反馈污染物理。
        let target = holder.position().0 + transform.rotation * config.hold_offset;
        let acceleration = (stiffness * (target - item.position().0)
            + damping * (holder.linear_velocity() - item.linear_velocity())
            - gravity.0)
            / denominator;
        let force = (acceleration * mass.value()).clamp_length_max(config.hold_max_force);
        item.apply_force(force);
        // 持有者承受相反的力，箱子的重量和撞墙阻力会反馈到动态角色。
        holder.apply_force(-force);
        // q 与 -q 表示同一姿态，选择短弧，避免箱子绕一整圈追向手部朝向。
        let mut rotation_error = transform.rotation * item.rotation().0.inverse();
        if rotation_error.w < 0.0 {
            rotation_error = -rotation_error;
        }
        let error = rotation_error.to_scaled_axis();
        let angular_acceleration = ((stiffness * error - damping * item.angular_velocity())
            / denominator)
            .clamp_length_max(80.0);
        item.apply_angular_acceleration(angular_acceleration);
    }
}

/// 采样物理解算后的实际速度，便于检查加速度、刹车和碰撞反馈。
fn log_character_velocity(
    time: Res<Time<Fixed>>,
    mut next_log_time: Local<f64>,
    characters: Query<(Entity, &LinearVelocity, &CharacterMotion), With<Character>>,
) {
    if time.elapsed_secs_f64() < *next_log_time {
        return;
    }
    *next_log_time = time.elapsed_secs_f64() + 0.5;
    for (entity, velocity, motion) in &characters {
        debug!(?entity, velocity = ?velocity.0, grounded = motion.grounded,
            reason = "physics_sample", "Character velocity sampled");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::{character_body, ground_body, parcel_body, world_collision_layers};
    use bevy::time::TimeUpdateStrategy;
    use std::time::Duration;

    fn test_app() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, TransformPlugin, GameplayPlugin))
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
                1.0 / 60.0,
            )));
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut().spawn((
            ground_body(&config),
            Transform::from_xyz(0.0, config.ground_y, 0.0),
        ));
        // 手动 update 不经过 App::run，需先完成物理插件的资源初始化。
        app.finish();
        app.cleanup();
        app.update();
        app
    }

    fn step(app: &mut App, count: usize) {
        for _ in 0..count {
            app.update();
        }
    }

    fn spawn_character(app: &mut App, position: Vec3, intent: CharacterIntent) -> Entity {
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((
                Character,
                intent,
                CharacterMotion::default(),
                Transform::from_translation(position),
                character_body(&config),
            ))
            .id()
    }

    fn spawn_box(app: &mut App, position: Vec3) -> Entity {
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((
                Parcel,
                Pickable,
                Transform::from_translation(position),
                parcel_body(&config),
            ))
            .id()
    }

    fn interact(app: &mut App, character: Entity) {
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        step(app, 1);
    }

    #[test]
    fn ground_probe_respects_collision_layers_and_excludes_held_boxes() {
        let mut app = test_app();
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, 0.0));
        let character = spawn_character(&mut app, Vec3::new(0.0, 0.6, 0.0), default());
        step(&mut app, 30);
        let grounded = |app: &App| {
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded
        };
        assert!(grounded(&app), "Free box must support the character");

        // 单独重跑探测，避免改变碰撞层后物理移动影响支撑过滤的断言。
        let mut schedule = Schedule::default();
        schedule.add_systems(update_grounded);
        let character_layers = *app.world().get::<CollisionLayers>(character).unwrap();
        app.world_mut()
            .entity_mut(character)
            .insert(CollisionLayers::NONE);
        schedule.run(app.world_mut());
        assert!(
            !grounded(&app),
            "Character collision filters must be respected"
        );
        app.world_mut()
            .entity_mut(character)
            .insert(character_layers);
        schedule.run(app.world_mut());
        assert!(grounded(&app));

        let item_layers = parcel_collision_layers();
        app.world_mut()
            .entity_mut(item)
            .insert(CollisionLayers::new(
                item_layers.memberships,
                LayerMask::NONE,
            ));
        schedule.run(app.world_mut());
        assert!(
            !grounded(&app),
            "Support collision filters must be respected"
        );
        app.world_mut().entity_mut(item).insert(item_layers);
        schedule.run(app.world_mut());
        assert!(grounded(&app));

        app.world_mut()
            .entity_mut(item)
            .insert((HeldBy(character), held_collision_layers()));
        schedule.run(app.world_mut());
        assert!(!grounded(&app), "Held box cannot support the character");
        // 即使外部代码误改持握碰撞层，持握身份也不能成为支撑。
        app.world_mut().entity_mut(item).insert(item_layers);
        schedule.run(app.world_mut());
        assert!(!grounded(&app));
        app.world_mut().entity_mut(item).remove::<HeldBy>();
        schedule.run(app.world_mut());
        assert!(
            grounded(&app),
            "Released box must become valid support again"
        );
    }

    #[test]
    fn ground_probe_finds_floor_after_a_nearer_wall_hit() {
        let mut app = test_app();
        let wall = app
            .world_mut()
            .spawn((
                RigidBody::Static,
                Collider::cuboid(0.04, 2.0, 2.0),
                world_collision_layers(),
                Transform::from_xyz(0.26, 1.0, 0.0),
            ))
            .id();
        step(&mut app, 2);
        // 先初始化墙面，再生成角色并只跑探测，避免墙面求解先推开角色。
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        let mut schedule = Schedule::default();
        schedule.add_systems(
            (
                move |config: Res<PrototypeConfig>, spatial_query: SpatialQuery| {
                    let closest = spatial_query
                        .cast_shape(
                            &Collider::sphere(config.character_radius * 0.8),
                            Vec3::Y * config.character_radius,
                            Quat::IDENTITY,
                            Dir3::NEG_Y,
                            &ShapeCastConfig::from_max_distance(0.12),
                            &SpatialQueryFilter::from_excluded_entities([character]),
                        )
                        .unwrap();
                    assert_eq!(closest.entity, wall);
                    assert!(closest.normal1.y < 0.65);
                },
                update_grounded,
            )
                .chain(),
        );
        schedule.run(app.world_mut());
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded,
            "Side wall must not hide valid floor support"
        );
    }

    #[test]
    fn movement_accelerates_brakes_and_diagonal_speed_is_bounded() {
        let mut app = test_app();
        let straight = spawn_character(&mut app, Vec3::ZERO, default());
        let diagonal = spawn_character(&mut app, Vec3::X * 5.0, default());
        step(&mut app, 30);
        app.world_mut()
            .get_mut::<CharacterIntent>(straight)
            .unwrap()
            .movement = Vec2::Y;
        app.world_mut()
            .get_mut::<CharacterIntent>(diagonal)
            .unwrap()
            .movement = Vec2::ONE;
        step(&mut app, 1);
        let first_speed = app
            .world()
            .get::<LinearVelocity>(straight)
            .unwrap()
            .0
            .length();
        assert!(first_speed > 0.0 && first_speed < 1.0, "{first_speed}");
        step(&mut app, 20);
        let a = app.world().get::<LinearVelocity>(straight).unwrap().0;
        let b = app.world().get::<LinearVelocity>(diagonal).unwrap().0;
        assert!((a.xz().length() - 4.5).abs() < 0.05, "{a:?}");
        assert!(
            (a.xz().length() - b.xz().length()).abs() < 0.05,
            "{a:?} {b:?}"
        );
        app.world_mut()
            .get_mut::<CharacterIntent>(straight)
            .unwrap()
            .movement = Vec2::ZERO;
        step(&mut app, 1);
        let braking = app
            .world()
            .get::<LinearVelocity>(straight)
            .unwrap()
            .0
            .xz()
            .length();
        assert!(braking > 0.0 && braking < a.xz().length());
        step(&mut app, 12);
        assert!(
            app.world()
                .get::<LinearVelocity>(straight)
                .unwrap()
                .0
                .xz()
                .length()
                < 0.05
        );
    }

    #[test]
    fn collision_blocks_character_and_dynamic_boxes_receive_momentum() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.2));
        step(&mut app, 30);
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(8.0, 3.0, 0.5),
            world_collision_layers(),
            Transform::from_xyz(0.0, 1.5, -4.0),
        ));
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        step(&mut app, 100);
        let position = app.world().get::<Position>(character).unwrap().0;
        assert!(position.z > -3.5, "Character crossed wall: {position:?}");
        let box_position = app.world().get::<Position>(item).unwrap().0;
        assert!(
            box_position.z < -1.4 && box_position.z > -3.8,
            "{box_position:?}"
        );
    }

    #[test]
    fn jump_is_consumed_once_and_gravity_lands_on_collider() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        step(&mut app, 30);
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded
        );
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .jump_pending = true;
        step(&mut app, 1);
        let velocity = app.world().get::<LinearVelocity>(character).unwrap().y;
        assert!((velocity - (5.0 - 9.81 / 60.0)).abs() < 0.05, "{velocity}");
        assert!(
            !app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .jump_pending
        );
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .jump_pending = true;
        step(&mut app, 1);
        assert!(app.world().get::<LinearVelocity>(character).unwrap().y < velocity);
        step(&mut app, 100);
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded
        );
        assert!(app.world().get::<Position>(character).unwrap().y.abs() < 0.03);
    }

    #[test]
    fn grip_preserves_dynamic_body_blocks_at_wall_and_release_keeps_velocity() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
        step(&mut app, 30);
        let before = app.world().get::<Position>(item).unwrap().0;
        interact(&mut app, character);
        assert_eq!(app.world().get::<HeldBy>(item).unwrap().0, character);
        assert_eq!(
            app.world().get::<RigidBody>(item),
            Some(&RigidBody::Dynamic)
        );
        let after = app.world().get::<Position>(item).unwrap().0;
        assert!(
            after.distance(before) < 0.2,
            "Pickup teleported: {before:?} {after:?}"
        );
        step(&mut app, 100);
        assert!((app.world().get::<Position>(item).unwrap().y - 1.0).abs() < 0.12);
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(8.0, 3.0, 0.2),
            world_collision_layers(),
            Transform::from_xyz(0.0, 1.5, -1.6),
        ));
        app.world_mut()
            .resource_mut::<PrototypeConfig>()
            .hold_offset
            .z = -2.4;
        step(&mut app, 90);
        let position = app.world().get::<Position>(item).unwrap().0;
        assert!(position.z > -1.3, "Held box crossed wall: {position:?}");
        // 直接运行交互系统验证释放瞬间不修改任何速度或位置，不混入随后重力。
        app.world_mut().get_mut::<LinearVelocity>(item).unwrap().0 = Vec3::new(1.0, 2.0, 0.5);
        app.world_mut().get_mut::<AngularVelocity>(item).unwrap().0 = Vec3::new(0.5, 1.0, 0.0);
        let before_release = app.world().get::<Position>(item).unwrap().0;
        let rotation_before_release = app.world().get::<Rotation>(item).unwrap().0;
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        let mut schedule = Schedule::default();
        schedule.add_systems(handle_interaction);
        schedule.run(app.world_mut());
        assert!(app.world().get::<HeldBy>(item).is_none());
        assert!(app.world().get::<HeldTarget>(item).is_none());
        assert_eq!(
            app.world().get::<LinearVelocity>(item).unwrap().0,
            Vec3::new(1.0, 2.0, 0.5)
        );
        assert_eq!(app.world().get::<Position>(item).unwrap().0, before_release);
        assert_eq!(
            app.world().get::<AngularVelocity>(item).unwrap().0,
            Vec3::new(0.5, 1.0, 0.0)
        );
        assert_eq!(
            app.world().get::<Rotation>(item).unwrap().0,
            rotation_before_release
        );
        step(&mut app, 120);
        assert!(app.world().get::<Position>(item).unwrap().y < 0.5);
    }

    #[test]
    fn holder_despawn_and_external_relation_removal_restore_free_collisions() {
        for despawn in [false, true] {
            let mut app = test_app();
            let character = spawn_character(&mut app, Vec3::ZERO, default());
            let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
            step(&mut app, 30);
            interact(&mut app, character);
            step(&mut app, 60);
            if despawn {
                app.world_mut().despawn(character);
            } else {
                app.world_mut().entity_mut(item).remove::<HeldBy>();
            }
            step(&mut app, 1);
            assert!(app.world().get::<HeldTarget>(item).is_none());
            assert_eq!(
                *app.world().get::<CollisionLayers>(item).unwrap(),
                parcel_collision_layers()
            );
            step(&mut app, 120);
            assert!(app.world().get::<Position>(item).unwrap().y < 0.5);
        }
    }

    #[test]
    fn no_fixed_step_preserves_requests_and_render_rates_share_physics() {
        let simulate = |frame_hz: f64| {
            let mut app = test_app();
            let character = spawn_character(&mut app, Vec3::ZERO, default());
            step(&mut app, 30);
            app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .jump_pending = true;
            let before = app.world().get::<Position>(character).unwrap().0;
            step(&mut app, 3);
            assert_eq!(app.world().get::<Position>(character).unwrap().0, before);
            assert!(
                app.world()
                    .get::<CharacterIntent>(character)
                    .unwrap()
                    .jump_pending
            );
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .movement = Vec2::Y;
            app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
                1.0 / frame_hz,
            )));
            step(&mut app, frame_hz as usize);
            app.world().get::<Position>(character).unwrap().0
        };
        let a = simulate(60.0);
        let b = simulate(120.0);
        assert!(a.abs_diff_eq(b, 0.1), "{a:?} {b:?}");
    }
}

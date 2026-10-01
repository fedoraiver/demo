//! 汇总启动时的配置与环境日志，沿用统一会话日志设施。

use bevy::prelude::*;

use crate::gameplay::PrototypeConfig;

/// 注册一次性的启动日志；玩法配置与固定时间步由应用组装时提供。
pub struct StartupLogPlugin;

impl Plugin for StartupLogPlugin {
    fn build(&self, app: &mut App) {
        // 四条日志只报告配置，不依赖场景实体，也不建立彼此的执行顺序。
        app.add_systems(
            Startup,
            (
                log_configuration,
                log_simulation_timestep,
                log_pose_synchronization,
                log_world_inspector,
            ),
        );
    }
}

/// 记录实际玩法配置；显式保留迁移前的日志分类，兼容现有过滤设置。
fn log_configuration(config: Res<PrototypeConfig>) {
    // 刚体与持握方式属于本次玩法配置，合并到原有记录便于沿用日志筛选。
    info!(target: "demo::gameplay", ?config,
        physics_engine = "avian3d", physics_version = "0.7.0",
        character_body = "dynamic", parcel_body = "dynamic",
        grip_mode = "spring_damper", release_mode = "preserve_velocity",
        "Prototype gameplay initialized");
}

/// 记录模拟频率，直接读取应用配置的固定时间步。
fn log_simulation_timestep(time: Res<Time<Fixed>>) {
    info!(
        target: "demo::settings",
        simulation_hz = 1.0 / time.timestep().as_secs_f64(),
        "Fixed simulation timestep initialized"
    );
}

/// 将模拟和逐帧姿态同步的调度约定写入统一会话日志，便于排查帧率相关问题。
fn log_pose_synchronization() {
    info!(target: "demo::camera", simulation_schedule = "FixedUpdate",
        grip_force_schedule = "FixedUpdate", physics_schedule = "FixedPostUpdate",
        presentation_schedule = "RunFixedMainLoop",
        presentation_order = "interpolation_character_facing_hold_target_camera_visibility", reason = "initialization",
        "Camera pose synchronization configured");
}

/// 检查器的启用信息沿用统一会话日志，方便核对本次调试环境。
fn log_world_inspector() {
    info!(target: "demo::inspector", plugin = "WorldInspectorPlugin", reason = "initialization",
        "World inspector enabled");
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc};

    use bevy::{
        ecs::schedule::SingleThreadedExecutor,
        log::{tracing, tracing_subscriber},
    };
    use uuid::Uuid;

    use super::*;

    #[test]
    fn startup_logs_preserve_targets_and_config_and_run_once() {
        let directory =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tmp/startup-log-tests");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{}.log", Uuid::new_v4()));
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(Arc::new(fs::File::create_new(&path).unwrap()))
            .finish();

        // 使用局部日志设施和最小 App；单线程启动调度确保日志捕获不跨线程。
        tracing::subscriber::with_default(subscriber, || {
            let mut app = App::new();
            app.insert_resource(PrototypeConfig {
                move_speed: 9.0,
                acceleration: 36.0,
                character_mass: 75.0,
                parcel_mass: 3.0,
                hold_frequency: 5.0,
                hold_damping_ratio: 0.8,
                hold_max_force: 240.0,
                ..default()
            })
            .insert_resource(Time::<Fixed>::from_seconds(0.25))
            .add_plugins(StartupLogPlugin)
            .edit_schedule(Startup, |schedule| {
                schedule.set_executor(SingleThreadedExecutor::new());
            });
            app.update();
            app.update();
        });

        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_file(path).unwrap();
        for (target, message, fields) in [
            (
                "demo::gameplay",
                "Prototype gameplay initialized",
                vec![
                    "move_speed: 9.0",
                    "acceleration: 36.0",
                    "character_mass: 75.0",
                    "parcel_mass: 3.0",
                    "hold_frequency: 5.0",
                    "hold_damping_ratio: 0.8",
                    "hold_max_force: 240.0",
                    "physics_engine=\"avian3d\"",
                    "physics_version=\"0.7.0\"",
                    "character_body=\"dynamic\"",
                    "parcel_body=\"dynamic\"",
                    "grip_mode=\"spring_damper\"",
                    "release_mode=\"preserve_velocity\"",
                ],
            ),
            (
                "demo::settings",
                "Fixed simulation timestep initialized",
                vec!["simulation_hz=4"],
            ),
            (
                "demo::camera",
                "Camera pose synchronization configured",
                vec![
                    "simulation_schedule=\"FixedUpdate\"",
                    "grip_force_schedule=\"FixedUpdate\"",
                    "physics_schedule=\"FixedPostUpdate\"",
                    "presentation_schedule=\"RunFixedMainLoop\"",
                    "presentation_order=\"interpolation_character_facing_hold_target_camera_visibility\"",
                    "reason=\"initialization\"",
                ],
            ),
            (
                "demo::inspector",
                "World inspector enabled",
                vec![
                    "plugin=\"WorldInspectorPlugin\"",
                    "reason=\"initialization\"",
                ],
            ),
        ] {
            let records: Vec<_> = contents
                .lines()
                .filter(|line| line.contains(message))
                .collect();
            assert_eq!(records.len(), 1, "Unexpected startup log count: {contents}");
            let record = records[0];
            assert!(
                record.contains("INFO") && record.contains(target),
                "{record}"
            );
            for field in fields {
                assert!(record.contains(field), "Missing {field}: {record}");
            }
        }
    }
}

//! 导出已完成插件装配的真实调度；不运行 Startup、帧循环或渲染线程。

use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use analysis_contract::runtime::{
    RuntimeAccess, RuntimeCondition, RuntimeEdge, RuntimeSchedule, RuntimeSet, RuntimeSnapshot,
    RuntimeSystem,
};
use bevy::{
    app::{PluginsState, SubApps},
    ecs::{
        query::ComponentAccessKind,
        schedule::{NodeId, Schedules},
    },
    extract::MainWorld,
    prelude::*,
};
use bevy_mod_debugdump::schedule_graph::{self, Settings};
use serde::Serialize;
use sha2::{Digest, Sha256};

type DumpResult<T> = Result<T, Box<dyn Error>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    bevy_version: &'static str,
    debugdump_version: &'static str,
    exported_at: u64,
    target: &'static str,
    features: [&'static str; 1],
    source_fingerprint: String,
    schedules: Vec<ScheduleEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleEntry {
    id: String,
    app: String,
    label: String,
    filename: String,
    sha256: String,
    system_count: usize,
}

/// 等待插件就绪并完成 finish，随后导出主应用与全部子应用的调度。
/// 不调用 cleanup，避免流水线渲染插件将 RenderApp 移交给渲染线程。
pub fn dump_schedules(app: &mut App, output: &Path) -> DumpResult<usize> {
    while app.plugins_state() == PluginsState::Adding {
        bevy::tasks::tick_global_task_pools_on_main_thread();
        std::thread::yield_now();
    }
    app.finish();
    write_schedules(app, output, Path::new(env!("CARGO_MANIFEST_DIR")))
}

fn write_schedules(app: &mut App, output: &Path, source_root: &Path) -> DumpResult<usize> {
    fs::create_dir_all(output)?;
    let manifest_path = output.join("manifest.json");
    // 完成全部导出后才发布清单，失败时不能沿用上次成功的清单。
    match fs::remove_file(&manifest_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let source_fingerprint = source_fingerprint(source_root)?;
    let mut snapshots = Vec::new();
    let mut entries = dump_world("main", app.world_mut(), output, &mut snapshots)?;
    let SubApps { main, sub_apps } = app.sub_apps_mut();
    let mut sub_apps = sub_apps.iter_mut().collect::<Vec<_>>();
    sub_apps.sort_by_key(|(label, _)| format!("{label:?}"));
    for (label, sub_app) in sub_apps {
        let app_name = format!("{label:?}");
        let mut context = MainWorldGuard::new(main.world_mut(), sub_app.world_mut(), &app_name)?;
        entries.extend(dump_world(
            &app_name,
            context.world_mut(),
            output,
            &mut snapshots,
        )?);
    }
    let count = entries.len();
    let manifest = Manifest {
        schema_version: 1,
        bevy_version: "0.20.0",
        debugdump_version: "0.17.0",
        exported_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        target: env!("DEMO_BUILD_TARGET"),
        features: ["debugdump"],
        source_fingerprint,
        schedules: entries,
    };
    let runtime = RuntimeSnapshot {
        schema_version: 1,
        source_fingerprint: manifest.source_fingerprint.clone(),
        target: manifest.target.to_owned(),
        features: manifest
            .features
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        schedules: snapshots,
    };
    // DOT、结构化注册和清单属于同一装配快照；最后发布清单才表示导出成功。
    fs::write(
        output.join("runtime.json"),
        serde_json::to_vec_pretty(&runtime)?,
    )?;
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    info!(target: "demo::inspector", directory = %output.display(), schedules = count,
        "Schedule export completed");
    Ok(count)
}

/// Extract 参数初始化也需要真实主世界；守卫在返回错误和 panic 时都将其移回。
struct MainWorldGuard<'a> {
    main_world: &'a mut World,
    sub_world: &'a mut World,
}

impl<'a> MainWorldGuard<'a> {
    fn new(
        main_world: &'a mut World,
        sub_world: &'a mut World,
        app_name: &str,
    ) -> DumpResult<Self> {
        if sub_world.contains_resource::<MainWorld>() {
            return Err(format!(
                "Cannot export sub-app {app_name}: MainWorld resource is already present."
            )
            .into());
        }
        // 替换槽只保留独占所有权；Extract 始终访问原主世界及其原 WorldId。
        let mut resource = MainWorld::default();
        std::mem::swap(main_world, &mut *resource);
        sub_world.insert_resource(resource);
        Ok(Self {
            main_world,
            sub_world,
        })
    }

    fn world_mut(&mut self) -> &mut World {
        self.sub_world
    }
}

impl Drop for MainWorldGuard<'_> {
    fn drop(&mut self) {
        let mut resource = self
            .sub_world
            .remove_resource::<MainWorld>()
            .expect("MainWorld must remain available while exporting schedules");
        std::mem::swap(self.main_world, &mut *resource);
    }
}

fn dump_world(
    app_name: &str,
    world: &mut World,
    output: &Path,
    snapshots: &mut Vec<RuntimeSchedule>,
) -> DumpResult<Vec<ScheduleEntry>> {
    if !world.contains_resource::<Schedules>() {
        info!(target: "demo::inspector", app = app_name, reason = "no_schedules_resource",
            "Sub-app has no schedules to export");
        return Ok(Vec::new());
    }
    world.resource_scope::<Schedules, _>(|world, mut schedules| {
        let ignored_ambiguities = schedules.ignored_scheduling_ambiguities.clone();
        let mut registered = schedules.iter_mut().collect::<Vec<_>>();
        registered.sort_by_key(|(label, _)| format!("{label:?}"));
        let mut entries = Vec::with_capacity(registered.len());
        for (label, schedule) in registered {
            let label_type = format!("{:?}", (label as &dyn std::any::Any).type_id());
            let label = format!("{label:?}");
            // 使用上游同样的图初始化路径，但显式传播构建失败，避免发布残缺图。
            schedule.graph_mut().initialize(world);
            schedule
                .graph_mut()
                .build_schedule(world, &ignored_ambiguities)
                .map_err(|error| {
                    format!("Failed to build schedule {app_name}/{label}: {error:?}")
                })?;
            let system_count = schedule.graph().systems.len();
            let dot = schedule_graph::schedule_graph_dot(schedule, world, &Settings::default());
            let id = schedule_id(app_name, &label);
            let filename = format!("schedule-{id}.dot");
            fs::write(output.join(&filename), dot.as_bytes())?;
            let graph = schedule.graph();
            let systems = graph
                .systems
                .iter()
                .map(|(key, system, conditions)| {
                    let node = NodeId::System(key);
                    let access = graph
                        .systems
                        .get(key)
                        .expect("Registered system must exist")
                        .access();
                    let access_set = access.to_filtered_access_set();
                    let accesses = access_set
                        .combined_access()
                        .try_iter_access()
                        .map(|items| {
                            items
                                .map(|item| {
                                    let (component, mode) = match item {
                                        ComponentAccessKind::Shared(component) => {
                                            (component, "read")
                                        }
                                        ComponentAccessKind::Exclusive(component) => {
                                            (component, "mutable_access")
                                        }
                                        ComponentAccessKind::Archetypal(component) => {
                                            (component, "filter")
                                        }
                                    };
                                    let info = world.components().get_info(component).expect(
                                        "System access must reference a registered component",
                                    );
                                    RuntimeAccess {
                                        type_id: info.type_id().map(|id| format!("{id:?}")),
                                        name: info.name().to_string(),
                                        mode: mode.to_owned(),
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    RuntimeSystem {
                        key: format!("{node:?}"),
                        graph_name: format!("node_{node:?}"),
                        name: system.name().to_string(),
                        type_id: format!("{:?}", system.system_type()),
                        conditions: conditions
                            .iter()
                            .map(|condition| RuntimeCondition {
                                name: condition.name().to_string(),
                                type_id: format!("{:?}", condition.system_type()),
                            })
                            .collect(),
                        accesses,
                        access_scope: if access.is_exclusive() {
                            "exclusive"
                        } else if access_set.combined_access().try_iter_access().is_err() {
                            "unbounded"
                        } else {
                            "finite"
                        }
                        .to_owned(),
                    }
                })
                .collect();
            let sets = graph
                .system_sets
                .iter()
                .map(|(key, set, conditions)| {
                    let node = NodeId::Set(key);
                    RuntimeSet {
                        key: format!("{node:?}"),
                        graph_name: format!("clusternode_{node:?}"),
                        label: format!("{set:?}"),
                        type_id: format!("{:?}", (set as &dyn std::any::Any).type_id()),
                        system_type: set.system_type().map(|id| format!("{id:?}")),
                        anonymous: set.is_anonymous(),
                        conditions: conditions
                            .iter()
                            .map(|condition| RuntimeCondition {
                                name: condition.name().to_string(),
                                type_id: format!("{:?}", condition.system_type()),
                            })
                            .collect(),
                    }
                })
                .collect();
            let edges = |graph: &bevy::ecs::schedule::graph::DiGraph<NodeId>| {
                graph
                    .all_edges()
                    .map(|(from, to)| RuntimeEdge {
                        from: format!("{from:?}"),
                        to: format!("{to:?}"),
                    })
                    .collect()
            };
            snapshots.push(RuntimeSchedule {
                id: id.clone(),
                app: app_name.to_owned(),
                label: label.clone(),
                type_id: label_type,
                dot_filename: filename.clone(),
                dot_sha256: sha256(dot.as_bytes()),
                systems,
                sets,
                hierarchy: edges(graph.hierarchy().graph()),
                dependencies: edges(graph.dependency().graph()),
            });
            info!(target: "demo::inspector", app = app_name, schedule = label,
                systems = system_count, filename, "Schedule exported");
            entries.push(ScheduleEntry {
                id,
                app: app_name.to_owned(),
                label,
                filename,
                sha256: sha256(dot.as_bytes()),
                system_count,
            });
        }
        Ok(entries)
    })
}

pub(super) fn schedule_id(app: &str, label: &str) -> String {
    sha256(format!("{app}\0{label}").as_bytes())[..16].to_owned()
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn source_fingerprint(root: &Path) -> DumpResult<String> {
    let mut paths = vec![PathBuf::from("Cargo.toml"), PathBuf::from("Cargo.lock")];
    if root.join("build.rs").exists() {
        paths.push(PathBuf::from("build.rs"));
    }
    collect_rust_files(root, Path::new("src"), &mut paths)?;
    let mut paths = paths
        .into_iter()
        .map(|path| {
            path.to_str()
                .map(|path| path.replace('\\', "/"))
                .ok_or_else(|| "Source path is not valid UTF-8.".into())
        })
        .collect::<DumpResult<Vec<String>>>()?;
    paths.sort();
    let mut hash = Sha256::new();
    for path in paths {
        let content = fs::read_to_string(root.join(&path))?.replace("\r\n", "\n");
        hash.update(path.as_bytes());
        hash.update([0]);
        hash.update(content.as_bytes());
        hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn collect_rust_files(root: &Path, relative: &Path, paths: &mut Vec<PathBuf>) -> DumpResult<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let path = relative.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_rust_files(root, &path, paths)?;
        } else if file_type.is_file() && path.extension().is_some_and(|ext| ext == "rs") {
            paths.push(path);
        }
    }
    Ok(())
}

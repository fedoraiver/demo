//! 检查器启动参数与调度导出的无窗口回归。

mod launch {
    use super::super::{LaunchMode, parse_launch_mode};
    use std::ffi::OsString;
    #[cfg(feature = "debugdump")]
    use std::path::PathBuf;

    fn parse(args: &[&str]) -> Result<LaunchMode, String> {
        parse_launch_mode(args.iter().map(OsString::from))
    }

    #[test]
    fn accepts_game_and_help_without_initializing_app() {
        assert_eq!(parse(&[]), Ok(LaunchMode::Game));
        assert_eq!(parse(&["--help"]), Ok(LaunchMode::Help));
        assert_eq!(parse(&["-h"]), Ok(LaunchMode::Help));
        assert!(parse(&["--help", "extra"]).is_err());
        assert!(parse(&["--unknown"]).is_err());
    }

    #[cfg(feature = "debugdump")]
    #[test]
    fn validates_export_directory_and_extra_arguments() {
        assert_eq!(
            parse(&["--dump-schedules", "tmp/graphs"]),
            Ok(LaunchMode::DumpSchedules(PathBuf::from("tmp/graphs")))
        );
        assert!(parse(&["--dump-schedules"]).is_err());
        assert!(parse(&["--dump-schedules", "--help"]).is_err());
        assert!(parse(&["--dump-schedules", "tmp/graphs", "extra"]).is_err());
    }

    #[cfg(not(feature = "debugdump"))]
    #[test]
    fn disabled_export_feature_is_an_error_instead_of_game_launch() {
        assert!(
            parse(&["--dump-schedules", "tmp/graphs"])
                .unwrap_err()
                .contains("requires the 'debugdump' Cargo feature")
        );
    }
}

#[cfg(feature = "debugdump")]
mod schedule_dump {
    use super::super::schedule_dump::{dump_schedules, schedule_id, sha256, source_fingerprint};
    use bevy::{
        app::{AppLabel, PluginsState, SubApp},
        ecs::{
            schedule::{ScheduleLabel, Schedules},
            world::WorldId,
        },
        extract::{Extract, ExtractSchedule, MainWorld},
        prelude::*,
    };
    use serde_json::Value;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    struct Fixture {
        path: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tmp/debugdump-tests")
                .join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(path.join("src/nested")).unwrap();
            fs::write(path.join("Cargo.toml"), "[package]\nname='fixture'\n").unwrap();
            fs::write(path.join("Cargo.lock"), "version = 4\n").unwrap();
            fs::write(path.join("src/main.rs"), "fn main() {}\n").unwrap();
            fs::write(path.join("src/nested/other.rs"), "struct Other;\n").unwrap();
            Self { path }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.path).unwrap();
        }
    }

    #[derive(AppLabel, Clone, Copy, Debug, Hash, PartialEq, Eq)]
    struct RenderApp;

    #[derive(AppLabel, Clone, Copy, Debug, Hash, PartialEq, Eq)]
    struct NoSchedules;

    #[derive(ScheduleLabel, Clone, Copy, Debug, Hash, PartialEq, Eq)]
    struct EmptySchedule;

    #[derive(Resource, Default)]
    struct Finished {
        finished: bool,
    }

    struct FinishRegistration;

    impl Plugin for FinishRegistration {
        fn build(&self, app: &mut App) {
            app.init_resource::<Finished>();
            app.add_systems(Startup, || panic!("Startup must not execute during export"));
        }

        fn finish(&self, app: &mut App) {
            app.world_mut().resource_mut::<Finished>().finished = true;
            app.add_systems(Update, registered_during_finish);
        }

        fn cleanup(&self, _: &mut App) {
            panic!("cleanup must not execute before export");
        }
    }

    fn registered_during_finish() {
        panic!("Update must not execute during export");
    }

    #[test]
    fn exports_main_subapp_and_empty_schedule_without_running_systems_or_cleanup() {
        let fixture = Fixture::new();
        let output = fixture.path.join("output");
        let mut app = App::new();
        app.add_plugins(FinishRegistration);
        let mut sub_app = SubApp::new();
        sub_app.add_systems(Update, registered_during_finish);
        sub_app.add_schedule(Schedule::new(EmptySchedule));
        app.insert_sub_app(RenderApp, sub_app);
        let mut no_schedules = SubApp::new();
        no_schedules.world_mut().remove_resource::<Schedules>();
        app.insert_sub_app(NoSchedules, no_schedules);

        let count = dump_schedules(&mut app, &output).unwrap();
        assert!(app.world().resource::<Finished>().finished);
        assert_eq!(app.plugins_state(), PluginsState::Finished);
        let manifest: Value =
            serde_json::from_slice(&fs::read(output.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["schemaVersion"], 1);
        assert_eq!(manifest["bevyVersion"], "0.20.0");
        assert_eq!(manifest["debugdumpVersion"], "0.17.0");
        assert_eq!(manifest["target"], env!("DEMO_BUILD_TARGET"));
        assert_eq!(manifest["features"], serde_json::json!(["debugdump"]));
        assert_eq!(manifest["sourceFingerprint"].as_str().unwrap().len(), 64);
        assert!(manifest["exportedAt"].as_u64().unwrap() > 0);
        let entries = manifest["schedules"].as_array().unwrap();
        assert_eq!(entries.len(), count);
        assert!(entries.iter().any(|entry| entry["app"] == "main"
            && entry["label"] == "Update"
            && entry["systemCount"] == 1));
        assert!(entries.iter().any(|entry| entry["app"] == "RenderApp"
            && entry["label"] == "Update"
            && entry["systemCount"] == 1));
        assert!(entries.iter().any(|entry| entry["app"] == "RenderApp"
            && entry["label"] == "EmptySchedule"
            && entry["systemCount"] == 0));
        assert!(!entries.iter().any(|entry| entry["app"] == "NoSchedules"));
        for entry in entries {
            let app_name = entry["app"].as_str().unwrap();
            let label = entry["label"].as_str().unwrap();
            let expected_id = schedule_id(app_name, label);
            assert_eq!(entry["id"], expected_id);
            assert_eq!(entry["filename"], format!("schedule-{expected_id}.dot"));
            let dot = fs::read(output.join(entry["filename"].as_str().unwrap())).unwrap();
            assert_eq!(entry["sha256"], sha256(&dot));
            assert!(String::from_utf8(dot).unwrap().contains("digraph"));
        }
    }

    #[test]
    fn fingerprints_sorted_source_paths_with_normalized_line_endings() {
        let fixture = Fixture::new();
        let expected_source = "Cargo.lock\0version = 4\n\0Cargo.toml\0[package]\nname='fixture'\n\0src/main.rs\0fn main() {}\n\0src/nested/other.rs\0struct Other;\n\0";
        assert_eq!(
            source_fingerprint(&fixture.path).unwrap(),
            sha256(expected_source.as_bytes())
        );
        fs::write(fixture.path.join("src/main.rs"), "fn main() {}\r\n").unwrap();
        fs::write(fixture.path.join("src/ignored.txt"), "not a Rust source").unwrap();
        assert_eq!(
            source_fingerprint(&fixture.path).unwrap(),
            sha256(expected_source.as_bytes())
        );
        fs::write(fixture.path.join("build.rs"), "fn main() {}\n").unwrap();
        let with_build = source_fingerprint(&fixture.path).unwrap();
        assert_ne!(with_build, sha256(expected_source.as_bytes()));
        fs::write(
            fixture.path.join("src/nested/other.rs"),
            "struct Changed;\n",
        )
        .unwrap();
        assert_ne!(source_fingerprint(&fixture.path).unwrap(), with_build);
    }

    fn first() {}
    fn second() {}

    #[test]
    fn failed_schedule_build_does_not_leave_a_success_manifest() {
        let fixture = Fixture::new();
        let output = fixture.path.join("output");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("manifest.json"), "previous successful export").unwrap();
        let mut app = App::new();
        app.add_systems(Update, (first.before(second), second.before(first)));
        let error = dump_schedules(&mut app, &output).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Failed to build schedule main/Update")
        );
        assert!(!output.join("manifest.json").exists());
    }

    #[derive(Component)]
    struct MainMarker {
        value: u32,
    }

    #[derive(Resource)]
    struct MainSnapshot {
        world_id: WorldId,
        entity: Entity,
        initialized: Arc<AtomicUsize>,
    }

    struct MainWorldProbe;

    impl FromWorld for MainWorldProbe {
        fn from_world(world: &mut World) -> Self {
            let snapshot = world.resource::<MainSnapshot>();
            assert_eq!(world.id(), snapshot.world_id);
            assert_eq!(world.get::<MainMarker>(snapshot.entity).unwrap().value, 41);
            snapshot.initialized.fetch_add(1, Ordering::SeqCst);
            Self
        }
    }

    fn extract_main_snapshot(
        _main: Extract<(Res<MainSnapshot>, Query<&MainMarker>, Local<MainWorldProbe>)>,
    ) {
        panic!("Extract systems must not execute during export");
    }

    fn extraction_app() -> (App, WorldId, Entity, Arc<AtomicUsize>) {
        let mut app = App::new();
        let world_id = app.world().id();
        let entity = app.world_mut().spawn(MainMarker { value: 41 }).id();
        let initialized = Arc::new(AtomicUsize::new(0));
        app.insert_resource(MainSnapshot {
            world_id,
            entity,
            initialized: initialized.clone(),
        });
        let mut sub_app = SubApp::new();
        sub_app.add_systems(ExtractSchedule, extract_main_snapshot);
        sub_app.set_extract(|_, _| panic!("Sub-app extraction must not execute during export"));
        app.insert_sub_app(RenderApp, sub_app);
        (app, world_id, entity, initialized)
    }

    fn assert_main_world_restored(app: &App, world_id: WorldId, entity: Entity) {
        assert_eq!(app.world().id(), world_id);
        assert_eq!(app.world().get::<MainMarker>(entity).unwrap().value, 41);
        let snapshot = app.world().resource::<MainSnapshot>();
        assert_eq!(snapshot.world_id, world_id);
        assert_eq!(snapshot.entity, entity);
        assert!(app.world().contains_resource::<Schedules>());
        assert!(
            !app.get_sub_app(RenderApp)
                .unwrap()
                .world()
                .contains_resource::<MainWorld>()
        );
    }

    #[test]
    fn exports_extract_params_against_real_main_world_and_restores_it() {
        let fixture = Fixture::new();
        let output = fixture.path.join("output");
        let (mut app, world_id, entity, initialized) = extraction_app();

        dump_schedules(&mut app, &output).unwrap();

        assert_main_world_restored(&app, world_id, entity);
        assert_eq!(initialized.load(Ordering::SeqCst), 1);
        let manifest: Value =
            serde_json::from_slice(&fs::read(output.join("manifest.json")).unwrap()).unwrap();
        assert!(
            manifest["schedules"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["app"] == "RenderApp"
                    && entry["label"] == "ExtractSchedule"
                    && entry["systemCount"] == 1)
        );
    }

    #[test]
    fn restores_main_world_after_extract_schedule_build_error() {
        let fixture = Fixture::new();
        let output = fixture.path.join("output");
        let (mut app, world_id, entity, initialized) = extraction_app();
        app.get_sub_app_mut(RenderApp).unwrap().add_systems(
            ExtractSchedule,
            (first.before(second), second.before(first)),
        );

        let error = dump_schedules(&mut app, &output).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("Failed to build schedule RenderApp/ExtractSchedule")
        );
        assert_main_world_restored(&app, world_id, entity);
        assert_eq!(initialized.load(Ordering::SeqCst), 1);
        assert!(!output.join("manifest.json").exists());
    }

    struct PanicMainWorldProbe;

    impl FromWorld for PanicMainWorldProbe {
        fn from_world(world: &mut World) -> Self {
            MainWorldProbe::from_world(world);
            panic!("extract initialization test panic");
        }
    }

    fn extract_with_panicking_initialization(_main: Extract<Local<PanicMainWorldProbe>>) {
        panic!("Extract systems must not execute during export");
    }

    #[test]
    fn restores_main_world_after_extract_parameter_initialization_panics() {
        let fixture = Fixture::new();
        let output = fixture.path.join("output");
        let (mut app, world_id, entity, initialized) = extraction_app();
        app.get_sub_app_mut(RenderApp)
            .unwrap()
            .add_systems(ExtractSchedule, extract_with_panicking_initialization);

        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            dump_schedules(&mut app, &output)
        }))
        .unwrap_err();

        assert_eq!(
            panic.downcast_ref::<&str>().copied(),
            Some("extract initialization test panic")
        );
        assert_main_world_restored(&app, world_id, entity);
        assert!(initialized.load(Ordering::SeqCst) > 0);
        assert!(
            app.get_sub_app(RenderApp)
                .unwrap()
                .world()
                .contains_resource::<Schedules>()
        );
        assert!(!output.join("manifest.json").exists());
    }

    #[test]
    fn rejects_existing_subapp_main_world_without_replacing_it() {
        let fixture = Fixture::new();
        let output = fixture.path.join("output");
        let (mut app, world_id, entity, initialized) = extraction_app();
        let existing = MainWorld::default();
        let existing_world_id = existing.id();
        app.get_sub_app_mut(RenderApp)
            .unwrap()
            .insert_resource(existing);

        let error = dump_schedules(&mut app, &output).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("MainWorld resource is already present")
        );
        assert_eq!(app.world().id(), world_id);
        assert_eq!(app.world().get::<MainMarker>(entity).unwrap().value, 41);
        assert_eq!(app.world().resource::<MainSnapshot>().entity, entity);
        assert_eq!(initialized.load(Ordering::SeqCst), 0);
        assert_eq!(
            app.get_sub_app(RenderApp)
                .unwrap()
                .world()
                .resource::<MainWorld>()
                .id(),
            existing_world_id
        );
        assert!(!output.join("manifest.json").exists());
    }
}

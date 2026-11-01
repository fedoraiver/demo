//! 使用隔离的 Cargo 编译准备依赖，并校验本次 driver 报告的完整性。
use crate::model::Report;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

/// 当前检查的 Cargo 配置；未选中的目标和特性不属于验证范围。
#[derive(Clone, Debug)]
pub struct Options {
    pub root: PathBuf,
    pub target: Option<String>,
    pub features: Vec<String>,
    pub all_features: bool,
    /// 嵌入调用时可指定内部 driver，CLI 使用同目录程序。
    pub driver: Option<PathBuf>,
}
impl Options {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            target: None,
            features: vec![],
            all_features: false,
            driver: None,
        }
    }
}

/// 报告只携带独立数据，不把 TyCtxt 的引用带出编译器回调。
#[derive(Serialize, Deserialize)]
pub struct DriverReport {
    pub run: String,
    pub configuration: String,
    pub compiler: String,
    pub source: String,
    pub report: Report,
    pub failure: Option<String>,
}

/// 对当前包的生产 lib/bin 执行检查；不会编译测试目标或启动项目程序。
pub fn check(options: &Options) -> Result<Report> {
    let root = options
        .root
        .canonicalize()
        .context("Cannot resolve project root")?;
    let compiler = compiler_output(&["-vV"])?;
    ensure!(
        compiler
            .lines()
            .any(|line| line == format!("commit-hash: {}", env!("ENTITY_CHECK_COMPILER"))),
        "Compiler does not match the checker's rustc ABI; rebuild with {}",
        env!("ENTITY_CHECK_CHANNEL")
    );
    let sysroot = PathBuf::from(compiler_output(&["--print", "sysroot"])?.trim());
    let output = cargo(&root)
        .args(["metadata", "--locked", "--no-deps", "--format-version", "1"])
        .output()?;
    ensure!(
        output.status.success(),
        "Cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let manifest = root.join("Cargo.toml").canonicalize()?;
    let package = metadata["packages"]
        .as_array()
        .context("Cargo returned no packages")?
        .iter()
        .find(|package| {
            Path::new(package["manifest_path"].as_str().unwrap_or(""))
                .canonicalize()
                .ok()
                .as_ref()
                == Some(&manifest)
        })
        .context("The selected root must contain a Cargo package")?;
    let package_id = package["id"].as_str().context("Missing package id")?;
    let clean_spec = package["name"].as_str().context("Missing package name")?;
    let mut features: BTreeSet<String> = options.features.iter().cloned().collect();
    features.insert("default".into());
    if options.all_features
        && let Some(declared) = package["features"].as_object()
    {
        features.extend(declared.keys().cloned());
    }
    loop {
        let mut implied = features.clone();
        for feature in &features {
            if let Some(values) = package["features"][feature].as_array() {
                for value in values {
                    if let Some(value) = value.as_str()
                        && package["features"].get(value).is_some()
                    {
                        implied.insert(value.into());
                    }
                }
            }
        }
        if implied == features {
            break;
        }
        features = implied;
    }
    let targets: Vec<_> = package["targets"]
        .as_array()
        .context("Missing targets")?
        .iter()
        .filter(|target| {
            target["kind"]
                .as_array()
                .is_some_and(|kinds| kinds.iter().any(|kind| kind == "bin" || kind == "lib"))
        })
        .filter(|target| {
            target["required-features"]
                .as_array()
                .is_none_or(|required| {
                    required.iter().all(|feature| {
                        feature
                            .as_str()
                            .is_some_and(|feature| features.contains(feature))
                    })
                })
        })
        .collect();
    ensure!(
        !targets.is_empty(),
        "No production lib/bin targets to analyze"
    );
    let sources: BTreeSet<String> = targets
        .iter()
        .map(|target| normalized(Path::new(target["src_path"].as_str().unwrap())))
        .collect::<Result<_>>()?;
    let configuration = serde_json::to_string(&(
        normalized(&root)?,
        &options.target,
        &options.features,
        options.all_features,
    ))?;
    let run = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tmp/entity-names");
    fs::create_dir_all(&cache)?;
    let cache = cache.canonicalize()?;
    // MSVC 的中间对象名较长，目录使用短名；完整编译器提交仍在报告中核验。
    let analysis = cache
        .join("rustc")
        .join(format!("{}-1", &env!("ENTITY_CHECK_COMPILER")[..12]));
    let target_dir = analysis.join("t");
    let build_dir = analysis.join("b");
    let reports = cache.join("runs").join(&run);
    for directory in [&target_dir, &build_dir, &reports] {
        fs::create_dir_all(directory)?;
        ensure!(
            directory.canonicalize()?.starts_with(&cache),
            "Analysis cache escaped the dedicated directory"
        );
    }
    let mut executable = env::current_exe()?;
    executable.pop();
    if executable.ends_with("deps") {
        executable.pop();
    }
    let driver = options.driver.clone().unwrap_or_else(|| {
        executable.join(format!(
            "check-entity-names-driver{}",
            env::consts::EXE_SUFFIX
        ))
    });
    ensure!(
        driver.is_file(),
        "Missing rustc driver {}; build the checker with cargo build --bins",
        driver.display()
    );
    let mut paths = vec![sysroot.join("bin"), sysroot.join("lib")];
    paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
    let path = env::join_paths(paths)?;
    let configure = |command: &mut Command| {
        command
            .env(
                "RUSTC",
                sysroot
                    .join("bin")
                    .join(format!("rustc{}", env::consts::EXE_SUFFIX)),
            )
            .env("CARGO_TARGET_DIR", &target_dir)
            .env("CARGO_BUILD_BUILD_DIR", &build_dir)
            .env("CARGO_INCREMENTAL", "0")
            .env("RUSTC_WRAPPER", &driver)
            .env("RUSTC_WORKSPACE_WRAPPER", &driver)
            .env("PATH", &path)
            .env("ENTITY_NAME_RUN", &run)
            .env("ENTITY_NAME_CONFIGURATION", &configuration)
            .env("ENTITY_NAME_REPORTS", &reports)
            .env(
                "ENTITY_NAME_SOURCES",
                serde_json::to_string(&sources).unwrap(),
            )
            .env("ENTITY_NAME_SYSROOT", &sysroot);
    };
    // 两个目录都覆盖，避免用户全局 build-dir 使清理波及共享缓存。
    let mut clean = cargo(&root);
    configure(&mut clean);
    clean.args(["clean", "--quiet", "-p", clean_spec]);
    if let Some(target) = &options.target {
        clean.args(["--target", target]);
    }
    ensure!(
        clean.status()?.success(),
        "Cannot invalidate the root package in the dedicated analysis cache"
    );
    let mut compile = cargo(&root);
    configure(&mut compile);
    compile.args(["check", "--quiet", "--locked", "-p", package_id]);
    if targets.iter().any(|target| {
        target["kind"]
            .as_array()
            .unwrap()
            .iter()
            .any(|kind| kind == "lib")
    }) {
        compile.arg("--lib");
    }
    if targets.iter().any(|target| {
        target["kind"]
            .as_array()
            .unwrap()
            .iter()
            .any(|kind| kind == "bin")
    }) {
        compile.arg("--bins");
    }
    if let Some(target) = &options.target {
        compile.args(["--target", target]);
    }
    if !options.features.is_empty() {
        compile.args(["--features", &options.features.join(",")]);
    }
    if options.all_features {
        compile.arg("--all-features");
    }
    ensure!(
        compile.status()?.success(),
        "Cargo compilation or rustc driver failed"
    );
    let mut report = Report {
        configuration: format!("{}; {}", env!("ENTITY_CHECK_CHANNEL"), configuration),
        ..Report::default()
    };
    let mut received = BTreeSet::new();
    for entry in fs::read_dir(&reports)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        let envelope: DriverReport = serde_json::from_slice(&fs::read(entry.path())?)?;
        ensure!(
            envelope.run == run
                && envelope.configuration == configuration
                && envelope.compiler == env!("ENTITY_CHECK_COMPILER"),
            "Stale or incompatible rustc driver report"
        );
        ensure!(
            sources.contains(&envelope.source),
            "Unexpected analyzed source {}",
            envelope.source
        );
        ensure!(
            envelope.failure.is_none(),
            "rustc analysis failed: {}",
            envelope.failure.unwrap_or_default()
        );
        received.insert(envelope.source);
        report.entities.extend(envelope.report.entities);
        report.diagnostics.extend(envelope.report.diagnostics);
    }
    ensure!(
        received == sources,
        "Missing fresh rustc analysis reports for {:?}",
        sources.difference(&received).collect::<Vec<_>>()
    );
    Ok(report)
}

fn cargo(root: &Path) -> Command {
    let mut command = Command::new("cargo");
    command
        .current_dir(root)
        .env("RUSTUP_TOOLCHAIN", env!("ENTITY_CHECK_CHANNEL"));
    command
}
fn compiler_output(args: &[&str]) -> Result<String> {
    let output = Command::new("rustc")
        .env("RUSTUP_TOOLCHAIN", env!("ENTITY_CHECK_CHANNEL"))
        .args(args)
        .output()?;
    ensure!(
        output.status.success(),
        "Cannot query the pinned Rust compiler"
    );
    Ok(String::from_utf8(output.stdout)?)
}
/// 统一报告和 Cargo 目标路径，Windows 扩展路径前缀不参与显示与比较。
pub fn normalized(path: &Path) -> Result<String> {
    Ok(path
        .canonicalize()?
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/"))
}

//! Cargo 编译单元与分析报告共同构成成功条件；缓存只复用内容仍匹配的依赖事实。
use crate::{
    report_cache::{AnalysisLock, CachedReport, ReportCache, inputs_key},
    unit_binding::{self, Hashes},
    unit_graph::UnitGraph,
};
use analysis_contract::{
    ANALYSIS_SCHEMA_VERSION, PackageOrigin, PackageTargetOrigin, Request, Rule, UnitReport,
    entity_names, named_fields, normalized,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::OsString,
    fs,
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

/// 所有检查共用同一配置入口；driver 仅供嵌入测试指定故障注入程序。
#[derive(Clone)]
pub struct Options {
    pub root: PathBuf,
    pub target: Option<String>,
    pub features: Vec<String>,
    pub all_features: bool,
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

#[derive(Clone, Deserialize)]
struct Package {
    id: String,
    name: String,
    manifest_path: PathBuf,
    targets: Vec<CargoTarget>,
}
#[derive(Clone, Deserialize)]
struct CargoTarget {
    src_path: PathBuf,
    kind: Vec<String>,
}

fn package_origins(metadata: &serde_json::Value) -> Result<Vec<PackageOrigin>> {
    let workspace = Path::new(
        metadata["workspace_root"]
            .as_str()
            .context("Missing Cargo workspace root")?,
    )
    .canonicalize()?;
    metadata["packages"].as_array().context("Missing Cargo packages")?.iter().map(|package| {
        let manifest = Path::new(package["manifest_path"].as_str().context("Missing Cargo manifest")?);
        let root = manifest.parent().context("Cargo manifest has no parent")?.canonicalize()?;
        let source = package["source"].as_str().map(str::to_owned).unwrap_or_else(|| {
            match root.strip_prefix(&workspace) {
                Ok(relative) => format!("workspace:{}", relative.to_string_lossy().replace('\\', "/")),
                Err(_) => format!("path:{}", root.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/")),
            }
        });
        let identity = serde_json::to_string(&serde_json::json!({"source":source,"name":package["name"],"version":package["version"]}))?;
        let mut targets = Vec::new();
        for target in package["targets"].as_array().context("Missing Cargo targets")? {
            let path = Path::new(target["src_path"].as_str().context("Missing Cargo target source")?);
            let kind: Vec<String> = serde_json::from_value(target["kind"].clone())?;
            let source = match normalized(path) {
                Ok(source) => source,
                // 发布包可省略测试、示例和基准源码；缺失文件不进入声明身份候选。
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
                    && path.is_absolute()
                    && !kind.is_empty()
                    && kind.iter().all(|kind| matches!(kind.as_str(), "example" | "test" | "bench")) => continue,
                Err(error) => return Err(error).with_context(|| format!("Cannot resolve Cargo target source {}", path.display())),
            };
            targets.push(PackageTargetOrigin {
                source,
                name: target["name"].as_str().context("Missing Cargo target name")?.into(),
                kind,
            });
        }
        Ok(PackageOrigin { root: normalized(&root)?, identity, targets })
    }).collect()
}
#[derive(Serialize)]
pub(crate) struct ArtifactTarget {
    pub source: String,
    pub name: String,
}

pub(crate) struct Artifact {
    pub package_id: String,
    pub target: ArtifactTarget,
    pub cargo_profile_test: bool,
    pub filenames: Vec<String>,
    fresh: bool,
    manifest_dir: String,
    pub crate_types: Vec<String>,
    executable: Option<PathBuf>,
    pub profile: serde_json::Value,
    pub features: Vec<String>,
    pub mode: String,
    pub metadata: serde_json::Value,
    selected: bool,
}
impl Artifact {
    fn matches_identity(&self, report: &UnitReport) -> bool {
        let normalize_types = |types: &[String]| -> BTreeSet<String> {
            types
                .iter()
                .map(|kind| {
                    if kind == "lib" {
                        "rlib".into()
                    } else {
                        kind.clone()
                    }
                })
                .collect()
        };
        if self.target.source != report.target.source
            || self.target.name != report.target.name
            || self.manifest_dir != report.manifest_dir
            || (!(report.target.test && report.crate_types == ["bin"])
                && normalize_types(&self.crate_types) != normalize_types(&report.crate_types))
        {
            return false;
        }
        true
    }

    fn matches_report_exact(&self, report: &UnitReport) -> bool {
        if !self.matches_identity(report) {
            return false;
        }
        self.filenames
            .iter()
            .any(|filename| report.inputs.outputs.contains(filename))
            || (!report.artifact_tag.is_empty()
                && self
                    .filenames
                    .iter()
                    .any(|filename| filename.contains(&report.artifact_tag)))
    }
}

fn report_owners(
    artifacts: &[Artifact],
    report: &UnitReport,
    hashes: &mut Hashes,
) -> Result<Vec<usize>> {
    let exact: Vec<_> = artifacts
        .iter()
        .enumerate()
        .filter(|(_, artifact)| artifact.matches_report_exact(report))
        .map(|(index, _)| index)
        .collect();
    if !exact.is_empty() {
        return Ok(exact);
    }
    // 公开 exe 可能是原生产物的复制件。先排除已精确绑定的报告，再核对真实字节；
    // 普通与测试报告不能靠遍历顺序或 executable 字段互相占用。
    let mut owners = Vec::new();
    if report.target.test || report.crate_types != ["bin"] {
        return Ok(owners);
    }
    for (index, artifact) in artifacts
        .iter()
        .enumerate()
        .filter(|(_, artifact)| artifact.matches_identity(report))
    {
        let Some(executable) = &artifact.executable else {
            continue;
        };
        if !executable
            .file_stem()
            .is_some_and(|stem| stem.to_string_lossy().replace('-', "_") == artifact.target.name)
        {
            continue;
        }
        let Some(public) = artifact
            .filenames
            .iter()
            .find(|filename| Path::new(filename) == executable)
        else {
            continue;
        };
        for output in &report.inputs.outputs {
            let path = Path::new(output);
            if path.extension() == executable.extension()
                && path.is_file()
                && Path::new(public).is_file()
                && hashes.get(public)? == hashes.get(output)?
            {
                owners.push(index);
                break;
            }
        }
    }
    Ok(owners)
}

struct Compilation {
    reports: Vec<UnitReport>,
    packages: serde_json::Value,
    executable: Option<PathBuf>,
    configuration: String,
    environment_path: OsString,
    summary: serde_json::Value,
}

/// 恢复其他包后只保留输入和产物均未改变的同轮报告，不能重新散列旧事实来冒充新证明。
struct RetainedReport {
    sha256: String,
    observations: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FactBundle {
    schema_version: u32,
    compiler: &'static str,
    configuration: String,
    workspace: String,
    packages: serde_json::Value,
    source_origins: Vec<serde_json::Value>,
    units: Vec<analysis_contract::facts::UnitFacts>,
    executable_sha256: String,
    runtime_sha256: String,
}

struct Host {
    root: PathBuf,
    cache: PathBuf,
    directory: PathBuf,
    target_dir: PathBuf,
    build_dir: PathBuf,
    sysroot: PathBuf,
    compiler_release: String,
    driver: PathBuf,
    path: OsString,
    host: String,
    run: String,
}

pub(crate) fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

impl Host {
    fn new(options: &Options, rule: Rule) -> Result<Self> {
        let root = options.root.canonicalize()?;
        let query = |args: &[&str]| -> Result<String> {
            let output = Command::new("rustc")
                .env("RUSTUP_TOOLCHAIN", env!("ANALYSIS_TOOLCHAIN"))
                .args(args)
                .output()?;
            ensure!(
                output.status.success(),
                "Cannot query the pinned Rust compiler"
            );
            Ok(String::from_utf8(output.stdout)?)
        };
        let version = query(&["-vV"])?;
        ensure!(
            version
                .lines()
                .any(|line| line == format!("commit-hash: {}", env!("ANALYSIS_COMPILER"))),
            "Compiler does not match the analysis driver's rustc ABI; rebuild with {}",
            env!("ANALYSIS_TOOLCHAIN")
        );
        let host = version
            .lines()
            .find_map(|line| line.strip_prefix("host: "))
            .context("Missing compiler host")?
            .to_owned();
        let compiler_release = version
            .lines()
            .find_map(|line| line.strip_prefix("release: "))
            .context("Missing compiler release")?
            .to_owned();
        let sysroot = PathBuf::from(query(&["--print", "sysroot"])?.trim());
        let mut executable = env::current_exe()?;
        executable.pop();
        if executable.ends_with("deps") {
            executable.pop();
        }
        let driver = options.driver.clone().unwrap_or_else(|| {
            executable.join(format!("rustc-analysis-driver{}", env::consts::EXE_SUFFIX))
        });
        ensure!(
            driver.is_file(),
            "Missing compiler analysis driver {}; build the shared tool workspace",
            driver.display()
        );
        let mut paths = vec![sysroot.join("bin"), sysroot.join("lib")];
        paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
        let path = env::join_paths(paths)?;
        let tool_repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()?;
        // Windows 链接器仍可能受完整对象文件路径长度限制，编译缓存使用短目录。
        let cache = tool_repository.join("tmp/ra");
        fs::create_dir_all(&cache)?;
        let cache = cache.canonicalize()?;
        let mode = match rule {
            Rule::NamedFields => "nf",
            Rule::EntityNames => "en",
            Rule::Architecture => "ecs",
        };
        let run = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        );
        let directory = cache.join("r").join(&run);
        // 契约升级只建立一次新的原生缓存，后续运行保留同一增量图与 Cargo 产物。
        let location = Command::new("cargo")
            .current_dir(&root)
            .env("RUSTUP_TOOLCHAIN", env!("ANALYSIS_TOOLCHAIN"))
            .env("RUSTC_WRAPPER", "")
            .env("RUSTC_WORKSPACE_WRAPPER", "")
            .args(["locate-project", "--workspace", "--message-format", "plain"])
            .output()?;
        ensure!(
            location.status.success(),
            "Cannot locate Cargo workspace: {}",
            String::from_utf8_lossy(&location.stderr)
        );
        let workspace_manifest = PathBuf::from(String::from_utf8(location.stdout)?.trim());
        let workspace = normalized(
            workspace_manifest
                .parent()
                .context("Cargo workspace manifest has no parent")?,
        )?;
        // 不同 workspace 的锁文件与稳定分析配置独立，避免共用 unit 的 token 相互替换。
        let slot = digest(workspace.as_bytes());
        let analysis = cache
            .join(format!(
                "{}-v{}",
                &env!("ANALYSIS_COMPILER")[..12],
                ANALYSIS_SCHEMA_VERSION
            ))
            .join(mode)
            .join(&slot[..8]);
        let target_dir = analysis.join("t");
        let build_dir = analysis.join("b");
        for path in [&directory, &target_dir, &build_dir] {
            fs::create_dir_all(path)?;
            ensure!(
                path.canonicalize()?.starts_with(&cache),
                "Analysis cache escaped the dedicated directory"
            );
        }
        Ok(Self {
            root,
            cache,
            directory,
            target_dir,
            build_dir,
            sysroot,
            compiler_release,
            driver,
            path,
            host,
            run,
        })
    }

    fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut command = Command::new(program);
        command
            .current_dir(&self.root)
            .env("RUSTUP_TOOLCHAIN", env!("ANALYSIS_TOOLCHAIN"))
            .env(
                "RUSTC",
                self.sysroot
                    .join("bin")
                    .join(format!("rustc{}", env::consts::EXE_SUFFIX)),
            )
            .env("PATH", &self.path)
            .env("CARGO_TARGET_DIR", &self.target_dir)
            .env("CARGO_BUILD_BUILD_DIR", &self.build_dir)
            .env_remove("CARGO_BUILD_TARGET")
            .env("CARGO_INCREMENTAL", "1")
            .env("RUSTC_WRAPPER", "")
            .env("RUSTC_WORKSPACE_WRAPPER", "");
        command
    }

    fn source_origins(&self) -> Result<Vec<serde_json::Value>> {
        let root = self.sysroot.join("lib/rustlib/src/rust/library");
        ensure!(
            root.join("core/src/lib.rs").is_file() && root.join("std/src/lib.rs").is_file(),
            "The pinned compiler rust-src component is missing"
        );
        Ok(vec![
            serde_json::json!({"name":"rustc-library","version":self.compiler_release,"root":normalized(&root)?,"compilerCommit":env!("ANALYSIS_COMPILER")}),
        ])
    }

    fn metadata(&self, options: &Options, full: bool) -> Result<serde_json::Value> {
        let mut command = self.command("cargo");
        command.args(["metadata", "--locked", "--offline", "--format-version", "1"]);
        if !full {
            command.arg("--no-deps");
        }
        if !options.features.is_empty() {
            command.args(["--features", &options.features.join(",")]);
        }
        if options.all_features {
            command.arg("--all-features");
        }
        let output = command.output()?;
        ensure!(
            output.status.success(),
            "Cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(serde_json::from_slice(&output.stdout)?)
    }

    fn recover_packages(
        &self,
        options: &Options,
        missing: &BTreeSet<String>,
        recovered: &mut BTreeSet<String>,
        lock_root: &Path,
        lock_digest: &str,
    ) -> Result<()> {
        ensure!(
            !missing.is_empty() && missing.is_disjoint(recovered),
            "Missing or ambiguous compiler facts after one package recovery: {missing:?}"
        );
        for id in missing {
            let mut clean = self.command("cargo");
            clean.args(["clean", "--quiet", "--locked", "-p", id]);
            if let Some(target) = options
                .target
                .as_deref()
                .filter(|target| *target != self.host)
            {
                clean.args(["--target", target]);
            }
            ensure!(
                clean.status()?.success(),
                "Cannot recover missing analysis report for {id}"
            );
            ensure!(
                file_digest(&lock_root.join("Cargo.lock"))? == lock_digest,
                "Package recovery changed the Cargo lockfile"
            );
            recovered.insert(id.clone());
        }
        Ok(())
    }

    fn compile(&self, options: &Options, rule: Rule, full_metadata: bool) -> Result<Compilation> {
        let started = Instant::now();
        let metadata = self.metadata(options, full_metadata)?;
        let packages: Vec<Package> = serde_json::from_value(metadata["packages"].clone())?;
        let manifest = self.root.join("Cargo.toml").canonicalize()?;
        let package = packages
            .iter()
            .find(|package| package.manifest_path.canonicalize().ok().as_ref() == Some(&manifest))
            .context("The selected root must contain a Cargo package")?;
        let all_targets = rule == Rule::NamedFields;
        let targets: Vec<_> = package
            .targets
            .iter()
            .filter(|target| {
                all_targets
                    || target
                        .kind
                        .iter()
                        .any(|kind| matches!(kind.as_str(), "lib" | "bin"))
            })
            .collect();
        ensure!(!targets.is_empty(), "No compilation targets to analyze");
        let sources = targets
            .iter()
            .map(|target| normalized(&target.src_path))
            .collect::<std::io::Result<BTreeSet<_>>>()?;
        let lock_root = PathBuf::from(
            metadata["workspace_root"]
                .as_str()
                .context("Missing Cargo workspace root")?,
        );
        let mut native_configuration = BTreeMap::new();
        let mut configured_environment = BTreeSet::new();
        for key in ["build", "profile", "target", "host", "unstable", "env"] {
            let output = self
                .command("cargo")
                .args([
                    "-Zunstable-options",
                    "config",
                    "get",
                    "--format=json-value",
                    "--merged=yes",
                    key,
                ])
                .output()?;
            // An absent native key produces an empty result, not an assumed default profile.
            if output.status.success() {
                native_configuration.insert(key, digest(&output.stdout));
                if key == "env" {
                    configured_environment.extend(
                        serde_json::from_slice::<serde_json::Value>(&output.stdout)?
                            .as_object()
                            .context("Invalid Cargo environment configuration")?
                            .keys()
                            .map(|name| unit_binding::environment_key(name)),
                    );
                }
            } else {
                let error = String::from_utf8_lossy(&output.stderr);
                ensure!(
                    error.contains("not set") || error.contains("not found"),
                    "Cannot query native Cargo configuration: {error}"
                );
            }
        }
        let relevant_environment: BTreeMap<_, _> = env::vars_os()
            .filter(|(name, _)| {
                let name = unit_binding::environment_key(&name.to_string_lossy());
                if matches!(
                    name.as_str(),
                    "CARGO_TARGET_DIR" | "CARGO_BUILD_BUILD_DIR" | "CARGO_BUILD_TARGET"
                ) {
                    return false;
                }
                name == "RUSTFLAGS"
                    || name == "CARGO_ENCODED_RUSTFLAGS"
                    || name == "RUSTDOCFLAGS"
                    || name.starts_with("CARGO_PROFILE_")
                    || name.starts_with("CARGO_TARGET_")
                    || name.starts_with("CARGO_BUILD_")
                    || name.starts_with("CARGO_UNSTABLE_")
            })
            .map(|(key, value)| {
                (
                    unit_binding::environment_key(&key.to_string_lossy()),
                    digest(value.to_string_lossy().as_bytes()),
                )
            })
            .collect();
        let lock_digest = file_digest(&lock_root.join("Cargo.lock"))?;
        // 命名规则可共享 workspace 单元；架构实体模板仍由选中的 primary 包决定。
        let report_scope = if rule == Rule::Architecture {
            &self.root
        } else {
            &lock_root
        };
        let configuration = digest(serde_json::to_vec(&serde_json::json!({
            "schemaVersion": ANALYSIS_SCHEMA_VERSION, "incremental":true,
            "workspace":normalized(report_scope)?,"target": options.target.as_deref().unwrap_or(&self.host),
            "features":options.features.iter().collect::<BTreeSet<_>>(),"allFeatures":options.all_features,"rule":rule,
            "compiler":env!("ANALYSIS_COMPILER"),"driver":file_digest(&self.driver)?,
            "lock":lock_digest,"cargo":native_configuration,"environment":relevant_environment
        }))?);
        let request = Request {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            run: self.run.clone(),
            configuration: configuration.clone(),
            compiler: env!("ANALYSIS_COMPILER").into(),
            workspace: normalized(&self.root)?,
            rule,
            sources,
            manifest_dirs: BTreeSet::from([normalized(&self.root)?]),
            package_origins: package_origins(&metadata)?,
        };
        let request_path = self
            .directory
            .join(format!("{}-request.input", package.name));
        let reports_dir = self.directory.join(&package.name);
        fs::create_dir_all(&reports_dir)?;
        fs::write(&request_path, serde_json::to_vec(&request)?)?;
        let configure = |command: &mut Command| {
            command
                .env("ANALYSIS_REQUEST", &request_path)
                .env("ANALYSIS_CONFIGURATION", &request.configuration)
                .env("ANALYSIS_REPORTS", &reports_dir)
                .env("ANALYSIS_SYSROOT", &self.sysroot)
                .env("RUSTC_WORKSPACE_WRAPPER", &self.driver)
                .env("NAMED_FIELDS_REPORTS", &reports_dir)
                .env("NAMED_FIELDS_REQUEST", &request_path)
                .env("ENTITY_NAME_RUN", &request.run)
                .env("ENTITY_NAME_CONFIGURATION", &request.configuration)
                .env("ENTITY_NAME_REPORTS", &reports_dir);
            command.env("RUSTC_WRAPPER", &self.driver);
        };
        let cargo_command = || {
            let mut command = self.command("cargo");
            configure(&mut command);
            command.args([
                if rule == Rule::Architecture {
                    "build"
                } else {
                    "check"
                },
                "--locked",
                "-p",
                &package.id,
            ]);
            if all_targets {
                command.arg("--all-targets");
            } else {
                if targets
                    .iter()
                    .any(|target| target.kind.iter().any(|kind| kind == "lib"))
                {
                    command.arg("--lib");
                }
                if targets
                    .iter()
                    .any(|target| target.kind.iter().any(|kind| kind == "bin"))
                {
                    command.arg("--bins");
                }
            }
            if let Some(target) = options
                .target
                .as_deref()
                .filter(|target| *target != self.host)
            {
                command.args(["--target", target]);
            }
            if !options.features.is_empty() {
                command.args(["--features", &options.features.join(",")]);
            }
            if options.all_features {
                command.arg("--all-features");
            }
            command
        };
        let graph_output = cargo_command()
            .args(["--unit-graph", "-Zunstable-options"])
            .output()?;
        ensure!(
            graph_output.status.success(),
            "Cargo unit graph failed: {}",
            String::from_utf8_lossy(&graph_output.stderr)
        );
        fs::write(
            self.directory
                .join(format!("{}-unit-graph.json", package.name)),
            &graph_output.stdout,
        )?;
        let graph = UnitGraph::parse(&graph_output.stdout)?;
        let mut environment: BTreeMap<String, String> = env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .map(|(name, value)| (unit_binding::environment_key(&name), value))
            .collect();
        for (name, value) in cargo_command().get_envs() {
            let name = unit_binding::environment_key(&name.to_string_lossy());
            if let Some(value) = value {
                environment.insert(name, value.to_string_lossy().into_owned());
            } else {
                environment.remove(&name);
            }
        }
        let cache = ReportCache::new(
            self.cache.join("v2").join(&configuration),
            configuration.clone(),
            rule,
        )?;
        let mut recovered = BTreeSet::new();
        let mut compiled = 0;
        let mut reused = 0;
        let mut cargo_ms = 0;
        let mut binding_ms = 0;
        let mut retained_reports = BTreeMap::<PathBuf, RetainedReport>::new();
        for attempt in 0..=packages.len() {
            let cargo_started = Instant::now();
            let output = cargo_command().arg("--message-format=json").output()?;
            cargo_ms += cargo_started.elapsed().as_millis();
            fs::write(
                self.directory
                    .join(format!("{}-{attempt}.stderr.log", package.name)),
                &output.stderr,
            )?;
            fs::write(
                self.directory
                    .join(format!("{}-{attempt}.stdout.jsonl", package.name)),
                &output.stdout,
            )?;
            if !output.stderr.is_empty() {
                eprint!("{}", String::from_utf8_lossy(&output.stderr));
            }
            let binding_started = Instant::now();
            let mut artifacts = Vec::new();
            let mut scripts = BTreeMap::<String, Vec<serde_json::Value>>::new();
            let mut seen = BTreeSet::new();
            let mut executable = None;
            for line in String::from_utf8(output.stdout)?.lines() {
                let value: serde_json::Value =
                    serde_json::from_str(line).context("Invalid Cargo JSON output")?;
                if value["reason"] == "compiler-message"
                    && let Some(text) = value["message"]["rendered"].as_str()
                {
                    eprint!("{text}");
                }
                if value["reason"] == "build-script-executed" {
                    scripts
                        .entry(
                            value["package_id"]
                                .as_str()
                                .context("Missing build script package")?
                                .into(),
                        )
                        .or_default()
                        .push(value.clone());
                }
                if value["reason"] != "compiler-artifact" {
                    continue;
                }
                let id = value["package_id"]
                    .as_str()
                    .context("Missing artifact package")?;
                let source = normalized(Path::new(
                    value["target"]["src_path"]
                        .as_str()
                        .context("Missing target source")?,
                ))?;
                let mut filenames: Vec<String> =
                    serde_json::from_value::<Vec<String>>(value["filenames"].clone())?
                        .iter()
                        .map(|filename| normalized(Path::new(filename)))
                        .collect::<std::io::Result<_>>()?;
                filenames.sort();
                filenames.dedup();
                let test = value["profile"]["test"]
                    .as_bool()
                    .context("Missing target test mode")?;
                let selected = if rule == Rule::Architecture {
                    !value["target"]["kind"]
                        .as_array()
                        .context("Missing target kind")?
                        .iter()
                        .any(|kind| kind == "custom-build")
                } else {
                    id == package.id && request.sources.contains(&source)
                };
                if !seen.insert((id.to_owned(), filenames.clone(), test)) {
                    continue;
                }
                if id == package.id
                    && !test
                    && let Some(binary) = value["executable"].as_str()
                {
                    executable = Some(PathBuf::from(normalized(Path::new(binary))?));
                }
                let mode = if rule == Rule::Architecture
                    || filenames.iter().any(|filename| {
                        Path::new(filename).extension().is_some_and(|extension| {
                            extension == "rlib"
                                || extension == "dll"
                                || extension == "so"
                                || extension == "dylib"
                                || extension == "exe"
                        })
                    })
                    || value["target"]["kind"]
                        .as_array()
                        .is_some_and(|kinds| kinds.iter().any(|kind| kind == "custom-build"))
                {
                    "build"
                } else {
                    "check"
                };
                artifacts.push(Artifact {
                    package_id: id.into(),
                    target: ArtifactTarget {
                        source,
                        name: value["target"]["name"]
                            .as_str()
                            .context("Missing target name")?
                            .replace('-', "_"),
                    },
                    cargo_profile_test: test,
                    filenames,
                    fresh: value["fresh"]
                        .as_bool()
                        .context("Missing Cargo fresh flag")?,
                    manifest_dir: normalized(
                        packages
                            .iter()
                            .find(|package| package.id == id)
                            .context("Unknown Cargo package")?
                            .manifest_path
                            .parent()
                            .context("Missing package directory")?,
                    )?,
                    crate_types: serde_json::from_value(value["target"]["crate_types"].clone())?,
                    executable: value["executable"]
                        .as_str()
                        .map(|path| normalized(Path::new(path)).map(PathBuf::from))
                        .transpose()?,
                    profile: value["profile"].clone(),
                    features: serde_json::from_value(value["features"].clone())?,
                    mode: mode.into(),
                    selected,
                    metadata: metadata["packages"]
                        .as_array()
                        .context("Missing Cargo packages")?
                        .iter()
                        .find(|package| package["id"] == id)
                        .context("Missing artifact metadata")?
                        .clone(),
                });
            }
            // Failed compilations retain the previous cache and never publish new reports.
            ensure!(
                output.status.success(),
                "Cargo compilation or rustc driver failed for {}",
                package.name
            );
            compiled += artifacts.iter().filter(|artifact| !artifact.fresh).count();
            ensure!(
                file_digest(&lock_root.join("Cargo.lock"))? == lock_digest,
                "Cargo lockfile changed during analysis"
            );
            ensure!(
                artifacts.iter().any(|artifact| artifact.selected),
                "No compilation targets were checked for {}",
                package.name
            );
            for values in scripts.values_mut() {
                values.sort_by_key(|value| serde_json::to_string(value).unwrap());
                values.dedup();
            }
            let mut reports = Vec::new();
            for entry in fs::read_dir(&reports_dir)? {
                let path = entry?.path();
                if path.extension().is_none_or(|extension| extension != "json") {
                    continue;
                }
                let report = read_report(&path).context("Stale or incompatible compiler report")?;
                ensure!(
                    report.schema_version == ANALYSIS_SCHEMA_VERSION
                        && report.rule == rule
                        && report.run == request.run
                        && report.configuration == configuration
                        && report.compiler == request.compiler,
                    "Stale or incompatible compiler report"
                );
                ensure!(
                    report.failure.is_none(),
                    "Compiler analysis failed: {}",
                    report.failure.as_deref().unwrap_or_default()
                );
                ensure!(
                    rule != Rule::Architecture || !report.analyzed || report.facts.is_some(),
                    "Architecture compiler report has no facts"
                );
                reports.push((report, path));
            }
            let mut selected = Vec::new();
            let mut selected_keys = Vec::new();
            let mut requested = BTreeSet::new();
            let mut missing = BTreeSet::new();
            let mut hashes = Hashes::default();
            let owners = reports
                .iter()
                .map(|(report, _)| report_owners(&artifacts, report, &mut hashes))
                .collect::<Result<Vec<_>>>()?;
            let mut graph_candidates = unit_binding::candidates(&artifacts, &graph)?;
            let mut accepted = Vec::new();
            let mut accepted_owners = Vec::new();
            for ((report, path), owners) in reports.into_iter().zip(owners) {
                let previous = retained_reports.remove(&path);
                let observations = if owners.len() == 1 && report.inputs.complete {
                    let index = owners[0];
                    graph_candidates[index]
                        .iter()
                        .filter_map(|candidate| {
                            unit_binding::observe_inputs(
                                index,
                                &report,
                                &artifacts,
                                candidate,
                                &scripts,
                                &self.sysroot,
                                &environment,
                                &configured_environment,
                                &mut hashes,
                            )
                            .ok()
                            .map(|proof| (candidate.key.clone(), proof))
                        })
                        .collect::<BTreeMap<_, _>>()
                } else {
                    BTreeMap::new()
                };
                let sha256 = file_digest(&path)?;
                if let Some(previous) = previous {
                    if owners.len() != 1
                        || !artifacts[owners[0]].fresh
                        || !retained_report_matches(&previous, &sha256, &observations)
                    {
                        eprintln!(
                            "Discarding superseded or changed same-run report: {}",
                            path.display()
                        );
                        fs::remove_file(&path)?;
                        continue;
                    }
                    reused += 1;
                }
                retained_reports.insert(
                    path.clone(),
                    RetainedReport {
                        sha256,
                        observations,
                    },
                );
                accepted.push((report, path));
                accepted_owners.push(owners);
            }
            let reports = accepted;
            let owners = accepted_owners;
            let current_by_artifact: Vec<Vec<usize>> = (0..artifacts.len())
                .map(|index| {
                    owners
                        .iter()
                        .enumerate()
                        .filter(|(_, owners)| owners.as_slice() == [index])
                        .map(|(report, _)| report)
                        .collect()
                })
                .collect();
            let mut cached_choices: Vec<Vec<(String, CachedReport)>> =
                (0..artifacts.len()).map(|_| Vec::new()).collect();
            let mut cache_errors: Vec<Vec<String>> =
                (0..artifacts.len()).map(|_| Vec::new()).collect();
            for (index, artifact) in artifacts.iter().enumerate() {
                if !current_by_artifact[index].is_empty() || !artifact.fresh {
                    continue;
                }
                for candidate in &graph_candidates[index] {
                    for harness in [false, true] {
                        let key = unit_binding::report_key(&candidate.key, harness);
                        let keys = if artifact.selected {
                            vec![key]
                        } else {
                            vec![key.clone(), inputs_key(&key)]
                        };
                        for key in keys {
                            let cached = (|| -> Result<Option<CachedReport>> {
                                let Some(cached) = cache.load(&key)? else {
                                    return Ok(None);
                                };
                                ensure!(
                                    cached.report.compiler == request.compiler
                                        && cached.report.target.test == harness
                                        && report_owners(&artifacts, &cached.report, &mut hashes)?
                                            .as_slice()
                                            == [index]
                                        && (!artifact.selected || cached.report.analyzed),
                                    "Cached compiler unit mismatch"
                                );
                                unit_binding::precheck_cached(
                                    index,
                                    &cached.report,
                                    &cached.proof,
                                    &artifacts,
                                    candidate,
                                    &scripts,
                                    &self.sysroot,
                                    &environment,
                                    &configured_environment,
                                    &mut hashes,
                                )?;
                                Ok(Some(cached))
                            })();
                            match cached {
                                Ok(Some(cached)) => {
                                    cached_choices[index].push((candidate.key.clone(), cached));
                                    break;
                                }
                                Err(error) => cache_errors[index].push(format!("{error:#}")),
                                _ => {}
                            }
                        }
                    }
                }
            }
            // 缓存键已绑定依赖证明类；只缩小到全部通过输入预检的候选，不挑第一项。
            for (index, choices) in cached_choices.iter().enumerate() {
                if current_by_artifact[index].is_empty() && !choices.is_empty() {
                    let keys: BTreeSet<_> = choices.iter().map(|(key, _)| key.as_str()).collect();
                    graph_candidates[index]
                        .retain(|candidate| keys.contains(candidate.key.as_str()));
                }
            }
            let evidence: Vec<Vec<&UnitReport>> = current_by_artifact
                .iter()
                .enumerate()
                .map(|(index, current)| {
                    if current.len() == 1 {
                        vec![&reports[current[0]].0]
                    } else if current.is_empty() {
                        cached_choices[index]
                            .iter()
                            .map(|(_, cached)| &cached.report)
                            .collect()
                    } else {
                        vec![]
                    }
                })
                .collect();
            let resolved =
                unit_binding::resolve(&artifacts, graph_candidates, &evidence, &self.sysroot);
            drop(evidence);
            let bound = match resolved {
                Ok(bound) => bound,
                Err(error) => {
                    let Some(failure) = error.downcast_ref::<unit_binding::ResolutionFailure>()
                    else {
                        return Err(error);
                    };
                    let missing: BTreeSet<_> = failure
                        .artifacts
                        .iter()
                        .map(|index| artifacts[*index].package_id.clone())
                        .collect();
                    eprintln!("Dependency proof awaits package report recovery: {error:#}");
                    binding_ms += binding_started.elapsed().as_millis();
                    self.recover_packages(
                        options,
                        &missing,
                        &mut recovered,
                        &lock_root,
                        &lock_digest,
                    )?;
                    continue;
                }
            };
            let mut reports: Vec<_> = reports.into_iter().map(Some).collect();
            let mut harnesses = BTreeMap::new();
            let mut unit_index = Vec::new();
            for (artifact, binding) in artifacts.iter().zip(&bound) {
                unit_index.push(serde_json::json!({"key":binding.key,"package":artifact.package_id,
                    "target":artifact.target,"cargoProfileTest":artifact.cargo_profile_test,"testHarness":null,"crateTypes":artifact.crate_types,"profile":artifact.profile,
                    "features":artifact.features,"mode":artifact.mode,"graph":binding.graph.class,
                    "dependencyClasses":binding.graph.dependency_classes,"fresh":artifact.fresh,
                    "selected":artifact.selected,"artifacts":hashes.files(&artifact.filenames)?}));
            }
            unit_index.sort_by_key(|unit| unit["key"].as_str().unwrap_or_default().to_owned());
            fs::write(
                self.directory
                    .join(format!("{}-{attempt}.unit-index.json", package.name)),
                serde_json::to_vec(&unit_index)?,
            )?;
            let mut pending = Vec::new();
            for (index, artifact) in artifacts.iter().enumerate() {
                let current: Vec<_> = reports
                    .iter()
                    .enumerate()
                    .filter(|(report_index, report)| {
                        report.is_some() && owners[*report_index].as_slice() == [index]
                    })
                    .map(|(index, _)| index)
                    .collect();
                if current.len() == 1 {
                    let (report, path) = reports[current[0]].take().unwrap();
                    harnesses.insert(bound[index].key.clone(), report.target.test);
                    if report.inputs.complete {
                        let proof = unit_binding::proof(
                            index,
                            &report,
                            &artifacts,
                            &bound,
                            &scripts,
                            &self.sysroot,
                            &environment,
                            &configured_environment,
                            &mut hashes,
                        )?;
                        pending.push((selected.len(), path, proof, index));
                    } else {
                        eprintln!(
                            "Analysis report is not reusable: {} {:?}",
                            artifact.target.name, report.inputs.gaps
                        );
                    }
                    if artifact.selected {
                        if report.analyzed {
                            requested.insert(selected.len());
                        } else {
                            missing.insert(artifact.package_id.clone());
                        }
                    }
                    selected_keys.push(unit_binding::report_key(
                        &bound[index].key,
                        report.target.test,
                    ));
                    selected.push(report);
                } else if current.is_empty() && artifact.fresh {
                    let mut candidates = Vec::new();
                    let mut errors = std::mem::take(&mut cache_errors[index]);
                    for (key, cached) in std::mem::take(&mut cached_choices[index]) {
                        if key != bound[index].key {
                            continue;
                        }
                        let checked = (|| -> Result<UnitReport> {
                            let proof = unit_binding::proof(
                                index,
                                &cached.report,
                                &artifacts,
                                &bound,
                                &scripts,
                                &self.sysroot,
                                &environment,
                                &configured_environment,
                                &mut hashes,
                            )?;
                            ensure!(proof == cached.proof, "Cached compiler input proof changed");
                            Ok(cached.report)
                        })();
                        match checked {
                            Ok(report) => {
                                candidates.push(report);
                            }
                            Err(error) => errors.push(format!("{error:#}")),
                        }
                    }
                    let cached_report = if candidates.len() == 1 {
                        candidates.pop()
                    } else {
                        if candidates.len() > 1 {
                            errors.push("ambiguous native test harness reports".into());
                        }
                        None
                    };
                    match cached_report {
                        Some(report) => {
                            harnesses.insert(bound[index].key.clone(), report.target.test);
                            reused += 1;
                            if artifact.selected {
                                requested.insert(selected.len());
                            }
                            selected_keys.push(unit_binding::report_key(
                                &bound[index].key,
                                report.target.test,
                            ));
                            selected.push(report);
                        }
                        None => {
                            eprintln!(
                                "Analysis cache miss: {} {}: {}",
                                artifact.package_id,
                                artifact.target.name,
                                if errors.is_empty() {
                                    "missing precise report".into()
                                } else {
                                    errors.join("; ")
                                }
                            );
                            missing.insert(artifact.package_id.clone());
                        }
                    }
                } else {
                    eprintln!(
                        "Analysis report mismatch: {} {} Cargo-profile-test={} fresh={} current={}",
                        artifact.package_id,
                        artifact.target.name,
                        artifact.cargo_profile_test,
                        artifact.fresh,
                        current.len()
                    );
                    missing.insert(artifact.package_id.clone());
                }
            }
            for (report, _) in reports.iter().flatten() {
                let owners: BTreeSet<_> = artifacts
                    .iter()
                    .filter(|artifact| artifact.matches_identity(report))
                    .map(|artifact| artifact.package_id.clone())
                    .collect();
                ensure!(
                    !owners.is_empty(),
                    "A compiler report has no Cargo unit: {} {}",
                    report.package,
                    report.target.name
                );
                missing.extend(owners);
            }
            for unit in &mut unit_index {
                if let Some(harness) = unit["key"].as_str().and_then(|key| harnesses.get(key)) {
                    unit["testHarness"] = serde_json::json!(harness);
                    unit["reportKey"] = serde_json::json!(unit_binding::report_key(
                        unit["key"].as_str().unwrap(),
                        *harness
                    ));
                }
            }
            fs::write(
                self.directory
                    .join(format!("{}-{attempt}.unit-index.json", package.name)),
                serde_json::to_vec(&unit_index)?,
            )?;
            binding_ms += binding_started.elapsed().as_millis();
            for (selected_index, path, proof, index) in pending {
                let report = &selected[selected_index];
                let key = unit_binding::report_key(&bound[index].key, report.target.test);
                let key = if report.analyzed {
                    key
                } else {
                    inputs_key(&key)
                };
                cache.store(&key, &path, report, proof)?;
            }
            if missing.is_empty() {
                let summary = serde_json::json!({"schemaVersion":2,"rule":rule,"configuration":configuration,"incremental":true,
                    "compiled":compiled,"reused":reused,"recovered":recovered.len(),"attempts":attempt+1,"requestedReports":requested.len(),
                    "cargoMs":cargo_ms,"bindingMs":binding_ms,"totalMs":started.elapsed().as_millis()});
                fs::write(
                    self.directory
                        .join(format!("{}-cache-summary.json", package.name)),
                    serde_json::to_vec_pretty(&summary)?,
                )?;
                eprintln!("Analysis cache: {summary}");
                return Ok(Compilation {
                    reports: ordered_reports(
                        selected_keys
                            .into_iter()
                            .zip(selected)
                            .enumerate()
                            .filter(|(index, _)| requested.contains(index))
                            .map(|(_, report)| report),
                    )?,
                    packages: metadata["packages"].clone(),
                    executable,
                    configuration,
                    environment_path: self.path.clone(),
                    summary,
                });
            }
            self.recover_packages(options, &missing, &mut recovered, &lock_root, &lock_digest)?;
        }
        unreachable!()
    }
}

// 原生 unit 与 harness 已在绑定阶段消歧；排序不使用运行路径或事实内容摘要。
fn ordered_reports(
    reports: impl IntoIterator<Item = (String, UnitReport)>,
) -> Result<Vec<UnitReport>> {
    let mut ordered = BTreeMap::new();
    for (key, report) in reports {
        ensure!(
            ordered.insert(key, report).is_none(),
            "Duplicate native compiler report identity"
        );
    }
    Ok(ordered.into_values().collect())
}

fn retained_report_matches(
    previous: &RetainedReport,
    sha256: &str,
    observations: &BTreeMap<String, serde_json::Value>,
) -> bool {
    previous.sha256 == sha256
        && !previous.observations.is_empty()
        && previous.observations == *observations
}

fn read_report(path: &Path) -> Result<UnitReport> {
    Ok(serde_json::from_reader(BufReader::new(fs::File::open(
        path,
    )?))?)
}

pub(crate) fn file_digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

struct NestedCheckOrder {
    indices: Vec<usize>,
    deferred: Vec<String>,
}

fn nested_package_ids(metadata: &serde_json::Value, manifests: &[String]) -> Result<Vec<String>> {
    let packages = metadata["packages"]
        .as_array()
        .context("Missing nested Cargo packages")?;
    manifests
        .iter()
        .map(|manifest| {
            let package = packages
                .iter()
                .find(|package| package["manifest_path"].as_str() == Some(manifest))
                .context("Nested check manifest is absent from Cargo metadata")?;
            Ok(package["id"]
                .as_str()
                .context("Missing nested Cargo package ID")?
                .to_owned())
        })
        .collect()
}

fn nested_check_order(
    selected: &[String],
    graphs: &[serde_json::Value],
) -> Result<NestedCheckOrder> {
    ensure!(
        selected.len() == graphs.len(),
        "Missing nested Cargo unit graph"
    );
    let mut dependencies = Vec::with_capacity(selected.len());
    for (package, graph) in selected.iter().zip(graphs) {
        let units = graph["units"]
            .as_array()
            .context("Missing nested Cargo units")?;
        let roots = graph["roots"]
            .as_array()
            .context("Missing nested Cargo roots")?;
        ensure!(!roots.is_empty(), "Nested Cargo unit graph has no roots");
        let mut required = BTreeSet::new();
        let mut pending = Vec::new();
        for root in roots {
            let index = root.as_u64().context("Invalid nested Cargo root")? as usize;
            let unit = units
                .get(index)
                .context("Nested Cargo root is out of range")?;
            ensure!(
                unit["pkg_id"].as_str() == Some(package.as_str()),
                "Nested Cargo graph belongs to a different package"
            );
            pending.push(index);
        }
        let mut visited = BTreeSet::new();
        while let Some(index) = pending.pop() {
            if !visited.insert(index) {
                continue;
            }
            let unit = units
                .get(index)
                .context("Nested Cargo dependency is out of range")?;
            let id = unit["pkg_id"]
                .as_str()
                .context("Missing nested Cargo unit package ID")?;
            if id != package.as_str()
                && let Some(index) = selected.iter().position(|selected| selected.as_str() == id)
            {
                required.insert(index);
            }
            for dependency in unit["dependencies"]
                .as_array()
                .context("Missing nested Cargo unit dependencies")?
            {
                pending.push(
                    dependency["index"]
                        .as_u64()
                        .context("Invalid nested Cargo dependency index")?
                        as usize,
                );
            }
        }
        dependencies.push(required);
    }
    let mut remaining: BTreeSet<_> = (0..selected.len()).collect();
    let mut indices = Vec::with_capacity(selected.len());
    while let Some(index) = remaining
        .iter()
        .copied()
        .find(|index| dependencies[*index].is_disjoint(&remaining))
    {
        remaining.remove(&index);
        indices.push(index);
    }
    // 包级 dev 边投影可能有环而实际 lib/test 单元仍合法；不据此拒绝原生 Cargo 构建。
    let deferred = remaining
        .iter()
        .map(|index| selected[*index].to_owned())
        .collect();
    indices.extend(remaining);
    Ok(NestedCheckOrder { indices, deferred })
}

fn order_nested_checks(checks: &[(Options, Host)]) -> Result<Vec<usize>> {
    let mut workspaces: BTreeMap<&Path, Vec<usize>> = BTreeMap::new();
    for (index, (_, host)) in checks.iter().enumerate() {
        workspaces.entry(&host.target_dir).or_default().push(index);
    }
    let mut indices: Vec<_> = (0..checks.len()).collect();
    for members in workspaces.values().filter(|members| members.len() > 1) {
        let (options, host) = &checks[members[0]];
        // metadata 只识别清单和 package ID；激活的 features、平台及 dev/build 边以各请求的原生单元图为准。
        let mut metadata = host.metadata(options, false)?;
        for package in metadata["packages"]
            .as_array_mut()
            .context("Missing nested Cargo packages")?
        {
            let manifest = package["manifest_path"]
                .as_str()
                .context("Missing nested Cargo manifest")?;
            package["manifest_path"] = serde_json::json!(normalized(Path::new(manifest))?);
        }
        let manifests: Vec<_> = members
            .iter()
            .map(|index| normalized(&checks[*index].0.root.join("Cargo.toml")))
            .collect::<std::io::Result<_>>()?;
        let selected = nested_package_ids(&metadata, &manifests)?;
        let mut graphs = Vec::with_capacity(members.len());
        for (index, package) in members.iter().zip(&selected) {
            let (options, host) = &checks[*index];
            let mut command = host.command("cargo");
            command.args([
                "check",
                "--locked",
                "-p",
                package,
                "--all-targets",
                "--unit-graph",
                "-Zunstable-options",
            ]);
            if let Some(target) = options
                .target
                .as_deref()
                .filter(|target| *target != host.host)
            {
                command.args(["--target", target]);
            }
            if !options.features.is_empty() {
                command.args(["--features", &options.features.join(",")]);
            }
            if options.all_features {
                command.arg("--all-features");
            }
            let output = command.output()?;
            ensure!(
                output.status.success(),
                "Nested Cargo ordering unit graph failed for {package}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            fs::write(
                host.directory.join("nested-order-unit-graph.json"),
                &output.stdout,
            )?;
            graphs.push(serde_json::from_slice(&output.stdout)?);
        }
        let order = nested_check_order(&selected, &graphs)?;
        if !order.deferred.is_empty() {
            eprintln!(
                "Nested check ordering retains original order for a dependency cycle and its dependents: {:?}",
                order.deferred
            );
        }
        for (slot, selected) in members.iter().zip(order.indices) {
            indices[*slot] = members[selected];
        }
    }
    Ok(indices)
}

/// 具名字段规则覆盖项目的全部 Cargo 目标，并检查工具自身的兼容入口。
pub fn check_named_fields(options: &Options) -> Result<named_fields::Report> {
    let host = Host::new(options, Rule::NamedFields)?;
    let directory = host
        .target_dir
        .parent()
        .context("Missing cache parent")?
        .to_path_buf();
    let mut locks = BTreeMap::from([(directory.clone(), AnalysisLock::acquire(&directory)?)]);
    let result = host.compile(options, Rule::NamedFields, true)?;
    let mut report = named_fields::Report {
        configuration: result.configuration,
        ..Default::default()
    };
    for unit in result.reports {
        report.compilations += 1;
        report.add(named_fields::Envelope {
            run: unit.run,
            configuration: unit.configuration,
            compiler: unit.compiler,
            target: unit.target,
            findings: unit.findings,
            failure: unit.failure,
        });
    }
    let mut nested_checks = Vec::new();
    for directory in ["contract", "compiler", "runner"] {
        let own = options.root.join("tools/rustc-analysis").join(directory);
        if !own.join("Cargo.toml").is_file() {
            continue;
        }
        let mut nested = Options::new(own);
        nested.driver = options.driver.clone();
        let nested_host = Host::new(&nested, Rule::NamedFields)?;
        let directory = nested_host
            .target_dir
            .parent()
            .context("Missing nested cache parent")?
            .to_path_buf();
        if !locks.contains_key(&directory) {
            locks.insert(directory.clone(), AnalysisLock::acquire(&directory)?);
        }
        nested_checks.push((nested, nested_host));
    }
    let order = order_nested_checks(&nested_checks)?;
    let mut nested_checks: Vec<_> = nested_checks.into_iter().map(Some).collect();
    for index in order {
        let (nested, nested_host) = nested_checks[index]
            .take()
            .expect("Each nested check is ordered once");
        let result = nested_host.compile(&nested, Rule::NamedFields, true)?;
        for unit in result.reports {
            report.compilations += 1;
            report.add(named_fields::Envelope {
                run: unit.run,
                configuration: unit.configuration,
                compiler: unit.compiler,
                target: unit.target,
                findings: unit.findings,
                failure: unit.failure,
            });
        }
    }
    Ok(report)
}

/// 实体规则只编译生产 lib/bin，夹具和游戏程序均不执行。
pub fn check_entity_names(options: &Options) -> Result<entity_names::Report> {
    let host = Host::new(options, Rule::EntityNames)?;
    let _lock = AnalysisLock::acquire(host.target_dir.parent().context("Missing cache parent")?)?;
    let result = host.compile(options, Rule::EntityNames, true)?;
    let mut report = entity_names::Report {
        configuration: result.configuration,
        ..Default::default()
    };
    for unit in result.reports {
        report.entities.extend(unit.entities.entities);
        report.diagnostics.extend(unit.entities.diagnostics);
    }
    Ok(report)
}

/// 构建带分析的真实应用，再只执行允许的 Schedule 专用导出入口。
pub fn extract(options: &Options, output: &Path) -> Result<()> {
    let mut selected = options.clone();
    if !selected
        .features
        .iter()
        .any(|feature| feature == "debugdump")
    {
        selected.features.push("debugdump".into());
    }
    let host = Host::new(&selected, Rule::Architecture)?;
    ensure!(
        selected
            .target
            .as_deref()
            .is_none_or(|target| target == host.host),
        "A runtime Schedule snapshot must be exported on its native target; cross-target checks do not execute binaries"
    );
    let _lock = AnalysisLock::acquire(host.target_dir.parent().context("Missing cache parent")?)?;
    let source_origins = host.source_origins()?;
    let result = host.compile(&selected, Rule::Architecture, true)?;
    publish_extraction(&host, source_origins, result, output)
}

fn publish_extraction(
    host: &Host,
    source_origins: Vec<serde_json::Value>,
    result: Compilation,
    output: &Path,
) -> Result<()> {
    fs::create_dir_all(output)?;
    let output = output.canonicalize()?;
    // 与输出同卷暂存，保留 --out 指向其他卷时的发布能力。
    let staging = output.join(format!(".extraction-{}", host.run));
    fs::create_dir(&staging)?;
    let debugdump = staging.join("debugdump");
    let executable = result
        .executable
        .context("Architecture extraction requires a production binary target")?;
    let status = Command::new(&executable)
        .current_dir(&host.root)
        .env("BEVY_ASSET_ROOT", &host.root)
        .env("PATH", &result.environment_path)
        .arg("--dump-schedules")
        .arg(&debugdump)
        .status()?;
    ensure!(status.success(), "Dedicated Schedule export failed");
    preserve_schedule_snapshot(&debugdump, &output)?;
    fs::copy(debugdump.join("runtime.json"), staging.join("runtime.json"))?;
    fs::write(
        staging.join("analysis-summary.json"),
        serde_json::to_vec_pretty(&result.summary)?,
    )?;
    let units = result
        .reports
        .into_iter()
        .map(|report| {
            report
                .facts
                .context("Selected architecture unit has no facts")
        })
        .collect::<Result<Vec<_>>>()?;
    let bundle = FactBundle {
        schema_version: 2,
        compiler: env!("ANALYSIS_COMPILER"),
        configuration: result.configuration,
        workspace: normalized(&host.root)?,
        packages: result.packages,
        source_origins,
        units,
        executable_sha256: file_digest(&executable)?,
        runtime_sha256: file_digest(&staging.join("runtime.json"))?,
    };
    let staged = staging.join("facts.json");
    let mut writer = BufWriter::with_capacity(1024 * 1024, fs::File::create(&staged)?);
    serde_json::to_writer(&mut writer, &bundle)?;
    writer.flush()?;
    drop(writer);
    publish_extraction_files(
        &staging,
        &output,
        &output.join(format!(".extraction-previous-{}", host.run)),
    )
}

fn read_schedule_snapshot(directory: &Path) -> Result<(serde_json::Value, Vec<u8>)> {
    ensure!(
        fs::symlink_metadata(directory)?.file_type().is_dir(),
        "Invalid Schedule export directory"
    );
    for name in ["manifest.json", "runtime.json"] {
        ensure!(
            fs::symlink_metadata(directory.join(name))?
                .file_type()
                .is_file(),
            "Missing or unsafe Schedule export file"
        );
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join("manifest.json"))?)?;
    let bytes = fs::read(directory.join("runtime.json"))?;
    let runtime: analysis_contract::runtime::RuntimeSnapshot = serde_json::from_slice(&bytes)?;
    ensure!(
        manifest["schemaVersion"] == 1
            && manifest["exportedAt"].as_u64().is_some()
            && [
                "bevyVersion",
                "debugdumpVersion",
                "target",
                "sourceFingerprint"
            ]
            .iter()
            .all(|field| manifest[*field]
                .as_str()
                .is_some_and(|value| !value.is_empty()))
            && runtime.schema_version == 1
            && manifest["sourceFingerprint"] == runtime.source_fingerprint
            && manifest["target"] == runtime.target
            && manifest["features"] == serde_json::to_value(&runtime.features)?
            && runtime
                .features
                .iter()
                .any(|feature| feature == "debugdump"),
        "Invalid Schedule export provenance"
    );
    let schedules = manifest["schedules"]
        .as_array()
        .context("Missing Schedule manifest entries")?;
    ensure!(
        schedules.len() == runtime.schedules.len(),
        "Schedule manifest/runtime count mismatch"
    );
    let mut ids = BTreeSet::new();
    for entry in schedules {
        let app = entry["app"].as_str().context("Missing Schedule app")?;
        let label = entry["label"].as_str().context("Missing Schedule label")?;
        let id = digest(format!("{app}\0{label}"));
        let id = &id[..16];
        ensure!(
            !app.is_empty() && !label.is_empty() && entry["id"] == id && ids.insert(id.to_owned()),
            "Invalid or duplicate Schedule identity"
        );
        let filename = entry["filename"]
            .as_str()
            .context("Missing Schedule DOT filename")?;
        ensure!(
            filename == format!("schedule-{id}.dot")
                || filename == format!("ecs-schedule-{id}.dot"),
            "Unsafe Schedule DOT filename"
        );
        let dot = directory.join(filename);
        ensure!(
            fs::symlink_metadata(&dot)?.file_type().is_file()
                && entry["sha256"] == file_digest(&dot)?,
            "Schedule DOT hash mismatch"
        );
        let matches = runtime
            .schedules
            .iter()
            .filter(|schedule| schedule.id == id)
            .collect::<Vec<_>>();
        ensure!(
            matches.len() == 1,
            "Missing or duplicate runtime Schedule identity"
        );
        let schedule = matches[0];
        ensure!(
            schedule.app == app
                && schedule.label == label
                && schedule.dot_filename == filename
                && entry["sha256"] == schedule.dot_sha256
                && entry["systemCount"].as_u64() == Some(schedule.systems.len() as u64),
            "Schedule manifest/runtime evidence mismatch"
        );
    }
    Ok((manifest, bytes))
}

// 真实导出始终执行；只有完整证据与旧发布原字节相符时才沿用旧清单及导出时间。
fn preserve_schedule_snapshot(staging: &Path, output: &Path) -> Result<()> {
    let (mut manifest, runtime) = read_schedule_snapshot(staging)?;
    let previous = output.join("debugdump");
    if let Ok((mut old_manifest, old_runtime)) = read_schedule_snapshot(&previous) {
        manifest.as_object_mut().unwrap().remove("exportedAt");
        old_manifest.as_object_mut().unwrap().remove("exportedAt");
        if manifest == old_manifest
            && runtime == old_runtime
            && fs::read(output.join("runtime.json")).is_ok_and(|bytes| bytes == old_runtime)
        {
            fs::copy(
                previous.join("manifest.json"),
                staging.join("manifest.json"),
            )?;
        }
    }
    Ok(())
}

// 新 facts 和 runtime 全部就绪后才替换；返回失败前恢复已移动的旧发布，避免混合配对。
fn publish_extraction_files(staging: &Path, output: &Path, backup: &Path) -> Result<()> {
    fs::create_dir(backup)?;
    let names = [
        "debugdump",
        "runtime.json",
        "analysis-summary.json",
        "facts.json",
    ];
    let mut previous = Vec::new();
    let mut installed = Vec::new();
    let publication = (|| -> Result<()> {
        for name in names {
            if output.join(name).exists() {
                fs::rename(output.join(name), backup.join(name))?;
                previous.push(name);
            }
            fs::rename(staging.join(name), output.join(name))?;
            installed.push(name);
        }
        Ok(())
    })();
    if let Err(error) = publication {
        for name in installed.into_iter().rev() {
            let filename = output.join(name);
            if filename.is_dir() {
                fs::remove_dir_all(&filename)?;
            } else {
                fs::remove_file(&filename)?;
            }
        }
        for name in previous.into_iter().rev() {
            fs::rename(backup.join(name), output.join(name))?;
        }
        return Err(error).context("Cannot publish extraction; restored the previous output");
    }
    fs::remove_dir_all(backup)
        .context("Extraction published but previous output cleanup failed")?;
    fs::remove_dir(staging).context("Extraction published but staging cleanup failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extraction_test_directory(name: &str) -> PathBuf {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests")
            .join(name)
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        directory.canonicalize().unwrap()
    }

    fn snapshot_fixture(directory: &Path, exported_at: u64, dot: &[u8]) {
        fs::create_dir_all(directory).unwrap();
        let id = digest("main\0Update")[..16].to_owned();
        let filename = format!("schedule-{id}.dot");
        let hash = digest(dot);
        let runtime = analysis_contract::runtime::RuntimeSnapshot {
            schema_version: 1,
            source_fingerprint: digest("source"),
            target: "test-target".into(),
            features: vec!["debugdump".into()],
            schedules: vec![analysis_contract::runtime::RuntimeSchedule {
                id: id.clone(),
                app: "main".into(),
                label: "Update".into(),
                type_id: "schedule-type".into(),
                dot_filename: filename.clone(),
                dot_sha256: hash.clone(),
                ..Default::default()
            }],
        };
        let manifest = serde_json::json!({"schemaVersion":1,"bevyVersion":"test-bevy","debugdumpVersion":"test-debugdump",
            "sourceFingerprint":runtime.source_fingerprint,"target":runtime.target,"features":runtime.features,
            "exportedAt":exported_at,"schedules":[{"id":id,"app":"main","label":"Update","filename":filename,"sha256":hash,"systemCount":0}]});
        fs::write(directory.join(filename), dot).unwrap();
        fs::write(
            directory.join("runtime.json"),
            serde_json::to_vec_pretty(&runtime).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    fn ordering_report(name: &str, run: &str, evidence: &str) -> UnitReport {
        UnitReport {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            rule: Rule::Architecture,
            analyzed: true,
            run: run.into(),
            configuration: "configuration".into(),
            compiler: "compiler".into(),
            target: named_fields::Target {
                source: format!("/source/{name}.rs"),
                name: name.into(),
                test: false,
            },
            manifest_dir: "/source".into(),
            package: name.into(),
            artifact_tag: name.into(),
            crate_types: vec!["rlib".into()],
            inputs: Default::default(),
            findings: vec![],
            entities: Default::default(),
            failure: None,
            facts: Some(analysis_contract::facts::UnitFacts {
                crate_name: name.into(),
                crate_identity: name.into(),
                source_files: vec![analysis_contract::facts::SourceFile {
                    path: format!("/source/{name}.rs"),
                    sha256: evidence.into(),
                }],
                ..Default::default()
            }),
        }
    }

    #[test]
    fn extraction_fact_order_uses_native_keys_and_keeps_changed_evidence() {
        let first = || {
            (
                unit_binding::report_key("native-a", false),
                ordering_report("a", "first-run", "original"),
            )
        };
        let second = || {
            (
                unit_binding::report_key("native-b", false),
                ordering_report("b", "second-run", "original"),
            )
        };
        let bytes = |reports| {
            let units = ordered_reports(reports)
                .unwrap()
                .into_iter()
                .map(|report| report.facts.unwrap())
                .collect::<Vec<_>>();
            serde_json::to_vec(&units).unwrap()
        };
        let baseline = bytes(vec![first(), second()]);
        assert_eq!(baseline, bytes(vec![second(), first()]));
        assert_eq!(
            baseline,
            bytes(vec![
                (
                    unit_binding::report_key("native-a", false),
                    ordering_report("a", "different-run", "original")
                ),
                second()
            ])
        );
        assert_ne!(
            baseline,
            bytes(vec![
                (
                    unit_binding::report_key("native-a", false),
                    ordering_report("a", "first-run", "changed")
                ),
                second()
            ])
        );
        assert!(ordered_reports(vec![first(), first()]).is_err());
        assert_ne!(
            unit_binding::report_key("native-a", false),
            unit_binding::report_key("native-a", true)
        );
    }

    #[test]
    fn extraction_snapshot_reuses_original_manifest_bytes_only_for_matching_evidence() {
        for change in [
            "none",
            "empty",
            "dot",
            "runtime",
            "runtime-whitespace",
            "manifest",
            "target",
            "features",
            "sourceFingerprint",
            "old-root-runtime",
            "old-dot",
            "old-manifest",
        ] {
            let directory = extraction_test_directory(change);
            let output = directory.join("output");
            let old = output.join("debugdump");
            let staging = directory.join("staging");
            snapshot_fixture(&old, 1, b"digraph { original }");
            fs::copy(old.join("runtime.json"), output.join("runtime.json")).unwrap();
            snapshot_fixture(
                &staging,
                2,
                if change == "dot" {
                    b"digraph { modified }"
                } else {
                    b"digraph { original }"
                },
            );
            match change {
                "empty" => {
                    for root in [&old, &staging] {
                        for name in ["manifest.json", "runtime.json"] {
                            let filename = root.join(name);
                            let mut snapshot: serde_json::Value =
                                serde_json::from_slice(&fs::read(&filename).unwrap()).unwrap();
                            snapshot["schedules"] = serde_json::json!([]);
                            fs::write(filename, serde_json::to_vec_pretty(&snapshot).unwrap())
                                .unwrap();
                        }
                    }
                    fs::copy(old.join("runtime.json"), output.join("runtime.json")).unwrap();
                }
                "runtime" => {
                    let filename = staging.join("runtime.json");
                    let mut value: serde_json::Value =
                        serde_json::from_slice(&fs::read(&filename).unwrap()).unwrap();
                    value["schedules"][0]["typeId"] = serde_json::json!("changed-type");
                    fs::write(filename, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
                }
                "runtime-whitespace" => {
                    let filename = staging.join("runtime.json");
                    let mut bytes = fs::read(&filename).unwrap();
                    bytes.push(b'\n');
                    fs::write(filename, bytes).unwrap();
                }
                "manifest" => {
                    let filename = staging.join("manifest.json");
                    let mut value: serde_json::Value =
                        serde_json::from_slice(&fs::read(&filename).unwrap()).unwrap();
                    value["additionalEvidence"] = serde_json::json!({"new":true});
                    fs::write(filename, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
                }
                "target" | "features" | "sourceFingerprint" => {
                    let value = match change {
                        "target" => serde_json::json!("changed-target"),
                        "features" => serde_json::json!(["debugdump", "extra"]),
                        _ => serde_json::json!(digest("changed source")),
                    };
                    for name in ["manifest.json", "runtime.json"] {
                        let filename = staging.join(name);
                        let mut snapshot: serde_json::Value =
                            serde_json::from_slice(&fs::read(&filename).unwrap()).unwrap();
                        snapshot[change] = value.clone();
                        fs::write(filename, serde_json::to_vec_pretty(&snapshot).unwrap()).unwrap();
                    }
                }
                "old-root-runtime" => {
                    fs::write(output.join("runtime.json"), b"damaged").unwrap();
                }
                "old-dot" => {
                    fs::write(
                        old.join(format!("schedule-{}.dot", &digest("main\0Update")[..16])),
                        b"damaged",
                    )
                    .unwrap();
                }
                "old-manifest" => {
                    fs::write(old.join("manifest.json"), b"damaged").unwrap();
                }
                _ => {}
            }
            let original = fs::read(old.join("manifest.json")).unwrap();
            let before = fs::read(staging.join("manifest.json")).unwrap();
            preserve_schedule_snapshot(&staging, &output).unwrap();
            let after = fs::read(staging.join("manifest.json")).unwrap();
            assert_eq!(
                after,
                if ["none", "empty"].contains(&change) {
                    original
                } else {
                    before
                },
                "{change}"
            );
            assert!(read_schedule_snapshot(&staging).is_ok(), "{change}");
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn extraction_snapshot_rejects_new_corruption_without_changing_published_bytes() {
        for name in ["manifest.json", "runtime.json", "dot"] {
            let directory = extraction_test_directory(name);
            let output = directory.join("output");
            let old = output.join("debugdump");
            let staging = directory.join("staging");
            snapshot_fixture(&old, 1, b"digraph {}");
            fs::copy(old.join("runtime.json"), output.join("runtime.json")).unwrap();
            snapshot_fixture(&staging, 2, b"digraph {}");
            let before = fs::read(old.join("manifest.json")).unwrap();
            let filename = if name == "dot" {
                format!("schedule-{}.dot", &digest("main\0Update")[..16])
            } else {
                name.into()
            };
            fs::write(staging.join(filename), b"damaged").unwrap();
            assert!(preserve_schedule_snapshot(&staging, &output).is_err());
            assert_eq!(fs::read(old.join("manifest.json")).unwrap(), before);
            assert!(read_schedule_snapshot(&old).is_ok());
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn extraction_publication_rolls_back_all_four_outputs_after_partial_failure() {
        let directory = extraction_test_directory("publication");
        let output = directory.join("output");
        let staging = directory.join("staging");
        snapshot_fixture(&output.join("debugdump"), 1, b"digraph { old }");
        snapshot_fixture(&staging.join("debugdump"), 2, b"digraph { new }");
        for root in [&output, &staging] {
            let runtime = fs::read(root.join("debugdump/runtime.json")).unwrap();
            fs::write(root.join("runtime.json"), &runtime).unwrap();
            fs::write(
                root.join("facts.json"),
                serde_json::to_vec(&serde_json::json!({"runtimeSha256":digest(runtime)})).unwrap(),
            )
            .unwrap();
            fs::write(root.join("analysis-summary.json"), b"summary").unwrap();
        }
        let files = [
            "debugdump/manifest.json",
            "debugdump/runtime.json",
            "runtime.json",
            "facts.json",
            "analysis-summary.json",
        ];
        let before = files.map(|name| fs::read(output.join(name)).unwrap());
        fs::remove_file(staging.join("facts.json")).unwrap();
        assert!(publish_extraction_files(&staging, &output, &directory.join("backup")).is_err());
        assert_eq!(
            files.map(|name| fs::read(output.join(name)).unwrap()),
            before
        );
        assert!(read_schedule_snapshot(&output.join("debugdump")).is_ok());
        snapshot_fixture(&staging.join("debugdump"), 2, b"digraph { new }");
        let runtime = fs::read(staging.join("debugdump/runtime.json")).unwrap();
        fs::write(staging.join("runtime.json"), &runtime).unwrap();
        fs::write(
            staging.join("facts.json"),
            serde_json::to_vec(&serde_json::json!({"runtimeSha256":digest(&runtime)})).unwrap(),
        )
        .unwrap();
        fs::write(staging.join("analysis-summary.json"), b"new summary").unwrap();
        publish_extraction_files(&staging, &output, &directory.join("success-backup")).unwrap();
        assert!(!staging.exists());
        assert!(!directory.join("success-backup").exists());
        let facts: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join("facts.json")).unwrap()).unwrap();
        assert_eq!(
            facts["runtimeSha256"],
            file_digest(&output.join("runtime.json")).unwrap()
        );
        assert_eq!(fs::read(output.join("runtime.json")).unwrap(), runtime);
        assert_eq!(
            read_schedule_snapshot(&output.join("debugdump")).unwrap().0["exportedAt"],
            2
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn extraction_failed_real_export_preserves_published_output() {
        let directory = extraction_test_directory("export-failure");
        let output = directory.join("output");
        snapshot_fixture(&output.join("debugdump"), 1, b"digraph {}");
        fs::copy(
            output.join("debugdump/runtime.json"),
            output.join("runtime.json"),
        )
        .unwrap();
        fs::write(output.join("facts.json"), b"previous facts").unwrap();
        let before = fs::read(output.join("debugdump/manifest.json")).unwrap();
        let run = directory.join("run");
        fs::create_dir(&run).unwrap();
        let host = Host {
            root: directory.clone(),
            cache: directory.clone(),
            directory: run,
            target_dir: directory.clone(),
            build_dir: directory.clone(),
            sysroot: directory.clone(),
            compiler_release: "test".into(),
            driver: PathBuf::new(),
            path: env::var_os("PATH").unwrap_or_default(),
            host: "test".into(),
            run: "test".into(),
        };
        // Rust 测试程序不接受 --dump-schedules，真实子进程以非零状态退出。
        let result = Compilation {
            reports: vec![],
            packages: serde_json::json!([]),
            executable: Some(env::current_exe().unwrap()),
            configuration: "test".into(),
            environment_path: host.path.clone(),
            summary: serde_json::json!({}),
        };
        assert!(publish_extraction(&host, vec![], result, &output).is_err());
        assert_eq!(
            fs::read(output.join("debugdump/manifest.json")).unwrap(),
            before
        );
        assert_eq!(
            fs::read(output.join("facts.json")).unwrap(),
            b"previous facts"
        );
        assert_eq!(
            fs::read(output.join("runtime.json")).unwrap(),
            fs::read(output.join("debugdump/runtime.json")).unwrap()
        );
        fs::remove_dir_all(directory).unwrap();
    }

    fn nested_metadata(packages: &[(&str, &str)]) -> serde_json::Value {
        serde_json::json!({"packages": packages.iter().map(|(id, manifest)| serde_json::json!({
            "id": id, "name": "same_name", "manifest_path": manifest,
        })).collect::<Vec<_>>()})
    }

    fn nested_graph(
        packages: &[&str],
        roots: &[usize],
        dependencies: &[(usize, usize)],
    ) -> serde_json::Value {
        serde_json::json!({
            "roots": roots,
            "units": packages.iter().enumerate().map(|(index, id)| serde_json::json!({
                "pkg_id": id,
                "dependencies": dependencies.iter().filter(|(from, _)| *from == index).map(|(_, to)| {
                    serde_json::json!({"index": to})
                }).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn nested_checks_follow_either_native_dependency_direction() {
        let packages = [
            ("contract-id", "/contract/Cargo.toml"),
            ("compiler-id", "/compiler/Cargo.toml"),
            ("runner-id", "/runner/Cargo.toml"),
        ];
        let manifests = packages
            .iter()
            .map(|(_, path)| path.to_string())
            .collect::<Vec<_>>();
        let mut metadata = nested_metadata(&packages);
        let selected = nested_package_ids(&metadata, &manifests).unwrap();
        let forward = vec![
            nested_graph(&["contract-id"], &[0], &[]),
            nested_graph(&["compiler-id", "contract-id"], &[0], &[(0, 1)]),
            nested_graph(
                &["runner-id", "compiler-id", "contract-id"],
                &[0],
                &[(0, 1), (1, 2)],
            ),
        ];
        assert_eq!(
            nested_check_order(&selected, &forward).unwrap().indices,
            [0, 1, 2]
        );
        let reverse = vec![
            nested_graph(&["contract-id"], &[0], &[]),
            nested_graph(
                &["contract-id", "runner-id", "compiler-id"],
                &[2],
                &[(2, 1), (1, 0)],
            ),
            nested_graph(&["runner-id", "contract-id"], &[0], &[(0, 1)]),
        ];
        assert_eq!(
            nested_check_order(&selected, &reverse).unwrap().indices,
            [0, 2, 1]
        );
        metadata["packages"].as_array_mut().unwrap().reverse();
        let selected = nested_package_ids(&metadata, &manifests).unwrap();
        assert_eq!(
            nested_check_order(&selected, &reverse).unwrap().indices,
            [0, 2, 1]
        );
    }

    #[test]
    fn nested_checks_project_reachable_normal_test_and_build_units() {
        let selected = vec![
            "compiler-id".into(),
            "runner-id".into(),
            "contract-id".into(),
        ];
        let graphs = vec![
            nested_graph(
                &["compiler-id", "compiler-id", "runner-id", "contract-id"],
                &[0, 1],
                &[(0, 3), (1, 2), (2, 3)],
            ),
            nested_graph(
                &["runner-id", "runner-id", "contract-id"],
                &[0],
                &[(0, 1), (1, 2)],
            ),
            nested_graph(&["contract-id"], &[0], &[]),
        ];
        assert_eq!(
            nested_check_order(&selected, &graphs).unwrap().indices,
            [2, 1, 0]
        );
    }

    #[test]
    fn nested_checks_bind_same_named_packages_by_manifest_and_native_id() {
        let packages = [
            ("source-b#same@1.0.0", "/source-b/Cargo.toml"),
            ("source-a#same@1.0.0", "/source-a/Cargo.toml"),
            ("consumer-id", "/consumer/Cargo.toml"),
        ];
        let metadata = nested_metadata(&packages);
        let manifests = packages
            .iter()
            .map(|(_, path)| path.to_string())
            .collect::<Vec<_>>();
        let selected = nested_package_ids(&metadata, &manifests).unwrap();
        let graphs = vec![
            nested_graph(
                &["source-b#same@1.0.0", "consumer-id", "source-a#same@1.0.0"],
                &[0],
                &[(0, 1), (1, 2)],
            ),
            nested_graph(&["source-a#same@1.0.0"], &[0], &[]),
            nested_graph(&["consumer-id", "source-a#same@1.0.0"], &[0], &[(0, 1)]),
        ];
        assert_eq!(
            nested_check_order(&selected, &graphs).unwrap().indices,
            [1, 2, 0]
        );
    }

    #[test]
    fn nested_checks_only_follow_units_reachable_from_native_roots() {
        let selected = vec!["consumer-id".into(), "producer-id".into()];
        let mut graphs = vec![
            nested_graph(
                &["consumer-id", "producer-id", "unrelated-id"],
                &[0],
                &[(2, 1)],
            ),
            nested_graph(&["producer-id"], &[0], &[]),
        ];
        assert_eq!(
            nested_check_order(&selected, &graphs).unwrap().indices,
            [0, 1]
        );
        graphs[0]["units"][0]["dependencies"] = serde_json::json!([{"index": 2}]);
        assert_eq!(
            nested_check_order(&selected, &graphs).unwrap().indices,
            [1, 0]
        );
        graphs[0]["roots"] = serde_json::json!([1]);
        assert!(nested_check_order(&selected, &graphs).is_err());
    }

    #[test]
    fn nested_check_cycles_retain_the_remaining_original_order() {
        let selected = vec![
            "contract-id".into(),
            "compiler-id".into(),
            "runner-id".into(),
            "independent-id".into(),
            "downstream-id".into(),
        ];
        let graphs = vec![
            nested_graph(&["contract-id"], &[0], &[]),
            nested_graph(
                &["compiler-id", "runner-id", "compiler-id"],
                &[0],
                &[(0, 1), (1, 2)],
            ),
            nested_graph(&["runner-id", "compiler-id"], &[0], &[(0, 1)]),
            nested_graph(&["independent-id"], &[0], &[]),
            nested_graph(&["downstream-id", "compiler-id"], &[0], &[(0, 1)]),
        ];
        let order = nested_check_order(&selected, &graphs).unwrap();
        assert_eq!(order.indices, [0, 3, 1, 2, 4]);
        assert_eq!(
            order.deferred,
            ["compiler-id", "runner-id", "downstream-id"]
        );
    }

    #[test]
    fn same_run_retention_requires_original_report_and_input_observations() {
        let observations = BTreeMap::from([
            (
                "class-a".into(),
                serde_json::json!({"binaries":{"dep.rlib":"old"}}),
            ),
            (
                "class-b".into(),
                serde_json::json!({"binaries":{"dep.rlib":"old"}}),
            ),
        ]);
        let previous = RetainedReport {
            sha256: "raw-report".into(),
            observations: observations.clone(),
        };
        assert!(retained_report_matches(
            &previous,
            "raw-report",
            &observations
        ));
        assert!(!retained_report_matches(
            &previous,
            "replaced-report",
            &observations
        ));
        let mut changed = observations.clone();
        changed.get_mut("class-a").unwrap()["binaries"]["dep.rlib"] = serde_json::json!("rebuilt");
        assert!(!retained_report_matches(&previous, "raw-report", &changed));
        changed.remove("class-a");
        assert!(!retained_report_matches(&previous, "raw-report", &changed));
        let incomplete = RetainedReport {
            sha256: "raw-report".into(),
            observations: BTreeMap::new(),
        };
        assert!(!retained_report_matches(
            &incomplete,
            "raw-report",
            &BTreeMap::new()
        ));
    }

    #[test]
    fn cached_input_precheck_does_not_replace_the_complete_dependency_proof() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/precheck")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let path = directory.join(name);
            fs::write(&path, bytes).unwrap();
            normalized(&path).unwrap()
        };
        let source = write("lib.rs", b"pub fn unchanged() {}\n");
        let output = write("libfixture.rlib", b"compiled artifact");
        let dep_info = write("fixture.d", b"native dep-info");
        let report = UnitReport {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            rule: Rule::NamedFields,
            analyzed: true,
            run: "producer".into(),
            configuration: "configuration".into(),
            compiler: "compiler".into(),
            target: named_fields::Target {
                source: source.clone(),
                name: "fixture".into(),
                test: false,
            },
            manifest_dir: normalized(&directory).unwrap(),
            package: "fixture".into(),
            artifact_tag: "".into(),
            crate_types: vec!["rlib".into()],
            inputs: analysis_contract::UnitInputs {
                complete: true,
                files: vec![analysis_contract::InputFile {
                    path: source.clone(),
                    sha256: file_digest(Path::new(&source)).unwrap(),
                }],
                dep_info: Some(analysis_contract::InputFile {
                    path: dep_info.clone(),
                    sha256: file_digest(Path::new(&dep_info)).unwrap(),
                }),
                outputs: vec![output.clone()],
                ..Default::default()
            },
            findings: vec![],
            entities: entity_names::Report::default(),
            facts: None,
            failure: None,
        };
        let artifact = Artifact {
            package_id: "fixture".into(),
            target: ArtifactTarget {
                source,
                name: "fixture".into(),
            },
            cargo_profile_test: false,
            filenames: vec![output.clone()],
            fresh: true,
            manifest_dir: report.manifest_dir.clone(),
            crate_types: vec!["lib".into()],
            executable: None,
            profile: serde_json::json!({"test":false}),
            features: vec![],
            mode: "build".into(),
            metadata: serde_json::json!({}),
            selected: true,
        };
        let artifacts = vec![artifact];
        let bound = vec![unit_binding::BoundUnit {
            key: "unit".into(),
            graph: crate::unit_graph::GraphBinding {
                class: "class".into(),
                dependency_classes: BTreeSet::new(),
                build_script_packages: BTreeSet::new(),
                direct_dependencies: BTreeMap::new(),
                required_rust_extern_names: BTreeSet::new(),
            },
        }];
        let scripts = BTreeMap::new();
        let environment = BTreeMap::new();
        let configured = BTreeSet::new();
        let mut hashes = Hashes::default();
        let proof = unit_binding::proof(
            0,
            &report,
            &artifacts,
            &bound,
            &scripts,
            &directory,
            &environment,
            &configured,
            &mut hashes,
        )
        .unwrap();
        let precheck = |candidate: &serde_json::Value, hashes: &mut Hashes| {
            unit_binding::precheck_cached(
                0,
                &report,
                candidate,
                &artifacts,
                &bound[0],
                &scripts,
                &directory,
                &environment,
                &configured,
                hashes,
            )
        };
        let mut stale = proof.clone();
        stale["dependencies"] = serde_json::json!({"old-dependency":{"artifact":"old"}});
        assert!(precheck(&stale, &mut hashes).is_ok());
        assert_ne!(
            proof, stale,
            "The host must compare the complete proof after choosing every dependency class"
        );
        let mut damaged = proof.clone();
        damaged["artifact"][&output] = serde_json::json!("damaged");
        assert!(precheck(&damaged, &mut hashes).is_err());
        fs::write(&artifacts[0].target.source, b"pub fn changed() {}\n").unwrap();
        assert!(precheck(&proof, &mut Hashes::default()).is_err());
    }

    #[test]
    fn public_executables_do_not_take_hashed_test_or_custom_bench_reports() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/harness-binding")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let output = |name: &str| {
            let path = directory.join(format!("{name}{}", env::consts::EXE_SUFFIX));
            fs::write(&path, b"identical executable bytes").unwrap();
            normalized(&path).unwrap()
        };
        let public = output("demo");
        let normal = output("demo-normal");
        let tested = output("demo-test");
        let bench = output("demo-bench");
        let artifact = |filename: &str, test: bool| Artifact {
            package_id: "fixture".into(),
            target: ArtifactTarget {
                source: "/fixture/main.rs".into(),
                name: "demo".into(),
            },
            cargo_profile_test: test,
            filenames: vec![filename.into()],
            fresh: true,
            manifest_dir: "/fixture".into(),
            crate_types: vec!["bin".into()],
            executable: Some(filename.into()),
            profile: serde_json::json!({"test":test}),
            features: vec![],
            mode: "build".into(),
            metadata: serde_json::json!({}),
            selected: true,
        };
        let report = |filename: &str, tag: &str, harness: bool| UnitReport {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            rule: Rule::NamedFields,
            analyzed: true,
            run: "producer".into(),
            configuration: "configuration".into(),
            compiler: "compiler".into(),
            target: named_fields::Target {
                source: "/fixture/main.rs".into(),
                name: "demo".into(),
                test: harness,
            },
            manifest_dir: "/fixture".into(),
            package: "fixture".into(),
            artifact_tag: tag.into(),
            crate_types: vec!["bin".into()],
            inputs: analysis_contract::UnitInputs {
                outputs: vec![filename.into()],
                cfg: vec![("test".into(), None)],
                ..Default::default()
            },
            findings: vec![],
            entities: entity_names::Report::default(),
            facts: None,
            failure: None,
        };
        let artifacts = vec![
            artifact(&public, false),
            artifact(&tested, true),
            artifact(&bench, true),
        ];
        let mut hashes = Hashes::default();
        assert_eq!(
            report_owners(&artifacts, &report(&normal, "-normal", false), &mut hashes).unwrap(),
            vec![0]
        );
        assert_eq!(
            report_owners(&artifacts, &report(&tested, "-test", true), &mut hashes).unwrap(),
            vec![1]
        );
        assert_eq!(
            report_owners(&artifacts, &report(&bench, "-bench", false), &mut hashes).unwrap(),
            vec![2]
        );
        let reversed: Vec<_> = artifacts.into_iter().rev().collect();
        assert_eq!(
            report_owners(&reversed, &report(&normal, "-normal", false), &mut hashes).unwrap(),
            vec![2]
        );
        assert_eq!(
            report_owners(&reversed, &report(&bench, "-bench", false), &mut hashes).unwrap(),
            vec![0]
        );
        // 完全相同的公开产物无法证明唯一拥有者，不能选择数组中的第一项。
        let ambiguous = vec![artifact(&public, false), artifact(&public, true)];
        assert_eq!(
            report_owners(&ambiguous, &report(&normal, "-normal", false), &mut hashes).unwrap(),
            vec![0, 1]
        );
    }

    #[test]
    fn package_origins_exclude_unpublished_auxiliary_targets() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/package-origins")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let library = directory.join("lib.rs");
        fs::write(&library, b"pub struct Published;").unwrap();
        let example = directory.join("benches/benchmark.rs");
        let test = directory.join("tests/serde.rs");
        let metadata = serde_json::json!({
            "workspace_root": directory,
            "packages": [{
                "name": "published",
                "version": "1.0.0",
                "manifest_path": directory.join("Cargo.toml"),
                "targets": [
                    {"src_path": library, "name": "published", "kind": ["lib"]},
                    {"src_path": example, "name": "benchmark", "kind": ["example"]},
                    {"src_path": test, "name": "serde", "kind": ["test"]}
                ]
            }]
        });
        let origins = package_origins(&metadata).unwrap();
        assert_eq!(origins.len(), 1);
        assert_eq!(origins[0].targets.len(), 1);
        assert_eq!(origins[0].targets[0].source, normalized(&library).unwrap());
        let mut missing_library = metadata.clone();
        missing_library["packages"][0]["targets"][0]["src_path"] =
            serde_json::json!(directory.join("missing.rs"));
        assert!(package_origins(&missing_library).is_err());
        let mut relative_example = metadata;
        relative_example["packages"][0]["targets"][1]["src_path"] =
            serde_json::json!("benches/benchmark.rs");
        assert!(package_origins(&relative_example).is_err());
    }
}

//! Cargo 编译单元与分析报告共同构成成功条件；缓存只复用内容仍匹配的依赖事实。
use analysis_contract::{
    PackageOrigin, PackageTargetOrigin, Request, Rule, UnitReport, entity_names, named_fields,
    normalized,
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
    time::{SystemTime, UNIX_EPOCH},
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
struct Artifact {
    package_id: String,
    target: named_fields::Target,
    filenames: Vec<String>,
    fresh: bool,
    manifest_dir: String,
    crate_types: Vec<String>,
    executable: Option<PathBuf>,
}
impl Artifact {
    fn matches_report(&self, report: &UnitReport) -> bool {
        if self.target != report.target
            || self.manifest_dir != report.manifest_dir
            || self.crate_types.iter().collect::<BTreeSet<_>>()
                != report.crate_types.iter().collect::<BTreeSet<_>>()
        {
            return false;
        }
        // Cargo 对外发布的可执行文件不带 extra-filename；使用完整编译目标及 crate 种类区分同源库。
        if self.crate_types.iter().any(|kind| kind == "bin")
            && self.executable.as_ref().is_some_and(|executable| {
                self.filenames
                    .iter()
                    .any(|filename| Path::new(filename) == executable)
            })
        {
            return true;
        }
        !report.artifact_tag.is_empty()
            && self
                .filenames
                .iter()
                .any(|filename| filename.contains(&report.artifact_tag))
    }
}

fn report_cache_key(
    target: &named_fields::Target,
    manifest_dir: &str,
    artifact_tag: &str,
    crate_types: &[String],
) -> Result<String> {
    Ok(digest(serde_json::to_vec(&(
        target,
        manifest_dir,
        artifact_tag,
        crate_types.iter().collect::<BTreeSet<_>>(),
    ))?))
}

impl Artifact {
    fn cache_paths(&self, directory: &Path) -> Result<Vec<PathBuf>> {
        let tags: BTreeSet<_> = self
            .filenames
            .iter()
            .filter_map(|filename| {
                let stem = Path::new(filename).file_stem()?.to_str()?;
                let (_, hash) = stem.rsplit_once('-')?;
                (hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
                    .then(|| format!("-{hash}"))
            })
            .collect();
        tags.into_iter()
            .map(|tag| {
                Ok(directory.join(format!(
                    "{}.json",
                    report_cache_key(&self.target, &self.manifest_dir, &tag, &self.crate_types)?
                )))
            })
            .collect()
    }
}

struct Compilation {
    reports: Vec<UnitReport>,
    packages: serde_json::Value,
    executable: Option<PathBuf>,
    configuration: String,
    environment_path: OsString,
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

fn digest(bytes: impl AsRef<[u8]>) -> String {
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
        let analysis = cache.join(&env!("ANALYSIS_COMPILER")[..12]).join(mode);
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
            .env("CARGO_INCREMENTAL", "0")
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

    fn compile(&self, options: &Options, rule: Rule, full_metadata: bool) -> Result<Compilation> {
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
        let configuration = digest(serde_json::to_vec(&serde_json::json!({
            "workspace": normalized(&self.root)?, "target": options.target.as_deref().unwrap_or(&self.host),
            "features": options.features, "allFeatures": options.all_features, "rule": rule,
            "compiler": env!("ANALYSIS_COMPILER"), "driver": digest(fs::read(&self.driver)?),
            "lock": digest(fs::read(lock_root.join("Cargo.lock"))?),
            "rustflags": env::var_os("RUSTFLAGS"), "encodedRustflags": env::var_os("CARGO_ENCODED_RUSTFLAGS"),
        }))?);
        let request = Request {
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
                .env("ANALYSIS_REPORTS", &reports_dir)
                .env("ANALYSIS_SYSROOT", &self.sysroot)
                .env("RUSTC_WORKSPACE_WRAPPER", &self.driver)
                .env("NAMED_FIELDS_REPORTS", &reports_dir)
                .env("NAMED_FIELDS_REQUEST", &request_path)
                .env("ENTITY_NAME_RUN", &request.run)
                .env("ENTITY_NAME_CONFIGURATION", &request.configuration)
                .env("ENTITY_NAME_REPORTS", &reports_dir);
            if rule != Rule::NamedFields {
                command.env("RUSTC_WRAPPER", &self.driver);
            }
        };
        let cache_directory = self.cache.join("u").join(&configuration);
        fs::create_dir_all(&cache_directory)?;
        let mut has_reports = false;
        for entry in fs::read_dir(&cache_directory)? {
            if entry?
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                has_reports = true;
                break;
            }
        }
        let empty_architecture_cache = rule == Rule::Architecture && !has_reports;
        // 新配置没有可复用的事实时先清理专属编译缓存，避免重编根包后才发现依赖报告缺失。
        let analysis_directory = self
            .target_dir
            .parent()
            .context("Analysis target has no parent")?
            .canonicalize()?;
        ensure!(
            analysis_directory.starts_with(&self.cache),
            "Analysis directory escaped the dedicated cache"
        );
        for directory in [&self.target_dir, &self.build_dir] {
            let resolved = directory.canonicalize()?;
            ensure!(
                resolved.starts_with(&analysis_directory) && resolved != analysis_directory,
                "Cargo clean escaped its dedicated analysis directories"
            );
        }
        let mut clean = self.command("cargo");
        clean.args(["clean", "--quiet"]);
        if empty_architecture_cache {
            eprintln!(
                "No architecture reports for this configuration; invalidating the dedicated Cargo analysis cache before compilation"
            );
        } else {
            // 其他情况只清理目标包，依赖继续使用已验证的报告。
            clean.args(["-p", &package.name]);
        }
        if let Some(target) = options
            .target
            .as_deref()
            .filter(|target| *target != self.host)
        {
            clean.args(["--target", target]);
        }
        ensure!(
            clean.status()?.success(),
            "Cannot invalidate the dedicated analysis cache"
        );
        let mut last_missing = BTreeSet::new();
        for attempt in 0..2 {
            let mut cargo = self.command("cargo");
            configure(&mut cargo);
            cargo.args([
                if rule == Rule::Architecture {
                    "build"
                } else {
                    "check"
                },
                "--locked",
                "--message-format=json",
                "-p",
                &package.id,
            ]);
            if all_targets {
                cargo.arg("--all-targets");
            } else {
                if targets
                    .iter()
                    .any(|target| target.kind.iter().any(|kind| kind == "lib"))
                {
                    cargo.arg("--lib");
                }
                if targets
                    .iter()
                    .any(|target| target.kind.iter().any(|kind| kind == "bin"))
                {
                    cargo.arg("--bins");
                }
            }
            if let Some(target) = options
                .target
                .as_deref()
                .filter(|target| *target != self.host)
            {
                cargo.args(["--target", target]);
            }
            if !options.features.is_empty() {
                cargo.args(["--features", &options.features.join(",")]);
            }
            if options.all_features {
                cargo.arg("--all-features");
            }
            let output = cargo.output()?;
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
            let mut artifacts = vec![];
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
                if value["reason"] != "compiler-artifact" {
                    continue;
                }
                let id = value["package_id"]
                    .as_str()
                    .context("Missing artifact package")?;
                if rule != Rule::Architecture && id != package.id {
                    continue;
                }
                if rule == Rule::Architecture
                    && value["target"]["kind"]
                        .as_array()
                        .is_some_and(|kind| kind.iter().any(|kind| kind == "custom-build"))
                {
                    continue;
                }
                let source = normalized(Path::new(
                    value["target"]["src_path"]
                        .as_str()
                        .context("Missing target source")?,
                ))?;
                // Cargo 也返回构建脚本 artifact；报告覆盖范围仍以本次选中源码为准。
                if rule != Rule::Architecture && !request.sources.contains(&source) {
                    continue;
                }
                let filenames: Vec<String> = serde_json::from_value(value["filenames"].clone())?;
                if !seen.insert(filenames.clone()) {
                    continue;
                }
                if id == package.id
                    && let Some(binary) = value["executable"].as_str()
                {
                    executable = Some(PathBuf::from(binary));
                }
                artifacts.push(Artifact {
                    package_id: id.into(),
                    target: named_fields::Target {
                        source,
                        name: value["target"]["name"]
                            .as_str()
                            .context("Missing target name")?
                            .replace('-', "_"),
                        test: value["profile"]["test"]
                            .as_bool()
                            .context("Missing target test mode")?,
                    },
                    filenames,
                    fresh: value["fresh"].as_bool().unwrap_or(false),
                    manifest_dir: normalized(
                        packages
                            .iter()
                            .find(|package| package.id == id)
                            .context("Unknown Cargo artifact package")?
                            .manifest_path
                            .parent()
                            .context("Package manifest has no parent")?,
                    )?,
                    crate_types: serde_json::from_value(value["target"]["crate_types"].clone())?,
                    executable: value["executable"].as_str().map(PathBuf::from),
                });
            }
            ensure!(
                output.status.success(),
                "Cargo compilation or rustc driver failed for {}",
                package.name
            );
            ensure!(
                !artifacts.is_empty(),
                "No compilation targets were checked for {}",
                package.name
            );
            let mut reports = vec![];
            for entry in fs::read_dir(&reports_dir)? {
                let path = entry?.path();
                if path.extension().is_none_or(|extension| extension != "json") {
                    continue;
                }
                let report: UnitReport = read_report(&path).with_context(|| match rule {
                    Rule::EntityNames => "Stale or incompatible rustc driver report",
                    _ => "Stale or incompatible compiler report",
                })?;
                ensure!(
                    report.run == request.run
                        && report.configuration == configuration
                        && report.compiler == request.compiler,
                    "{}",
                    if rule == Rule::EntityNames {
                        "Stale or incompatible rustc driver report"
                    } else {
                        "Stale or incompatible compiler report"
                    }
                );
                ensure!(
                    report.failure.is_none(),
                    "Compiler analysis failed: {}",
                    report.failure.as_deref().unwrap_or_default()
                );
                if rule != Rule::Architecture {
                    ensure!(
                        request.sources.contains(&report.target.source),
                        "Unexpected analyzed source {}",
                        report.target.source
                    );
                }
                if rule == Rule::Architecture {
                    ensure!(
                        report.facts.is_some(),
                        "Architecture compiler report has no facts"
                    );
                    let key = report_cache_key(
                        &report.target,
                        &report.manifest_dir,
                        &report.artifact_tag,
                        &report.crate_types,
                    )?;
                    // 已验证的原始报告直接复制到缓存，不再序列化整张事实图。
                    fs::copy(&path, cache_directory.join(format!("{key}.json")))?;
                }
                reports.push(report);
            }
            if rule != Rule::Architecture {
                let mut expected = BTreeMap::new();
                let mut received = BTreeMap::new();
                for artifact in &artifacts {
                    *expected.entry(artifact.target.clone()).or_insert(0usize) += 1;
                }
                for report in &reports {
                    *received.entry(report.target.clone()).or_insert(0usize) += 1;
                }
                ensure!(
                    received == expected,
                    "{}: expected {expected:?}, received {received:?}",
                    if rule == Rule::EntityNames {
                        "Missing fresh rustc analysis reports"
                    } else {
                        "Missing or unexpected compilation reports"
                    }
                );
                return Ok(Compilation {
                    reports,
                    packages: metadata["packages"].clone(),
                    executable,
                    configuration,
                    environment_path: self.path.clone(),
                });
            }
            let (selected, missing) =
                select_reports(&artifacts, reports, &cache_directory, &request)?;
            if missing.is_empty() {
                return Ok(Compilation {
                    reports: selected,
                    packages: metadata["packages"].clone(),
                    executable,
                    configuration,
                    environment_path: self.path.clone(),
                });
            }
            last_missing = missing.clone();
            if attempt == 0 {
                for id in missing {
                    let mut clean = self.command("cargo");
                    clean.args(["clean", "--quiet", "-p", &id]);
                    if let Some(target) = options
                        .target
                        .as_deref()
                        .filter(|target| *target != self.host)
                    {
                        clean.args(["--target", target]);
                    }
                    ensure!(
                        clean.status()?.success(),
                        "Cannot invalidate a missing dependency analysis report"
                    );
                }
                for entry in fs::read_dir(&reports_dir)? {
                    let path = entry?.path();
                    if path
                        .extension()
                        .is_some_and(|extension| extension == "json")
                    {
                        fs::remove_file(path)?;
                    }
                }
            }
        }
        anyhow::bail!("Missing or ambiguous compiler facts for Cargo units: {last_missing:?}")
    }
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

fn source_files_match(
    report: &UnitReport,
    hashes: &mut BTreeMap<String, Option<String>>,
) -> Result<bool> {
    let Some(facts) = &report.facts else {
        return Ok(false);
    };
    if facts.source_files.is_empty() {
        return Ok(false);
    }
    for source in &facts.source_files {
        let actual = hashes
            .entry(source.path.clone())
            .or_insert_with(|| file_digest(Path::new(&source.path)).ok());
        if actual.as_ref() != Some(&source.sha256) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn select_reports(
    artifacts: &[Artifact],
    mut reports: Vec<UnitReport>,
    cache_directory: &Path,
    request: &Request,
) -> Result<(Vec<UnitReport>, BTreeSet<String>)> {
    let mut selected = Vec::with_capacity(artifacts.len());
    let mut missing = BTreeSet::new();
    let mut hashes = BTreeMap::new();
    for artifact in artifacts {
        let current: Vec<_> = reports
            .iter()
            .enumerate()
            .filter(|(_, report)| artifact.matches_report(report))
            .map(|(index, _)| index)
            .collect();
        if current.len() == 1 {
            selected.push(reports.swap_remove(current[0]));
            continue;
        }
        if !current.is_empty() || !artifact.fresh {
            eprintln!(
                "Analysis report mismatch: package={} target={} kinds={:?} fresh={} current={} artifactFiles={:?}",
                artifact.package_id,
                artifact.target.name,
                artifact.crate_types,
                artifact.fresh,
                current.len(),
                artifact.filenames
            );
            missing.insert(artifact.package_id.clone());
            continue;
        }
        // 只有 Cargo 复用但本次缺少报告的单元才读取其精确缓存，不扫描其他大报告。
        let mut cached = Vec::new();
        for path in artifact.cache_paths(cache_directory)? {
            if !path.is_file() {
                continue;
            }
            let report = read_report(&path)?;
            if report.compiler == request.compiler
                && report.configuration == request.configuration
                && report.failure.is_none()
                && artifact.matches_report(&report)
                && source_files_match(&report, &mut hashes)?
            {
                cached.push(report);
            }
        }
        if cached.len() == 1 {
            selected.push(cached.pop().expect("One cached report"));
        } else {
            eprintln!(
                "Analysis cache miss: package={} target={} kinds={:?} validCached={}",
                artifact.package_id,
                artifact.target.name,
                artifact.crate_types,
                cached.len()
            );
            missing.insert(artifact.package_id.clone());
        }
    }
    Ok((selected, missing))
}

#[cfg(test)]
mod tests {
    use super::*;
    use analysis_contract::facts::{SourceFile, UnitFacts};

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

    fn selection_fixture() -> (UnitReport, Artifact, Request) {
        let report = UnitReport {
            run: "fixture".into(),
            configuration: "configuration".into(),
            compiler: "compiler".into(),
            target: named_fields::Target {
                source: "/fixture/lib.rs".into(),
                name: "fixture".into(),
                test: false,
            },
            manifest_dir: "/fixture".into(),
            package: "fixture".into(),
            artifact_tag: "-0123456789abcdef".into(),
            crate_types: vec!["lib".into()],
            findings: vec![],
            entities: entity_names::Report::default(),
            facts: Some(UnitFacts {
                crate_name: "fixture".into(),
                ..Default::default()
            }),
            failure: None,
        };
        let artifact = Artifact {
            package_id: "fixture".into(),
            target: report.target.clone(),
            filenames: vec!["/target/libfixture-0123456789abcdef.rlib".into()],
            fresh: true,
            manifest_dir: report.manifest_dir.clone(),
            crate_types: report.crate_types.clone(),
            executable: None,
        };
        let request = Request {
            run: report.run.clone(),
            configuration: report.configuration.clone(),
            compiler: report.compiler.clone(),
            workspace: "/fixture".into(),
            rule: Rule::Architecture,
            sources: BTreeSet::new(),
            manifest_dirs: BTreeSet::new(),
            package_origins: vec![],
        };
        (report, artifact, request)
    }

    #[test]
    fn fresh_owned_report_does_not_read_even_its_invalid_cache() {
        let (report, artifact, request) = selection_fixture();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/selection")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let paths = artifact.cache_paths(&directory).unwrap();
        assert_eq!(paths.len(), 1);
        fs::write(&paths[0], b"invalid cache must remain unread").unwrap();
        let original = report.facts.as_ref().unwrap().crate_name.as_ptr();
        let (selected, missing) =
            select_reports(&[artifact], vec![report], &directory, &request).unwrap();
        assert!(missing.is_empty());
        assert_eq!(selected.len(), 1);
        assert_eq!(
            selected[0].facts.as_ref().unwrap().crate_name.as_ptr(),
            original
        );
    }

    #[test]
    fn reused_artifact_loads_only_its_exact_cache_and_checks_source_bytes() {
        let (mut report, artifact, request) = selection_fixture();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/reuse")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("lib.rs");
        fs::write(&source, b"pub struct Original;").unwrap();
        report.facts.as_mut().unwrap().source_files = vec![SourceFile {
            path: source.to_string_lossy().into_owned(),
            sha256: file_digest(&source).unwrap(),
        }];
        let paths = artifact.cache_paths(&directory).unwrap();
        fs::write(&paths[0], serde_json::to_vec(&report).unwrap()).unwrap();
        fs::write(directory.join("unrelated.json"), b"unrelated invalid cache").unwrap();
        let artifacts = vec![artifact];
        let (selected, missing) = select_reports(&artifacts, vec![], &directory, &request).unwrap();
        assert_eq!(selected.len(), 1);
        assert!(missing.is_empty());
        fs::write(&source, b"pub struct Changed;").unwrap();
        let (selected, missing) = select_reports(&artifacts, vec![], &directory, &request).unwrap();
        assert!(selected.is_empty());
        assert!(missing.contains("fixture"));
    }

    #[test]
    fn public_executable_matches_without_hash_but_dependency_units_require_their_hash() {
        let mut report = UnitReport {
            run: "fixture".into(),
            configuration: "fixture".into(),
            compiler: "fixture".into(),
            target: named_fields::Target {
                source: "/fixture/src/main.rs".into(),
                name: "fixture".into(),
                test: false,
            },
            manifest_dir: "/fixture".into(),
            package: "fixture".into(),
            artifact_tag: "-0123456789abcdef".into(),
            crate_types: vec!["bin".into()],
            findings: vec![],
            entities: entity_names::Report::default(),
            facts: None,
            failure: None,
        };
        let mut artifact = Artifact {
            package_id: "fixture".into(),
            target: report.target.clone(),
            filenames: vec!["/target/debug/fixture.exe".into()],
            fresh: false,
            manifest_dir: "/fixture".into(),
            crate_types: vec!["bin".into()],
            executable: Some(PathBuf::from("/target/debug/fixture.exe")),
        };
        assert!(artifact.matches_report(&report));
        report.crate_types = vec!["lib".into()];
        assert!(!artifact.matches_report(&report));
        artifact.crate_types = vec!["lib".into()];
        artifact.executable = None;
        artifact.filenames = vec!["/target/debug/deps/libfixture-0123456789abcdef.rlib".into()];
        assert!(artifact.matches_report(&report));
        report.artifact_tag = "-fedcba9876543210".into();
        assert!(!artifact.matches_report(&report));
        report.artifact_tag.clear();
        assert!(!artifact.matches_report(&report));
    }

    #[test]
    fn dependency_report_is_reusable_only_while_all_source_bytes_match() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("include.rs");
        fs::write(&source, b"pub struct Included;\n").unwrap();
        let mut report = UnitReport {
            run: "fixture".into(),
            configuration: "fixture".into(),
            compiler: env!("ANALYSIS_COMPILER").into(),
            target: named_fields::Target {
                source: normalized(&source).unwrap(),
                name: "fixture".into(),
                test: false,
            },
            manifest_dir: normalized(&directory).unwrap(),
            package: "fixture".into(),
            artifact_tag: String::new(),
            crate_types: vec!["lib".into()],
            findings: vec![],
            entities: entity_names::Report::default(),
            facts: Some(UnitFacts {
                source_files: vec![SourceFile {
                    path: normalized(&source).unwrap(),
                    sha256: digest(fs::read(&source).unwrap()),
                }],
                ..Default::default()
            }),
            failure: None,
        };
        assert!(source_files_match(&report, &mut BTreeMap::new()).unwrap());
        fs::write(&source, b"pub struct Modified;\n").unwrap();
        assert!(!source_files_match(&report, &mut BTreeMap::new()).unwrap());
        report.facts.as_mut().unwrap().source_files.clear();
        assert!(!source_files_match(&report, &mut BTreeMap::new()).unwrap());
        report.facts = None;
        assert!(!source_files_match(&report, &mut BTreeMap::new()).unwrap());
    }
}

/// 具名字段规则覆盖项目的全部 Cargo 目标，并检查工具自身的兼容入口。
pub fn check_named_fields(options: &Options) -> Result<named_fields::Report> {
    let host = Host::new(options, Rule::NamedFields)?;
    let result = host.compile(options, Rule::NamedFields, false)?;
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
    for directory in ["contract", "compiler", "runner"] {
        let own = options.root.join("tools/rustc-analysis").join(directory);
        if !own.join("Cargo.toml").is_file() {
            continue;
        }
        let mut nested = Options::new(own);
        nested.driver = options.driver.clone();
        let nested_host = Host::new(&nested, Rule::NamedFields)?;
        let result = nested_host.compile(&nested, Rule::NamedFields, false)?;
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
    let result = host.compile(options, Rule::EntityNames, false)?;
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
    let source_origins = host.source_origins()?;
    let result = host.compile(&selected, Rule::Architecture, true)?;
    fs::create_dir_all(output)?;
    let output = output.canonicalize()?;
    let debugdump = output.join("debugdump");
    fs::create_dir_all(&debugdump)?;
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
    ensure!(
        debugdump.join("manifest.json").is_file() && debugdump.join("runtime.json").is_file(),
        "Dedicated export did not publish its runtime snapshot"
    );
    fs::copy(debugdump.join("runtime.json"), output.join("runtime.json"))?;
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
        schema_version: 1,
        compiler: env!("ANALYSIS_COMPILER"),
        configuration: result.configuration,
        workspace: normalized(&host.root)?,
        packages: result.packages,
        source_origins,
        units,
        executable_sha256: file_digest(&executable)?,
        runtime_sha256: file_digest(&output.join("runtime.json"))?,
    };
    let staged = output.join("facts.json.new");
    let mut writer = BufWriter::with_capacity(1024 * 1024, fs::File::create(&staged)?);
    serde_json::to_writer(&mut writer, &bundle)?;
    writer.flush()?;
    drop(writer);
    fs::rename(staged, output.join("facts.json"))?;
    Ok(())
}

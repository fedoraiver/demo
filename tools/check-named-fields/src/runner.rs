//! 编排 Cargo 全目标编译，并按编译单元核验本次 AST 校验报告。
use crate::report::{Envelope, Report, Request, Target};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct Options {
    pub root: PathBuf,
    pub target: Option<String>,
    pub features: Vec<String>,
    pub all_features: bool,
    /// 嵌入调用和集成测试可指定宿主；CLI 使用相邻程序。
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

#[derive(Deserialize)]
struct Package {
    id: String,
    name: String,
    manifest_path: PathBuf,
    targets: Vec<CargoTarget>,
}
#[derive(Deserialize)]
struct CargoTarget {
    src_path: PathBuf,
}

struct Host {
    driver: PathBuf,
    sysroot: PathBuf,
    path: OsString,
    host: String,
    cache: PathBuf,
    directory: PathBuf,
    run: String,
}

impl Host {
    fn new(options: &Options) -> Result<Self> {
        let query = |args: &[&str]| -> Result<String> {
            let output = Command::new("rustc")
                .env("RUSTUP_TOOLCHAIN", env!("NAMED_FIELDS_TOOLCHAIN"))
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
                .any(|line| line == format!("commit-hash: {}", env!("NAMED_FIELDS_RUSTC"))),
            "Compiler does not match the checker's rustc ABI; rebuild with {}",
            env!("NAMED_FIELDS_TOOLCHAIN")
        );
        let host = version
            .lines()
            .find_map(|line| line.strip_prefix("host: "))
            .context("Missing rustc host triple")?
            .into();
        let sysroot = PathBuf::from(query(&["--print", "sysroot"])?.trim());
        let driver = options
            .driver
            .clone()
            .unwrap_or(env::current_exe()?.with_file_name(format!(
                "check-named-fields-driver{}",
                env::consts::EXE_SUFFIX
            )));
        ensure!(
            driver.is_file(),
            "Missing compiler host {}; build with cargo build --bins",
            driver.display()
        );
        let mut paths = vec![sysroot.join("bin"), sysroot.join("lib")];
        paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
        let path = env::join_paths(paths)?;
        let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tmp/named-fields");
        fs::create_dir_all(&cache)?;
        let cache = cache.canonicalize()?;
        let run = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        );
        let directory = cache.join("runs").join(&run);
        fs::create_dir_all(&directory)?;
        for path in [cache.join("a/t"), cache.join("a/b"), directory.clone()] {
            fs::create_dir_all(&path)?;
            ensure!(
                path.canonicalize()?.starts_with(&cache),
                "Cache escaped the dedicated named-fields directory"
            );
        }
        Ok(Self {
            driver,
            sysroot,
            path,
            host,
            cache,
            directory,
            run,
        })
    }
    fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut command = Command::new(program);
        command
            .env("RUSTUP_TOOLCHAIN", env!("NAMED_FIELDS_TOOLCHAIN"))
            .env(
                "RUSTC",
                self.sysroot
                    .join("bin")
                    .join(format!("rustc{}", env::consts::EXE_SUFFIX)),
            )
            .env("PATH", &self.path)
            .env("CARGO_TARGET_DIR", self.cache.join("a/t"))
            .env("CARGO_BUILD_BUILD_DIR", self.cache.join("a/b"))
            .env("CARGO_BUILD_TARGET", &self.host)
            .env("CARGO_INCREMENTAL", "0")
            .env("RUSTC_WRAPPER", "")
            .env("RUSTC_WORKSPACE_WRAPPER", "");
        command
    }
    fn package(&self, root: &Path) -> Result<Package> {
        let output = self
            .command("cargo")
            .current_dir(root)
            .args(["metadata", "--locked", "--no-deps", "--format-version", "1"])
            .output()?;
        ensure!(
            output.status.success(),
            "Cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        #[derive(Deserialize)]
        struct Metadata {
            packages: Vec<Package>,
        }
        let metadata: Metadata = serde_json::from_slice(&output.stdout)?;
        let manifest = root.join("Cargo.toml").canonicalize()?;
        metadata
            .packages
            .into_iter()
            .find(|package| package.manifest_path.canonicalize().ok().as_ref() == Some(&manifest))
            .context("The selected root must contain a Cargo package")
    }
    fn request(&self, name: &str, request: &Request) -> Result<(PathBuf, PathBuf)> {
        let reports = self.directory.join(name);
        fs::create_dir_all(&reports)?;
        let path = reports.join("request.input");
        fs::write(&path, serde_json::to_vec(request)?)?;
        Ok((path, reports))
    }
    fn configure(&self, command: &mut Command, request: &Path, reports: &Path) {
        command
            .env("NAMED_FIELDS_REQUEST", request)
            .env("NAMED_FIELDS_REPORTS", reports)
            .env("NAMED_FIELDS_SYSROOT", &self.sysroot);
    }
    fn check_package(
        &self,
        package: &Package,
        options: &Options,
        index: usize,
        report: &mut Report,
    ) -> Result<()> {
        let root = package
            .manifest_path
            .parent()
            .context("Missing manifest directory")?;
        let request = Request {
            run: self.run.clone(),
            configuration: serde_json::to_string(&(
                normalized(root)?,
                options.target.as_deref().unwrap_or(&self.host),
                &options.features,
                options.all_features,
                "all-targets",
            ))?,
            manifest_dir: normalized(root)?,
            targets: package
                .targets
                .iter()
                .map(|target| normalized(&target.src_path))
                .collect::<Result<_>>()?,
        };
        let (path, reports) = self.request(&format!("package-{index}"), &request)?;
        let mut clean = self.command("cargo");
        clean
            .current_dir(root)
            .args(["clean", "--quiet", "-p", &package.name]);
        if let Some(target) = &options.target {
            clean.args(["--target", target]);
        }
        ensure!(
            clean.status()?.success(),
            "Cannot invalidate the checked package in the dedicated cache"
        );
        let mut cargo = self.command("cargo");
        self.configure(&mut cargo, &path, &reports);
        cargo
            .current_dir(root)
            .env("RUSTC_WORKSPACE_WRAPPER", &self.driver)
            .args([
                "check",
                "--locked",
                "--all-targets",
                "--message-format=json",
                "-p",
                &package.id,
            ]);
        if let Some(target) = &options.target {
            cargo.args(["--target", target]);
        }
        if !options.features.is_empty() {
            cargo.args(["--features", &options.features.join(",")]);
        }
        if options.all_features {
            cargo.arg("--all-features");
        }
        let output = cargo.output()?;
        if !output.stderr.is_empty() {
            eprint!("{}", String::from_utf8_lossy(&output.stderr));
        }
        let mut artifacts = BTreeSet::new();
        let mut expected = BTreeMap::<Target, usize>::new();
        for line in String::from_utf8(output.stdout)?.lines() {
            let message: serde_json::Value =
                serde_json::from_str(line).context("Invalid Cargo JSON output")?;
            if message["reason"] == "compiler-message"
                && let Some(rendered) = message["message"]["rendered"].as_str()
            {
                eprint!("{rendered}");
            }
            if message["reason"] == "compiler-artifact" && message["package_id"] == package.id {
                let filenames = serde_json::to_string(&message["filenames"])?;
                if !artifacts.insert(filenames) {
                    continue;
                }
                let target = Target {
                    source: normalized(Path::new(
                        message["target"]["src_path"]
                            .as_str()
                            .context("Missing artifact source")?,
                    ))?,
                    name: message["target"]["name"]
                        .as_str()
                        .context("Missing artifact name")?
                        .replace('-', "_"),
                    test: message["profile"]["test"]
                        .as_bool()
                        .context("Missing artifact test mode")?,
                };
                *expected.entry(target).or_default() += 1;
            }
        }
        ensure!(
            output.status.success(),
            "Cargo compilation or macro expansion failed for {}",
            package.name
        );
        ensure!(
            !expected.is_empty(),
            "No compilation targets were checked for {}",
            package.name
        );
        let envelopes = read_reports(&reports, &request)?;
        let mut received = BTreeMap::<Target, usize>::new();
        for envelope in &envelopes {
            let target = &envelope.target;
            ensure!(
                request.targets.contains(&target.source),
                "Unexpected checked source {}",
                target.source
            );
            *received.entry(target.clone()).or_default() += 1;
        }
        ensure!(
            received == expected,
            "Missing or unexpected compilation reports: expected {expected:?}, received {received:?}"
        );
        report.compilations += envelopes.len();
        for envelope in envelopes {
            report.add(envelope);
        }
        Ok(())
    }
}

fn read_reports(directory: &Path, request: &Request) -> Result<Vec<Envelope>> {
    let mut reports = vec![];
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let envelope: Envelope = serde_json::from_slice(&fs::read(&path)?)
            .with_context(|| format!("Invalid report {}", path.display()))?;
        ensure!(
            envelope.run == request.run
                && envelope.configuration == request.configuration
                && envelope.compiler == env!("NAMED_FIELDS_RUSTC"),
            "Stale or incompatible compiler report {}",
            path.display()
        );
        ensure!(
            envelope.failure.is_none(),
            "AST validation failed: {}",
            envelope.failure.as_deref().unwrap_or_default()
        );
        reports.push(envelope);
    }
    Ok(reports)
}

pub fn check(options: &Options) -> Result<Report> {
    let host = Host::new(options)?;
    let root = options.root.canonicalize()?;
    let mut packages = vec![host.package(&root)?];
    let own = root.join("tools/check-named-fields");
    if own.join("Cargo.toml").is_file() {
        packages.push(host.package(&own)?);
    }
    let mut report = Report {
        configuration: format!(
            "{}; root={}, target={}, features={:?}, all_features={}, all Cargo targets; checker host={}",
            env!("NAMED_FIELDS_TOOLCHAIN"),
            normalized(&root)?,
            options.target.as_deref().unwrap_or(&host.host),
            options.features,
            options.all_features,
            host.host
        ),
        ..Report::default()
    };
    for (index, package) in packages.iter().enumerate() {
        let selected = if index == 0 {
            options.clone()
        } else {
            Options::new(own.clone())
        };
        host.check_package(package, &selected, index, &mut report)?;
    }
    Ok(report)
}

pub fn normalized(path: &Path) -> Result<String> {
    Ok(path
        .canonicalize()?
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/"))
}

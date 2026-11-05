//! Cargo 外层包装器保存依赖 MIR，内层按请求执行所选编译单元的分析。
use analysis_contract::{
    ANALYSIS_SCHEMA_VERSION, Request, Rule, UnitInputs, UnitReport, entity_names, named_fields,
    normalized,
};
use anyhow::{Result, ensure};
use rustc_driver::{Callbacks, Compilation};
use rustc_interface::interface;
use rustc_middle::ty::TyCtxt;
use rustc_span::Symbol;
use std::{
    collections::BTreeSet,
    env, fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_REPORT: AtomicU64 = AtomicU64::new(0);

fn create_report_file(
    directory: &Path,
    pid: u32,
    timestamp: u128,
    counter: &AtomicU64,
) -> std::io::Result<(PathBuf, fs::File)> {
    loop {
        let serial = counter.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!("{pid}-{timestamp}-{serial}.json"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

struct Checker {
    request: Request,
    analyze: bool,
    source: String,
    artifact_tag: String,
    reads: crate::inputs::ReadTracker,
    pending: Option<UnitReport>,
    input_failure: Option<String>,
}

fn track_configuration(config: &mut interface::Config, configuration: String) {
    let previous = config.track_state.take();
    // 只登记稳定语义配置；每轮 run 与报告目录不进入 Cargo/rustc 的失效条件。
    config.track_state = Some(Box::new(move |session| {
        if let Some(previous) = previous {
            previous(session);
        }
        session.env_depinfo.borrow_mut().insert((
            Symbol::intern("ANALYSIS_CONFIGURATION"),
            Some(Symbol::intern(&configuration)),
        ));
    }));
}

struct StateOnly {
    configuration: String,
}

impl Callbacks for StateOnly {
    fn config(&mut self, config: &mut interface::Config) {
        track_configuration(config, self.configuration.clone());
    }
}

impl Checker {
    fn report(&self, tcx: TyCtxt<'_>) -> UnitReport {
        UnitReport {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            rule: self.request.rule,
            analyzed: self.analyze,
            run: self.request.run.clone(),
            configuration: self.request.configuration.clone(),
            compiler: env!("ANALYSIS_COMPILER").into(),
            target: named_fields::Target {
                source: self.source.clone(),
                name: tcx.crate_name(rustc_span::def_id::LOCAL_CRATE).to_string(),
                test: tcx.sess.opts.test,
            },
            manifest_dir: env::var_os("CARGO_MANIFEST_DIR")
                .and_then(|path| normalized(Path::new(&path)).ok())
                .unwrap_or_default(),
            package: env::var("CARGO_PKG_NAME").unwrap_or_default(),
            artifact_tag: self.artifact_tag.clone(),
            crate_types: tcx.crate_types().iter().map(ToString::to_string).collect(),
            inputs: UnitInputs::default(),
            findings: vec![],
            entities: entity_names::Report::default(),
            facts: None,
            failure: None,
        }
    }

    fn write(&self, report: &UnitReport) {
        let directory =
            PathBuf::from(env::var_os("ANALYSIS_REPORTS").expect("Missing report directory"));
        // Windows 在长构建期间会复用 PID；独占创建保证旧单元报告不会被覆盖。
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Invalid report time")
            .as_nanos();
        let (_, file) = create_report_file(&directory, std::process::id(), timestamp, &NEXT_REPORT)
            .expect("Cannot create analysis report");
        let mut writer = BufWriter::with_capacity(1024 * 1024, file);
        serde_json::to_writer(&mut writer, report).expect("Cannot serialize analysis report");
        writer.flush().expect("Cannot flush analysis report");
    }
}

impl Callbacks for Checker {
    fn config(&mut self, config: &mut interface::Config) {
        if self.analyze && self.request.rule == Rule::Architecture {
            // 此 nightly 默认在 metadata 编码后才提供本地 crate hash；分析回调早于编码。
            // 专用分析采用 rustc 原生 HIR 回退，使证书与最终 metadata 使用同一 hash。
            config.opts.unstable_opts.metadata_crate_hash = false;
        }
        self.reads.install(config);
        track_configuration(config, self.request.configuration.clone());
    }

    fn after_expansion<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        if let Err(error) = self.reads.snapshot_tracked_files(tcx) {
            self.input_failure = Some(format!("{error:#}"));
        }
        if self.analyze && self.request.rule == Rule::NamedFields {
            let mut report = self.report(tcx);
            let (_, krate) = tcx.resolver_for_lowering();
            match crate::named_fields::check(&krate.borrow(), tcx.sess.source_map()) {
                Ok(findings) => report.findings = findings,
                Err(error) => report.failure = Some(format!("{error:#}")),
            }
            // AST 检查仍在展开阶段进行；通用输入在分析结束后收齐，并与其余规则统一写出。
            self.pending = Some(report);
        }
        Compilation::Continue
    }

    fn after_analysis<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        let mut report = self.pending.take().unwrap_or_else(|| self.report(tcx));
        if self.analyze && self.request.rule != Rule::NamedFields {
            let result = match self.request.rule {
                Rule::EntityNames => {
                    crate::entity::analysis::check(tcx).map(|entities| report.entities = entities)
                }
                Rule::Architecture => {
                    crate::ecs::extract_with_origins(tcx, &self.request.package_origins)
                        .map(|facts| report.facts = Some(facts))
                }
                Rule::NamedFields => unreachable!(),
            };
            if let Err(error) = result {
                report.failure = Some(format!("{error:#}"));
            }
        }
        match self.reads.collect(tcx) {
            Ok(inputs) => report.inputs = inputs,
            Err(error) => self.input_failure = Some(format!("{error:#}")),
        }
        if let Some(error) = self.input_failure.take() {
            report.failure = Some(match report.failure.take() {
                Some(previous) => format!("{previous}; compiler input proof failed: {error}"),
                None => format!("Compiler input proof failed: {error}"),
            });
        }
        self.write(&report);
        Compilation::Continue
    }
}

fn compilation_source(arguments: &[String], request: &Request) -> Result<Option<String>> {
    let targets: BTreeSet<_> = request
        .package_origins
        .iter()
        .flat_map(|origin| &origin.targets)
        .map(|target| target.source.as_str())
        .collect();
    if !targets.is_empty() {
        let sources: BTreeSet<_> = arguments
            .iter()
            .skip(1)
            .filter_map(|argument| normalized(Path::new(argument)).ok())
            .filter(|source| targets.contains(source.as_str()))
            .collect();
        ensure!(
            sources.len() <= 1,
            "Compiler arguments match multiple Cargo target sources: {sources:?}"
        );
        return Ok(sources.into_iter().next());
    }
    if request.package_origins.is_empty() {
        return Ok(arguments
            .iter()
            .skip(1)
            .filter(|argument| argument.ends_with(".rs"))
            .find_map(|argument| normalized(Path::new(argument)).ok()));
    }
    Ok(None)
}

fn source_is_build_script(
    request: &Request,
    source: &str,
    manifest: Option<&str>,
    name_fallback: bool,
) -> bool {
    if request.package_origins.is_empty() {
        return name_fallback;
    }
    let targets: Vec<_> = request
        .package_origins
        .iter()
        .filter(|origin| manifest.is_none_or(|manifest| origin.root == manifest))
        .flat_map(|origin| &origin.targets)
        .filter(|target| target.source == source)
        .collect();
    // 同源多目标无法仅靠 crate 名区分，保守保留主动分析，避免漏掉同名普通 bin。
    !targets.is_empty()
        && targets.iter().all(|target| {
            !target.kind.is_empty() && target.kind.iter().all(|kind| kind == "custom-build")
        })
}

fn run() -> Result<ExitCode> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    ensure!(
        !args.is_empty(),
        "The analysis driver must be invoked by Cargo"
    );
    let request_path = env::var_os("ANALYSIS_REQUEST")
        .ok_or_else(|| anyhow::anyhow!("Missing analysis request"))?;
    let request: Request = serde_json::from_slice(&fs::read(request_path)?)?;
    ensure!(
        request.schema_version == ANALYSIS_SCHEMA_VERSION,
        "Unsupported analysis request schema"
    );
    ensure!(
        request.compiler == env!("ANALYSIS_COMPILER"),
        "Analysis driver does not match the requested compiler ABI"
    );
    ensure!(
        env::var("ANALYSIS_CONFIGURATION").ok().as_deref() == Some(request.configuration.as_str()),
        "Stable analysis configuration does not match the request"
    );
    let diagnostics =
        rustc_session::EarlyDiagCtxt::new(rustc_session::config::ErrorOutputType::default());
    let expanded = rustc_driver::args::arg_expand_all(&diagnostics, &args);
    let is_compile = expanded
        .iter()
        .any(|arg| arg == "--crate-name" || arg.starts_with("--crate-name="));
    if is_compile
        && request.rule != Rule::NamedFields
        && !expanded.iter().any(|arg| arg == "-Zalways-encode-mir")
    {
        args.extend(["-Zalways-encode-mir".into(), "-Zmir-opt-level=0".into()]);
    }
    let nested = Path::new(&args[0]).file_stem().is_some_and(|name| {
        matches!(
            name.to_str(),
            Some(
                "rustc-analysis-driver" | "check-entity-names-driver" | "check-named-fields-driver"
            )
        )
    });
    let manifest =
        env::var_os("CARGO_MANIFEST_DIR").and_then(|path| normalized(Path::new(&path)).ok());
    let source = compilation_source(&expanded, &request)?;
    let selected = request.rule == Rule::Architecture
        || manifest
            .as_ref()
            .is_some_and(|path| request.manifest_dirs.contains(path));
    let build_script_name = expanded
        .windows(2)
        .any(|pair| pair[0] == "--crate-name" && pair[1] == "build_script_build")
        || expanded
            .iter()
            .any(|argument| argument == "--crate-name=build_script_build");
    if !nested
        && is_compile
        && let Some(source) = source
    {
        let analyze = selected
            && !(request.rule == Rule::Architecture
                && source_is_build_script(
                    &request,
                    &source,
                    manifest.as_deref(),
                    build_script_name,
                ))
            && (request.rule == Rule::Architecture || request.sources.contains(&source));
        args.extend(["--sysroot".into(), env::var("ANALYSIS_SYSROOT")?]);
        let artifact_tag = expanded
            .iter()
            .find_map(|arg| arg.strip_prefix("extra-filename="))
            .unwrap_or_default()
            .to_owned();
        rustc_driver::compiler_entrypoint(
            &args,
            &mut Checker {
                request,
                analyze,
                source,
                artifact_tag,
                reads: crate::inputs::ReadTracker::default(),
                pending: None,
                input_failure: None,
            },
        );
        Ok(ExitCode::SUCCESS)
    } else if !nested && is_compile {
        // Cargo 的无源码查询只登记状态；真实编译单元均由 Checker 产出输入报告。
        args.extend(["--sysroot".into(), env::var("ANALYSIS_SYSROOT")?]);
        rustc_driver::compiler_entrypoint(
            &args,
            &mut StateOnly {
                configuration: request.configuration,
            },
        );
        Ok(ExitCode::SUCCESS)
    } else {
        let status = Command::new(&args[0]).args(&args[1..]).status()?;
        Ok(ExitCode::from(
            status
                .code()
                .and_then(|code| u8::try_from(code).ok())
                .unwrap_or(2),
        ))
    }
}

/// 保留普通进程退出码，分析错误由带运行身份的报告同步返回。
pub fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Compiler analysis driver failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_target_sources_take_priority_and_build_scripts_use_target_kind() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/driver-sources")
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
        let source = directory.join("input.data");
        let fallback = directory.join("fallback.rs");
        let build = directory.join("build.data");
        for path in [&source, &fallback, &build] {
            fs::write(path, "fn main() {}\n").unwrap();
        }
        let manifest = normalized(&directory).unwrap();
        let source = normalized(&source).unwrap();
        let fallback = normalized(&fallback).unwrap();
        let build = normalized(&build).unwrap();
        let mut request = Request {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            run: "source-fixture".into(),
            configuration: "source-fixture".into(),
            compiler: env!("ANALYSIS_COMPILER").into(),
            workspace: manifest.clone(),
            rule: Rule::Architecture,
            sources: BTreeSet::new(),
            manifest_dirs: BTreeSet::new(),
            package_origins: vec![analysis_contract::PackageOrigin {
                root: manifest.clone(),
                identity: "fixture".into(),
                targets: vec![analysis_contract::PackageTargetOrigin {
                    source: source.clone(),
                    name: "build_script_build".into(),
                    kind: vec!["bin".into()],
                }],
            }],
        };
        let arguments = vec!["rustc".into(), fallback.clone(), source.clone()];
        assert_eq!(
            compilation_source(&arguments, &request).unwrap(),
            Some(source.clone())
        );
        assert!(
            !source_is_build_script(&request, &source, Some(&manifest), true),
            "A bin named build_script_build is not a Cargo custom-build target"
        );
        request.package_origins[0]
            .targets
            .push(analysis_contract::PackageTargetOrigin {
                source: build.clone(),
                name: "build-script-build".into(),
                kind: vec!["custom-build".into()],
            });
        assert!(source_is_build_script(
            &request,
            &build,
            Some(&manifest),
            false
        ));
        assert!(
            compilation_source(&["rustc".into(), source.clone(), build.clone()], &request).is_err()
        );
        request.package_origins[0]
            .targets
            .push(analysis_contract::PackageTargetOrigin {
                source: build.clone(),
                name: "shared-bin".into(),
                kind: vec!["bin".into()],
            });
        assert!(
            !source_is_build_script(&request, &build, Some(&manifest), true),
            "A shared-source ordinary target must not be skipped by its build-script name"
        );
        request.package_origins.clear();
        assert_eq!(
            compilation_source(&arguments, &request).unwrap(),
            Some(fallback)
        );
        assert!(source_is_build_script(&request, &source, None, true));
        assert!(
            compilation_source(
                &[
                    "rustc".into(),
                    "--crate-name=___".into(),
                    "--print=sysroot".into(),
                    "-".into()
                ],
                &request
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn recycled_pid_and_reset_counter_never_overwrite_an_earlier_report() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tmp/ra/tests/driver-reports")
            .join(format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let first_process = AtomicU64::new(0);
        let (first, mut file) = create_report_file(&directory, 42, 100, &first_process).unwrap();
        file.write_all(b"earlier unit").unwrap();
        drop(file);
        // 固定时钟和 PID，并重置进程内计数器，复现最严格的文件名碰撞。
        let recycled_process = AtomicU64::new(0);
        let (second, mut file) =
            create_report_file(&directory, 42, 100, &recycled_process).unwrap();
        file.write_all(b"later unit").unwrap();
        drop(file);
        assert_ne!(first, second);
        assert_eq!(fs::read(first).unwrap(), b"earlier unit");
        assert_eq!(fs::read(second).unwrap(), b"later unit");
    }
}

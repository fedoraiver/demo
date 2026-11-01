//! Cargo 外层包装器保存依赖 MIR，内层按请求执行所选编译单元的分析。
use analysis_contract::{Request, Rule, UnitReport, entity_names, named_fields, normalized};
use anyhow::{Result, ensure};
use rustc_driver::{Callbacks, Compilation};
use rustc_interface::interface;
use rustc_middle::ty::TyCtxt;
use std::{
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
    source: String,
    artifact_tag: String,
    crate_types: Vec<String>,
}

impl Checker {
    fn report(&self, tcx: TyCtxt<'_>) -> UnitReport {
        UnitReport {
            run: self.request.run.clone(),
            configuration: self.request.configuration.clone(),
            compiler: env!("ANALYSIS_COMPILER").into(),
            target: named_fields::Target {
                source: self.source.clone(),
                name: tcx.crate_name(rustc_span::def_id::LOCAL_CRATE).to_string(),
                test: tcx.sess.config.contains(&(rustc_span::sym::test, None)),
            },
            manifest_dir: env::var_os("CARGO_MANIFEST_DIR")
                .and_then(|path| normalized(Path::new(&path)).ok())
                .unwrap_or_default(),
            package: env::var("CARGO_PKG_NAME").unwrap_or_default(),
            artifact_tag: self.artifact_tag.clone(),
            crate_types: self.crate_types.clone(),
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
    fn after_expansion<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        if self.request.rule == Rule::NamedFields {
            let mut report = self.report(tcx);
            let (_, krate) = tcx.resolver_for_lowering();
            match crate::named_fields::check(&krate.borrow(), tcx.sess.source_map()) {
                Ok(findings) => report.findings = findings,
                Err(error) => report.failure = Some(format!("{error:#}")),
            }
            self.write(&report);
        }
        Compilation::Continue
    }

    fn after_analysis<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        if self.request.rule != Rule::NamedFields {
            let mut report = self.report(tcx);
            let result = match self.request.rule {
                Rule::EntityNames => {
                    crate::entity::analysis::check(tcx).map(|entities| report.entities = entities)
                }
                Rule::Architecture => {
                    crate::ecs::extract(tcx).map(|facts| report.facts = Some(facts))
                }
                Rule::NamedFields => unreachable!(),
            };
            if let Err(error) = result {
                report.failure = Some(format!("{error:#}"));
            }
            self.write(&report);
        }
        Compilation::Continue
    }
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
        request.compiler == env!("ANALYSIS_COMPILER"),
        "Analysis driver does not match the requested compiler ABI"
    );
    let diagnostics =
        rustc_session::EarlyDiagCtxt::new(rustc_session::config::ErrorOutputType::default());
    let expanded = rustc_driver::args::arg_expand_all(&diagnostics, &args);
    let is_compile = expanded.iter().any(|arg| arg == "--crate-name");
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
    let source = expanded
        .iter()
        .skip(1)
        .filter(|arg| arg.ends_with(".rs"))
        .find_map(|arg| normalized(Path::new(arg)).ok());
    let selected = request.rule == Rule::Architecture
        || manifest
            .as_ref()
            .is_some_and(|path| request.manifest_dirs.contains(path));
    let build_script = expanded
        .windows(2)
        .any(|pair| pair[0] == "--crate-name" && pair[1] == "build_script_build");
    if !nested
        && is_compile
        && selected
        && !(request.rule == Rule::Architecture && build_script)
        && let Some(source) = source
            .filter(|source| request.rule == Rule::Architecture || request.sources.contains(source))
    {
        args.extend(["--sysroot".into(), env::var("ANALYSIS_SYSROOT")?]);
        let artifact_tag = expanded
            .iter()
            .find_map(|arg| arg.strip_prefix("extra-filename="))
            .unwrap_or_default()
            .to_owned();
        let crate_types = expanded
            .iter()
            .enumerate()
            .filter_map(|(index, argument)| {
                argument.strip_prefix("--crate-type=").or_else(|| {
                    (argument == "--crate-type")
                        .then(|| expanded.get(index + 1).map(String::as_str))
                        .flatten()
                })
            })
            .flat_map(|value| value.split(',').map(str::to_owned))
            .collect();
        rustc_driver::compiler_entrypoint(
            &args,
            &mut Checker {
                request,
                source,
                artifact_tag,
                crate_types,
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

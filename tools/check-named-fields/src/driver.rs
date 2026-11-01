//! 作为 Cargo workspace wrapper 检查当前编译配置的展开 AST。
#![feature(rustc_private)]
extern crate rustc_ast;
extern crate rustc_driver;
extern crate rustc_interface;
extern crate rustc_middle;
extern crate rustc_session;
extern crate rustc_span;

mod validate;
use anyhow::{Result, ensure};
use check_named_fields::{
    report::{Envelope, Request, Target},
    runner::normalized,
};
use rustc_driver::{Callbacks, Compilation};
use rustc_interface::interface;
use rustc_middle::ty::TyCtxt;
use std::{
    env, fs,
    path::PathBuf,
    process::{Command, ExitCode},
};

struct Checker {
    request: Request,
    source: String,
}
impl Callbacks for Checker {
    fn after_expansion<'tcx>(&mut self, _: &interface::Compiler, tcx: TyCtxt<'tcx>) -> Compilation {
        let target = Target {
            source: self.source.clone(),
            name: tcx.crate_name(rustc_span::def_id::LOCAL_CRATE).to_string(),
            test: tcx.sess.config.contains(&(rustc_span::sym::test, None)),
        };
        let (_, krate) = tcx.resolver_for_lowering();
        let result = validate::check(&krate.borrow(), tcx.sess.source_map());
        write_report(&self.request, target, result).unwrap();
        Compilation::Continue
    }
}

fn write_report(
    request: &Request,
    target: Target,
    result: Result<Vec<check_named_fields::report::Finding>>,
) -> Result<()> {
    let (findings, failure) = match result {
        Ok(findings) => (findings, None),
        Err(error) => (vec![], Some(format!("{error:#}"))),
    };
    let envelope = Envelope {
        run: request.run.clone(),
        configuration: request.configuration.clone(),
        compiler: env!("NAMED_FIELDS_RUSTC").into(),
        target,
        findings,
        failure,
    };
    let path = PathBuf::from(
        env::var_os("NAMED_FIELDS_REPORTS")
            .ok_or_else(|| anyhow::anyhow!("Missing report directory"))?,
    )
    .join(format!("{}.json", std::process::id()));
    fs::write(path, serde_json::to_vec(&envelope)?)?;
    Ok(())
}

fn run() -> Result<ExitCode> {
    let mut args: Vec<_> = env::args().skip(1).collect();
    let request: Request =
        serde_json::from_slice(&fs::read(env::var_os("NAMED_FIELDS_REQUEST").ok_or_else(
            || anyhow::anyhow!("The driver must be invoked by the named-fields checker"),
        )?)?)?;
    ensure!(!args.is_empty(), "Missing compiler invocation");
    let diagnostics =
        rustc_session::EarlyDiagCtxt::new(rustc_session::config::ErrorOutputType::default());
    // 只在识别参数时展开响应文件，实际编译保留原参数，避免 Windows 命令行超长。
    let expanded = rustc_driver::args::arg_expand_all(&diagnostics, &args);
    let source = expanded
        .iter()
        .skip(1)
        .filter(|arg| arg.ends_with(".rs"))
        .find_map(|arg| {
            normalized(std::path::Path::new(arg))
                .ok()
                .filter(|path| request.targets.contains(path))
        });
    let selected = env::var_os("CARGO_MANIFEST_DIR")
        .and_then(|path| normalized(std::path::Path::new(&path)).ok())
        .as_deref()
        == Some(&request.manifest_dir);
    if selected
        && expanded.iter().any(|arg| arg == "--crate-name")
        && let Some(source) = source
    {
        args.extend(["--sysroot".into(), env::var("NAMED_FIELDS_SYSROOT")?]);
        rustc_driver::compiler_entrypoint(&args, &mut Checker { request, source });
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
fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Named-fields driver failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

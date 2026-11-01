//! Cargo 包装器：依赖编译保留 MIR，项目目标在官方编译器回调中分析。
#![feature(rustc_private)]
extern crate rustc_abi;
extern crate rustc_const_eval;
extern crate rustc_data_structures;
extern crate rustc_driver;
extern crate rustc_hir;
extern crate rustc_index;
extern crate rustc_infer;
extern crate rustc_interface;
extern crate rustc_middle;
extern crate rustc_mir_dataflow;
extern crate rustc_session;
extern crate rustc_span;
extern crate rustc_trait_selection;
extern crate rustc_type_ir;

mod analysis;
mod bevy;
mod call_graph;
mod constants;
mod liveness;
mod mir_value;
use check_entity_names::{
    model::Report,
    workspace::{DriverReport, normalized},
};
use rustc_driver::{Callbacks, Compilation};
use rustc_interface::interface;
use rustc_middle::ty::TyCtxt;
use std::{
    collections::BTreeSet,
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

struct Checker {
    source: String,
}
impl Callbacks for Checker {
    fn after_analysis<'tcx>(
        &mut self,
        _compiler: &interface::Compiler,
        tcx: TyCtxt<'tcx>,
    ) -> Compilation {
        let result = analysis::check(tcx);
        let (report, failure) = match result {
            Ok(report) => (report, None),
            Err(error) => (Report::default(), Some(format!("{error:#}"))),
        };
        let envelope = DriverReport {
            run: env::var("ENTITY_NAME_RUN").unwrap(),
            configuration: env::var("ENTITY_NAME_CONFIGURATION").unwrap(),
            compiler: env!("ENTITY_CHECK_COMPILER").into(),
            source: self.source.clone(),
            report,
            failure,
        };
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.source.hash(&mut hash);
        let path = PathBuf::from(env::var_os("ENTITY_NAME_REPORTS").unwrap())
            .join(format!("{:x}.json", hash.finish()));
        fs::write(path, serde_json::to_vec(&envelope).unwrap()).unwrap();
        Compilation::Continue
    }
}
fn main() -> ExitCode {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let Some(compiler) = args.first().cloned() else {
        eprintln!("The driver must be invoked by the entity-name checker");
        return ExitCode::from(2);
    };
    // 识别时遵循 rustc 的 @响应文件规则，转发时保留原文件以兼容 Windows 长命令行。
    let diagnostics =
        rustc_session::EarlyDiagCtxt::new(rustc_session::config::ErrorOutputType::default());
    let expanded = rustc_driver::args::arg_expand_all(&diagnostics, &args);
    let is_compile = expanded.iter().any(|arg| arg == "--crate-name");
    if is_compile && !expanded.iter().any(|arg| arg == "-Zalways-encode-mir") {
        args.extend(["-Zalways-encode-mir".into(), "-Zmir-opt-level=0".into()]);
    }
    // 外层包装器负责所有依赖的 MIR 参数；内层 workspace 包装器才分析项目目标。
    let nested =
        Path::new(&compiler).file_stem() == Some(std::ffi::OsStr::new("check-entity-names-driver"));
    let sources: BTreeSet<String> = env::var("ENTITY_NAME_SOURCES")
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    let source = if nested {
        None
    } else {
        expanded
            .iter()
            .skip(1)
            .filter(|arg| arg.ends_with(".rs"))
            .find_map(|arg| {
                normalized(Path::new(arg))
                    .ok()
                    .filter(|path| sources.contains(path))
            })
    };
    if let Some(source) = source {
        args.extend(["--sysroot".into(), env::var("ENTITY_NAME_SYSROOT").unwrap()]);
        rustc_driver::compiler_entrypoint(&args, &mut Checker { source });
        ExitCode::SUCCESS
    } else {
        match Command::new(&compiler).args(&args[1..]).status() {
            Ok(status) => ExitCode::from(
                status
                    .code()
                    .and_then(|code| u8::try_from(code).ok())
                    .unwrap_or(2),
            ),
            Err(error) => {
                eprintln!("Cannot invoke compiler wrapper: {error}");
                ExitCode::from(2)
            }
        }
    }
}

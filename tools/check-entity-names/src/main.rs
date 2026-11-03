//! 静态检查项目创建的实体是否在初始组件或场景中声明名称。

use check_entity_names::workspace;

use std::{path::PathBuf, process::ExitCode};

use anyhow::{Result, bail};
use workspace::Options;

fn arguments() -> Result<Options> {
    let mut options = Options::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--target" => {
                options.target = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--target needs a value"))?,
                )
            }
            "--features" => options.features.extend(
                args.next()
                    .ok_or_else(|| anyhow::anyhow!("--features needs a value"))?
                    .split(',')
                    .map(str::to_owned),
            ),
            "--all-features" => options.all_features = true,
            "--help" | "-h" => {
                println!(
                    "check-entity-names [project-root] [--target TARGET] [--features A,B] [--all-features]"
                );
                std::process::exit(0);
            }
            _ if arg.starts_with('-') => bail!("Unknown argument: {arg}"),
            _ => options.root = PathBuf::from(arg),
        }
    }
    Ok(options)
}

fn main() -> ExitCode {
    match arguments().and_then(|options| workspace::check(&options)) {
        Ok(report) => {
            report.print();
            if report.has_errors() {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(error) => {
            eprintln!("Entity-name analysis failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

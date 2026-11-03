use anyhow::{Result, bail};
use check_named_fields::runner::{self, Options};
use std::{path::PathBuf, process::ExitCode};

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
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned),
            ),
            "--all-features" => options.all_features = true,
            "--help" | "-h" => {
                println!(
                    "check-named-fields [project-root] [--target TARGET] [--features A,B] [--all-features]"
                );
                std::process::exit(0);
            }
            _ if arg.starts_with('-') => bail!("Unknown argument: {arg}"),
            _ => options.root = arg.into(),
        }
    }
    Ok(options)
}

fn main() -> ExitCode {
    match arguments().and_then(|options| runner::check(&options)) {
        Ok(report) => {
            report.print();
            if report.issues.is_empty() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("Named-fields check failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

//! 规则检查、编译器提取和模型装配的统一命令入口。
use anyhow::{Result, bail};
use rustc_analysis::{Options, check_entity_names, check_named_fields, extract, model};
use std::{collections::BTreeMap, path::PathBuf, process::ExitCode};

fn run() -> Result<ExitCode> {
    let mut arguments = std::env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| "help".into());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!(
            "rustc-analysis check --rule named-fields|entity-names [--workspace PATH] [--target TARGET] [--features A,B] [--all-features]\nrustc-analysis extract --workspace PATH --out DIRECTORY [--target TARGET] [--features A,B] [--all-features]\nrustc-analysis model --facts PATH --runtime PATH --out PATH"
        );
        return Ok(ExitCode::SUCCESS);
    }
    let mut values = BTreeMap::new();
    let mut all_features = false;
    while let Some(argument) = arguments.next() {
        if argument == "--all-features" {
            all_features = true;
            continue;
        }
        if !matches!(
            argument.as_str(),
            "--rule"
                | "--workspace"
                | "--target"
                | "--features"
                | "--out"
                | "--facts"
                | "--runtime"
        ) {
            bail!("Unknown argument: {argument}");
        }
        let value = arguments
            .next()
            .ok_or_else(|| anyhow::anyhow!("{argument} needs a value"))?;
        if value.starts_with("--") {
            bail!("{argument} needs a value");
        }
        if values.insert(argument.clone(), value).is_some() {
            bail!("Repeated argument: {argument}");
        }
    }
    let allowed: &[&str] = match command.as_str() {
        "check" => &["--rule", "--workspace", "--target", "--features"],
        "extract" => &["--workspace", "--target", "--features", "--out"],
        "model" => &["--facts", "--runtime", "--out"],
        _ => bail!("Unknown command: {command}"),
    };
    for key in values.keys() {
        if !allowed.contains(&key.as_str()) {
            bail!("{key} is not supported by {command}");
        }
    }
    if command == "model" && all_features {
        bail!("--all-features is not supported by model");
    }
    let required = |name: &str| {
        values
            .get(name)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("Missing {name}"))
    };
    let mut options = Options::new(
        values
            .get("--workspace")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?),
    );
    options.target = values.get("--target").cloned();
    options.features = values
        .get("--features")
        .map(|value| {
            value
                .split(',')
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    options.all_features = all_features;
    match command.as_str() {
        "check" => match values.get("--rule").map(String::as_str) {
            Some("named-fields") => {
                let report = check_named_fields(&options)?;
                report.print();
                Ok(if report.issues.is_empty() {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::FAILURE
                })
            }
            Some("entity-names") => {
                let report = check_entity_names(&options)?;
                report.print();
                Ok(if report.has_errors() {
                    ExitCode::FAILURE
                } else {
                    ExitCode::SUCCESS
                })
            }
            _ => bail!("--rule must be named-fields or entity-names"),
        },
        "extract" => {
            extract(&options, &required("--out")?)?;
            Ok(ExitCode::SUCCESS)
        }
        "model" => {
            model::build(
                &required("--facts")?,
                &required("--runtime")?,
                &required("--out")?,
            )?;
            Ok(ExitCode::SUCCESS)
        }
        _ => bail!("Unknown command: {command}"),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Compiler analysis failed: {error:#}");
            ExitCode::from(2)
        }
    }
}

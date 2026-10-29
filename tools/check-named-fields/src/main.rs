//! 检查项目源码中的单字段包装结构体，不编译游戏或展开外部宏。

#[cfg(test)]
mod tests;

use std::{error::Error, fs, path::Path, path::PathBuf, process::ExitCode};

use syn::{Fields, ItemStruct, visit::Visit};

#[derive(Debug, PartialEq, Eq)]
struct Violation {
    path: PathBuf,
    name: String,
    line: usize,
    column: usize,
}

struct NamedFieldsVisitor<'a> {
    path: &'a Path,
    violations: Vec<Violation>,
}

impl<'ast> Visit<'ast> for NamedFieldsVisitor<'_> {
    fn visit_item_struct(&mut self, item: &'ast ItemStruct) {
        if matches!(&item.fields, Fields::Unnamed(fields) if fields.unnamed.len() == 1) {
            let start = item.ident.span().start();
            self.violations.push(Violation {
                path: self.path.to_owned(),
                name: item.ident.to_string(),
                line: start.line,
                column: start.column + 1,
            });
        }
        syn::visit::visit_item_struct(self, item);
    }
}

fn collect_sources(directory: &Path, paths: &mut Vec<PathBuf>) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_sources(&entry.path(), paths)?;
        } else if file_type.is_file() && entry.path().extension().is_some_and(|ext| ext == "rs") {
            paths.push(entry.path());
        }
    }
    Ok(())
}

fn check_project(root: &Path) -> Result<Vec<Violation>, Box<dyn Error>> {
    let mut paths = Vec::new();
    // 独立读取每个文件，平台条件、测试模块及尚未注册的模块也遵守同一规则。
    collect_sources(&root.join("src"), &mut paths)?;
    for directory in [
        "tests",
        "examples",
        "benches",
        "tools/check-named-fields/src",
    ] {
        let directory = root.join(directory);
        if directory.exists() {
            collect_sources(&directory, &mut paths)?;
        }
    }
    if root.join("build.rs").exists() {
        paths.push(root.join("build.rs"));
    }
    if paths.is_empty() {
        return Err("no project Rust sources found".into());
    }
    paths.sort();

    let mut violations = Vec::new();
    for path in paths {
        let relative = path.strip_prefix(root)?;
        let source = fs::read_to_string(&path)?;
        let syntax =
            syn::parse_file(&source).map_err(|error| format!("{}: {error}", relative.display()))?;
        let mut visitor = NamedFieldsVisitor {
            path: relative,
            violations: Vec::new(),
        };
        visitor.visit_file(&syntax);
        violations.extend(visitor.violations);
    }
    Ok(violations)
}

fn main() -> ExitCode {
    let root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
    match check_project(&root) {
        Ok(violations) if violations.is_empty() => {
            println!("Project single-field structs use named fields.");
            ExitCode::SUCCESS
        }
        Ok(violations) => {
            for violation in violations {
                eprintln!(
                    "{}:{}:{}: single-field tuple struct `{}` must use named fields",
                    violation.path.to_string_lossy().replace('\\', "/"),
                    violation.line,
                    violation.column,
                    violation.name,
                );
            }
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("Named-fields check failed: {error}");
            ExitCode::FAILURE
        }
    }
}

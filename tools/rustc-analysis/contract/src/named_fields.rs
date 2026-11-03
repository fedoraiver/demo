//! 只在会话边界转换 Span；相同声明跨编译目标合并。
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Site {
    pub path: String,
    pub line: usize,
    pub column: usize,
}

impl std::fmt::Display for Site {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}:{}", self.path, self.line, self.column)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Expansion {
    pub name: String,
    pub call: Option<Site>,
    pub definition: Option<Site>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Finding {
    pub name: String,
    pub site: Site,
    pub definition: Option<Site>,
    pub expansions: Vec<Expansion>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Target {
    pub source: String,
    pub name: String,
    pub test: bool,
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}{} ({})",
            self.name,
            if self.test { " [test]" } else { "" },
            self.source
        )
    }
}

#[derive(Serialize, Deserialize)]
pub struct Request {
    pub run: String,
    pub configuration: String,
    pub manifest_dir: String,
    pub targets: BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
pub struct Envelope {
    pub run: String,
    pub configuration: String,
    pub compiler: String,
    pub target: Target,
    pub findings: Vec<Finding>,
    pub failure: Option<String>,
}

#[derive(Debug, Default)]
pub struct Report {
    pub configuration: String,
    pub issues: BTreeMap<Finding, BTreeSet<String>>,
    pub compilations: usize,
}

impl Report {
    pub fn add(&mut self, envelope: Envelope) {
        let context = envelope.target.to_string();
        for finding in envelope.findings {
            self.issues
                .entry(finding)
                .or_default()
                .insert(context.clone());
        }
    }
    pub fn print(&self) {
        println!("Configuration: {}", self.configuration);
        for (finding, targets) in &self.issues {
            eprintln!(
                "{}: error[named-fields]: single-field tuple struct `{}` must use named fields",
                finding.site, finding.name
            );
            if let Some(site) = &finding.definition {
                eprintln!("  declaration: {site}");
            }
            for expansion in &finding.expansions {
                eprintln!("  macro: {}", expansion.name);
                if let Some(site) = &expansion.call {
                    eprintln!("    call: {site}");
                }
                if let Some(site) = &expansion.definition {
                    eprintln!("    definition: {site}");
                }
            }
            eprintln!(
                "  checked in: {}",
                targets.iter().cloned().collect::<Vec<_>>().join("; ")
            );
        }
        println!(
            "Named-fields check: {} violations, {} compilation targets.",
            self.issues.len(),
            self.compilations
        );
    }
}

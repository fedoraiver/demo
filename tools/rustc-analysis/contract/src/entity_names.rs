//! 组件存在性、名称内容和子实体分别保留证据，未知信息不能冒充已验证。

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Site {
    pub path: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum NameEvidence {
    Absent,
    Name(Option<String>),
    Required(Box<NameEvidence>),
    Unknown(String),
    Combined(Vec<NameEvidence>),
    Alternatives(Vec<NameEvidence>),
    Related(Vec<NameEvidence>),
    Roots(Vec<NameEvidence>),
    Located {
        site: Site,
        value: Box<NameEvidence>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Diagnostic {
    pub site: Site,
    pub kind: DiagnosticKind,
    pub reason: String,
    pub trace: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum DiagnosticKind {
    Violation,
    Unresolved,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Report {
    pub diagnostics: BTreeSet<Diagnostic>,
    pub entities: BTreeSet<Creation>,
    pub configuration: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Creation {
    pub site: Site,
    pub label: String,
    pub trace: Vec<String>,
}

impl Report {
    pub fn has_errors(&self) -> bool {
        !self.diagnostics.is_empty()
    }

    pub fn print(&self) {
        println!("Configuration: {}", self.configuration);
        for item in &self.diagnostics {
            println!(
                "{}:{}:{}: error[{}]: {}{}",
                item.site.path,
                item.site.line,
                item.site.column,
                match item.kind {
                    DiagnosticKind::Violation => "entity-name",
                    DiagnosticKind::Unresolved => "unresolved-name",
                },
                item.reason,
                if item.trace.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", item.trace.join(" -> "))
                }
            );
            if item.kind == DiagnosticKind::Unresolved {
                println!(
                    "  help: Trace the concrete bundle/scene source; declare Name in each entity's initial composition."
                );
            }
        }
        let violations = self
            .diagnostics
            .iter()
            .filter(|item| item.kind == DiagnosticKind::Violation)
            .count();
        println!(
            "Entity-name check: {} entity declarations, {violations} violations, {} unresolved names.",
            self.entities.len(),
            self.diagnostics.len() - violations
        );
    }

    pub fn entity(&mut self, value: &NameEvidence, site: &Site, trace: &[String], label: String) {
        for branch in alternatives(value) {
            if let NameEvidence::Roots(items) = branch {
                for (index, item) in items.iter().enumerate() {
                    self.entity(item, site, trace, format!("{label}/list[{index}]"));
                }
            } else {
                self.inspect(&branch, site, trace, label.clone());
            }
        }
    }

    fn inspect(&mut self, value: &NameEvidence, site: &Site, trace: &[String], label: String) {
        let mut names = Vec::new();
        let mut required = Vec::new();
        let mut unknown = Vec::new();
        let mut children = Vec::new();
        collect(
            value,
            &mut names,
            &mut required,
            &mut unknown,
            &mut children,
        );
        if names.is_empty() {
            names = required;
        }
        self.entities.insert(Creation {
            site: site.clone(),
            label: label.clone(),
            trace: trace.to_vec(),
        });
        let mut emit = |kind, reason: String| {
            self.diagnostics.insert(Diagnostic {
                site: site.clone(),
                kind,
                reason: format!("{label}: {reason}"),
                trace: trace.to_vec(),
            });
        };
        match names.last() {
            Some(Some(name)) if name.is_empty() => emit(
                DiagnosticKind::Violation,
                "Name is empty at creation".into(),
            ),
            Some(_) => (),
            None if unknown.is_empty() => emit(
                DiagnosticKind::Violation,
                "Name is missing at creation".into(),
            ),
            None => emit(
                DiagnosticKind::Unresolved,
                format!("Name presence cannot be determined: {}", unknown.join("; ")),
            ),
        }
        for (index, child) in children.into_iter().enumerate() {
            let (child, child_site) = match child {
                NameEvidence::Located { site, value } => (value.as_ref(), site),
                value => (value, site),
            };
            self.entity(
                child,
                child_site,
                trace,
                format!("{label}/related[{index}]"),
            );
        }
    }
}

fn alternatives(value: &NameEvidence) -> Vec<NameEvidence> {
    match value {
        NameEvidence::Alternatives(branches) => branches.iter().flat_map(alternatives).collect(),
        NameEvidence::Combined(parts) => {
            let mut products = vec![Vec::new()];
            for part in parts {
                let branches = alternatives(part);
                // 分支组合达到上限时保留未知证据，避免指数展开耗尽检查进程。
                if products.len().saturating_mul(branches.len()) > 256 {
                    return vec![NameEvidence::Unknown(
                        "scene branch combinations exceed the analysis limit".into(),
                    )];
                }
                products = products
                    .into_iter()
                    .flat_map(|prefix| {
                        branches.iter().map(move |branch| {
                            let mut next = prefix.clone();
                            next.push(branch.clone());
                            next
                        })
                    })
                    .collect();
            }
            products.into_iter().map(NameEvidence::Combined).collect()
        }
        NameEvidence::Located { site, value } => alternatives(value)
            .into_iter()
            .map(|value| NameEvidence::Located {
                site: site.clone(),
                value: Box::new(value),
            })
            .collect(),
        NameEvidence::Required(value) => alternatives(value)
            .into_iter()
            .map(|value| NameEvidence::Required(Box::new(value)))
            .collect(),
        value => vec![value.clone()],
    }
}

fn collect<'a>(
    value: &'a NameEvidence,
    names: &mut Vec<&'a Option<String>>,
    required: &mut Vec<&'a Option<String>>,
    unknown: &mut Vec<&'a str>,
    children: &mut Vec<&'a NameEvidence>,
) {
    match value {
        NameEvidence::Name(name) => names.push(name),
        NameEvidence::Unknown(reason) => unknown.push(reason),
        NameEvidence::Combined(parts) => {
            for part in parts {
                collect(part, names, required, unknown, children);
            }
        }
        NameEvidence::Related(items) | NameEvidence::Roots(items) => children.extend(items),
        NameEvidence::Located { value, .. } => collect(value, names, required, unknown, children),
        NameEvidence::Required(value) => {
            let mut nested = Vec::new();
            collect(value, required, &mut nested, unknown, children);
            required.extend(nested);
        }
        NameEvidence::Alternatives(_) => unknown.push("unresolved conditional scene composition"),
        NameEvidence::Absent => (),
    }
}

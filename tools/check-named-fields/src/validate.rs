//! 检查当前配置完成宏展开与条件编译处理后的结构体形状。
use anyhow::Result;
use check_named_fields::report::{Expansion, Finding, Site};
use rustc_ast::{
    Item, ItemKind, VariantData,
    visit::{self, Visitor},
};
use rustc_span::{Span, Symbol, source_map::SourceMap};
use std::path::Path;

struct Declaration {
    name: Symbol,
    ident: Span,
    item: Span,
}
struct Validator {
    declarations: Vec<Declaration>,
}

impl Visitor<'_> for Validator {
    fn visit_item(&mut self, item: &Item) {
        if let ItemKind::Struct(ident, _, VariantData::Tuple(fields, _)) = &item.kind
            && fields.len() == 1
        {
            self.declarations.push(Declaration {
                name: ident.name,
                ident: ident.span,
                item: item.span,
            });
        }
        visit::walk_item(self, item);
    }
}

fn site(map: &SourceMap, span: Span) -> Option<Site> {
    if span.is_dummy() {
        return None;
    }
    let position = map.lookup_char_pos(span.lo());
    let path = position
        .file
        .name
        .prefer_local_unconditionally()
        .to_string();
    let path = check_named_fields::runner::normalized(Path::new(&path))
        .unwrap_or_else(|_| path.trim_start_matches(r"\\?\").replace('\\', "/"));
    Some(Site {
        path,
        line: position.line,
        column: position.col_display + 1,
    })
}

pub fn check(krate: &rustc_ast::Crate, map: &SourceMap) -> Result<Vec<Finding>> {
    let mut validator = Validator {
        declarations: vec![],
    };
    for item in &krate.items {
        validator.visit_item(item);
    }
    validator
        .declarations
        .into_iter()
        .map(|declaration| {
            let span = if declaration.item.from_expansion() {
                declaration.item
            } else {
                declaration.ident
            };
            let primary = site(map, span.source_callsite())
                .ok_or_else(|| anyhow::anyhow!("Cannot locate struct {}", declaration.name))?;
            let definition = site(map, declaration.ident).filter(|site| site != &primary);
            let expansions = span
                .macro_backtrace()
                .map(|expansion| Expansion {
                    name: expansion.kind.descr().to_string(),
                    call: site(map, expansion.call_site.source_callsite()),
                    definition: site(map, expansion.def_site),
                })
                .collect();
            Ok(Finding {
                name: declaration.name.to_string(),
                site: primary,
                definition,
                expansions,
            })
        })
        .collect()
}

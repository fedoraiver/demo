use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tmp/named-fields-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
            ));
        fs::create_dir_all(root.join("src")).unwrap();
        Self { root }
    }

    fn write(&self, path: &str, source: &str) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn rejects_wrappers_in_nested_local_and_inactive_code_with_locations() {
    let fixture = Fixture::new();
    fixture.write(
        "src/main.rs",
        r#"pub(crate) struct Plain(pub u8);
mod nested {
    #[cfg(any())]
    pub struct Generic<'a, T>(
        #[allow(dead_code)] pub(crate) &'a T,
    ) where T: Sized;
}
fn helper() { struct Local(u16); }
#[cfg(test)] mod tests { struct TestOnly(u32); }
"#,
    );
    let violations = check_project(&fixture.root).unwrap();
    assert_eq!(
        violations
            .iter()
            .map(|violation| (violation.name.as_str(), violation.line))
            .collect::<Vec<_>>(),
        [("Plain", 1), ("Generic", 4), ("Local", 8), ("TestOnly", 9)],
    );
    assert!(violations.iter().all(|violation| violation.column > 0));
    assert!(
        violations
            .iter()
            .all(|violation| violation.path == Path::new("src/main.rs"))
    );
}

#[test]
fn accepts_named_fields_markers_tuple_variants_and_multiple_fields() {
    let fixture = Fixture::new();
    fixture.write(
        "src/main.rs",
        r###"struct Wrapper<T> { value: T }
struct Marker;
struct Empty {}
struct Pair(pub u8, pub u8);
enum Event { Value(u8), Pair(u8, u16) }
// struct Comment(u8);
/* struct BlockComment(u8); */
const TEXT: &str = "struct StringLiteral(u8);";
const RAW: &str = r#"struct RawString(u8);"#;
fn external_api() { let _ = external::Wrapper(1).0; }
"###,
    );
    assert!(check_project(&fixture.root).unwrap().is_empty());
}

#[test]
fn scans_unregistered_files_and_build_script_but_not_dependencies_or_assets() {
    let fixture = Fixture::new();
    fixture.write("src/main.rs", "fn main() {}");
    fixture.write("src/not_registered/deeper.rs", "struct Hidden(u8);");
    fixture.write("build.rs", "fn main() { struct BuildOnly(u8); }");
    fixture.write("tests/integration.rs", "struct Integration(u8);");
    fixture.write("examples/demo.rs", "struct Example(u8);");
    fixture.write("benches/speed.rs", "struct Benchmark(u8);");
    fixture.write("tools/check-named-fields/src/local.rs", "struct Tool(u8);");
    fixture.write("vendor/external.rs", "struct External(u8);");
    fixture.write("assets/example.rs", "struct Asset(u8);");
    fixture.write("tmp/scratch.rs", "struct Temporary(u8);");
    fixture.write("target/generated.rs", "struct Generated(u8);");
    fixture.write("src/notes.txt", "struct TextFile(u8);");
    let violations = check_project(&fixture.root).unwrap();
    assert_eq!(
        violations
            .iter()
            .map(|violation| (violation.path.as_path(), violation.name.as_str()))
            .collect::<Vec<_>>(),
        [
            (Path::new("benches/speed.rs"), "Benchmark"),
            (Path::new("build.rs"), "BuildOnly"),
            (Path::new("examples/demo.rs"), "Example"),
            (Path::new("src/not_registered/deeper.rs"), "Hidden"),
            (Path::new("tests/integration.rs"), "Integration"),
            (Path::new("tools/check-named-fields/src/local.rs"), "Tool"),
        ]
    );
}

#[test]
fn fails_on_invalid_rust_and_missing_sources_instead_of_silently_skipping() {
    let fixture = Fixture::new();
    assert!(check_project(&fixture.root).is_err());
    fixture.write("src/broken.rs", "struct Broken(");
    let error = check_project(&fixture.root).unwrap_err().to_string();
    assert!(error.contains("broken.rs"), "{error}");
    assert!(check_project(&fixture.root.join("missing")).is_err());
}

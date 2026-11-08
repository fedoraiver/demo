//! 模型入口只接受结构事实输入，旧的自然语言补写参数明确失败。
use std::process::Command;

#[test]
fn model_cli_rejects_removed_annotation_argument() {
    let output = Command::new(env!("CARGO_BIN_EXE_rustc-analysis"))
        .args(["model", "--annotations", "unused.json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Unknown argument: --annotations")
    );
}

#[test]
fn model_help_lists_only_fact_inputs() {
    let output = Command::new(env!("CARGO_BIN_EXE_rustc-analysis"))
        .arg("help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("model --facts PATH --runtime PATH --out PATH"));
    assert!(!help.contains("--annotations"));
}

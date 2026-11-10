#!/usr/bin/env bash
set -euo pipefail

# 统一构建和调用分析工具；全部编译产物隔离在所属检出的 tmp 下。
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
tool_manifest="$project_root/tools/rustc-analysis/Cargo.toml"
arguments=("$@")
cd "$project_root"

export CARGO_TARGET_DIR="$project_root/tmp/rustc-analysis/tool/target"
export CARGO_BUILD_BUILD_DIR="$project_root/tmp/rustc-analysis/tool/build"
compiler_root=$(rustc --print sysroot)
export PATH="$compiler_root/bin:$compiler_root/lib:$PATH"
# 直接运行 driver 及回归子进程时，也能加载固定工具链的编译器与标准库。
target_libraries=$(rustc --print target-libdir)
export LD_LIBRARY_PATH="$compiler_root/lib:$target_libraries${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

cargo build --locked --manifest-path "$tool_manifest" --workspace --bins
if [[ ${arguments[0]-} == '--build-only' ]]; then
  exit 0
fi

if [[ ${arguments[0]-} == 'verify' ]]; then
  rule=''
  for ((index = 1; index < ${#arguments[@]}; index++)); do
    if [[ ${arguments[index]} == '--rule' && $((index + 1)) -lt ${#arguments[@]} ]]; then
      rule=${arguments[index + 1]}
      break
    fi
  done
  case "$rule" in
    named-fields|entity-names) ;;
    '') echo 'verify requires --rule' >&2; exit 2 ;;
    *) echo 'Unknown verification rule' >&2; exit 2 ;;
  esac

  cargo fmt --all --manifest-path "$tool_manifest" -- --check
  cargo test --locked --manifest-path "$tool_manifest" --workspace -- --test-threads=1
  regression_manifest="$project_root/tools/check-$rule/Cargo.toml"
  cargo build --locked --manifest-path "$regression_manifest" --bins
  cargo test --locked --manifest-path "$regression_manifest" -- --test-threads=1 --skip production_source_entities_have_names_at_creation
  arguments[0]='check'
fi

exec "$CARGO_TARGET_DIR/debug/rustc-analysis" "${arguments[@]}"

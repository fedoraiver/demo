# 测试指南

本指南供开发者按变更选择验证；模块测试代码留在 `src/<feature>/tests.rs`，组织规则见 [开发规范](../development.md#测试代码组织)。各指南描述预期，不代表已经执行。实际检查、失败和未验证事项记录在对应 Issue 或 PR；用户反馈只确认其实际报告的场景。

## 四个测试层级

按验证范围区分，而非以文件名或是否无窗口区分：

- **单元测试**：验证纯函数或局部行为。
- **集成测试**：验证组件、系统或插件之间的交互。
- **系统测试**：通过公开输入与输出验证完整业务或工具管线；也可以无窗口运行。
- **验收测试**：按需求和可观察结果确认行为，可驱动的客观条件通过应用验收构建检查，主观评价由用户执行。

项目使用 Rust 原生 `#[test]` 与 Cargo。Bevy 测试以最小 `App` / `World` 和手动时间构造必要环境。应用验收脚本和音频管线使用 Python `unittest`。按变更选择有意义的层级，无需每项变更覆盖全部层级。

## Agent 验证边界

用户自行启动普通游戏查看效果，见[运行说明](../../README.md#运行)。Agent 运行[验收脚本](app-acceptance.md#当前驱动范围)执行固定场景，也可进行[探索性应用验收](#探索性应用验收)。两种方式均使用无窗程序 `demo-acceptance`，通过 Bevy BRP 发送键鼠输入和获取离屏截图。禁止使用 computer-use 启动或操作游戏。

原生窗口、屏幕呈现、检查器深层控件和声音输出按各自专项验证。原生窗口专项使用平台辅助程序时，操作前核对本次进程和前台窗口。用户提供的日志可直接分析。

Agent 可阅读代码、检查格式和编译，并执行最小 `App` / `World` 的无窗口测试。这些测试不创建游戏窗口、加载完整游戏或依赖桌面交互，与应用级测试分别报告。

交付时记录实际执行的自动检查、探索性观察及未验证项，附对应证据。

## 按变更类型选择检查

| 变更 | 检查 |
| --- | --- |
| 普通文档 | 检查内容、职责、相对链接与引用；无需运行游戏或 Rust 检查。 |
| 文档 Mermaid | 对照源码核对关系、条件与抽象层次，用锁定的 Mermaid 依赖验证语法和链接。 |
| Rust 代码 | 阅读相关实现，运行 `cargo fmt --all -- --check` 和 `cargo check --locked`。 |
| 行为 | 除 Rust 检查外，运行相应应用包的无窗口测试及受影响的[应用验收脚本](app-acceptance.md#当前驱动范围)。未实现驱动和未执行环境记为覆盖缺口。 |

普通游戏的全部无窗口 Rust 测试使用 `cargo test --locked --lib`。测试必须验证实际行为和边界，不得借测试启动游戏。

| 范围 | 指南 |
| --- | --- |
| 状态与场景 | [game_flow](game_flow.md)、[scene_assembly](scene_assembly.md) |
| 角色、物理与交互 | [character](character.md)、[physics](physics.md)、[item_interaction](item_interaction.md)、[first_person](first_person.md) |
| 界面与设置 | [ui](ui.md)、[settings](settings.md)、[window_policy](window_policy.md) |
| 音频、检查器与日志 | [audio](audio.md)、[inspector](inspector.md)、[session_log](session_log.md) |

## 本地 Rust 源码覆盖率

使用插桩报告定位普通游戏的无窗口 Rust 测试执行到的代码。覆盖率对应当前平台的 `demo` 库测试配置。Windows 下从仓库根目录打开一个临时 PowerShell 会话。若缺少 LLVM 工具，先执行 `rustup component add llvm-tools`，使用 [仓库固定工具链](../../rust-toolchain.toml) 中的版本。[Rust 插桩覆盖率](https://doc.rust-lang.org/rustc/instrument-coverage.html)

```powershell
$coverageRoot = (Get-Location).Path
$coverageRun = (New-Item -ItemType Directory -Force -Path ('tmp/coverage/run-' + [guid]::NewGuid().ToString('N'))).FullName
$env:CARGO_TARGET_DIR = Join-Path $coverageRoot 'tmp/coverage/target'
$env:LLVM_PROFILE_FILE = Join-Path $coverageRun 'demo-%p.profraw'
$env:BEVY_ASSET_ROOT = $coverageRoot

$coverageMessages = cargo rustc --locked -p demo --lib --profile test -j 2 --message-format=json -- -C instrument-coverage
if ($LASTEXITCODE -ne 0) { throw 'Failed to build the instrumented library tests.' }
$coverageTest = $coverageMessages | ConvertFrom-Json |
    Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.target.name -eq 'demo' -and $_.executable } |
    Select-Object -ExpandProperty executable
if (@($coverageTest).Count -ne 1) { throw 'Expected one demo library test executable.' }

Push-Location apps/game
try {
    & $coverageTest --test-threads=1
    if ($LASTEXITCODE -ne 0) { throw 'The library tests failed.' }
} finally {
    Pop-Location
}

$coverageHost = ((rustc -vV | Select-String '^host: ').Line -replace '^host: ')
$coverageTools = Join-Path (rustc --print sysroot) "lib/rustlib/$coverageHost/bin"
$coverageRaw = @(Get-ChildItem -LiteralPath $coverageRun -Filter 'demo-*.profraw' -File | Select-Object -ExpandProperty FullName)
$coverageData = Join-Path $coverageRun 'demo.profdata'
& (Join-Path $coverageTools 'llvm-profdata.exe') merge -sparse $coverageRaw -o $coverageData
if ($LASTEXITCODE -ne 0) { throw 'Failed to merge the coverage profiles.' }

$coverageRootPattern = [regex]::Escape($coverageRoot).Replace('\\', '[/\\]').Replace('\ ', ' ')
$coverageFilters = @(
    "-include-filename-regex=^$coverageRootPattern[/\\](src|apps[/\\]game[/\\]src)[/\\]"
    '-ignore-filename-regex=[/\\]tests[.]rs$'
)
$llvmCov = Join-Path $coverageTools 'llvm-cov.exe'
& $llvmCov report $coverageTest "-instr-profile=$coverageData" @coverageFilters | Set-Content (Join-Path $coverageRun 'summary.txt')
if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the coverage summary.' }
& $llvmCov show $coverageTest "-instr-profile=$coverageData" @coverageFilters -format=html "-output-dir=$coverageRun/html" -show-line-counts-or-regions
if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the HTML coverage report.' }
Join-Path $coverageRun 'html/index.html'
```

每次生成的 `summary.txt` 和 `html/index.html` 位于对应的 `tmp/coverage/run-*` 目录。绝对路径和 `%p` 使测试子进程切换目录后仍把计数写到同一轮目录，并各自使用独立文件。报告统计 `src/` 和 `apps/game/src/` 下具有覆盖率映射的项目源码，排除 `tests.rs`。随测试配置编译进其他文件的辅助代码仍按该文件计入。统计范围随编译目标和平台变化。[LLVM 覆盖率报告命令](https://llvm.org/docs/CommandGuide/llvm-cov.html)

## 验收测试

能用脚本驱动和判定的客观条件按[应用自动化验收](app-acceptance.md)执行。修改共享控件、输入、物理或调度时，检查受影响的使用场景。缺少脚本、工具或硬件的条件记为未验证的覆盖缺口。实际结果和未完成范围记录在对应 Issue 或 PR。

音频保留现有无窗口回归。声音输出和听感由用户自行查看，专项步骤见[音频验收](audio.md#音频验收)。

## 自动化启动准备

`demo-acceptance` 以无窗方式运行，主世界通过 Bevy Remote Protocol（BRP）默认监听 `127.0.0.1:15702`。离屏截图需要兼容的渲染适配器，可在无交互桌面的环境运行。逻辑窗口、渲染和静音方式见[验收接入](../architecture/acceptance.md)。

先关闭同一账号下此游戏的其他实例，再在本 worktree 根目录构建并运行对应脚本。安装驱动需要 Git 和 Python 3.11 或更新版本。[验收类别](app-acceptance.md#当前驱动范围)

```powershell
cargo build --locked -p demo-acceptance
python -m pip install -r scripts/acceptance/requirements.txt
python -B scripts/acceptance/menu.py
python -B scripts/acceptance/settings.py
python -B scripts/acceptance/physics.py
python -B scripts/acceptance/view.py
python -B scripts/acceptance/session_log.py
```

脚本串行运行，各自启动并关闭子进程。默认程序是 `target/debug/demo-acceptance.exe`（Windows）或 `target/debug/demo-acceptance`，可用 `--exe <path>` 指定。可用 `--port <number>` 指定本次子进程与驱动使用的 BRP 端口。条件等待上限默认 60 秒，由 `--timeout <seconds>` 调整。各类别报告、进程输出和 PNG 直接写入 `--output <directory>`，默认 `tmp/automation`。

更新验收工具时，运行 `cargo update -p bevy-acceptance-test` 刷新锁文件，再运行 `python -m pip install --force-reinstall -r scripts/acceptance/requirements.txt` 更新同一分支的 Python 驱动。用本节脚本验证两部分能配合运行。

### 共用设置与恢复

验收构建与普通游戏共用用户配置目录中的 `settings.toml`。每次脚本运行先在同目录创建 `settings.acceptance-recovery.json`，保存原文件字节或文件缺失状态，再写入测试配置。测试配置在 `[game.audio]` 中设定 `master_volume = 0`，其余字段沿用游戏默认值。同一次运行的子进程重启沿用脚本已写出的设置。脚本在每次启动前核对磁盘状态，并在发送输入前通过 BRP 核对总音量，将结果记入会话报告。[各平台设置路径](../player-guide.md#设置)

每个脚本在子进程退出后核对当前文件归属，再恢复原字节或原有的缺失状态。恢复成功后删除备份。发现外部写入或设置保存尚未完成时，保留磁盘文件和备份。备份存在期间，其他验收脚本无法启动，包括来自其他工作目录的脚本。[设置验收条件](app-acceptance.md#设置)

意外中断后，先关闭游戏，再从报告或错误消息定位备份。`saved` 记录脚本最后确认的配置版本。确认磁盘配置可恢复后，将 `original.bytes_base64` 解码为原始字节并写回 `path`。`original` 为 `null` 时，需要恢复到文件缺失的状态。若磁盘配置还有需保留的修改，先留下当前文件和备份以便合并。确认恢复结果后移走备份，再运行验收。

### 远程身份与就绪条件

脚本先读取 HTTP 响应头 `X-Bevy-Pid`，核对它等于所启动的进程，再在同一连接发送控制请求。重连后重新核对 PID。启动后依次等待远程可读、逻辑主窗口和离屏相机可用以及对应场景就绪。

### 输入、截图与收尾

脚本注入 Bevy 原生键鼠消息并观察业务结果。截图从离屏渲染目标的像素事件生成，匹配请求实体后校验格式和尺寸并编码 PNG。通用接口和数据路径见[验收接入](../architecture/acceptance.md)。

正常收尾释放脚本持有的按键和鼠标按钮，再向逻辑主窗口发送关闭消息并等待退出。出现失败或中断时保留报告和已取得的证据，并在逻辑主窗口已确认时尝试正常关闭。需要终止仍在运行的子进程时，在会话记录中标记 `forced_termination`。正式日志路径从本次会话信息关联。[共用设置与恢复](#共用设置与恢复)

Rust 无窗口验证覆盖消息输入、截图反射传输和朝向状态。Python 回归覆盖 BRP 请求、证据解析、PNG 编码、配置恢复和验收编号映射：

```powershell
cargo test --locked -p demo-acceptance --bin demo-acceptance remote_contract
cargo test --locked -p demo-acceptance --bin demo-acceptance brp_reads_and_writes_pending_yaw_before_facing_consumes_it
python -B -m unittest discover -s scripts -p 'test_acceptance*.py'
```

## 探索性应用验收

需要观察画面或排查交互时，可在本 worktree 根目录直接启动验收构建。直接启动遵循当前玩家设置及音量。需要脚本准备静音配置和退出后恢复时，使用对应的验收脚本。[共用设置与恢复](#共用设置与恢复)

```powershell
cargo run --locked -p demo-acceptance
```

用 HTTP 响应头 `X-Bevy-Pid` 核对实际游戏进程后再发送键鼠输入。重连时重新核对 PID。通过 BRP 获取离屏截图，根据画面决定下一步键鼠操作，再截图确认结果。结束时释放自己持有的键鼠，再正常关闭本次进程。[验收消息与截图接口](../architecture/acceptance.md)

探索性验证记录实际操作和观察，并附对应截图或会话日志。固定验收子项按脚本断言及其证据判定。

## 完成代码变更前的自查

按 [开发规范](../development.md) 核对以下通用项。专项回归场景见对应的模块测试文档。

- 必要的中文注释已补齐，Rust 注释格式正确，注释与代码一致，删除了失效说明。
- 系统仅声明必要的读写访问；执行依赖和延迟命令的可见时机正确。
- 功能插件注册了所需的系统、资源和消息；实体销毁后不会留下错误引用或失效缓存。
- 新增或修改的关键流程、状态变化和错误有对应日志。
- 已执行本次变更对应的格式、编译和无窗口测试检查，并记录结果；未完成的运行或视觉验证已明确列出。

如需偏离一般工程约定，在代码注释或交付说明中解释具体理由和影响，并保持偏离范围最小。一般约定的例外不能扩大 [Agent 验证边界](#agent-验证边界)，也不能以自动化名义操作普通游戏或使用 computer-use。

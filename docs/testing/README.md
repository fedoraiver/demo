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

用户自行启动普通游戏查看效果，见[运行说明](../../README.md#运行)。Agent 运行[验收脚本](app-acceptance.md#当前驱动范围)执行固定场景，也可按需进行[探索性实机验证](#探索性实机验证)。两种方式都使用启用了 `acceptance-test` 的游戏程序，通过 Bevy BRP 获取截图和发送键鼠输入。禁止使用 computer-use 启动或操作游戏。

原生窗口专项可使用平台辅助程序，操作前核对本次进程和前台窗口。性能和检查器深层控件按各自专项验证。用户提供的日志可直接分析。

Agent 可阅读代码、检查格式和编译，并执行最小 `App` / `World` 的无窗口测试。这些测试不创建游戏窗口、加载完整游戏或依赖桌面交互，与应用级测试分别报告。

交付时记录实际执行的自动检查、探索性观察及未验证项，附对应证据。

## 按变更类型选择检查

| 变更 | 检查 |
| --- | --- |
| 普通文档 | 检查内容、职责、相对链接与引用；无需运行游戏或 Rust 检查。 |
| 文档 Mermaid | 对照源码核对关系、条件与抽象层次，用锁定的 Mermaid 依赖验证语法和链接；不触发生成式 ECS 图导出或重建。 |
| 生成式 ECS 架构图 | 由 [GitHub Actions 工作流](../../.github/workflows/ecs-architecture.yml)生成、校验和发布。 |
| Rust 代码 | 阅读相关实现，运行 `cargo fmt --all -- --check` 和 `cargo check --locked`。 |
| 行为 | 除 Rust 检查外，运行相关 `cargo test --locked` 无窗口测试及受影响的[应用验收脚本](app-acceptance.md#当前驱动范围)。未实现驱动和未执行环境记为覆盖缺口。 |

需要默认配置的全部无窗口 Rust 测试时运行 `cargo test --locked`；测试必须验证实际行为和边界，不得借测试启动游戏。

| 范围 | 指南 |
| --- | --- |
| 状态与场景 | [game_flow](game_flow.md)、[scene_assembly](scene_assembly.md) |
| 角色、物理与交互 | [character](character.md)、[physics](physics.md)、[item_interaction](item_interaction.md)、[first_person](first_person.md) |
| 界面与设置 | [ui](ui.md)、[settings](settings.md)、[window_policy](window_policy.md) |
| 音频、检查器与日志 | [audio](audio.md)、[inspector](inspector.md)、[session_log](session_log.md) |

## 验收测试

能用脚本驱动和判定的客观条件按[应用自动化验收](app-acceptance.md)执行。修改共享控件、输入、物理或调度时，检查受影响的使用场景。缺少脚本、工具或硬件的条件记为未验证的覆盖缺口。实际结果和未完成范围记录在对应 Issue 或 PR。

音频保留现有无窗口回归。声音输出和听感由用户自行查看，专项步骤见[音频验收](audio.md#音频验收)。

## 自动化启动准备

启用 `acceptance-test` 后，游戏在主世界通过 Bevy Remote Protocol（BRP）监听 `127.0.0.1:15702`，并跳过检查器及 Egui。两种实机验证都需要可用的图形适配器、交互桌面和本次主窗口的焦点。

在本 worktree 根目录构建，再按[验收类别](app-acceptance.md#当前驱动范围)选择脚本。使用 Python 3.11 或更新版本：

```powershell
cargo build --locked --features acceptance-test
python -B scripts/acceptance/menu.py
python -B scripts/acceptance/settings.py
python -B scripts/acceptance/physics.py
python -B scripts/acceptance/view.py
python -B scripts/acceptance/session_log.py
```

脚本串行运行，各自启动并关闭子进程。默认程序是 `target/debug/demo.exe`（Windows）或 `target/debug/demo`，可用 `--exe <path>` 指定。条件等待上限默认 60 秒，由 `--timeout <seconds>` 调整。各类别报告、进程输出和 PNG 直接写入 `--output <directory>`，默认 `tmp/automation`。设置验收期间避免从其他进程修改同一份配置。

### 远程身份与就绪条件

脚本先读取 HTTP 响应头 `X-Bevy-Pid`，核对它等于所启动的进程，再在同一连接发送控制请求。重连后重新核对 PID。启动后依次等待远程可读、主窗口可用和对应场景就绪。发现意外失焦时停止新的交互输入，仍可释放已持有的输入并正常关闭。

### 输入、截图与收尾

脚本注入原生键鼠消息并分别观察业务结果。截图从主窗口像素事件生成，匹配请求实体后校验格式和尺寸并编码 PNG。通用接口和数据路径见[验收接入](../architecture/acceptance.md)。

正常收尾释放脚本持有的按键和鼠标按钮，再发送窗口关闭消息并等待退出。出现失败或中断时保留报告和已取得的证据，并在主窗口已确认时尝试正常关闭；尚未确认主窗口，或正常关闭失败且子进程仍在运行时，终止本次子进程并在会话记录中标记 `forced_termination`。正式日志路径从本次会话信息关联。设置脚本在游戏退出后核对磁盘并原样恢复，恢复冲突时保留备份。

Rust 无窗口验证覆盖消息输入、截图反射传输和朝向状态。Python 回归覆盖 BRP 请求、证据解析、PNG 编码、配置恢复和验收编号映射：

```powershell
cargo test --locked --features acceptance-test acceptance::
cargo test --locked --features acceptance-test brp_reads_and_writes_pending_yaw_before_facing_consumes_it
python -B -m unittest discover -s scripts -p 'test_acceptance*.py'
```

## 探索性实机验证

需要观察画面或排查交互时，Agent 可在本 worktree 启动同一个验收构建。

```powershell
cargo run --locked --features acceptance-test
```

用 HTTP 响应头 `X-Bevy-Pid` 核对实际游戏进程，并确认本次主窗口有焦点。控制请求通过已核对的连接发送，重连时重新核对 PID。通过 BRP 获取主窗口截图，根据画面决定下一步键鼠操作，再截图确认结果。意外失焦时停止新的交互输入。结束时释放自己持有的键鼠，再正常关闭本次进程。消息和截图接口见[验收接入](../architecture/acceptance.md)。

探索性验证记录实际操作和观察，并附对应截图或会话日志。固定验收子项按脚本断言及其证据判定。

## 完成代码变更前的自查

按 [开发规范](../development.md) 核对以下通用项。专项回归场景见对应的模块测试文档。

- 必要的中文注释已补齐，Rust 注释格式正确，注释与代码一致，删除了失效说明。
- 系统仅声明必要的读写访问；执行依赖和延迟命令的可见时机正确。
- 功能插件注册了所需的系统、资源和消息；实体销毁后不会留下错误引用或失效缓存。
- 新增或修改的关键流程、状态变化和错误有对应日志。
- 已执行本次变更对应的格式、编译和无窗口测试检查，并记录结果；未完成的运行或视觉验证已明确列出。

如需偏离一般工程约定，在代码注释或交付说明中解释具体理由和影响，并保持偏离范围最小。一般约定的例外不能扩大 [Agent 验证边界](#agent-验证边界)，也不能以自动化名义操作普通游戏或使用 computer-use。

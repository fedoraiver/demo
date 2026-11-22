# 测试指南

本指南供开发者按变更选择验证；模块测试代码留在 `src/<feature>/tests.rs`，组织规则见 [开发规范](../development.md#测试代码组织)。各指南描述预期，不代表已经执行。实际检查、失败和未验证事项记录在对应 Issue 或 PR；用户反馈只确认其实际报告的场景。

## 四个测试层级

按验证范围区分，而非以文件名或是否无窗口区分：

- **单元测试**：验证纯函数或局部行为。
- **集成测试**：验证组件、系统或插件之间的交互。
- **系统测试**：通过公开输入与输出验证完整业务或工具管线；也可以无窗口运行。
- **验收测试**：按需求和可观察结果确认行为，可驱动的客观条件通过应用验收构建检查，主观评价由用户执行。

项目使用 Rust 原生 `#[test]` 与 Cargo；Bevy 测试以最小 `App` / `World` 和手动时间构造必要环境。应用验收脚本和音频管线使用 Python `unittest`，架构图工具主要使用 Node 内置测试，详见 [架构图验证](../diagrams/testing.md)。按变更选择有意义的层级，无需每项变更覆盖全部层级。

## Agent 验证边界

普通游戏由用户启动和操作，Agent 只启动启用 `acceptance-test` 的游戏。所有模式均禁止使用 computer-use 操作游戏。验收的键鼠与截图通过 Bevy BRP 执行，原生窗口专项可用核对了本次进程与前台身份的平台辅助程序。用户提供的日志可直接分析。

Agent 可启用 `acceptance-test` 后启动真实窗口，通过 [验收脚本](app-acceptance.md#当前驱动范围)或原生 BRP 进行交互。原生窗口、性能和检查器深层控件按各自专项验证。音频由用户按[音频验收](game-acceptance.md#音频验收)执行。未实现工具或缺硬件属于覆盖缺口。

Agent 可阅读代码、检查格式和编译，并执行最小 `App` / `World` 的无窗口测试；这些测试不创建游戏窗口、加载完整游戏或依赖桌面交互，与应用级测试分别报告。专用调度导出及静态图检查的例外和限制见 [架构图验证](../diagrams/testing.md)。

交付时分别报告自动检查、用户实际验收及未完成项；必要人工检查给出对应步骤、预期和日志位置。

## 按变更类型选择检查

| 变更 | 检查 |
| --- | --- |
| 普通文档 | 检查内容、职责、相对链接与引用；无需运行游戏或 Rust 检查。 |
| 文档 Mermaid | 对照源码核对关系、条件与抽象层次，用锁定的 Mermaid 依赖验证语法和链接；不触发生成式 ECS 图导出或重建。 |
| 架构图、工具或产物 | 按 [架构图验证](../diagrams/testing.md) 和 [维护指南](../diagrams/maintenance.md) 选择检查；SVG 视觉验证仅在用户明确要求时执行。 |
| Rust 代码 | 阅读相关实现，运行 `cargo fmt --all -- --check` 和 `cargo check --locked`。 |
| 行为 | 除 Rust 检查外，增加或运行有针对性的无窗口测试；按[应用自动化验收](app-acceptance.md)选择受影响的场景，未实现驱动和未执行环境明确列为覆盖缺口。 |

需要全部无窗口 Rust 测试时运行 `cargo test --locked`；测试必须验证实际行为和边界，不得借测试启动游戏。

| 范围 | 指南 |
| --- | --- |
| 状态与场景 | [game_flow](game_flow.md)、[scene_assembly](scene_assembly.md) |
| 角色、物理与交互 | [character](character.md)、[physics](physics.md)、[item_interaction](item_interaction.md)、[first_person](first_person.md) |
| 界面与设置 | [ui](ui.md)、[settings](settings.md)、[window_policy](window_policy.md) |
| 音频、检查器与日志 | [audio](audio.md)、[inspector](inspector.md)、[session_log](session_log.md) |

## 验收测试

可驱动的客观条件见[应用自动化验收](app-acceptance.md)，主观判断与确实无法自动化的专项见[人工补充验收](game-acceptance.md)。模块指南维护底层测试及验收边界。普通启动按下述准备由用户执行。修改共享控件、输入、物理或调度时，须覆盖其所有使用场景。无窗口通过不代表实际窗口、设备或其他帧率与平台已经通过；实际结果和未完成范围记录在对应 Issue 或 PR。

## 验收准备

以下命令和步骤仅供用户自行执行。先按 [玩家指南](../player-guide.md#资源准备) 确认运行资源完整。排版、真实输入与声音输出必须在实际窗口与设备上确认。

在仓库根目录启动游戏；在 worktree 验收时，从该 worktree 根目录启动，并使用该目录生成的 [会话日志](../player-guide.md#会话日志)，不要混用其他检出的会话：

```powershell
cargo run --locked
```

Windows MSVC 用户先确认能够显示主菜单并创建本次会话日志，再按[菜单与窗口验收](app-acceptance.md#菜单与暂停)检查 16:9 拖拽、最大化与 DPI，并核对窗口策略安装日志。若以 `0xc0000139`（`STATUS_ENTRYPOINT_NOT_FOUND`）或其他错误在应用初始化前退出、没有新日志，保留终端退出码和构建目标；这不能证明游戏内窗口策略已运行。

## 自动化启动准备

启用 `acceptance-test` 后，游戏在主世界通过 Bevy Remote Protocol（BRP）监听 `127.0.0.1:15702`，并跳过检查器及 Egui。窗口验收需要可用的图形适配器、交互桌面和本次主窗口的焦点。音频输出由游戏原有系统管理，听感按[音频验收](game-acceptance.md#音频验收)执行。

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

Agent 也可从本 worktree 启动同一构建，核对目标进程后通过原生 BRP 交互：

```powershell
cargo run --locked --features acceptance-test
```

### 远程身份与就绪条件

脚本先读取 HTTP 响应头 `X-Bevy-Pid`，核对它等于所启动的进程，再在同一连接发送控制请求。重连后重新核对 PID。启动后依次等待远程可读、主窗口可用和对应场景就绪。发现意外失焦时停止发送操作。

### 输入、截图与收尾

脚本注入原生键鼠消息并分别观察业务结果。截图从主窗口像素事件生成，匹配请求实体后校验格式和尺寸并编码 PNG。通用接口和数据路径见[验收接入](../architecture/acceptance.md)。

正常收尾释放脚本持有的按键和鼠标按钮，再发送窗口关闭消息并等待退出。出现失败或中断时保留报告和已取得的证据，并尝试优雅关闭已启动的子进程。正式日志路径从本次会话信息关联。设置脚本在游戏退出后核对磁盘并原样恢复，恢复冲突时保留备份。

Rust 无窗口验证覆盖消息输入、截图反射传输和朝向状态。Python 回归覆盖 BRP 请求、证据解析、PNG 编码、配置恢复和验收编号映射：

```powershell
cargo test --locked --features acceptance-test acceptance::
python -B -m unittest discover -s scripts -p 'test_acceptance*.py'
```

## 完成代码变更前的自查

以下检查用于确认变更遵守 [开发规范](../development.md)，具体规则在该文档中维护：

- 必要的中文注释已补齐，Rust 注释格式正确，注释与代码一致，删除了失效说明。
- 系统仅声明必要的读写访问；执行依赖和延迟命令的可见时机正确。
- 跨固定步与渲染帧的功能已核对[显示一致性约束](../development.md#固定模拟与逐帧显示的一致性)，相关测试不会通过补跑固定步掩盖帧末错误。
- 功能插件注册了所需的系统、资源和消息；实体销毁后不会留下错误引用或失效缓存。
- 架构图更新按 [架构图维护](../diagrams/maintenance.md) 执行，不作为普通代码任务或每次提交的自查项；完成产物及自动回归检查，SVG 视觉验证遵守[默认关闭与明确启用规则](../diagrams/testing.md#架构图视觉检查)，跳过的项目不计为实际观察通过。
- 新增或修改的关键流程、状态变化和错误有对应文件日志；每次游玩创建独立会话日志并保留历史记录。
- 已执行本次变更对应的格式、编译和无窗口测试检查，并记录结果；未完成的运行或视觉验证已明确列出。

如需偏离一般工程约定，在代码注释或交付说明中解释具体理由和影响，并保持偏离范围最小。一般约定的例外不能扩大 [Agent 验证边界](#agent-验证边界)，也不能以自动化名义操作普通游戏或使用 computer-use。

# ECS 架构图维护

本指南面向维护源码模型、查看器和发布流程的开发者。本地与 [GitHub Actions](../../.github/workflows/ecs-architecture.yml) 共用 [maintain.mjs](maintain.mjs)；rustc 提取事实，真实应用导出 Schedule，Rust 装配 schema `2` 语义模型，Node 生成并校验完整图，再打包 Pages。过程不读取用途注释，也不调用大模型。模型及查看器契约见[架构图参考](README.md)。

## Actions 构建与发布

相关源码、分析工具、图包或工作流变更触发面向 `master` 的 PR 构建。PR 只检查；推送到 `master` 且成功后发布 [GitHub Pages](https://fedoraiver.github.io/demo/)。也可从 Actions 的 `ECS architecture` 手动运行；非 `master` 分支只构建，`master` 可发布。仓库 Pages 的构建来源须选择 GitHub Actions，部署环境使用 `github-pages`。

发布图表示原生 Linux 目标在导出时的注册结构。页面显示源码提交、目标及构建 ID；它不代表 Windows、macOS、其他设备能力或随后动态注册的 Schedule。部署 job 只在同轮完整检查及静态包校验成功后运行，使用 Pages 写权限和 OIDC；构建 job 只有仓库读取权限。

构建采用免费标准 `ubuntu-24.04` runner、Node 24、仓库固定 nightly 和锁定依赖。Xvfb 提供虚拟显示，Mesa Lavapipe 提供软件 Vulkan；专用导出仍完整装配插件，但不执行 Startup、游戏循环或渲染线程。无音频设备时的实际初始化结果记录在会话日志中，不通过删插件或测试夹具替代真实导出。

Puppeteer 浏览器来自图包锁定依赖，工作流显式设置 `MERMAID_CHROMIUM_PATH` 并启动检查。中文字体安装后，实际字体文件 SHA-256 和 fontconfig 版本生成 `MERMAID_RENDER_CONTEXT`；该值和浏览器字节身份共同参与图形缓存指纹。原生 Node 回归必须使用该浏览器，不能把缺少浏览器导致的跳过当作通过。

Rust 编译和对象绘图的初始并发均为 `2`，关闭开发／测试调试信息，构建限时 `240` 分钟。缓存仅保留 Cargo/npm 下载、锁定浏览器和仍须逐图核验的几何候选，不保存 Cargo 编译物或绕过事实校验。内存、磁盘或时间不足时运行失败，保留可获得的日志与资源摘要，不自动改用付费或自托管 runner，也不缩减事实或放宽校验。

同一 PR／分支的新运行取消旧构建；Pages 部署单独串行，开始前再次核对 `master` 当前提交，旧构建只留审计、不覆盖新提交。构建记录进程峰值内存和每 `15` 秒磁盘样本。完整审计输出、编译事实及执行日志作为 Actions artifact 保存 `3` 天，静态 Pages artifact 同样保存 `3` 天。历史失败、中断或未知退出不能作为本轮成功依据。

## 本地执行与恢复

完整发布流程在 Linux 原生环境执行。准备仓库工具链、PowerShell、Node、Bevy 编译依赖、虚拟显示、软件 Vulkan、中文字体及图包依赖；版本入口分别为 [rust-toolchain.toml](../../rust-toolchain.toml)、[Cargo.lock](../../Cargo.lock) 和 [package-lock.json](package-lock.json)。Linux 设备和浏览器环境可对照工作流准备，不为维护入口新建另一套 npm 环境。

在目标 checkout 内运行以下统一命令；跨目录调用时显式传入 `--workspace`。执行前核对工作树、分支和已有修改，生成不会自动暂存或提交。

```text
npm run maintain --prefix docs/diagrams -- plan
xvfb-run -a npm run maintain --prefix docs/diagrams -- run
npm run maintain --prefix docs/diagrams -- status --run-id <run-id>
npm run maintain --prefix docs/diagrams -- report --format markdown
xvfb-run -a npm run maintain --prefix docs/diagrams -- run --resume <run-id>
npm run maintain --prefix docs/diagrams -- pack-pages
npm run maintain --prefix docs/diagrams -- check-pages
```

`plan` 只读核对依赖与已有事实，列出所需阶段，不运行 Cargo、安装或导出。`run` 依次准备依赖、提取事实和真实 Schedule、装配模型、预检、生成、完整审计校验和完整 Node 回归；必要输入缺失或任一阶段非零退出均停止下游。`--resume` 使用原运行记录，仅复用输入、工具、输出与退出结果仍有效的已完成阶段；普通 `run` 建立新的历史并可复用合法检查点。

`preflight --debugdump PATH` 单独核对冻结模型与对应真实快照，不解析 Rust 或补造对象。`pack-pages --out PATH` 在完整审计通过后生成静态包；`check-pages --directory PATH` 单独核对静态包。两者默认使用 `tmp/ecs-architecture/pages/`，相对路径按所选工作区解析。

状态与原始日志位于 `tmp/ecs-architecture/maintenance/<run-id>/`，编译器输出位于 `tmp/ecs-architecture/compiler/`，工具编译物位于 `tmp/rustc-analysis/`，分析缓存及逐次报告位于 `tmp/ra/`。同一工作区执行锁冲突直接失败，不抢占已有锁或进程。跨 worktree 的共享 Cargo 编译仍由调用方串行安排。缓存细则见[构建缓存与完整性](README.md#构建缓存与完整性)。

定位失败时先读取最新阶段、attempt、退出码及对应 stdout/stderr。保留真实输入与诊断，定向修复后恢复；单图失败不清空整批缓存。恢复前核对启动环境，尤其是 `PATH`、Cargo 配置、工具链、浏览器和字体上下文。不能通过手改指纹、生成文件或结构事实消除失败。

## 完整审计与 Pages 静态包

`generated/` 只作为本地及 CI 的临时生成目录，不纳入 Git，也不使用 Git LFS。完整清单核验 schema `2` 模型、全部调用图 NDJSON、冻结源码、对象身份、关系证据及真实 Schedule；缺少调用图、哈希或准确边数不符均失败。完整审计文件是排查证据，不由网页重复下载。

打包器从已通过完整校验的产物构建独立静态包，保留全部浏览与下载所需资源、源码快照以及本地 Graphviz／Mermaid 运行库；排除主模型和调用图。发布清单独立描述静态包的实际文件与 SHA-256，不能沿用要求审计文件的完整清单再手工删文件。校验同时检查额外文件、资源闭包、相对路径、构建来源及体积预算；静态包上限为 `900000000` 字节，超出即失败。

静态包根入口为 `index.html`，架构页和源码页位于 `pages/`；项目 Pages 子路径下全部资源使用相对 URL。可从 Actions artifact 下载同轮审计、日志或静态包。[本地预览服务](README.md#本地自动预览)默认读取完整 `generated/`，可显式指定实际静态包；目录参数按仓库根解析，直接双击 HTML 不能替代 HTTP 资源加载。

```text
npm run serve --prefix docs/diagrams -- --directory tmp/ecs-architecture/pages
```

## 可选视觉诊断

自动更新与发布不包含 SVG 目测、正式页面浏览器验收或 VS Code 协议验收。这些项目不构成发布 gate，也不需要为默认跳过取得额外确认。隔离静态夹具的浏览器、文字、几何及交互自动回归仍属于完整 Node 检查。

用户明确要求视觉诊断时，可复用统一入口的 `visual plan/render/record/bind/report`。计划冻结当前清单及文件哈希；渲染保存预览和必要的原尺寸分块，截图本身不产生通过结论。只有实际观察后才记录 `passed`／`failed`、`reviewer: { "id": "检查者" }`、`actualInspection: true`、带时区的 `checkedAt`、具体 `notes`、`observedWith` 和完整 `images` 路径及哈希。检查者可以是人或工具，不要求指定 AI 模型。

```text
npm run maintain --prefix docs/diagrams -- visual plan --batch current
npm run maintain --prefix docs/diagrams -- visual render --plan <plan.json>
npm run maintain --prefix docs/diagrams -- visual record --plan <plan.json> --input <observations.json>
npm run maintain --prefix docs/diagrams -- visual report --plan <plan.json>
```

默认覆盖全部缺少有效观察的图；只有用户明确限定范围时使用 `--sample N --seed TEXT --scope TEXT`，可用 `--force-object ID` 或 `--force-view ID` 固定对象。证据索引默认保存在主检出 `tmp/ecs-architecture/visual-checks/index-v2.json`，不隐式迁移旧索引。`visual bind --commit COMMIT` 只适用于目标提交实际含有完全匹配产物的历史版本；当前不提交生成文件，日常维护无需绑定。

正式页面或外部编辑器访问被策略拒绝后，停止该目标验收，不换端口、协议、浏览器或编译夹具绕过。自动检查与实际观察分别记录；具体检查项见[验证参考](../testing/README.md#架构图视觉检查)。

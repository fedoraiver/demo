# ECS 架构图维护

正式构建与发布由 `master` 上的 [ECS architecture 工作流](../../.github/workflows/ecs-architecture.yml) 执行。工作流通过 [maintain.mjs](maintain.mjs) 提取编译器与真实调度事实、生成并校验完整架构图、运行 Node 回归，然后打包、校验及发布 Pages，并核对发布的资源清单。模型及查看器契约见[架构图参考](README.md)。

架构图表示原生 Linux 目标在导出时的注册结构，不代表 Windows、macOS、其他设备能力或随后动态注册的 Schedule。源码提交、目标及构建 ID 保存在启动数据和清单中，用于校验同轮资源。

## 调度导出边界

工作流使用 `--dump-schedules` 装配插件并导出调度，可能访问 GPU、音频设备或资产。Xvfb 提供虚拟显示，Mesa Lavapipe 提供软件 Vulkan，设备初始化结果见会话日志。导出停止在应用运行前，不执行 `Startup`、游戏循环或渲染线程。架构图使用与构建身份匹配的真实调度快照。

## 工作流故障排查

排查工作流故障时，可在 Linux 原生环境复现。准备仓库工具链、Bash、Node、Bevy 编译依赖、虚拟显示、软件 Vulkan、中文字体及图包依赖。版本以 [rust-toolchain.toml](../../rust-toolchain.toml)、[Cargo.lock](../../Cargo.lock) 和 [package-lock.json](package-lock.json) 为准。维护入口使用图包自身的 npm 环境。架构事实提取使用的编译器宿主必须匹配被调用的编译器提交。

在 `docs/diagrams/` 目录执行 `npm ci --foreground-scripts` 安装依赖，再执行 `npm exec --yes=false -- puppeteer browsers install chrome` 安装图包锁定版本的 Puppeteer 浏览器。`package.json` 的 `allowScripts` 只批准锁定版本的 esbuild 与 Puppeteer 安装脚本，版本升级时同步复核。复现完整浏览器回归时，将 `MERMAID_CHROMIUM_PATH` 和 `MAINTENANCE_VISUAL_CHROMIUM` 都设为该锁定浏览器的路径并确认能启动。按清单中所有实际字体文件的 SHA-256 和 fontconfig 版本提供 `MERMAID_RENDER_CONTEXT`，该值与浏览器字节身份共同参与图形缓存指纹。原生 Node 回归使用该浏览器，浏览器缺失导致跳过时不能视为通过。

在目标 checkout 内运行以下统一命令；从其他目录调用时，`--prefix` 须指向维护脚本所在的图包目录。`--workspace` 默认指向脚本所在 worktree；`run` 及恢复运行须使用该 worktree，`plan`、预检和静态包命令可显式指定其他 worktree。执行前核对工作树、分支和已有修改，生成不会自动暂存或提交。

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

`generated/` 只作为临时生成目录，不纳入 Git，也不使用 Git LFS。完整清单核验 schema `2` 模型、全部调用图 NDJSON、冻结源码、对象身份、关系证据及真实 Schedule；缺少调用图、哈希或准确边数不符均失败。完整审计文件是排查证据，不由网页重复下载。

页面启动与外置运行数据使用 schema `7`，完整架构数据包使用 schema `6`，Mermaid 几何输入版本见[渲染身份](src/mermaid-cache.mjs)。完整检查从原模型独立推导可见规范关系、函数卡片成员和显示边分组，核对每条可见关系恰好属于一个显示组以及两侧成员方向。赋值 `modify` 保留在原模型审计，网页展示范围与[显示规则](README.md#对象专属图)一致。混用旧运行数据、组成员或几何输入的产物须重新生成。

打包器从已通过完整校验的产物构建独立静态包，保留全部浏览与下载所需资源、源码快照以及本地 Graphviz／Mermaid 运行库，排除主模型、调用图和编译事实；删减审计文件只能由打包器完成，不能直接修改完整审计清单。完整 SVG 下载使用静态原生产物，查看器的[连线流动](README.md#节点与连线视觉规范)由页面独立维护。发布清单独立描述静态包的实际文件与 SHA-256，不能沿用要求审计文件的完整清单再手工删文件。校验同时检查额外文件、资源闭包、相对路径、构建来源及体积预算；静态包上限为 `900000000` 字节，超出即失败。

静态包根入口为 `index.html`，架构页和源码页位于 `pages/`；项目 Pages 子路径下全部资源使用相对 URL。[本地预览服务](README.md#本地自动预览)默认读取完整 `generated/`，可显式指定实际静态包；目录参数按仓库根解析，直接双击 HTML 不能替代 HTTP 资源加载。

```text
npm run serve --prefix docs/diagrams -- --directory tmp/ecs-architecture/pages
```

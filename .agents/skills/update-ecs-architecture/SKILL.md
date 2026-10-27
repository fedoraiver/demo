---
name: update-ecs-architecture
description: 更新、核对或修复本项目的 ECS 架构图，包括真实 Schedule 导出、逐对象关系、Graphviz／Mermaid 产物、源码快照和视觉检查。用于架构图维护请求。
---

# 更新 ECS 架构图

在当前工作区维护 `docs/diagrams/`。Schedule 图使用真实应用的 debugdump 导出与 Graphviz；对象图使用已核对清单与 Mermaid。用户明确的维护范围优先，不据本 Skill 增设审批。

## 读取与范围

- 从仓库根读取 [AGENTS.md](../../../AGENTS.md)、[开发规范](../../../docs/development.md)、[当前架构](../../../docs/architecture.md)、[验证参考](../../../docs/testing/README.md)及[图的说明](../../../docs/diagrams/README.md)。
- 检查 `git status --short`、暂存与未暂存 diff。使用用户指定基线；未指定时对照原产物、清单和当前源码，保留用户修改。
- 核对 `build-ecs.mjs`、调度导出与导入模块、`ecs-data.json`、对象目录、源码策略、查看器及对应 Rust 源码。修改维护入口，不手改生成 HTML、SVG 路径或源码快照。
- 原图、diff、日志及截图放根 `tmp/ecs-architecture/` 下的任务目录；正式产物留在 `docs/diagrams/`。只在用户要求时暂存或提交。

## Schedule 导出与导入

按[调度快照](../../../docs/diagrams/README.md#调度快照)核对覆盖和边界。导出复用真实应用装配，在插件就绪并完成 `finish` 后、`cleanup` 前，记录主应用及可访问子应用中的全部已注册 Schedule。应用与 Schedule 共同标识图，不按标签名称合并不同应用的调度。

真实导出由用户执行：

```powershell
cargo run --locked --features debugdump -- --dump-schedules tmp/debugdump
```

导出不进入游戏循环、不执行 Startup，但完整装配可能初始化 GPU、音频设备及资产。遵守[Agent 验证边界](../../../docs/testing/README.md#agent-验证边界)：Agent 不运行该完整导出；仅运行最小无窗口夹具和静态文档构建。缺少有效导出时完成独立工作并明确缺项，不用测试夹具或旧系统图冒充真实结果。

检查导出清单的应用、Schedule、稳定文件身份、依赖版本、内容哈希及源码指纹。缺失、冲突或过期输入必须使导入失败。正式清单、DOT、SVG 和 HTML 一起保留，源码指纹匹配时可从正式 DOT 离线重建。

Graphviz 由锁定的 `@viz-js/viz` 生成默认 SVG，并在浏览器离线 Worker 中按需重排筛选后的 Schedule。呈现样式在布局前应用，系统、集合和依赖线复用对象样式，位置与路径仍由 Graphviz 产生；不套用 Mermaid 的身份或严格走线检查，不手工接线、改箭头或补画关系。它表达注册快照，不表示条件成立、系统实际执行、后续动态注册或 Observer 触发关系，也不拼接跨 Schedule 总序。

维护[调度筛选](../../../docs/diagrams/README.md#调度筛选与重新布局)时，核对包含／排除下拉按来源 Plugin 组多选、目录与完整路径的对应、未知来源及无当前系统的已选组；不把定义路径当作实际注册 Plugin 的证据。搜索仅缩小选项范围，集合名不参与筛选；核对多组并集、空包含与排除优先，以及旧完整名称、旧文本条件的兼容和取消。应用／Enter 提交后保留命中系统、必要祖先集合与 marker，以及两端仍存在的原边，不加入未命中系统邻居或跨删除节点补边；原生上下文端点按该节规则保留，不补造名称或计入系统数。空筛选直接恢复默认 SVG，不初始化 WASM；零命中与失败明确反馈。保留原始 DOT、来源哈希及节点身份，核对中间模型的边、有效属性和集合层级，以及分组元数据与来源的对应；不把限定的 debugdump 转换器当作通用 DOT 无损解析器。

## 对象模型与源码核对

对象清单继续维护系统、Observer、实体、组件、资源、消息、访问和注册事实；删除旧系统页不删除对象目录依赖的共享数据。核对真实声明、注册、SystemSet、运行条件、显式顺序与延迟命令可见时机，区分 Component、Resource、Local、NonSend、QueryData、SystemParam、helper 及普通实体引用。数据访问、插件装配和 Schedule 执行顺序分别表达。

保留稳定节点、关系、原实体投影和各次注册身份；别名只连接同一声明，不按显示名、类型、函数或 canonical Entity 合并对象。复合消息与泛型聚合按真实类型拆分，旧聚合只保留候选映射，不任选一个对象。

按[对象专属图](../../../docs/diagrams/README.md#对象专属图)核对每个生产对象恰好一图：中心唯一，`Plugin`／`PluginGroup` 中心只保留单卡与零可见边；其余对象包含全部直接邻居及中心的全部入出边，不递归扩展、不加入邻居之间的边。中心 `kind=Entity` 时再过滤全部 Component 及触及它们的边，并按剩余端点重算可见邻居；无可见关系时保留中心单卡。全局对象、关系目录、其他对象图的插件关系及右侧完整组件清单不删减。组件投影归属来自 `model.entities[*].components`，不按名称或 ID 前缀猜测。

统一关系包含实体挂载、系统访问与组件操作、消息与事件、实体引用与关系、注册、集合成员及显式顺序。逐条区分字段读取、可变访问、实际修改、添加、移除、存在过滤与反射。`With`／`Without`／`Has`、Option 查询或存在判断不自动等于字段读取，`writes` 不证明插入或移除。追踪 helper、World 闭包、Commands 和关系 hook 的真实条件、生效时机及证据；helper 不冒充注册系统，未核实操作保留缺口。

按[源码范围](../../../docs/diagrams/README.md#源码范围)逐类核对 `sourceEntries`：Component 仅真实定义；Entity 提供创建与销毁；System／Observer 提供定义及该对象对应注册；其他类别依规范表。原 `source` 不自动成为定义入口；必要入口缺证据时写入 `sourceGaps`，不得用普通使用处或虚构实现补齐。操作边定位实际操作、参数或配置。

项目声明通过定位模块核对；依赖定义使用锁定包身份、泛型实参及 `cargo metadata --locked --offline` 获取的真实源码。核对别名、宏声明、同名二维／三维类型、声明唯一性、行列、目录边界、来源角色与完整快照，不硬写本机 Cargo 根目录，不让工作区配置覆盖依赖根。

保留业务系统 → tracing producer，再分 File worker → 会话文件与 Console worker 的日志拓扑。文件保持 External I/O 身份及真实创建入口，不增设没有依据的队列、stderr 或退出关系。

## 对象绘图与页面交互

按[视觉规范](../../../docs/diagrams/README.md#节点与连线视觉规范)与[Mermaid 布局](../../../docs/diagrams/README.md#mermaid-布局与连线)生成对象图。分类目录维护语义 kind，样式模块维护形状和配色，不能相互推断。保留真实关系、相反读写方向、有向环和原生布局；不可见布局约束不增加业务身份或执行关系。

全部 Mermaid 原生候选执行同一严格几何检查，核对真实轮廓、路径、源端接触、目标箭头、标签背景及遮挡，不能只检查包围框。默认 `padding=16`；仅其他检查全部通过而源端接触失败时可试 `padding=4`，随后重跑完整检查。不得手工移动连线、箭头或标签、删边或放宽容差。

对象右栏按[节点详情](../../../docs/diagrams/README.md#节点详情)保留完整说明、归属、注册、Query、字段、组件清单和源码，核对 System 不显示“约束与说明”的例外；不因显示范围删减共享数据。Read／Write 分别按 canonical Entity 去重，显示归并不删原记录。同函数其他注册有独立入口。源码编辑器、复制反馈、工作区与依赖定位遵守[源码定位验证](../../../docs/testing/README.md#架构图源码定位验证)。

查看器使用顶部选图，不保留左侧导航；Schedule 按应用分组，默认主应用 `Update`，缺失时选首个非空调度。Schedule 占满画布，不显示右栏、分隔条或对象图例，原生节点不做对象联动。对象图保留选择、详情、图例、源码及可调整面板；全局对象搜索和旧聚合候选显示在顶栏浮层，不占用详情栏。搜索进入普通对象后选图控件显示当前对象。两类图均支持平移、缩放、适合窗口及历史恢复；Plugin 入口和“打开所属插件”进入对应 Plugin／PluginGroup 单卡图。

核对 `schedule`、重复的 `scheduleIncludePlugin`／`scheduleExcludePlugin`、兼容的系统与文本筛选参数、`object`、`node` 及来源上下文；过滤随 URL、刷新、返回原视图和浏览器历史恢复，输入草稿不冒充已应用条件。切 Schedule 后仍可取消没有本图系统的已选组及旧条件；检查逐项选择、批量选择当前搜索结果中有系统的组、单栏及全部清空。旧总览进入默认调度，旧插件链接的有效节点进入精确对象，无节点时进入插件对象，旧 component 与聚合候选继续迁移。保留 workspace、其他参数和片段，兼容使用历史替换。焦点、面板、搜索、选择恢复及复制反馈按图的说明与验证参考检查，不让选择或 `paint` 抢其他控件焦点。

## 生成与校验

已有有效正式 DOT 时直接重建；Rust 源码或锁定依赖变化时先由用户提供新的真实导出。从仓库根依次运行，失败修复后重试：

```text
npm ci --prefix docs/diagrams
node docs/diagrams/build-ecs.mjs --debugdump tmp/debugdump
node docs/diagrams/check-ecs.mjs
node --test docs/diagrams/*.test.mjs
```

已有有效正式调度清单与 DOT 时，可省略 `--debugdump`；仅查看器、筛选模型或样式变化不要求重新运行应用，也不触发 Rust 检查。Node.js、渲染器及编译要求以锁定依赖为准；Mermaid Chromium 只用于文档编译。默认 SVG 与对象图直接内嵌，Schedule 筛选使用内嵌 Graphviz WASM Worker，不加载 CDN 或额外脚本、字体及 WASM。核对 Worker 复用、取消、过时响应、SVG 安全检查与失败时的静态图恢复；分发内嵌运行库时保留对应许可证与来源说明。

动态产物清单只包含 Schedule DOT／默认 SVG 和 object Mermaid／SVG，以及两份 HTML、内嵌调度模型和源码快照；旧总览、插件及基础设施系统图不残留。筛选结果不覆盖正式产物。校验器按 engine 分派：Graphviz 核对清单、来源、尺寸与输入输出对应；Mermaid object 保留原身份、单卡／一跳可见投影、源码与几何检查。自动审计不代替源码核对，也不保证发现全部遗漏的 Rust 行为。

## 视觉检查与交付

按[架构图视觉检查](../../../docs/testing/README.md#架构图视觉检查)实际查看最终 HTML 的全部 Schedule 与对象图，以及动态清单中的全部独立 SVG。已有逐图基线时按 SHA-256 复用未变化记录，重新目测变化产物，确认最终清单全部覆盖；变化交互仍须实际桌面浏览器验证。

检查完整文字、原生箭头、裁切与遮挡，Schedule 背景与画布同为 `#F6F8FB`，集合标题不被连线遮挡；对象图另查中心、单卡或一跳邻居、组件清单、语义样式、详情及源码。实际验证顶栏选图与对象搜索浮层、Schedule 无右栏、插件单卡、严格筛选与离线重新布局、旧链接、别名候选、返回与历史、平移缩放、面板、焦点、复制及工作区配置。桌面浏览器缩窄窗口检查布局，不要求手机或真实触屏验收。空筛选须直接恢复静态图，筛选不得加载网络资源；静态编译或 Node WASM 成功不代表浏览器验收或 VS Code 实际打开。

分别报告真实导出／导入、代码与模型检查、全部 SVG 目测、HTML 浏览器及协议验收。列出具体变化、完成范围与未验证项；执行记录放对应 Issue／PR，长期文档只保留可复用指导。临时材料放根 tmp，不启动或操作游戏，不使用编译浏览器绕过本地文档访问限制。

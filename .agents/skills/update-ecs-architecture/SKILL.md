---
name: update-ecs-architecture
description: 更新、核对或修复本项目的 ECS 架构图，包括源码语义、插件系统图、逐对象关系图、Mermaid 编译产物、源码快照、生成校验及视觉检查。用于架构图维护请求。
---

# 更新 ECS 架构图

在当前工作区维护 `docs/diagrams/`，以当前 Rust 源码、锁定依赖和已核实清单为准。

## 读取与范围

- 从仓库根读取 [AGENTS.md](../../../AGENTS.md)、[开发规范](../../../docs/development.md)、[当前架构](../../../docs/architecture.md)、[验证指南](../../../docs/testing/README.md)和[图的说明](../../../docs/diagrams/README.md)。
- 核对 `ecs-data.json`、`build-ecs.mjs`、`architecture-model.mjs`、`architecture-objects.mjs`、`architecture-kinds.mjs`、`architecture-components.mjs`、`architecture-source-policy.mjs`、`architecture-source-evidence.mjs`，以及渲染、编译、查看器与对应 Rust 源码。布局和部分说明属于生成模块，不只改 JSON，也不手画生成 SVG。
- 检查 `git status --short`、暂存与未暂存 diff，使用用户指定基线；未指定时从原图和清单对照当前源码，不只看最近提交。保留用户已有修改。
- 原图、diff、日志和截图保存到根 `tmp/ecs-architecture/` 下独立任务目录；正式产物留在 `docs/diagrams/`。用户明确的维护范围优先，不据本 Skill 增设审批。

## 源码与模型核对

核对插件显式装配、系统及 Observer 注册、Schedule／SystemSet、运行条件、真实顺序与延迟命令可见时机；区分 Component、Resource、Local、NonSend、QueryData、SystemParam、普通辅助值及实体引用。核对 ChildOf 等关系、生成销毁、消息／事件与 Observer 条件，不把数据访问画成执行先后。

14 个项目插件及 Bevy、Avian、Enhanced Input、Kira、Egui 五个基础设施入口只保留“系统与调度”和明确空态；Observer 在事件发出系统旁形成局部分支，不伪造固定 Schedule。系统图按精确事件对象将“来源 → 事件 → Observer”投影为标有事件名的直接触发线，保留原关系 ID、实际条件、生效时机与源码证据；原始关系和事件对象继续在对象图浏览，投影线不进入统一关系目录，也不扩大对象图的一跳范围。多来源不复制 Observer，不按事件名合并对象，不把全部 Observer 串成统一区域或排版链；同一发出位置的直接回调可用局部无环不可见约束控制扇出宽度。实体、组件、资源、消息及其他生产对象通过各自对象图浏览，完整对象及关系目录不因视图过滤删减。`architecture-infrastructure.mjs` 维护入口、分节和文件前缀；四个第三方入口位于 Bevy 之前，插值归 Avian，Inspector 归 Egui，浏览归属不覆盖真实定义来源。系统优先使用明确 feature，否则沿用 module／提供方规则。

保留稳定节点、关系和原注册身份；别名只连接同一声明与身份，不按名称合并。每个组件投影和系统／Observer 注册分别建图，同类型、同函数及 canonical Entity 不作为合并身份。普通插件视图维持各注册的调度语义；SystemSet／Engine flow 的多个阶段保留为原对象配置，不机械复制成系统。插件局部视图的外部引用提供摘要和所属插件入口，不复制其他插件内部流程。`main / App` 纯插件装配边在系统视图过滤，在对象图中保留；项目安装第三方插件及退出刷新等其他真实关系不丢失。旧混合第三方 node 链接按真实归属替换到当前入口，无效旧入口回总览，保留工作区及其他 URL 状态。

功能总览按 [App 调度总览](../../../docs/diagrams/README.md#app-调度总览) 汇总全部项目系统及已核实的引擎／第三方集合、同步与聚合流程，保留 `overview` 视图和导航身份。核对启动、每帧与固定循环的真实驱动边界及全部运行时注册覆盖，不以插件依赖或安装顺序替代系统顺序，也不将静态清单视为全部引擎内部系统。Observer、原生回调、Egui 内部驱动和 RenderApp 的边界按该规范分别表达；插件入口继续从侧栏或所属插件跳转。

Entity、Component 使用与 System 相同的原生圆角矩形，保留各自配色及描边；Entity 保持单层砖红轮廓，完整组件清单位于右侧。从 `model.entities[*].components` 取得精确投影归属，不按 ID 前缀、显示名或中文 owner 猜测。清单补齐不递归添加其他实体、系统或业务关系。对象图保留真实 `from`／`to` 与关系 ID，不将组件端点替换为实体。

按[对象专属图](../../../docs/diagrams/README.md#对象专属图)对照生产 Rust 声明、实际注册、锁定包身份和泛型实参补齐对象目录。普通 helper、测试专用声明与说明卡片不独立产图；关系记录继续为边及详情，真实关系组件仍生成 Component 图。复合消息和泛型聚合按已核实实际对象拆分，旧聚合入口保留候选映射，不任选一个对象。每个对象恰好一图，中心唯一，包含全部直接邻居及中心的全部入出边，不递归扩展，也不加入邻居之间的边；孤立对象生成单卡图。

仅中心 `kind=Entity` 的对象图隐藏全部 Component 卡片及所有触及 Component 的边，再由中心与剩余边端点重算可见节点；按此可见投影检查一跳完整性，过滤后无边则保留中心单卡。全局对象与关系目录保持完整，Component 自身图继续展示关联 Entity。实体右侧完整组件清单及各投影入口保留，节点 ID 与 URL 不变。

统一关系目录汇集实体包含、系统读写及组件操作事实、消息与事件、实体关系、注册、集合成员和显式调度约束，不仅筛选原 `system_links`。逐条核对字段读取、可变访问／修改、添加、移除、存在过滤和反射行为。`With`／`Without`／`Has`、Option 查询或只判断存在的 get 不等于字段读取，reads／writes 不能独立证明生命周期操作。追踪普通 helper、World 闭包、Commands 与关系 hook 的实际位置、条件和生效时机；helper 不冒充注册 System，仅有访问声明时保留其证据级别，缺证据的操作不画成确定业务边。

源码范围的唯一维护表位于[源码范围](../../../docs/diagrams/README.md#源码范围)。逐类按语义身份核对节点 `sourceEntries`，而非按视觉形状；Component 仅定义，Entity 创建与销毁，System／Observer 定义与该对象对应注册，其余类别按表检查。同函数其他注册保留独立对象入口，测试注册标明 scope，不增加生产对象。操作边独立定位真实操作、参数或配置。原 source 保留使用／注册语义，不能自动提升为定义；没有证据的必要入口写入 sourceGaps 并明确待核实，不能借普通使用处或虚构函数填满。

项目声明通过 `source-locator.mjs` 定位；Bevy／第三方的真实定义通过 `architecture-source-definitions.mjs` 和 `dependency-sources.mjs` 读取锁定依赖。核对提供包、别名、宏声明、Avian 二维／三维重名定义、PlayTypedChannels 及 ApplyDeferred 的真实定义和注册来源。Cargo 路径来自 `cargo metadata --locked --offline`，不硬编码本机根目录；验证唯一声明、包名版本、文件行列、目录边界、定义来源与完整快照，项目工作区配置不覆盖依赖根。

日志拓扑保留业务系统 → tracing producer，再分 File worker → 会话文件与 Console worker 两路，可沿各对象图逐步浏览；`physics-file-log` 保留 External I/O 身份与 `create_session_file` 入口，不新增队列、stderr 或扩大退出刷新关系。

## 绘图与右栏

使用真实 Mermaid 定义与编译，不手改最终路径或补画代理矩形。按[分类与视觉规范](../../../docs/diagrams/README.md#节点与连线视觉规范)维护类别、名称、短用途、选中效果和图例；`architecture-kinds.mjs` 与 `architecture-style.mjs` 分别维护语义身份和视觉表达，不得以样式猜测或覆盖 kind。分类依据真实声明，辅助函数、分组和流程聚合不冒充单个 System，缺少证据时标待核实。完整 description、字段、查询、约束及视图摘要作为数据保留。

按[布局规则](../../../docs/diagrams/README.md#mermaid-布局与连线)核对方向、Schedule 标题、对象图中心和直接邻居。系统图及总览使用统一 Dagre 原生布局，保持阶段横排、真实系统纵排，所有候选遵守相同严格几何检查。分组的 `nodes` 只记录真实成员，Observer 与无固定 Schedule 的触发流程可作为来源分组的 `visualAttachments` 形成局部分支；没有唯一阶段来源的组件记录于 `view.observerBranches`。物理声明与真实成员分开核对，三者联合完整覆盖且每个节点唯一，不据排版包含关系推断 Schedule 注册。Schedule 阶段驱动、系统 `kind=order` 与不可见 `layoutLinks` 分开维护；加长不可见连线仍保留稳定 ID 和真实端点，排版容器不增加业务身份、关系端点或隐含执行边。完整注册参数和测试 scope 留在详情，不混入运行时分组标题。

所有原生布局候选保留唯一节点、真实关系、相反读写方向和有向环，并通过 `architecture-routing.mjs` 的同一套严格检查。直线／曲线、真实轮廓、端点与标签的数值规则由上述布局规范维护，不能只检查包围框。

同时检查源端路径起点、目标原生箭头尖端与自身真实轮廓贴合，以及原生标签背景不遮挡卡片或标题。默认 flowchart.padding=16；只有其他检查全通过而仅源端接触失败时，同一原生候选才可尝试 padding=4，再跑完整校验。不得手工接线、移动箭头／标签、删边、增加虚假端点或放宽容差。

按[节点详情](../../../docs/diagrams/README.md#节点详情)核对右栏的完整说明、归属、访问与注册记录、组件清单和源码分组。Read／Write 分别按 canonical Entity 去重；显示归并不删原始记录，专属图不以局部组件访问摘要代替完整 System 信息。

按[焦点规则](../../../docs/diagrams/README.md#画布交互与焦点)核对指针与键盘操作、清除选择和历史恢复。焦点迁移不改变滚动或视角，不抢其他控件焦点；`paint` 不迁移焦点。选择效果不得改变外部虚线或透明填充，切页、取消与重复选择准确恢复。

图例从当前视图实际类别动态取得，不为补齐类别新增业务节点，也不混入业务 SVG。界面、图例样例与面板尺寸按图的说明核对，不另存一套视觉参数。

节点、连线的源码区共用 `source-editor.mjs` 的 VS Code、可选择定位与复制反馈，只渲染审阅后的 sourceEntries；独立源码页从 README 进入，完整项目与依赖快照继续生成。配置、协议、复制成功两秒恢复、失败手动复制、异步失效与无障碍反馈按[源码定位验证](../../../docs/testing/README.md#架构图源码定位验证)检查，不能以页面请求冒充编辑器已打开。

## 生成与自动校验

全部对象 SVG／同名 .mmd 与普通视图在生成时编译并内嵌 HTML，动态 views 决定产物清单；浏览器只读取已有 SVG，不运行 Mermaid 编译，也不加载 CDN。object URL 参数使用原投影或注册 ID，保留 feature／tab 来源上下文、node、workspace、其他查询与片段。旧 component 精确迁移到原投影，旧 data/events 带有效对象节点进入对象图，否则回所属系统页，使用 replaceState 兼容。全局搜索覆盖全部对象并以实体或注册阶段区分同名结果；卡片单击显示详情，通过明确入口进入对象图，同图中心仅选择，历史返回恢复节点与画布位置。

从仓库根依次运行，每条成功后继续，失败修复并重试：

```text
npm ci --prefix docs/diagrams
node docs/diagrams/build-ecs.mjs
node docs/diagrams/check-ecs.mjs
node --test docs/diagrams/*.test.mjs
```

Node.js 最低版本22.13.0，实际要求以 package.json 和 lockfile 为准；必要时使用环境已有合适运行时，不将个人路径写进仓库。Mermaid 初始化使用共享 maxTextSize=200000，frontmatter 保留完整配置；headless Chromium 可由 MERMAID_CHROMIUM_PATH 指定，否则自动查找 Chrome／Edge，只用于图编译。

生成覆盖两份 HTML、总览、非空项目／基础设施系统页及全部 `ecs-object-*.svg`／`.mmd`，旧 data/events、组件类型图及其他过期产物按动态清单清理。检查最终 diff，并对照生成前基线核对规范类别、节点／关系 ID、全部注册、生产声明与精确投影覆盖、每对象一图、按可见投影的一跳入出边完整性、有效源码入口、导航参数、依赖定义与快照；不得因分类迁移静默丢失业务信息。校验器不理解所有 Rust 语义，不能发现全部遗漏系统或操作；自动通过不替代人工对照源码。仅用户要求时暂存或提交。

## 视觉检查与交付

按[架构图视觉检查](../../../docs/testing/README.md#架构图视觉检查)实际查看最终 HTML 的总览、全部插件与基础设施系统页和空态、全部对象图及动态清单中的所有独立 SVG。先看整体，再放大变化区域，检查完整文字、普通 Entity、对象中心及可见直接邻居、原生箭头与真实端点、遮挡裁切、全部节点和连线类型，以及右侧完整详情、源码分组和缺证据提示。已有逐图目测基线时，按 SHA-256 复用未变化 SVG 的记录，只重新目测变化产物，并确认最终动态清单全部被覆盖；变化交互仍需实际浏览器检查。

实际桌面浏览器验证全局对象搜索、详情／组件清单／端点进入对象图、同名投影和不同注册、旧链接与聚合候选、关联对象及所属插件导航、返回与前进后退、断网浏览、鼠标平移缩放、分组定位、面板240px、键盘焦点、取消恢复、复制与工作区配置；静态编译不能代替这些操作验收。验收环境范围以[架构图视觉检查](../../../docs/testing/README.md#架构图视觉检查)为准。

截图、日志和临时副本放根 tmp；不要启动或操作游戏，不使用编译浏览器绕过本地文档访问限制。生成、模型／源码策略校验、全部SVG视觉和HTML真实浏览器检查分别记录，未完成项明确原因与范围。交付列源码核对范围、具体变化、实际验证和未完成事项；执行结果写入对应Issue／PR，长期文档只保留可复用指导。

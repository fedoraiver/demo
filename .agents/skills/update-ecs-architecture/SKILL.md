---
name: update-ecs-architecture
description: 更新、核对或修复本项目的 ECS 架构图，包括源码语义、插件清单、组件类型图、Mermaid 编译产物、源码快照、生成校验及视觉检查。用于架构图维护请求。
---

# 更新 ECS 架构图

在当前工作区维护 `docs/diagrams/`，以当前 Rust 源码、锁定依赖和已核实清单为准。

## 读取与范围

- 从仓库根读取 [AGENTS.md](../../../AGENTS.md)、[开发规范](../../../docs/development.md)、[当前架构](../../../docs/architecture.md)、[验证指南](../../../docs/testing/README.md)和[图的说明](../../../docs/diagrams/README.md)。
- 核对 `ecs-data.json`、`build-ecs.mjs`、`architecture-model.mjs`、`architecture-kinds.mjs`、`architecture-components.mjs`、`architecture-source-policy.mjs`、`architecture-source-evidence.mjs`，以及渲染、编译、查看器与对应 Rust 源码。布局和部分说明属于生成模块，不只改 JSON，也不手画生成 SVG。
- 检查 `git status --short`、暂存与未暂存 diff，使用用户指定基线；未指定时从原图和清单对照当前源码，不只看最近提交。保留用户已有修改。
- 原图、diff、日志和截图保存到根 `tmp/ecs-architecture/` 下独立任务目录；正式产物留在 `docs/diagrams/`。用户明确的维护范围优先，不据本 Skill 增设审批。

## 源码与模型核对

核对插件显式装配、系统及 Observer 注册、Schedule／SystemSet、运行条件、真实顺序与延迟命令可见时机；区分 Component、Resource、Local、NonSend、QueryData、SystemParam、普通辅助值及实体引用。核对 ChildOf 等关系、生成销毁、消息／事件与 Observer 条件，不把数据访问画成执行先后。

14 个项目插件及 Bevy、Avian、Enhanced Input、Kira、Egui 五个基础设施入口保留三个页签与明确空态，不通过删减真实系统、Observer、实体关系或必需节点简化布局。`architecture-infrastructure.mjs` 维护入口、分节和文件前缀；四个第三方入口位于 Bevy 之前，插值归 Avian，Inspector 归 Egui，浏览归属不覆盖真实定义来源。系统优先使用明确 feature，否则沿用 module／提供方规则。

保留稳定节点、关系和原注册身份；别名只连接同一声明与身份，不按名称合并。普通插件视图维持各注册的调度语义；组件类型图可按同一真实函数归并卡片，原注册 ID 与全部注册信息保留。插件局部视图的外部引用提供摘要和所属插件入口，不复制其他插件内部流程。`main / App` 纯插件装配边只在视图过滤，原模型保留；项目安装第三方插件及退出刷新等其他真实关系不丢失。旧混合第三方 node 链接按真实归属替换到当前入口，无效旧入口回总览，保留工作区及其他 URL 状态。

功能总览按 [App 调度总览](../../../docs/diagrams/README.md#app-调度总览) 汇总全部项目系统及已核实的引擎／第三方集合、同步与聚合流程，保留 `overview` 视图和导航身份。核对启动、每帧与固定循环的真实驱动边界及全部运行时注册覆盖，不以插件依赖或安装顺序替代系统顺序，也不将静态清单视为全部引擎内部系统。Observer、原生回调、Egui 内部驱动和 RenderApp 的边界按该规范分别表达；插件入口继续从侧栏或所属插件跳转。

Entity、Component 使用与 System 相同的原生圆角矩形，保留各自配色及描边；Entity 保持单层砖红轮廓，完整组件清单位于右侧。从 `model.entities[*].components` 的 canonical 索引取得归属，不按 ID 前缀、显示名或中文 owner 猜测。清单补齐不递归添加其他实体、系统或业务关系。数据页使用固定 `displayFrom`／`displayTo` 投影连接 Entity，canonical `from`／`to` 与关系 ID 保留，详情仍定位真实组件端点。

按[组件类型专属图](../../../docs/diagrams/README.md#组件类型专属图)核对真实 Rust 声明、包身份与泛型参数。同类型的全部投影归入一个类型图，同名不同定义保持独立；保留 `projectionIds`、`ownerEntityIds`、中心组件与原节点入口。缺少证据时标待核实，不猜测归并。图中每个真实函数仅出现一次，多处 Schedule 注册在完整详情单独显示。

组件图逐条核对包含、字段读取、可变访问／修改、添加、移除、存在过滤和反射行为。`With`／`Without`／`Has`、Option 查询或只判断存在的 get 不等于字段读取，reads／writes 不能独立证明生命周期操作。追踪普通 helper、World 闭包、Commands 与关系 hook 的实际位置、条件和生效时机；helper 不冒充注册 System，缺证据的关系不画成确定业务边。

源码范围的唯一维护表位于[源码范围](../../../docs/diagrams/README.md#源码范围)。逐类按语义身份核对节点 `sourceEntries`，而非按视觉形状；Component 仅定义，Entity 创建与销毁，System／Observer 定义与全部注册，其余类别按表检查。操作边独立定位真实操作、参数或配置。原 source 保留使用／注册语义，不能自动提升为定义；没有证据的必要入口写入 sourceGaps 并明确待核实，不能借普通使用处或虚构函数填满。

项目声明通过 `source-locator.mjs` 定位；Bevy／第三方的真实定义通过 `architecture-source-definitions.mjs` 和 `dependency-sources.mjs` 读取锁定依赖。核对提供包、别名、宏声明、Avian 二维／三维重名定义、PlayTypedChannels 及 ApplyDeferred 的真实定义和注册来源。Cargo 路径来自 `cargo metadata --locked --offline`，不硬编码本机根目录；验证唯一声明、包名版本、文件行列、目录边界、定义来源与完整快照，项目工作区配置不覆盖依赖根。

日志拓扑保留业务系统 → tracing producer，再分 File worker → 会话文件与 Console worker 两路。物理页只引用 producer，完整链在会话日志页；`physics-file-log` 保留 External I/O 身份与 `create_session_file` 入口，不新增队列、stderr 或扩大退出刷新关系。

## 绘图与右栏

使用真实 Mermaid 定义与编译，不手改最终路径或补画代理矩形。`architecture-kinds.mjs` 维护规范语义类别，`architecture-style.mjs` 统一对应的 visualType、edgeSemantic、displayLabel 和图例；不得以视觉样式覆盖或猜测 kind。按[分类与视觉规范](../../../docs/diagrams/README.md#节点与连线视觉规范)核实真实 System、SystemSet、SystemParam、分组、同步、流程聚合、装配入口、平台接口及说明类别，不回退为笼统 Contract，也不把辅助函数或聚合流程当作单个 System。项目与引擎的同类身份共用规范，旧 engine 条目需凭源码明确归类。名称完整、14px、加粗，短用途常规字重，优先使用人工 display_summary；不截断、不机械截句、不注入所属 Entity 前缀。完整 description、字段、查询、约束及视图摘要作为数据保留，右侧使用完整正文。

按[布局规则](../../../docs/diagrams/README.md#mermaid-布局与连线)维护 Dagre：App 总览与插件系统图主方向 LR、Schedule 内部 TB；数据页 TB，事件页 LR。Schedule 真实阶段连接、系统 kind=order 与不可见 layoutLinks 分开维护。插件局部页启动标题仅 Startup，状态组从真实运行时注册推导 Schedule 类型名、按出现顺序去重，测试注册及参数不进组标题；完整参数在详情保留。总览另表达完整驱动骨架和固定循环每帧 `0..N` 步。核对七个短标题及完整 `RunFixedMainLoop · AfterFixedMainLoop`，不增加隐含执行边。

组件图用原生方向、透明排版容器、不可见布局边、声明顺序与有界间距形成 Entity／Component／System 阅读分区，保留相反读写方向、有向环与所有真实关系。透明排版元素不增加业务身份或端点。所有候选共用 `architecture-routing.mjs` 严格检查：无遮挡共线直线容差 0.5 图内像素，其余使用至少偏离弦线 0.25 图内像素的真实 basis／bumpX／bumpY 曲线；全部真实轮廓、凹形、多图元、外部虚线和 Schedule 标题参与避让，不能仅检查包围框。

同时检查源端路径起点、目标原生箭头尖端与自身真实轮廓贴合，以及原生标签背景不遮挡卡片或标题。默认 flowchart.padding=16；只有其他检查全通过而仅源端接触失败时，同一原生候选才可尝试 padding=4，再跑完整校验。不得手工接线、移动箭头／标签、删边、增加虚假端点或放宽容差。

右栏按[节点详情](../../../docs/diagrams/README.md#节点详情)统一名称、完整说明、归属和插件按钮、Schedule／Read／Write／Query、字段约束、组件清单与源码分组；空栏目省略，无节点类型 badge。Read／Write 各自按 canonical Entity 去重且只显示实体名，其他分类及条目保持，分类和条目分别缩进16px；每条注册独立成块，字段逐行、数组逐项，测试 scope 保留。专属图仍展示完整 System 信息，不以局部组件访问摘要代替。

选择与清除使用真实轮廓的增强填充、描边和蓝色外圈，按缩放补偿，不影响外部虚线及透明填充；切页、历史与重复选择准确恢复。按[焦点规则](../../../docs/diagrams/README.md#画布交互与焦点)检查 canvas 的 region／tabindex=-1、pointerdown preventScroll、节点 Tab／Enter／Space，以及清除仅释放图内或被删除按钮焦点；paint 不迁移焦点，不叠加第二层矩形框。

右侧未选择时仅显示当前视图实际类型的英文 Legend，Nodes／Edges 样例来自共享 Mermaid guideSamples，每类一个普通样例；类别与数量从共享目录动态取得，分类别名不生成重复图例，各类轮廓与配色组合唯一，SystemSet 与系统分组的成员边分别表达。QueryData 与关系记录没有实际卡片时不为覆盖类别新增业务节点；有外部引用才补英文虚线说明。图例不混入业务 SVG。界面保持浅色，顶栏仅品牌与工作区，画布顶部仅分组定位，无通用操作正文或工具栏导出／图例按钮；面板按共享宽度与窄屏规则工作。

节点、连线的源码区共用 `source-editor.mjs` 的 VS Code、可选择定位与复制反馈，只渲染审阅后的 sourceEntries；独立源码页从 README 进入，完整项目与依赖快照继续生成。配置、协议、复制成功两秒恢复、失败手动复制、异步失效与无障碍反馈按[源码定位验证](../../../docs/testing/README.md#架构图源码定位验证)检查，不能以页面请求冒充编辑器已打开。

## 生成与自动校验

全部组件类型 SVG／同名 .mmd 与普通视图在生成时编译并内嵌 HTML，动态 views 决定产物清单；浏览器只读取已有 SVG，不运行 Mermaid 编译，也不加载 CDN。component URL 参数使用原投影 ID，保留 feature／tab 来源上下文、node、workspace、其他查询与片段，旧 Component 深链接通过 replaceState 兼容。同图中心组件仅选择，Entity 组件清单及搜索进入专属图，历史返回恢复节点与画布位置。

从仓库根依次运行，每条成功后继续，失败修复并重试：

```text
npm ci --prefix docs/diagrams
node docs/diagrams/build-ecs.mjs
node docs/diagrams/check-ecs.mjs
node --test docs/diagrams/*.test.mjs
```

Node.js 最低版本22.13.0，实际要求以 package.json 和 lockfile 为准；必要时使用环境已有合适运行时，不将个人路径写进仓库。Mermaid 初始化使用共享 maxTextSize=200000，frontmatter 保留完整配置；headless Chromium 可由 MERMAID_CHROMIUM_PATH 指定，否则自动查找 Chrome／Edge，只用于图编译。

生成覆盖两份 HTML、总览、非空项目／基础设施页签及全部 `ecs-component-*.svg`／`.mmd`，旧产物按动态清单清理。检查最终 diff，并对照生成前基线核对规范类别、节点／关系 ID、全部注册、组件类型／投影覆盖、唯一函数、有效源码入口、导航参数、依赖定义与快照；不得因分类迁移静默丢失业务信息。校验器不理解所有 Rust 语义，不能发现全部遗漏系统或操作；自动通过不替代人工对照源码。仅用户要求时暂存或提交。

## 视觉检查与交付

按[架构图视觉检查](../../../docs/testing/README.md#架构图视觉检查)实际查看最终 HTML 的总览、全部插件与基础设施页签和空态、全部组件类型图及动态清单中的所有独立 SVG。先看整体，再放大变化区域，检查完整文字、普通 Entity、类型分区、原生箭头与真实端点、遮挡裁切、全部节点和连线类型，以及右侧完整详情、源码分组和缺证据提示。图形再次生成后重查最终版本。

实际桌面浏览器验证组件清单／搜索／端点进入专属图、同类型投影与旧链接、其他组件及所属插件导航、返回与前进后退、断网浏览、鼠标平移缩放、分组定位、面板240px、键盘焦点、取消恢复、复制与工作区配置；静态编译不能代替这些操作验收。验收环境范围以[架构图视觉检查](../../../docs/testing/README.md#架构图视觉检查)为准。

截图、日志和临时副本放根 tmp；不要启动或操作游戏，不使用编译浏览器绕过本地文档访问限制。生成、模型／源码策略校验、全部SVG视觉和HTML真实浏览器检查分别记录，未完成项明确原因与范围。交付列源码核对范围、具体变化、实际验证和未完成事项；执行结果写入对应Issue／PR，长期文档只保留可复用指导。

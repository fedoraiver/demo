# Schedule 快照、导入与筛选模型

在导出、导入、Graphviz 生成或调度筛选模型维护前读取；执行阶段归[维护流程](workflow.md)，筛选控件与历史归[查看器](viewer.md)。

## 真实装配与注册快照

按[调度快照](../../../../docs/diagrams/README.md#调度快照)复用真实应用装配，在插件就绪并完成 `finish` 后、`cleanup` 前，记录主应用及可访问子应用的全部已注册 Schedule。应用与 Schedule 共同标识图，不按标签名称合并不同应用。

专用导出继续使用 `bevy_mod_debugdump` 生成 DOT，同时输出[结构化运行时快照](../../../../tools/rustc-analysis/contract/src/runtime.rs)，记录原生系统／集合键、真实类型、条件、访问及 DOT 图元绑定。rustc 负责源码语义，真实注册及 Schedule 边由运行时快照负责，不能互相替代。

## 导出有效性与导入失败

正式维护通过统一分析入口同时取得编译器事实与真实快照：

```powershell
pwsh -NoProfile -File ./scripts/rustc-analysis.ps1 extract --workspace . --out tmp/ecs-architecture/compiler
```

该入口使用固定 nightly、所选 target／features 和专用编译缓存构建应用，再只执行 `--dump-schedules`。`facts.json` 与 `runtime.json` 保存在输出根目录，`debugdump/` 保存 `manifest.json`、运行时快照及每个 Schedule 的 DOT。系统及访问类型的运行时哈希只连接匹配构建中的编译器类型，不作为持久对象 ID。

该专用导出允许 Agent 执行，不进入游戏循环、不执行 Startup；完整装配仍可能初始化 GPU、音频设备及资产。边界见[验证参考](../../../../docs/testing/README.md#agent-验证边界)。不得省略导出参数或启动、操作游戏；跨目标静态检查不执行目标程序。

复用前核对源码、工具链、Cargo 配置、锁文件、编译单元和输出哈希，检查应用、Schedule、原生键、DOT 身份及来源一致。缺失、冲突、过期或混用构建的输入必须失败；普通旧 DOT 或测试夹具不能代替缺失的编译器事实和真实注册快照。导出失败时完成独立工作并明确缺项，不发布成功清单。

## Graphviz 呈现与语义边界

Graphviz 由锁定的 `@viz-js/viz` 生成默认 SVG，并在浏览器离线 Worker 中按需重排筛选后的 Schedule。呈现样式在布局前应用，系统、集合和依赖线复用对象样式，位置与路径由 Graphviz 产生；不套用 Mermaid 的严格走线检查，不手工接线、改箭头或补画关系。

图表达导出时的注册结构，不表示条件成立、系统实际执行、后续动态注册、Observer 触发或跨 Schedule 总序。显示名不是声明身份；编译器绑定不唯一时保留缺口或按必要性阻止构建，不用名称、Debug 标题或注册顺序选取候选。

## Plugin 分组与条件语义

维护[调度筛选](../../../../docs/diagrams/README.md#调度筛选与重新布局)时，核对包含／排除下拉按来源 Plugin 组多选、目录与完整来源的对应、未知来源及无当前系统的已选组。定义来源不证明实际注册 Plugin；多组取并集、空包含显示全部，排除优先。集合名称不参与系统筛选。

勾选、取消、批量选择和清空立即生效，搜索只缩小选项范围。核对现有完整名称与文本筛选参数，以及旧条件的取消和恢复；筛选参数兼容不等于保留旧对象 ID 映射。

## 筛选投影与中间模型

筛选保留命中系统、必要祖先集合与 marker，以及两端仍存在的原边，不加入未命中邻居或跨删除节点补边。原生上下文端点按[调度筛选规则](../../../../docs/diagrams/README.md#调度筛选与重新布局)保留，不补造名称或计入系统数。空筛选恢复默认 SVG，不初始化 WASM；零命中与失败明确反馈。

保留原始 DOT、哈希及图元身份，核对中间模型的边、有效属性、集合层级和来源分组。DOT 转换仅服务锁定 debugdump 的呈现与筛选，不再从 DOT 文字反推源码声明、访问或操作，也不作为通用无损 DOT 解析器。

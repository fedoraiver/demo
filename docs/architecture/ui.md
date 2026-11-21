# UI 架构

源码入口见 [ui/](../../src/ui/mod.rs)。

## 菜单状态与请求

`MenuState` 管理页面、分类、返回来源与提示；`MenuFocus` 保存可操作按钮序号，`MenuInputSource` 区分鼠标与导航来源。设置和帮助切换页面，不改变其主菜单或暂停来源。`SettingsDraft` 在分类间保留，`Apply` 校验通过后才替换运行中的 `GameSettings`。保存与返回规则见[设置](../player-guide.md#设置)。

菜单控制者的高优先级 `MenuContext` 使用 `require_reset`；动作与绑定通过 BSN `Actions<Context>` 和 `Bindings` 声明，随控制者一起清理。键盘、手柄与原生 `PointerPress` 主键消息均产生 `UiRequest`。按钮使用 `bevy::ui_widgets::Button`，`Hovered` 表达悬停，`Pressed` 与项目 `PrimaryPress` 区分原生任意键按压和主键来源；原生键盘 `Activate` 不进入请求，避免与 Enhanced Input 重复。集中入口每帧接受一项语义请求，连续滑条采样合并，返回优先于同帧采样，最终数值与释放反馈一并处理。

请求在 `PreUpdate` 的 `EnhancedInputSystems::Trigger` 后消费，确保动作 Observer 已写入请求，随后进入 `StateTransition`。`Update` 先重建并销毁旧页面，再消费缓冲的 `PointerPress`；从原始命中沿 `ChildOf` 查找仍存活的菜单按钮，同帧按下并释放也保留点击，右键与中键不生成请求。鼠标请求留到下一次 `PreUpdate` 消费，避免旧页面返回动作穿透。样式统一读取输入来源、焦点与交互，具体契约见[菜单高亮](#菜单高亮)。

音量和灵敏度滑条共用主键 `PointerPress` 捕获、轨道取值与释放清理。局部读取左键与物理光标位置，同帧完整点击也采样最终位置并结束捕获。释放、失焦、光标离窗或页面销毁时结束捕获。原生 `Pressed` 移除时清理项目 `PrimaryPress`，`PickingSystems::Last` 后还按指针身份补清取消状态。窗口失焦或鼠标离窗也清理鼠标按压，避免后续副键继承残留样式。

灵敏度数字框用 `TextInput` 和 `EditableText` 处理原生输入。分发前记录编辑焦点，编辑时方向键留给文本光标。当前数字框的待处理编辑先于菜单请求应用，同帧输入与 Enter 一起提交。数字框与滑条共用草稿，在本帧布局前同步。失焦规范化等待原生文本编辑完成，再将合法值显示为两位小数。

`Continue`、`Multiplayer` 和未实现设置项只声明灰色 `Coming Soon` 展示节点，不包含 `Button`、`MenuButton` 或业务动作，因而不会进入鼠标行为或键盘焦点列表。菜单行为与占位说明见 [玩家指南](../player-guide.md#菜单与占位功能)。

## 菜单高亮

`MenuFocus` 只表示导航目标。鼠标来源下，仅实际悬停或主键按下的按钮高亮，移出或释放后按当前状态恢复。导航来源下，仅当前焦点显示导航高亮，静止光标不会产生悬停高亮。主键按下的背景独立于输入来源，由 `Pressed` 和 `PrimaryPress` 共同判定。当前分类的选中表达应与悬停区分，帮助编号等装饰不具备按钮动作或导航焦点。

真实鼠标移动或点击切回鼠标来源，即使仍在同一按钮内、`Hovered` 未变化。移动到空白或离开窗口也清除导航高亮。页面重建和 `Hovered` 变化本身不会改变输入来源。所有可交互菜单按钮共用这些规则。

## 页面与菜单背景

UI 控件与主菜单背景通过 `bsn!`、`bsn_list!` 和返回 `impl Scene` 的辅助函数声明结构；系统负责交互和运行时变化。页面与共享控件入口见 [pages.rs](../../src/ui/pages.rs) 和 [widgets.rs](../../src/ui/widgets.rs)。

`rebuild_page` 在页面、分类、返回来源或视口任一逻辑尺寸取整后变化时替换 `MenuRoot`。新滚动容器从初始偏移开始，只有视口尺寸变化时保留导航焦点序号。焦点、设置值和成功／失败提示原位更新，保留按钮、滑条、数字框和滚动实体。原位更新使内容缩短时，只夹取超出范围的滚动位置。

主菜单、暂停与帮助是固定内容区，没有 `MenuScroll`。设置仅右侧面板的标题、字段、说明和操作提示滚动；分类、底部操作和页脚固定。滚轮及焦点滚入只作用于该内容区。

视口与 `Scrollbar` 轨道是同一容器的兄弟，轨道通过 `Scrolls / ScrolledBy` 关系关联目标，`ScrollbarThumb` 直接属于轨道。原生 `Scrollbar.target` 由关系适配层同步，仅用于 Bevy 控件接口；改绑或解绑时同步原生控件并清理拖动。原生 `ScrollbarPlugin` 管理比例、拖动、轨道分页及指针清理，控件不进入菜单导航。项目在 `PostUpdate` 的 UI `Layout` 后、可见性传播前同步显隐、拾取、高亮与有效范围；无溢出时归零并隐藏，离页或失效拖动同步清理。右侧预留空间不随显隐改变，避免内容折行反复切换。

`UiSystems` 声明 `Build / Pointer / Style`。`Update` 中的滑条采样、填充更新与音量文字更新位于 `Pointer` 后、`Style` 前。滚动条绑定位于 `Build` 后、`Style` 前。Build 的延迟命令在后续读取前应用。

主菜单的 `MenuBackdrop` 使用 `DespawnOnExit(AppState::MainMenu)` 管理纯色背景相机，设置和帮助沿用该相机，暂停沿用当前玩法相机。菜单相机标记 `IsDefaultUiCamera`，进入游戏时随背景根销毁，玩法相机接管界面。启用检查器时由其添加 Egui 上下文。字体准备约定见 [玩家指南](../player-guide.md#资源准备)。

### 文字测量与容器约束

横排自动宽度的短文字保留自然测量；在文字节点统一设置 `min_width: px(0)` 可能使测量宽度归零。容器与文字分别约束：容器可按需收缩、限宽或滚动，长正文通过可用宽度换行。按视口约束的页面根设置 `min_height: px(0)`，使超长内容进入内部滚动区；百分比高度本身不能阻止自动最小高度撑大根节点。

共享文字或按钮变更须同时保留短标签尺寸和正文换行；验证场景与排查方法见[文字布局与高亮回归](../testing/ui.md#文字布局与高亮回归)。

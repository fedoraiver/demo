# demo

基于 Rust 和 Bevy 的游戏制作实践项目，当前玩法尚未确定。

## 运行

安装 Rust 工具链后，在仓库根目录执行：

```powershell
cargo run --locked
```

运行资源随仓库保存在 [assets/](assets/)，请保留完整目录及路径结构。依赖版本以 [Cargo.toml](Cargo.toml) 与 [Cargo.lock](Cargo.lock) 为准。

详细使用方式见 [玩家指南](docs/player-guide.md)，构建与发布方法见 [开发规范](docs/development.md#构建与调试)。

## 文档

- [玩家指南](docs/player-guide.md)：当前演示内容、操作、设置、资源与会话日志。
- [游戏设计](docs/game-design.md)：玩法探索与确认状态。
- [开发规范](docs/development.md)：工程约定、构建与调试方法。
- [Bevy App 与项目模块](docs/architecture/README.md)：通用 App 机制、默认生命周期与项目模块入口。
- [在线 ECS 架构图](https://fedoraiver.github.io/demo/)：[模型与查看器说明](docs/diagrams/README.md)及[维护指南](docs/diagrams/maintenance.md)。
- [测试指南](docs/testing/README.md)：测试框架、四个测试层级、模块验证与实机验收入口。
- [应用自动化验收](docs/testing/app-acceptance.md)：分类脚本、客观验收条件与覆盖范围。
- [资产文档](docs/assets/README.md)：资产维护、导入、事件映射与来源记录。

面向 Agent 的执行要求见 [AGENTS.md](AGENTS.md)。

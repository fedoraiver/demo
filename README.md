# demo

一个基于 Rust 和 Bevy 的 demo，用于探索游戏制作、积累实践经验并提升游戏制作水平。当前玩法尚未确定。

## 运行

安装 Rust 工具链后，在仓库根目录执行：

```powershell
cargo run --locked
```

运行资源随仓库保存在 [assets/](assets/)，请保留完整目录及路径结构。依赖版本以 [Cargo.toml](Cargo.toml) 与 [Cargo.lock](Cargo.lock) 为准。

详细使用方式见 [使用说明](docs/usage.md)，构建与发布方法见 [开发规范](docs/development.md#构建与调试)。

## 文档

- [使用说明](docs/usage.md)：当前演示内容、操作、设置、资源与会话日志。
- [游戏设计](docs/game-design.md)：项目目的与玩法探索状态。
- [开发规范](docs/development.md)：工程约定、构建与调试方法。
- [当前架构](docs/architecture.md)：模块职责、ECS 数据与系统流程。
- [验证参考](docs/testing/README.md)：开发检查、无窗口验证和架构图检查。
- [游戏手动验收](docs/testing/game-acceptance.md)：由用户执行的游戏、窗口、声音和会话日志检查。
- [美术资产](art/ASSET_GUIDE.md)与[道具美术资产](art/items/README.md)：制作源、资源清单与离线检查方法。
- [音频管线](docs/audio.md)：声音素材、事件接口与试听方式。

面向 Agent 的执行要求见 [AGENTS.md](AGENTS.md)。

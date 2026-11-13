# 音频管线

本文面向维护音频资产和接入声音事件的开发者，说明正式素材导入、清单生成、技术检查和运行时接入。用户试听入口见[使用说明](usage.md#音效)，运行时调度见[音效数据流](architecture.md#音效数据流)。

## 记录归属

| 记录 | 用途 |
| --- | --- |
| [音效事件表](../assets/audio/events.md) | 已接入声音事件的触发与去重合同。 |
| [来源记录](../assets/audio/ATTRIBUTION.md) | 外部发布包、作者、许可证和取得证据。 |
| [generation.json](../assets/audio/generation.json) | 正式素材选择、事件映射与播放策略的输入。 |
| [audio_manifest.json](../assets/audio/audio_manifest.json) | 运行映射、来源、处理、哈希和技术信息。 |
| [quality_report.json](../assets/audio/quality_report.json) | 检查工具、阈值与测量结果。 |

修改输入配置或管线后重新生成清单、质量报告与试听快照，素材来源和文件参数由其所属记录维护。

## 素材要求

优先复用仓库素材。外部素材采用来源与许可可核实的 CC0 完整发布文件，保留原编码、原包条目、哈希及许可证副本。素材制作遵循零预算约束，不接受付费生成 API。音频清单中的播放增益只在运行时应用。

## 重现与检查

正常构建直接使用仓库中的音频文件。清单生成需要 Python 标准库，技术检查还需要本机 `ffmpeg` 与 `ffprobe`。管线回归还使用本机 Node.js 检查试听页的分类、路径与播放状态。试听用例在离线数据夹具中执行。从仓库根目录执行下列命令。

```powershell
python -B scripts/audio_pipeline.py generate
python -B scripts/audio_pipeline.py check
python -B scripts/build_audition_index.py
python -B -m unittest discover -s scripts -p test_audio_pipeline.py
```

`generate` 从导入配置和来源证据重建清单，素材集合与分类由配置决定。每项素材可通过 `event_ids` 声明事件映射，省略时使用素材 ID。`check` 解码到内存，测量格式、静音、削波与 DC，并核对成品及原包条目的哈希，再更新清单和报告。`build_audition_index.py` 刷新 `audition_data.js`，使[独立试听页](../assets/audio/audition.html)可直接打开使用。

解码工具未在 PATH 中时，为 `check` 传入 `--ffmpeg <路径> --ffprobe <路径>`。无窗口覆盖见[音频验证](testing/README.md#音频无窗口验证)。

### 导入正式发布包

当前外部导入流程处理正式发布包中的 OGG 条目，素材分类与目标路径由配置给出。取得或重新导入发布包时执行下列命令。

```powershell
python -B scripts/audio_pipeline.py import-sources --acquired-date YYYY-MM-DD
```

日期填写实际取得日期。重用已取得的包时添加 `--use-cache` 并保留原日期。完整包暂存在根 `tmp/audio/downloads/`，正式来源证据写入 `assets/audio/sources/`。导入后执行清单生成、技术检查和快照刷新。

## 后端依赖

当前 Bevy 0.20 所需的 Seedling 与 Firewheel 兼容实现尚未发布，依赖来自 [Seedling 兼容分支](https://github.com/eswartz/bevy_seedling-fork/tree/migrate-to-bevy-0.20) 与 [Firewheel 兼容分支](https://github.com/eswartz/Firewheel-fork/tree/bevy-0.20)。`Cargo.toml` 用完整 `rev` 固定两者，`Cargo.lock` 固定全部解析结果；更新时需重新核对上游差异、Bevy 版本与音频无窗口回归。

## 接入与验收

声音生产端按[事件合同](../assets/audio/events.md)发送 `SoundRequest`，由 `GameAudioPlugin` 使用 `bevy_seedling` 管理加载、播放、混音与设备输出。当前菜单事件通过 `UiPool` 采样池播放，使用真实时间控制冷却，排队实例计入并发限制。未加载或静音的请求立即消费。

当前 UI 声音的有效增益为默认基准、素材清单音量、Master Volume 与 UI Volume 的乘积。设置页通过 `AudioPreview` 即时预览，应用成功后保存，返回时采用最近成功应用的设置。正在播放与排队实例都通过池总线响应当前混音，素材的独立倍率保留在 `SamplePlayer` 中。

新增素材时，在 `generation.json` 声明素材分类、来源、事件映射与播放策略，生成清单并补齐来源证据。将声音接入运行时事件时，同步更新 `SoundCue`、事件类别及清单映射，由所属功能在事件被接受后发送请求，并按所需声音类别接入播放通道、混音与生命周期行为。当前接入范围见[事件表](../assets/audio/events.md)，相关实现检查见[音频无窗口验证](testing/README.md#音频无窗口验证)。

清单编译嵌入 Rust 程序，修改后需重新编译。技术检查与真实设备听感分别记录，用户按[音频验收](testing/game-acceptance.md#音频验收)确认触发、混音和输出。

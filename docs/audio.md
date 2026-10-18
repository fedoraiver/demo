# 音频管线

本文面向维护音频资产和接入声音反馈的开发者，说明来源导入、可重现生成、技术检查和接入要求。用户操作与独立试听见 [使用说明](usage.md#音效)，运行时 ECS 数据流见 [当前架构](architecture.md#音效数据流)。

## 资产与记录的归属

| 记录 | 用途 |
| --- | --- |
| [音效事件表](../assets/audio/events.md) | 当前事件的触发与去重合同，以及未接入素材的语义边界。 |
| [来源记录](../assets/audio/ATTRIBUTION.md) | 外部包、作者、许可证及取得证据，原创素材权属和未下载候选。 |
| [generation.json](../assets/audio/generation.json) | 外部包导入选择、本地合成配方、独立种子和播放策略的输入配置。 |
| [audio_manifest.json](../assets/audio/audio_manifest.json) | 生成后的运行时映射，以及与文件对应的来源、处理、哈希和技术信息。 |
| [quality_report.json](../assets/audio/quality_report.json) | 技术检查的工具版本、阈值和结果。 |

生成后的清单和报告由管线维护；调整生成输入时修改 `generation.json` 或生成器，不手工维护第二份参数表。试听页使用生成快照，修改清单后也要刷新快照。

## 素材要求

优先复用仓库已有素材。外部素材只接受来源与许可可核实的 CC0 完整发布文件，不接受 CC BY-NC、许可不明素材、影视游戏提取声音或付费生成 API。

保留正式发布文件的编码格式、原包条目、字节哈希及许可证副本。不得用网页有损预览代替原文件，也不将有损文件转换成 WAV 后声称是无损原录音。

本地合成不使用外部采样，权利归属按原创素材记录，不标为第三方 CC0。合成环境底声是试听候选，默认不在游戏播放；真实声音缺口及取得状态见 [来源记录](../assets/audio/ATTRIBUTION.md#真实声音缺口仅候选未下载)。

## 重现与检查

仓库已有音频可直接使用，正常构建不需要下载。运行以下命令前，确认本机已有 Python；生成只使用 Python 标准库，技术检查还需要 `ffmpeg` 和 `ffprobe`。在仓库根目录执行：

```powershell
python scripts/audio_pipeline.py generate
python scripts/audio_pipeline.py check
python scripts/build_audition_index.py
```

`generate` 重建原创 WAV 与运行时清单，保留外部 OGG 和下载记录。`check` 不播放音频：在内存复现合成字节、比对外部文件与取得记录的哈希，并更新清单和质量报告。`build_audition_index.py` 刷新试听页的 `audition_data.js` 快照。

解码工具不在 PATH 时，可为 `check` 传入 `--ffmpeg <路径> --ffprobe <路径>`。缺少工具应记录为未完成检查，不能视作通过；管线不自动安装解码器。技术检查范围、无窗口回归与预期结果见 [音频无窗口验证](testing/README.md#音频无窗口验证)。

### 导入外部发布包

仅在需要取得或重新导入正式发布包时执行：

```powershell
python scripts/audio_pipeline.py import-sources --acquired-date YYYY-MM-DD
```

`--acquired-date` 填写实际取得日期。重新使用已取得的包时添加 `--use-cache` 并保留其实际取得日期，不把缓存使用日期记录为下载日期。完整包暂存在根 `tmp/audio/downloads/`，正式来源证据写入 `assets/audio/sources/`。

替换素材前核实许可并更新导入配置；导入后重新执行生成、检查和快照刷新。首次取得日期与候选页面查阅日期分别记录，不补写未取得文件的哈希。

## 接入与验收

声音反馈通过已接受的业务结果发送，不从按键推断成功。接入时按 [音效事件表](../assets/audio/events.md) 确认触发、去重及当前范围；新增语义时同步维护 `SoundCue` 与清单映射，不能把预留素材名称当成玩法需求。

运行时由 `AssetServer` 加载实际文件，路径相对 `assets/`。清单编译嵌入 Rust 程序，修改清单后需要重新编译。混音、加载失败处理、并发和暂停行为由 [音效数据流](architecture.md#音效数据流) 说明，音量设置的操作与持久化见 [使用说明](usage.md#设置)。

技术报告不代表听感或真实设备输出通过。`subjective_listening_status` 与 `game_runtime_status` 必须反映实际验收状态，不能从文件存在或网页可播放推断。听感与游戏声音输出由用户按 [音频检查与用户验收](testing/game-acceptance.md#音频验收) 完成。

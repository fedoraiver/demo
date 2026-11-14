# 音频管线

本文面向维护音频资产和接入声音事件的开发者，说明正式素材导入、清单生成、技术检查和运行时接入。运行时接入与调度见[音频架构](../../architecture/audio.md)。

## 记录归属

| 记录 | 用途 |
| --- | --- |
| [音效事件表](events.md) | 已接入声音事件的触发与去重合同。 |
| [来源记录](ATTRIBUTION.md) | 外部发布包、作者、许可证和取得证据。 |
| [generation.json](../../../assets/audio/generation.json) | 正式素材选择、事件映射与播放策略的输入。 |
| [audio_manifest.json](../../../assets/audio/audio_manifest.json) | 运行映射、来源、处理、哈希和技术信息。 |
| [quality_report.json](../../../assets/audio/quality_report.json) | 检查工具、阈值与测量结果。 |

修改输入配置或管线后重新生成清单与质量报告，素材来源和文件参数由其所属记录维护。

## 素材要求

优先复用仓库素材。外部素材采用来源与许可可核实的 CC0 完整发布文件，保留原编码、原包条目、哈希及许可证副本。素材制作遵循零预算约束，不接受付费生成 API。音频清单中的播放增益只在运行时应用。

## 重现与检查

正常构建直接使用仓库中的音频文件。清单生成需要 Python 标准库，技术检查还需要本机 `ffmpeg` 与 `ffprobe`。从仓库根目录执行下列命令。

```powershell
python -B scripts/audio_pipeline.py generate
python -B scripts/audio_pipeline.py check
python -B -m unittest discover -s scripts -p test_audio_pipeline.py
```

`generate` 从导入配置和来源证据重建清单，素材集合与分类由配置决定。每项素材可通过 `event_ids` 声明事件映射，省略时使用素材 ID。`check` 解码到内存，测量格式、静音、削波与 DC，并核对成品及原包条目的哈希，再更新清单和报告。

解码工具未在 PATH 中时，为 `check` 传入 `--ffmpeg <路径> --ffprobe <路径>`。无窗口覆盖见[音频验证](../../testing/audio.md#音频无窗口验证)。

### 导入正式发布包

当前外部导入流程处理正式发布包中的 OGG 条目，素材分类与目标路径由配置给出。取得或重新导入发布包时执行下列命令。

```powershell
python -B scripts/audio_pipeline.py import-sources --acquired-date YYYY-MM-DD
```

日期填写实际取得日期。重用已取得的包时添加 `--use-cache` 并保留原日期。完整包暂存在根 `tmp/audio/downloads/`，正式来源证据写入 `assets/audio/sources/`。导入后执行清单生成和技术检查。

## 接入与验收

声音生产端按[事件合同](events.md)发送声音请求，运行时接入与混音见[音频架构](../../architecture/audio.md)。

新增素材时，在 `generation.json` 声明素材分类、来源、事件映射与播放策略，生成清单并补齐来源证据。将声音接入运行时事件时，同步更新 `SoundCue`、事件类别及清单映射，由所属功能在事件被接受后发送请求，并按所需声音类别接入播放通道、混音与生命周期行为。当前接入范围见[事件表](events.md)，相关实现检查见[音频无窗口验证](../../testing/audio.md#音频无窗口验证)。

清单编译嵌入 Rust 程序，修改后需重新编译。技术检查与真实设备听感分别记录，用户按[音频验收](../../testing/audio.md#音频验收)确认触发、混音和输出。

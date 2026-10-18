# 音频来源与处理记录

本文记录音频的来源、权属与取得证据。精确文件映射、处理记录及 SHA-256 见 [audio_manifest.json](audio_manifest.json)，生成与检查流程见 [音频管线](../../docs/audio.md)。

## 已取得的外部素材

| 发布包 | 作者 | 版本 | 许可证 | 实际取得日期 | 来源页面 | 原包许可证副本 |
| --- | --- | --- | --- | --- | --- | --- |
| Interface Sounds | Kenney | 1.0 | CC0 1.0 Universal | 2026-10-01 | [Kenney 官方页面](https://kenney.nl/assets/interface-sounds) | [License.txt](sources/kenney_interface-sounds-License.txt) |
| Impact Sounds | Kenney | 1.0 | CC0 1.0 Universal | 2026-10-01 | [Kenney 官方页面](https://kenney.nl/assets/impact-sounds) | [License.txt](sources/kenney_impact-sounds-License.txt) |

许可证为 [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)，此处保留作者与来源。许可证副本按原包字节复制，没有改写。正式 ZIP 下载地址、原包大小和 SHA-256、许可证哈希及选中条目的原始 SHA-256 保存在 [source_receipts.json](sources/source_receipts.json)。完整下载包仅在根 `tmp/audio/downloads/` 暂存，不提交。

外部成品由官方包中的 Ogg Vorbis 条目解包、重命名而来，音频字节不变。它们是有损正式发布文件，不声称为原始无损录音；没有从网页试听预览取音，也没有转成 WAV。技术测量只解码到内存，播放增益不改写音频文件。

## 本地合成素材

作者记录为 `demo project local procedural generator`，许可证字段为 `project-original`，表示项目新生成的素材，权利归项目保留，不是第三方 CC0 声明。首次创建日期为 2026-10-01，没有外部素材的取得日期。

生成器为 [audio_pipeline.py](../../scripts/audio_pipeline.py)，版本 `1.0.0`，只使用 Python 标准库；记录的生成环境为 Python `3.11.15`。每条声音的参数与独立种子由 [generation.json](generation.json) 维护，脚本、配置和成品哈希保存在运行时清单中。

合成素材没有使用外部采样。处理包括数学合成、去除 DC 均值、一次性反馈音的边缘渐变与目标峰值缩放，最后一次量化为 PCM16 WAV；循环底纹使用整数周期谐波，不在接缝添加静音或渐变。环境底纹是合成候选，不是海浪实录。

## 真实声音缺口：仅候选，未下载

下列来源页面于 2026-10-01 查阅并记录为 CC0 1.0，原文件尚未取得；`acquired_date` 为 `null`，状态为 `not_downloaded`。这只是当时的来源记录，实际取得前仍须核实文件及许可。

| 用途 | 候选 | 作者 | 记录的许可证 |
| --- | --- | --- | --- |
| 海浪环境 | [Sea-waves medium 01-090714.wav](https://freesound.org/people/ra_gun/sounds/77467/) | ra_gun | CC0 1.0 Universal |
| 微风环境 | [Gentle wind](https://freesound.org/people/fthgurdy/sounds/528944/) | fthgurdy | CC0 1.0 Universal |
| 真实推车移动 | [cart.wav](https://freesound.org/people/mariiao2/sounds/232799/) | mariiao2 | CC0 1.0 Universal |

候选的页面元数据与限制保存在清单的 `pending_sources`。记录指出 Freesound 需要登录下载原文件；网页有损预览不能代替原 WAV。未取得文件没有下载哈希，底噪、适配性与可循环性也尚未确认。

`cart.wav` 描述移动金属推车，不能据此认定适用于碰撞。当前撞击素材仍是 Kenney 的通用金属占位，事件接入与预留范围见 [音效事件表](events.md)。

## 技术报告与验收

技术检查的测量值、工具与阈值保存在 [quality_report.json](quality_report.json)。报告中的听感与游戏运行状态只代表实际完成的检查，不能由哈希或解码通过推断；听感和真实设备输出的验收步骤见 [用户验收指南](../../docs/testing/game-acceptance.md#音频验收)。

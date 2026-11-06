# 音频来源与处理记录

本文维护已收录音频的来源、许可与取得证据。文件映射、原包条目及 SHA-256 由[音频清单](audio_manifest.json)维护，导入与检查方法见[音频管线](../../docs/audio.md)。

| 发布包 | 作者 | 版本 | 许可证 | 实际取得日期 | 来源页面 | 原包许可证副本 |
| --- | --- | --- | --- | --- | --- | --- |
| Interface Sounds | Kenney | 1.0 | CC0 1.0 Universal | 2026-10-01 | [Kenney 官方页面](https://kenney.nl/assets/interface-sounds) | [License.txt](sources/kenney_interface-sounds-License.txt) |

菜单悬停、确认和返回声音由官方包中的 Ogg Vorbis 条目直接解包并重命名，保留原始音频字节与许可证副本。素材属于有损正式发布文件，播放增益不改写文件。

正式下载地址、原包大小与哈希、许可证哈希以及选中条目的原始哈希由[source_receipts.json](sources/source_receipts.json)保存。完整下载包仅暂存在根 `tmp/audio/downloads/`，缓存使用保留实际取得日期。

技术测量由[质量报告](quality_report.json)记录。哈希、格式或解码检查不能证明听感与真实设备输出，用户验收见[音频验收](../../docs/testing/game-acceptance.md#音频验收)。

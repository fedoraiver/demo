# 音频来源与处理记录

第一版零预算管线共 13 条声音。外部声音来自 Kenney 的官方完整发布包，使用 CC0 1.0 Universal；本地合成声没有使用外部采样。未使用付费生成 API、CC BY-NC、许可不明素材或影视游戏提取声。所有文件的来源、日期、处理和 SHA-256 见 [audio_manifest.json](audio_manifest.json)，技术测量见 [quality_report.json](quality_report.json)。

## 已取得的外部素材

| 发布包 | 作者 | 版本 | 许可证 | 实际取得日期 | 来源页面 | 原包许可证副本 |
| --- | --- | --- | --- | --- | --- | --- |
| Interface Sounds | Kenney | 1.0 | CC0 1.0 Universal | 2026-10-01 | [Kenney 官方页面](https://kenney.nl/assets/interface-sounds) | [License.txt](sources/kenney_interface-sounds-License.txt) |
| Impact Sounds | Kenney | 1.0 | CC0 1.0 Universal | 2026-10-01 | [Kenney 官方页面](https://kenney.nl/assets/impact-sounds) | [License.txt](sources/kenney_impact-sounds-License.txt) |

[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) 允许包括商业用途在内的使用；作者不要求署名，此处主动保留来源。许可证副本按原包字节复制，没有改写。正式 ZIP 下载地址、原包大小和 SHA-256、选中条目的原始 SHA-256 都保存在 [source_receipts.json](sources/source_receipts.json)。完整下载包仅在根 `tmp/audio/downloads/` 暂存，不提交。

| 成品路径（相对 assets/） | 原始发布包条目 | 处理步骤 |
| --- | --- | --- |
| `audio/ui/menu_hover.ogg` | Interface Sounds / `Audio/click_001.ogg` | 解包，重命名，音频字节不变 |
| `audio/ui/menu_confirm.ogg` | Interface Sounds / `Audio/confirmation_001.ogg` | 解包，重命名，音频字节不变 |
| `audio/ui/menu_cancel.ogg` | Interface Sounds / `Audio/back_001.ogg` | 解包，重命名，音频字节不变 |
| `audio/sfx/parcel_land.ogg` | Impact Sounds / `Audio/impactWood_medium_000.ogg` | 解包，重命名，音频字节不变；当前木箱适用 |
| `audio/sfx/cart_collision.ogg` | Impact Sounds / `Audio/impactMetal_medium_000.ogg` | 解包，重命名，音频字节不变；通用金属撞击占位 |

这些 Ogg Vorbis 文件是官方发布格式，属于有损编码，不声称为原始无损录音。没有从网页试听预览取音，也没有转成 WAV。测量时只解码到内存；播放增益记录在 manifest 的 `playback.volume`，没有修改文件本身。

## 本地合成素材

作者记录为 `demo project local procedural generator`，许可证字段为 `project-original`，表示项目新生成的素材，不是第三方 CC0 声明，权利归项目保留。首次创建日期为 2026-10-01；没有外部素材的“取得日期”。生成器是 [audio_pipeline.py](../../scripts/audio_pipeline.py)，版本 `1.0.0`，只需要 Python 标准库；实际生成环境 Python `3.11.15`。全部参数、每个音符的频率、包络、峰值、谐波和独立随机种子见 [generation.json](generation.json)。脚本和配置 SHA-256 写入 manifest。

| 文件 ID | 种子 | 声音设计 |
| --- | --- | --- |
| `parcel_pickup` | 17001 | 上行双音，区分拾取动作完成 |
| `parcel_release` | 17002 | 短下行音，区分放下与落地撞击 |
| `parcel_handoff` | 17003 | 柔和交替双音，仅为将来交接预留 |
| `character_bounce` | 17004 | 低音向下滑动，仅为明确弹开事件预留 |
| `instability_warning` | 17005 | 双脉冲，最多每秒一次 |
| `delivery_success` | 17006 | 上行三音，仅为未来订单成功预留 |
| `delivery_failure` | 17007 | 下行双音，仅为未来交付拒绝预留 |
| `ambience_island_placeholder` | 17008 | 6 秒周期谐波背景底纹；这是合成候选，非真实海浪，默认关闭 |

合成处理：按已记录参数生成正弦及第二谐波，去除 DC 均值，一次性反馈音应用边缘渐变，按目标峰值缩放，最后仅一次量化成 44.1 kHz / 16 bit / mono PCM WAV。循环背景使用整数周期谐波，不在接缝添加静音或渐变。重新生成时，应保留版本和参数；修改声音设计时更新生成器版本或配置及种子并重新检查。

复现与检查（仓库根目录执行）：

```powershell
# 已取得的完整原包位于 tmp/audio/downloads 时：日期必须是实际取得日。
python scripts/audio_pipeline.py import-sources --acquired-date 2026-10-01 --use-cache
# 首次取得原包时省略 --use-cache，并填实际取得日。
python scripts/audio_pipeline.py generate
python scripts/audio_pipeline.py check
python scripts/build_audition_index.py
```

`generate` 重建 PCM 与 manifest，保留外部 OGG 文件和原下载记录。`check` 在内存重新合成 8 条 PCM 并比对完整文件字节的 SHA-256，同时核对 5 条外部 OGG 与原 ZIP 条目哈希；它使用已有 `ffmpeg`、`ffprobe` 测量，不播放音频。不在 PATH 时可传 `--ffmpeg` 和 `--ffprobe` 的完整路径。检查工具版本与阈值保留在质量报告。工具不自动安装或下载解码器。

## 真实声音缺口：仅候选，未下载

下列来源页面于 2026-10-01 核实为 CC0 1.0，原文件尚未取得；`acquired_date` 为 `null`，状态为 `not_downloaded`。Freesound 要求登录下载原文件；网页有损预览不能冒充原 WAV。尚未确认底噪、声音适配或可循环性。

| 用途 | 候选 | 作者 | 许可证 |
| --- | --- | --- | --- |
| 海浪环境 | [Sea-waves medium 01-090714.wav](https://freesound.org/people/ra_gun/sounds/77467/) | ra_gun | CC0 1.0 Universal |
| 微风环境 | [Gentle wind](https://freesound.org/people/fthgurdy/sounds/528944/) | fthgurdy | CC0 1.0 Universal |
| 真实推车移动 | [cart.wav](https://freesound.org/people/mariiao2/sounds/232799/) | mariiao2 | CC0 1.0 Universal |

`cart.wav` 描述的是移动金属推车，不能据此认定适用于碰撞；当前撞击素材是 Kenney 的通用金属占位。候选的页面元数据与限制保留在 manifest 的 `pending_sources`，没有伪造下载、文件哈希或取得日期。

## 检查与验收边界

技术检查覆盖可解码格式、44.1/48 kHz、1/2 声道、头尾静音、满幅样本、DC、文件哈希以及循环的边界样本和斜率差；报告明确记录实际阈值。数值检查不等同于听感通过，当前未进行主观试听和游戏运行验证。用户可打开 [试听页面](audition.html)，逐条试听并调整总音量；循环声应至少听三个周期，留意接缝点击、音色重复和底噪。

已有素材复用检查在可读的 `D:/demo/assets`、`D:/demo/art` 中未发现可复用音频；原 worktree 的 `assets` 目录不存在。`D:/demo/art/scripts`、`blender`、`previews` 访问被拒，不能声称已检查这些目录；没有修改其他 worktree。事件合同及当前/预留范围见 [事件表](events.md)。

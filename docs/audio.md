# 第一版音频管线

当前声音管线使用 `bevy_kira_audio 0.26.0`，对应项目 Bevy 0.19；具体版本以 Cargo 声明与锁文件为准。玩法结果通过 ECS 消息进入播放端，接入范围与阈值见 [当前架构](architecture.md#音效数据流)。音效事件、来源与参数分别维护在下表链接，不把预留素材当作已实现玩法。

| 文件 | 维护内容 |
| --- | --- |
| [events.md](../assets/audio/events.md) | 菜单、拾取、交接、落地、推车碰撞、弹开、失稳、交付成功和失败的事件合同与当前接入范围。 |
| [audio_manifest.json](../assets/audio/audio_manifest.json) | 精确播放 ID、相对 `assets` 路径、来源、取得日期、处理、生成参数、播放策略、哈希与技术质量。 |
| [ATTRIBUTION.md](../assets/audio/ATTRIBUTION.md) | 作者、包版本、许可证及证据、原创素材权属、真实声音缺口与未下载候选。 |
| [generation.json](../assets/audio/generation.json) | 本地生成器版本、每条合成声的种子与全部配方、正式发布包导入选择。 |
| [quality_report.json](../assets/audio/quality_report.json) | 解码格式、静音、削波、DC、循环边界和文件哈希检查结果；不代表人耳验收。 |

## 素材与预算

仓库已有素材优先复用；外部素材只接受来源与许可可核实的 CC0 完整发布文件，不接受 CC BY-NC、许可不明素材、影视游戏提取声音或付费生成 API。当前外部素材为 Kenney 官方发布包中的 OGG，原样提取并保存原文件名、字节哈希及包内 License 副本。它们是有损正式发布文件，不宣称为无损原录音，也不转换为 WAV 冒充原件。

反馈音由 Python 标准库本地生成，不需要生成服务、jsfxr 网站或登录。配方保存包络、频率、时长、谐波、目标峰值和独立种子，生成器版本是 `1.0.0`。原创文件为一次量化的 PCM16 WAV，无外部采样；权利留在项目，不能误记为第三方 CC0。环境底声是明确标注的合成占位，默认不在游戏中播放。真实海浪、风与推车声音只列为未下载候选；Freesound 登录后的原文件须另行取得并检查，页面预览不能代替。

## 逐项试听

用户可在浏览器中直接打开 [audition.html](../assets/audio/audition.html)。页面通过同目录的 `audition_data.js` 静态快照读取清单，用户点击后才播放；同一时间仅播放一项，支持停止、监听音量与仅循环素材的循环开关。查看详情可见来源、许可、生成参数、哈希和技术报告。

也可在仓库根目录执行以下命令，仅启动本地试听文件服务：

```powershell
python scripts/serve_audio.py
```

随后打开 `http://127.0.0.1:8765/audition.html`；按 Ctrl+C 停止服务。该脚本只绑定 localhost，不启动游戏。HTTP 下可以刷新 manifest；直接本地打开时使用静态快照或手动导入 JSON。浏览器策略若禁止 `file://`，使用 localhost。

## 重现与检查

已生成的音频足够播放，正常构建无需下载。以下命令在仓库根目录运行，仅重现原创 WAV 和更新清单，不访问网络：

```powershell
python scripts/audio_pipeline.py generate
python scripts/audio_pipeline.py check
python scripts/build_audition_index.py
```

`check` 使用本机现有 `ffmpeg` 与 `ffprobe` 解码到内存，可用 `--ffmpeg <路径> --ffprobe <路径>` 指定。没有工具时应报告未完成检查，不能将缺少解码器视作通过。脚本检查所有声道的削波、DC、采样率和格式，并按每帧最大声道幅度检测头尾静音；循环文件检查边界采样差与一阶斜率差。阈值记录在报告中。短音不进行循环测试，环境循环仍需人耳检查底噪、重复感和接缝。

只有需要重新取得外部正式包时才使用导入命令，`--acquired-date` 必须填本次实际取得日期；已取得的包可加 `--use-cache`，不能用缓存伪造新的下载：

```powershell
python scripts/audio_pipeline.py import-sources --acquired-date YYYY-MM-DD
```

导入的包保留在 `tmp/audio/downloads`，正式归属证据在 `assets/audio/sources`；首次取得与候选查阅日期分开记录。替换原素材需要先确认许可，再更新配置、来源与报告。清单嵌入 Rust 二进制，修改后重新编译；试听快照也需重新生成。格式、编译、无窗口解码与真实物理事件检查见 [验证指南](testing.md#音频检查与用户验收)。

用户听感与游戏声音输出验收由用户自行完成；技术报告始终保留 `subjective_listening_status` 和 `game_runtime_status`，不得从文件或网页播放状态推断已经听过。

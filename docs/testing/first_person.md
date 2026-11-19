# first_person 测试

[测试指南](README.md)说明分层与执行边界；客观应用检查使用验收构建与脚本，人工范围见[补充验收](game-acceptance.md)。

## 无窗口集成验证

运行 `cargo test --locked first_person::tests`；跨帧朝向、镜头及持物的测试条件见 [持物与视角同步](item_interaction.md#持物与视角同步的无窗口验证)。

## 人物移动与镜头验收

客观应用条件见[应用自动化验收](app-acceptance.md#人物移动与镜头)，验收运行方式与执行边界见[测试指南](README.md#agent-验证边界)。主观评价及确实无法可靠驱动的专项见[人工补充验收](game-acceptance.md)。

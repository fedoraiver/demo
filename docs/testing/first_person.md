# first_person 测试

测试分层、运行方式与执行边界见[测试指南](README.md)。

## 无窗口集成验证

运行 `cargo test --locked first_person::tests`；跨帧朝向、镜头及持物的测试条件见 [持物与视角同步](item_interaction.md#持物与视角同步的无窗口验证)。

## 人物移动与镜头验收

移动、转向与镜头的应用级条件见[应用自动化验收](app-acceptance.md#人物移动与镜头)。

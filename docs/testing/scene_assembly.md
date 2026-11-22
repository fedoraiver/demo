# scene_assembly 测试

[测试指南](README.md)说明分层和执行边界。脚本覆盖与缺口见[应用自动化验收](app-acceptance.md)。

## 场景与无窗口验证

灰盒场景与物理检查见 [场景测试](../../src/scene_assembly/tests.rs)，在仓库根目录执行。

```powershell
cargo test --locked scene_assembly::tests
cargo test --locked character::tests
cargo test --locked physics::tests
```

场景测试使用最小 `App / World`，只注册所需资源、BSN、变换和物理设施。检查开始时装配一套平地、玩家、控制者、相机、灯光与三个方块，测试核对角色根的物理组件以及地面、箱体根的网格与物理组件，以及地面物理顶面等于配置、出生高度按地面高度和偏移计算；视觉子实体不重复添加刚体或碰撞体仍需检查，当前测试未断言此项。执行真实物理步验证接地和方块落地，通过真实 E 动作验证拿放。暂停与恢复保留实体，返回主菜单完整清理，连续开始只出现一套初始场景。

场景显示和生命周期的脚本覆盖与待实现条件见[菜单与暂停](app-acceptance.md#菜单与暂停)和[物理交互](app-acceptance.md#物理交互)。

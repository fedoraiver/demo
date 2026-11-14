# scene_assembly 测试

[测试指南](README.md)说明分层和执行边界；实机步骤由用户执行。

## 场景与无窗口验证

灰盒场景与物理检查见 [场景测试](../../src/scene_assembly/tests.rs)，在仓库根目录执行。

```powershell
cargo test --locked scene_assembly::tests
cargo test --locked character::tests
cargo test --locked physics::tests
```

场景测试使用最小 `App / World`，只注册所需资源、BSN、变换和物理设施。检查开始时装配一套平地、玩家、控制者、相机、灯光与三个方块，网格与碰撞位于业务根。执行真实物理步验证接地和方块落地，通过真实 E 动作验证拿放。暂停与恢复保留实体，返回主菜单完整清理，连续开始只出现一套初始场景。

用户检查场景显示和生命周期见 [菜单与暂停验收](ui.md#英文菜单与暂停验收) 与 [物理交互验收](physics.md#物理交互验收)。

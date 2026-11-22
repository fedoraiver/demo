# physics 测试

[测试指南](README.md)说明分层与执行边界；客观应用检查使用验收构建与脚本，人工范围见[补充验收](game-acceptance.md)。

## 无窗口集成验证

运行 `cargo test --locked physics::tests`；休眠首步的测试条件见 [角色测试](character.md)，高速碰撞的条件见下方 [高速碰撞回归](#高速碰撞回归)。

## 高速碰撞回归

高速薄墙回归 `character_ccd_blocks_high_speed_velocity_and_impulses_at_different_yaws` 用 `SpeculativeCcd::new(0.001)` 限制推测接触距离，以不同水平 yaw 验证角色受到初速度或外部冲量后仍被扫掠阻挡。先完成一次高速物理步建立引擎预测邻域，再创建薄墙并检查后续实际固定步；用 `CcdFilter::NONE` 显式关闭扫掠的对照应穿过同一薄墙，避免 Avian 的自动 CCD 或推测接触造成假通过。不能仅在零 yaw 下验证，也不能将线性算法当作与当前非线性算法等效的替代。无窗口结果验证物理行为，不能证明真实渲染 FPS；具体耗时和执行结果记录在关联 Issue 或 PR 中。

`character_ccd_keeps_dynamic_body_protection_after_plugin_upgrade` 验证高速角色被动态薄墙逐帧阻挡，以 Avian 默认过滤的穿墙对照证明动态过滤位必要。`approaching_fast_dynamic_bodies_keep_their_order_with_predictive_neighbors` 覆盖角色与箱体、两个箱体高速相向运动：使用真实身体工厂，先推进一个尚未交会的高速步建立预测邻域，再逐帧保持顺序与最小间距；只移除双方 `SpeculativeCcd` 的对照应在随后的首个交会步交叉，证明速度扩张邻域参与候选生成，不能仅靠扫掠组件存在判断安全。

应用级移动、跳跃和碰撞见 [物理交互验收](physics.md#物理交互验收)。

## 物理交互验收

客观应用条件见[应用自动化验收](app-acceptance.md#物理交互)，验收运行方式与执行边界见[测试指南](README.md#agent-验证边界)。主观评价及确实无法可靠驱动的专项见[人工补充验收](game-acceptance.md)。

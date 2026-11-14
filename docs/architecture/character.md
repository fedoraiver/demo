# 角色架构

源码入口见 [character/](../../src/character/mod.rs)。

- **角色业务实体**通过 `Character`、意图与运动组件表达能力，Avian 动态刚体保存物理状态，`Transform` 表达插值呈现。根位于脚底；物理旋转锁定以防倾倒，水平朝向由相机系统同步。

## 接地、移动与跳跃

Avian 在默认固定调度中处理重力、速度积分与碰撞。接地通过脚底球体 shape cast 和地面法线判断，探测按角色的真实碰撞层过滤支撑物，持握箱不会作为角色支撑面；跳跃请求只在接地时施加一次向上冲量，侧面碰墙不能充当地面。移动轴先限制长度再转换为水平目标速度，通过力加速或减速，空中操控力度低于接地时；碰撞与外力可以改变实际速度，斜向输入不会提高目标速度。

## 连续碰撞检测

角色使用 `SweptCcd::default().with_filter(CcdFilter::ALL)`，按每步运动与碰撞体最薄尺寸的比例启用非线性扫掠，默认门槛为半厚度。普通步行按厚度门槛决定是否扫掠，高速外力与旋转接触仍受保护；过滤覆盖静态、运动学和动态刚体。角色与自由箱体还显式设置 `SpeculativeCcd::default()`，按速度扩张预测邻域，让相向高速动态物体在扫掠前互为碰撞候选。

`CharacterPlugin` 在 `OnEnter(AppState::MainMenu)` 和 `OnEnter(AppState::Paused)` 清空 `CharacterIntent`。

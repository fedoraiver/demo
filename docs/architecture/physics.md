# 物理架构

源码入口见 [physics/](../../src/physics/mod.rs)。

## 休眠身体唤醒

`GamePhysicsPlugin` 的提前唤醒只处理 `Sleeping` 身体：位姿、速度或 `SleepTimer` 的变化必须晚于 `LastPhysicsTick`，才排队 `WakeBody`，并在准备求解器前提交。这样跳跃、主动移动与外部冲量在首个固定步参与重力和位置积分；物理自身的回写不会反复唤醒静置物体，正常休眠继续由 Avian 管理。

## 碰撞检测与重力

方块沿用[角色连续碰撞检测](character.md#连续碰撞检测)的半厚度门槛与完整过滤，保留动态接触与旋转扫掠。角色或箱体形状、旋转约束及运动速度变化后须重评门槛，并保留不同水平 yaw 的高速薄墙及无 CCD 穿透对照；检查见 [高速碰撞回归](../testing/physics.md#高速碰撞回归) 与 [物理交互验收](../testing/physics.md#物理交互验收)。

运动与尺寸参数以 [PrototypeConfig](../../src/settings/prototype.rs) 的定义和默认值为准；固定步中在 `PrototypeConfig` 变化时将重力同步到物理资源，检查器编辑只影响当前会话。

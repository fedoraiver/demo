# 持箱转向错位

## Executive summary

自由视角下，持箱转动鼠标曾导致木箱抖动或出现虚影。没有固定步的帧里，镜头先使用了本帧视角，人物朝向和木箱还停在上一次固定步的姿态。旧测试补跑固定步后才断言，掩盖了错位。

## Impact and scope

旧架构以 120 FPS 渲染和 60 Hz 固定模拟为例，说明持箱转向时部分渲染帧不执行固定步。保存下来的实机反馈确认了虚影消失，未记录反馈时的帧率或其他验收结果。

## Evidence and timeline

首次发生日期未留存。2026-10-01 的[修复提交](https://github.com/fedoraiver/demo/commit/919323af37aa653688f2b1e754708ed681bb12ca)记录了固定步与逐帧姿态同步的调整。同次提交的[架构记录](https://github.com/fedoraiver/demo/blob/919323af37aa653688f2b1e754708ed681bb12ca/docs/architecture.md#L75-L83)记载了故障现象、旧测试顺序和用户反馈。

## Root cause and missed safeguards

旧实现每帧读取鼠标角度并更新镜头，人物和持物只在 `FixedUpdate` 更新。在相邻固定步之间，镜头与木箱使用不同帧的角度。旧测试在 `app.update()` 返回后主动补跑一次固定步，人物和木箱已追上镜头，断言看不到玩家实际看到的帧末状态。

## Prevention

当时的修复在逐帧更新中按人物朝向、持物姿态、镜头的顺序同步，再由 `PostUpdate` 传播变换。移动、重力和拿放仍在固定步处理。修改相机、转向或附件跟随时，应在 `app.update()` 返回后立即检查帧末变换，覆盖本帧没有固定步的情况。[帧末姿态回归](../testing/item_interaction.md#避免测试掩盖帧间错位)

## Related records

- [当前调度与模拟边界](../architecture/game_flow.md#调度与模拟边界)
- [故障修复时的回归说明](https://github.com/fedoraiver/demo/blob/919323af37aa653688f2b1e754708ed681bb12ca/docs/testing.md#避免测试掩盖帧间错位)

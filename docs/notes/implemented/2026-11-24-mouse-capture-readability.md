# Agent Note: 鼠标捕获决策的可读性

Status: implemented

## Problem

[Issue #11 第 14 项](https://github.com/fedoraiver/demo/issues/11)提出整理鼠标捕获系统。当前相机捕获优先级与组件写入交错，读者需要从多个分支同时还原状态变化和日志原因。

## Decision

用只读函数按优先级计算相机的下一捕获状态和原因。系统完整消费窗口焦点消息，并把得到的同一焦点状态用于相机决策和玩法输入日志。

## Changes

[捕获系统](../../../src/first_person/capture.rs) 统一依据初始化或捕获切换标记应跳过的位移，并记录捕获日志。现有 [无窗口测试](../../../src/first_person/tests.rs) 增加 Esc 与 F3 同帧按下的用例，验证释放状态、光标可见性与玩法上下文。

## Alternatives considered

拆成多个 ECS 系统会为每帧的捕获结果引入额外的传递数据和调度约束。局部纯函数可以表达决策顺序，并由现有系统管理所有写入。

## Consequences

相机决策与光标、Egui 转发和玩法输入归属的更新仍在同一个 PreUpdate 系统内完成。失焦消息即使和回焦同帧也会触发释放。捕获条件与调度边界见 [第一人称架构](../../architecture/first_person.md#鼠标捕获与输入归属)。

## Verification

[第一人称无窗口测试](../../testing/first_person.md) 覆盖同帧按键优先级、F3、失焦回焦、暂停恢复与关联失效。检查器构建和实际输入回归的入口见 [检查器测试](../../testing/inspector.md)。

# Agent Note: 可选检查器与诊断反射

Status: implemented

## Problem

普通游戏默认编译和装配世界检查器，玩法类型也默认携带诊断反射。检查器、BRP 验收和 Bevy 设置持久化需要各自对应的构建边界。

## Decision

使用 `inspector` 选择窗口游戏的检查器。任一诊断 feature 都提供当前已有的诊断反射。由 Bevy 自动注册可收集的类型，继续注册无法由派生收集的泛型实例。设置持久化沿用始终开启的反射。

## Changes

[运行入口](../../../README.md#运行)与[检查器架构](../../architecture/inspector.md)说明 feature 组合。鼠标捕获保留在基础输入路径，Egui 转发随检查器构建。无窗入口可和检查器同时编译，运行时按验收模式装配。会话日志脚本检查玩法、固定时步和限帧初始化，检查器日志归专项验证。调度导出记录启用的 feature。

## Alternatives considered

为检查器与验收维护两份反射范围可以减少普通检查器可编辑的数据。共用范围让两种工具访问同一组已有诊断字段。

## Consequences

开启检查器后可展开鼠标捕获等原供 BRP 读取的数据。原生 BRP 继续通过显式注册读取应用状态及键鼠的三个泛型实例。普通启动仍以原生设置反射保存用户配置。[验收接入](../../architecture/acceptance.md) · [设置持久化](../../architecture/settings.md#设置草稿与持久化)

## Verification

覆盖各 feature 的构建与装配、设置读写、已有诊断数据的自动注册、基础鼠标捕获及 Egui 输入转发。五套脚本按[自动化启动准备](../../testing/README.md#自动化启动准备)执行，检查器窗口操作按专项条件验证。[世界检查器测试](../../testing/inspector.md)

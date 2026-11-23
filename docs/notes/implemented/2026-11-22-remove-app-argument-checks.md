# Agent Note: 移除应用入口的参数检查

Status: implemented

## Problem

[入口参数的原有约定](2026-11-22-ordinary-game-schedule-export.md)要求应用按指定参数形式启动，额外参数会使入口提前退出。

## Decision

普通游戏、检查器和无窗验收忽略命令行参数。调度导出只读取可选的 `--output <directory>`。

## Changes

移除四个应用入口的参数拒绝分支。[调度导出](https://github.com/fedoraiver/demo/blob/054f6fdf596d2f6b4c9c0ce9ce6999250e28da4f/docs/diagrams/maintenance.md#调度导出边界)默认写入仓库根下的 `tmp/schedules`，供人工启动和未指定目录时使用。

## Alternatives considered

移除 `--output` 会使架构提取工具无法为每次运行指定独立的导出目录。

## Consequences

架构提取继续使用显式输出路径。验收端口继续从环境变量读取并由验收工具解析。

## Verification

检查四个应用的编译，验证调度导出的默认路径和带额外参数的显式路径。

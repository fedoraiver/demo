# Agent Note: 隔离规则测试的临时 Cargo 工作区

Status: implemented

## Problem

仓库根声明 Cargo workspace 后，Cargo 会尝试将 `tmp/` 下只声明 `[package]` 的测试包归入该 workspace。规则测试在加载清单时失败。

## Decision

生成的测试包在根清单中声明自己的 `[workspace]`，路径依赖继续作为依赖包编译。

## Changes

[具名字段测试](../../../tools/check-named-fields/tests/check.rs)和[实体命名测试](../../../tools/check-entity-names/tests/check.rs)各自声明临时包的工作区边界。

## Alternatives considered

在仓库清单排除每个临时路径会让根清单依赖各套测试的目录结构。

## Consequences

测试继续在仓库的 `tmp/` 下真实运行 Cargo，并覆盖临时包和外部宏的编译行为。

## Verification

运行两套 Cargo 集成测试，覆盖临时工作区加载、规则结果和编译报告故障注入。

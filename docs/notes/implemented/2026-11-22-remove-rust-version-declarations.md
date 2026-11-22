# Agent Note: 移除最低 Rust 版本声明

Status: implemented

## Problem

项目使用固定 nightly，同时在 Cargo 清单中维护最低 Rust 版本声明。

## Decision

由 [rust-toolchain.toml](../../../rust-toolchain.toml) 固定项目使用的编译器。

## Changes

移除游戏、应用及自有工具清单中的 `rust-version` 声明和继承项，并更新[开发规范](../../development.md#技术栈与版本)。

## Alternatives considered

保留最低版本声明需要在工具链升级时同步维护这些声明。

## Consequences

项目清单不再声明最低支持版本。依赖自身的编译器要求仍生效。

## Verification

使用固定 nightly 检查根工作区编译及各工具清单的依赖解析。

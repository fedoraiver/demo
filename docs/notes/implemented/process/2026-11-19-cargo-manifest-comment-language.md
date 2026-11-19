# Agent Note: Cargo 清单注释语言

Status: implemented

## Problem

根 [Cargo.toml](../../../../Cargo.toml) 的平台依赖注释为中文，其余注释为英文。

## Decision

根清单的注释统一使用英文。

## Changes

将根清单的平台依赖注释译为英文，并明确指出对应平台是 macOS 和 Windows。

## Alternatives considered

此项为直接翻译，无需比较替代方案。

## Consequences

Cargo 配置保持原样。

## Verification

逐行比较注释之外的清单内容，并确认三条注释均为英文。

# Agent Note: 文档审查子代理模型更新

Status: implemented — 已同步派发规则、示例与记录校验。

## Problem

文档审查流程的事实与归属审查和独立终审需要迁移到 6.2 Sol。

## Decision

按[派发规则](../../../../.agents/skills/review-docs/references/delegation.md)，事实与归属审查和独立终审用 `gpt-6.2-sol`，文案修订用 `gpt-6.1-terra`。各角色沿用原推理档位。

## Changes

同步更新[分工记录示例](../../../../.agents/skills/review-docs/references/tooling.md)、[默认校验模型](../../../../.agents/skills/review-docs/scripts/records.mjs)及相关测试数据。

## Alternatives considered

模型与角色由需求指定，无需比较其他模型。

## Consequences

默认模型校验作用于新录入的分工记录。旧会话按原有哈希链读取，保留当时的模型标识。

## Verification

使用工具自测验证两个派发模型的记录可录入，并检查 `gpt-6.2-astra` 在默认校验下被拒绝。

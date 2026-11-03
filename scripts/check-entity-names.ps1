# 规则入口共用编译器宿主、回归执行和专用缓存。
param(
    [string]$Target,
    [string[]]$Features = @(),
    [switch]$AllFeatures
)
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$arguments = @('verify', '--rule', 'entity-names', '--workspace', $projectRoot)
if ($Target) { $arguments += @('--target', $Target) }
if ($Features.Count -gt 0) { $arguments += @('--features', ($Features -join ',')) }
if ($AllFeatures) { $arguments += '--all-features' }
& (Join-Path $PSScriptRoot 'rustc-analysis.ps1') @arguments
exit $LASTEXITCODE
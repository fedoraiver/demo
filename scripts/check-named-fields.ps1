# 本地运行具名字段检查，按格式、回归和仓库编译检查的顺序失败即停。
param(
    [string]$Target,
    [string[]]$Features = @(),
    [switch]$AllFeatures
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $projectRoot 'tools/check-named-fields/Cargo.toml'
$variables = @('CARGO_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR')
$previous = @{}
foreach ($variable in $variables) {
    $previous[$variable] = [Environment]::GetEnvironmentVariable($variable, 'Process')
}

Push-Location -LiteralPath $projectRoot
try {
    $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'tmp/named-fields/tool/t'
    $env:CARGO_BUILD_BUILD_DIR = Join-Path $projectRoot 'tmp/named-fields/tool/b'

    Write-Host 'Checking named-fields tool formatting...'
    & cargo fmt --manifest-path $manifestPath -- --check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & cargo build --locked --manifest-path $manifestPath --bins
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host 'Testing named-fields checker...'
    & cargo test --locked --manifest-path $manifestPath -- --test-threads=1
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host 'Checking compiled project structs...'
    $arguments = @($projectRoot)
    if ($Target) { $arguments += @('--target', $Target) }
    if ($Features.Count -gt 0) { $arguments += @('--features', ($Features -join ',')) }
    if ($AllFeatures) { $arguments += '--all-features' }
    & cargo run --locked --manifest-path $manifestPath -- @arguments
    exit $LASTEXITCODE
}
finally {
    foreach ($variable in $variables) {
        [Environment]::SetEnvironmentVariable($variable, $previous[$variable], 'Process')
    }
    Pop-Location
}

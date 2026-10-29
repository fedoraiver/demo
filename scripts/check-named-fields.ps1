# 本地运行具名字段检查，按格式、回归测试和真实源码扫描的顺序失败即停。
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $projectRoot 'tools/check-named-fields/Cargo.toml'
$previousTargetDir = [Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR', 'Process')

Push-Location -LiteralPath $projectRoot
try {
    $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'tmp/named-fields/target'

    Write-Host 'Checking named-fields tool formatting...'
    & cargo fmt --manifest-path $manifestPath -- --check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host 'Testing named-fields checker...'
    & cargo test --locked --manifest-path $manifestPath
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host 'Checking project wrapper structs...'
    & cargo run --locked --manifest-path $manifestPath -- $projectRoot
    exit $LASTEXITCODE
}
finally {
    [Environment]::SetEnvironmentVariable('CARGO_TARGET_DIR', $previousTargetDir, 'Process')
    Pop-Location
}

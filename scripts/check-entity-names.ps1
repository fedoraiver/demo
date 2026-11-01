# 只运行静态检查器的回归和生产源码扫描，不执行游戏测试或启动游戏。
param(
    [string]$Target,
    [string[]]$Features = @(),
    [switch]$AllFeatures
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $projectRoot 'tools/check-entity-names/Cargo.toml'
$variables = @('CARGO_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR', 'ENTITY_NAME_CHECK_TARGET', 'ENTITY_NAME_CHECK_FEATURES', 'ENTITY_NAME_CHECK_ALL_FEATURES')
$previous = @{}
foreach ($variable in $variables) {
    $previous[$variable] = [Environment]::GetEnvironmentVariable($variable, 'Process')
}

Push-Location -LiteralPath $projectRoot
try {
    $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'tmp/entity-names/tool/target'
    $env:CARGO_BUILD_BUILD_DIR = Join-Path $projectRoot 'tmp/entity-names/tool/build'
    $env:ENTITY_NAME_CHECK_TARGET = $Target
    $env:ENTITY_NAME_CHECK_FEATURES = $Features -join ','
    $env:ENTITY_NAME_CHECK_ALL_FEATURES = $AllFeatures.IsPresent.ToString()

    & cargo fmt --manifest-path $manifestPath -- --check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & cargo build --locked --manifest-path $manifestPath --bins
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & cargo test --locked --manifest-path $manifestPath -- --nocapture --test-threads=1
    exit $LASTEXITCODE
}
finally {
    Pop-Location
    foreach ($variable in $variables) {
        [Environment]::SetEnvironmentVariable($variable, $previous[$variable], 'Process')
    }
}

[CmdletBinding()]
param(
    [switch]$InstallDependencies,
    [switch]$Test,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CliArguments
)

$ErrorActionPreference = 'Stop'
# 原生命令的退出码由本入口显式处理，避免调用方偏好把 CLI 的既有错误 JSON 变成第二份异常输出。
$PSNativeCommandUseErrorActionPreference = $false
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $workspaceRoot 'tools/review-docs'
$runtimeRoot = Join-Path $workspaceRoot 'tmp/review-docs/runtime'
$originalLocation = Get-Location
$originalCache = $env:npm_config_cache
$originalConsoleOutputEncoding = [Console]::OutputEncoding
$originalOutputEncoding = $OutputEncoding
$resultCode = 0

try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    $nodeVersion = & node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.13.0') {
        throw 'review-docs 需要 Node.js >=22.13.0。'
    }
    if ($InstallDependencies) {
        # 安装目录和缓存必须属于脚本所在工作树；禁止重解析点将写入导向其他目录。
        foreach ($relative in @('tmp', 'tmp/review-docs', 'tmp/review-docs/runtime', 'tmp/review-docs/npm-cache')) {
            $candidate = Join-Path $workspaceRoot $relative
            if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "依赖安装目录禁止链接: $candidate"
            }
        }
        foreach ($relative in @('tmp/review-docs/runtime', 'tmp/review-docs/npm-cache')) {
            $existingRoot = Join-Path $workspaceRoot $relative
            if (Test-Path -LiteralPath $existingRoot) {
                $nestedLink = Get-ChildItem -LiteralPath $existingRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
                if ($nestedLink) { throw "依赖或缓存目录禁止内部链接: $($nestedLink.FullName)" }
            }
        }
        New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
        foreach ($name in @('package.json', 'package-lock.json')) {
            $destination = Join-Path $runtimeRoot $name
            if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "依赖文件禁止链接: $destination" }
            Copy-Item -LiteralPath (Join-Path $toolRoot $name) -Destination $destination -Force
        }
        $env:npm_config_cache = Join-Path $workspaceRoot 'tmp/review-docs/npm-cache'
        Set-Location -LiteralPath $runtimeRoot
        & npm ci --ignore-scripts --no-audit --no-fund | ForEach-Object { [Console]::Error.WriteLine($_) }
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
    }
    if ($Test) {
        Set-Location -LiteralPath $workspaceRoot
        & node --test (Join-Path $toolRoot 'tests.mjs')
        $resultCode = $LASTEXITCODE
    } elseif ($CliArguments.Count -gt 0) {
        Set-Location -LiteralPath $originalLocation.Path
        & node (Join-Path $toolRoot 'cli.mjs') @CliArguments
        $resultCode = $LASTEXITCODE
    } elseif (-not $InstallDependencies) {
        throw '请指定 init/check/record/report，或 -InstallDependencies/-Test。'
    }
} catch {
    @{ schemaVersion = 1; error = $_.Exception.Message } | ConvertTo-Json -Compress | Write-Output
    [Console]::Error.WriteLine($_.Exception.Message)
    $resultCode = 2
} finally {
    Set-Location -LiteralPath $originalLocation.Path
    if ($null -eq $originalCache) { Remove-Item Env:npm_config_cache -ErrorAction SilentlyContinue } else { $env:npm_config_cache = $originalCache }
    [Console]::OutputEncoding = $originalConsoleOutputEncoding
    $OutputEncoding = $originalOutputEncoding
}
exit $resultCode

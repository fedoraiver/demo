# 统一构建和调用分析工具；全部编译产物隔离在所属检出的 tmp 下。
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$arguments = @($args)
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$toolManifest = Join-Path $projectRoot 'tools/rustc-analysis/Cargo.toml'
$variables = @('CARGO_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR', 'PATH', 'LD_LIBRARY_PATH')
$previous = @{}
foreach ($variable in $variables) {
    $previous[$variable] = [Environment]::GetEnvironmentVariable($variable, 'Process')
}
Push-Location -LiteralPath $projectRoot
try {
    $env:CARGO_TARGET_DIR = Join-Path $projectRoot 'tmp/rustc-analysis/tool/target'
    $env:CARGO_BUILD_BUILD_DIR = Join-Path $projectRoot 'tmp/rustc-analysis/tool/build'
    $compilerRoot = (& rustc --print sysroot).Trim()
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $env:PATH = (Join-Path $compilerRoot 'bin') + [IO.Path]::PathSeparator + (Join-Path $compilerRoot 'lib') + [IO.Path]::PathSeparator + $env:PATH
    if ($IsLinux) {
        # 直接运行 driver 及回归子进程时，也能加载固定工具链的编译器与标准库。
        $targetLibraries = (& rustc --print target-libdir).Trim()
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $libraryPaths = @((Join-Path $compilerRoot 'lib'), $targetLibraries)
        if ($env:LD_LIBRARY_PATH) { $libraryPaths += $env:LD_LIBRARY_PATH }
        $env:LD_LIBRARY_PATH = $libraryPaths -join [IO.Path]::PathSeparator
    }
    & cargo build --locked --manifest-path $toolManifest --workspace --bins
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($arguments.Count -gt 0 -and $arguments[0] -eq '--build-only') { exit 0 }
    if ($arguments.Count -gt 0 -and $arguments[0] -eq 'verify') {
        $ruleIndex = [Array]::IndexOf($arguments, '--rule')
        if ($ruleIndex -lt 0 -or $ruleIndex + 1 -ge $arguments.Count) { throw 'verify requires --rule' }
        $rule = $arguments[$ruleIndex + 1]
        if ($rule -notin @('named-fields', 'entity-names')) { throw 'Unknown verification rule' }
        & cargo fmt --all --manifest-path $toolManifest -- --check
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & cargo test --locked --manifest-path $toolManifest --workspace -- --test-threads=1
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $regressionManifest = Join-Path $projectRoot ('tools/check-' + $rule + '/Cargo.toml')
        & cargo build --locked --manifest-path $regressionManifest --bins
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & cargo test --locked --manifest-path $regressionManifest -- --test-threads=1 --skip production_source_entities_have_names_at_creation
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $arguments[0] = 'check'
    }
    $analysisProgram = if ($IsWindows) { 'rustc-analysis.exe' } else { 'rustc-analysis' }
    & (Join-Path $env:CARGO_TARGET_DIR ('debug/' + $analysisProgram)) @arguments
    exit $LASTEXITCODE
}
finally {
    Pop-Location
    foreach ($variable in $variables) {
        [Environment]::SetEnvironmentVariable($variable, $previous[$variable], 'Process')
    }
}

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$HookArguments
)

$ErrorActionPreference = 'Stop'

# Windows Git 的 sh Hook 中 $PPID 可能恒为 1；读取原生祖先进程来配对同次提交的前后入口。
# 创建时间参与标识，避免进程 ID 重用时误消费以前失败提交留下的回执。
if ($HookArguments.Count -gt 0 -and $HookArguments.Count -lt 2 -and
    $HookArguments[0] -in @('pre-commit', 'synchronize-index')) {
    $ancestorProcessId = $PID
    for ($depth = 0; $depth -lt 8; $depth++) {
        $processMetadata = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ancestorProcessId" `
            -Property ProcessId, ParentProcessId, Name, CreationDate -ErrorAction Stop
        if ($null -eq $processMetadata) {
            break
        }
        if ($processMetadata.Name -ieq 'git.exe') {
            if ($null -ne $processMetadata.CreationDate) {
                $creationTicks = $processMetadata.CreationDate.ToUniversalTime().Ticks
                $HookArguments = @($HookArguments) + "$($processMetadata.ProcessId)-$creationTicks"
            }
            break
        }
        if ($processMetadata.ParentProcessId -eq 0 -or $processMetadata.ParentProcessId -eq $ancestorProcessId) {
            break
        }
        $ancestorProcessId = $processMetadata.ParentProcessId
    }
}

# 优先复用桌面应用随附的运行时；其他机器可使用 PATH 中的 Node.js。
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (Test-Path -LiteralPath $bundledNode) {
    $nodePath = $bundledNode
} else {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
}

# Git Hook 通过参数调用生成或索引同步入口；手动调用没有 Git 祖先时保持原参数。
& $nodePath (Join-Path $PSScriptRoot 'architecture-hook.mjs') @HookArguments
exit $LASTEXITCODE

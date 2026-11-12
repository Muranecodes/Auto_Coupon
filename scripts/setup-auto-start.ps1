$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $RepoRoot "scripts\fetch_coupons.py"
$PythonExe = (Get-Command python).Source
$PythonwExe = Join-Path (Split-Path -Parent $PythonExe) "pythonw.exe"
if (-not (Test-Path $PythonwExe)) {
    $PythonwExe = $PythonExe
}

# 1. 註冊 Windows 工作排程器 (Task Scheduler) 每日排程 (StartWhenAvailable: 錯過時間開機後自動補跑)
$TaskName = "Auto_Coupon_Daily_Update"
$Action = New-ScheduledTaskAction `
    -Execute $PythonwExe `
    -Argument "`"$ScriptPath`" --once-per-day --wait-network --git-push" `
    -WorkingDirectory $RepoRoot

$TriggerDaily = New-ScheduledTaskTrigger -Daily -At 9:00AM
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $TriggerDaily `
    -Settings $Settings `
    -Description "每日開機後自動抓取 CallingTaiwan foodpanda 與 Uber Eats 優惠碼並更新 coupons.json" `
    -Force | Out-Null

Write-Host "✅ 已註冊 Windows 工作排程器任務: $TaskName"

# 2. 建立 Windows 啟動資料夾 (Startup) 靜默啟動腳本 (純 ASCII 觸發工作排程器，開機登入後自動背景執行，不彈出黑窗且避開中文路徑編碼問題)
$StartupDir = [Environment]::GetFolderPath('Startup')
$VbsPath = Join-Path $StartupDir "Auto_Coupon_Daily.vbs"

$VbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "schtasks /Run /TN ""$TaskName""", 0, False
"@

[System.IO.File]::WriteAllText($VbsPath, $VbsContent, [System.Text.Encoding]::ASCII)
Write-Host "✅ 已建立開機自動執行腳本: $VbsPath"

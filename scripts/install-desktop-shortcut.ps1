$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$archiveRoot = Join-Path $env:USERPROFILE '.dsh\data\qq-archive'
$settingsPath = Join-Path $archiveRoot 'launcher-settings.json'
if (-not (Test-Path -LiteralPath $settingsPath)) { throw 'Create launcher-settings.json before installing the shortcut.' }
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$dshRoot = [string]$settings.dshRoot
if ([string]::IsNullOrWhiteSpace($dshRoot) -or -not (Test-Path -LiteralPath $dshRoot)) {
  throw 'launcher-settings.json must contain a valid dshRoot.'
}
$launcher = Join-Path $PSScriptRoot 'start-dsh-with-qq.ps1'
$target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'DSH + QQ 群归档.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$shortcut.WorkingDirectory = $dshRoot
$shortcut.Description = 'Start DSH, SnowLuma, and the local QQ archive'
$shortcut.IconLocation = "$target,0"
$shortcut.Save()
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
Write-Host "Created $shortcutPath"

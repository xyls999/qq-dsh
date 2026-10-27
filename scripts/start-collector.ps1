$ErrorActionPreference = 'Stop'
$archiveRoot = Join-Path $env:USERPROFILE '.dsh\data\qq-archive'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$snowLumaRoot = $env:SNOWLUMA_ROOT
if ([string]::IsNullOrWhiteSpace($snowLumaRoot)) {
  $settingsPath = Join-Path $archiveRoot 'launcher-settings.json'
  if (-not (Test-Path -LiteralPath $settingsPath)) { throw 'SnowLuma root is not configured.' }
  $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
  $snowLumaRoot = [string]$settings.snowLumaRoot
}
$configRoot = Join-Path $snowLumaRoot 'config'
$configFiles = @(Get-ChildItem -LiteralPath $configRoot -Filter 'onebot_*.json' -File)
if ($configFiles.Count -ne 1) {
  throw "Expected exactly one SnowLuma account config; found $($configFiles.Count)."
}
$config = Get-Content -LiteralPath $configFiles[0].FullName -Raw | ConvertFrom-Json
$server = @($config.networks.wsServers | Where-Object { $_.name -eq 'ws-default' })
if ($server.Count -ne 1 -or $server[0].host -ne '127.0.0.1' -or $server[0].port -ne 3001) {
  throw 'SnowLuma ws-default must be the local 127.0.0.1:3001 server.'
}
if ([string]::IsNullOrWhiteSpace([string]$server[0].accessToken)) {
  throw 'SnowLuma ws-default has no access token.'
}
$env:SNOWLUMA_ACCESS_TOKEN = [string]$server[0].accessToken
Set-Location -LiteralPath $pluginRoot
Write-Host 'Starting the local, target-group-only archive collector. Press Ctrl+C to stop.'
try {
  & node .\src\cli.js start --enable
} finally {
  Remove-Item Env:SNOWLUMA_ACCESS_TOKEN -ErrorAction SilentlyContinue
}

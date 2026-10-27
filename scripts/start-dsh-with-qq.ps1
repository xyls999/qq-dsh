param([switch]$LibraryOnly)

$ErrorActionPreference = 'Stop'

function Get-LaunchPlan {
  param(
    [bool]$SnowLumaReady,
    [bool]$CollectorConnected,
    [bool]$DshRunning
  )

  $plan = @()
  if ($SnowLumaReady) {
    $plan += 'Reuse-SnowLuma'
  } else {
    $plan += 'Start-SnowLuma', 'Wait-SnowLuma'
  }
  if ($CollectorConnected) {
    $plan += 'Reuse-Collector'
  } else {
    $plan += 'Start-Collector', 'Wait-Collector'
  }
  if ($DshRunning) {
    $plan += 'Reuse-DSH'
  } else {
    $plan += 'Start-DSH'
  }
  return $plan
}

if ($LibraryOnly) { return }

$script:ArchiveRoot = Join-Path $env:USERPROFILE '.dsh\data\qq-archive'
$script:SettingsPath = Join-Path $script:ArchiveRoot 'launcher-settings.json'
$script:PluginRoot = Split-Path -Parent $PSScriptRoot
$script:CollectorStarter = Join-Path $PSScriptRoot 'start-collector.ps1'
$script:CollectorCli = Join-Path $script:PluginRoot 'src\cli.js'
$script:PluginConfig = Join-Path $script:PluginRoot 'config.json'
$script:NodePath = (Get-Command node.exe -ErrorAction Stop).Source

function Get-ListenerOwners {
  param([int]$Port)
  return @(
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
}

function Get-SnowLumaState {
  $webOwners = @(Get-ListenerOwners -Port 5099)
  $oneBotOwners = @(Get-ListenerOwners -Port 3001)
  if ($webOwners.Count -eq 0 -and $oneBotOwners.Count -eq 0) { return 'stopped' }
  if ($webOwners.Count -ne 1 -or $oneBotOwners.Count -ne 1 -or $webOwners[0] -ne $oneBotOwners[0]) {
    return 'partial'
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($webOwners[0])"
  if ($process.ExecutablePath -like "$script:SnowLumaRoot\*" -and $process.CommandLine -match 'index\.mjs') {
    return 'ready'
  }
  return 'conflict'
}

function Wait-ForSnowLuma {
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    $state = Get-SnowLumaState
    if ($state -eq 'ready') { return }
    if ($state -ne 'stopped') { throw "SnowLuma ports are in a partial or conflicting state ($state); refusing to launch another instance." }
    Start-Sleep -Seconds 1
  }
  throw 'SnowLuma did not become ready on ports 5099 and 3001 within 90 seconds.'
}

function Get-CollectorStatus {
  try {
    $output = & $script:NodePath $script:CollectorCli status 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return (($output -join "`n") | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Test-CollectorProcess {
  $starter = [regex]::Escape($script:CollectorStarter)
  return [bool](@(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -match $starter
  }).Count -gt 0)
}

function Wait-ForCollector {
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    $status = Get-CollectorStatus
    if ($status -and $status.modelExportEnabled) {
      throw 'DeepSeek message export is enabled; refusing to continue the automatic launcher.'
    }
    if ($status -and $status.enabled -and $status.collector.state -eq 'connected') { return }
    Start-Sleep -Seconds 1
  }
  throw 'The local archive collector did not connect to SnowLuma within 45 seconds.'
}

function Test-DshRunning {
  return [bool](@(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and
      $_.CommandLine -match 'apps[\\/]cli[\\/]src[\\/]bin\.ts' -and
      $_.CommandLine -match '\bweb\b'
  }).Count -gt 0)
}

$mutex = [Threading.Mutex]::new($false, 'Local\DshQqArchiveStartup')
$ownsMutex = $false
try {
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) {
    Write-Host 'The DSH + QQ startup launcher is already running.'
    return
  }

  if (-not (Test-Path -LiteralPath $script:SettingsPath)) {
    throw 'Create launcher-settings.json in the local archive data directory with snowLumaRoot and dshRoot.'
  }
  $settings = Get-Content -LiteralPath $script:SettingsPath -Raw | ConvertFrom-Json
  $script:SnowLumaRoot = [string]$settings.snowLumaRoot
  $script:DshRoot = [string]$settings.dshRoot
  foreach ($path in @($script:SnowLumaRoot, $script:DshRoot, $script:CollectorStarter, $script:CollectorCli, $script:PluginConfig)) {
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) {
      throw "Required startup path not found: $path"
    }
  }

  $pluginConfig = Get-Content -LiteralPath $script:PluginConfig -Raw | ConvertFrom-Json
  if ($pluginConfig.modelExportEnabled) {
    throw 'DeepSeek message export is enabled; disable it before using the automatic launcher.'
  }

  $snowLumaState = Get-SnowLumaState
  if ($snowLumaState -in @('partial', 'conflict')) {
    throw "SnowLuma is partially running or another process owns its ports ($snowLumaState); refusing to create a duplicate."
  }
  $collectorStatus = Get-CollectorStatus
  if ($collectorStatus -and $collectorStatus.modelExportEnabled) {
    throw 'DeepSeek message export is enabled; disable it before using the automatic launcher.'
  }
  $collectorConnected = $collectorStatus -and $collectorStatus.enabled -and $collectorStatus.collector.state -eq 'connected'
  $plan = Get-LaunchPlan -SnowLumaReady ($snowLumaState -eq 'ready') -CollectorConnected ([bool]$collectorConnected) -DshRunning (Test-DshRunning)
  Write-Host ("Startup plan: " + ($plan -join ' -> '))

  if ($snowLumaState -eq 'stopped') {
    Start-Process -FilePath $env:ComSpec -ArgumentList "/c `"$(Join-Path $script:SnowLumaRoot 'launcher.bat')`"" `
      -WorkingDirectory $script:SnowLumaRoot -WindowStyle Normal | Out-Null
    Wait-ForSnowLuma
  }

  if (-not $collectorConnected) {
    if (Test-CollectorProcess) {
      Wait-ForCollector
    } else {
      $oldSnowLumaRoot = $env:SNOWLUMA_ROOT
      $env:SNOWLUMA_ROOT = $script:SnowLumaRoot
      try {
        Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
          -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:CollectorStarter) `
          -WorkingDirectory $script:ArchiveRoot -WindowStyle Normal | Out-Null
      } finally {
        if ($null -eq $oldSnowLumaRoot) { Remove-Item Env:SNOWLUMA_ROOT -ErrorAction SilentlyContinue }
        else { $env:SNOWLUMA_ROOT = $oldSnowLumaRoot }
      }
      Wait-ForCollector
    }
  }

  if (-not (Test-DshRunning)) {
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/k', 'pnpm dsh web') `
      -WorkingDirectory $script:DshRoot -WindowStyle Normal | Out-Null
  }
  Write-Host 'DSH, SnowLuma, and the local QQ archive are ready. Model export remains disabled.'
} catch {
  Write-Error $_
  exit 1
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

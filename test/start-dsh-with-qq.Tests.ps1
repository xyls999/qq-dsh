$scriptUnderTest = Join-Path $PSScriptRoot '..\scripts\start-dsh-with-qq.ps1'
. $scriptUnderTest -LibraryOnly

Describe 'Get-LaunchPlan' {
  It 'starts SnowLuma and collector before DSH when none are running' {
    $plan = Get-LaunchPlan -SnowLumaReady $false -CollectorConnected $false -DshRunning $false
    ($plan -join ',') | Should Be 'Start-SnowLuma,Wait-SnowLuma,Start-Collector,Wait-Collector,Start-DSH'
  }

  It 'reuses all healthy services without launching duplicates' {
    $plan = Get-LaunchPlan -SnowLumaReady $true -CollectorConnected $true -DshRunning $true
    ($plan -join ',') | Should Be 'Reuse-SnowLuma,Reuse-Collector,Reuse-DSH'
  }

  It 'starts only the missing collector and DSH when SnowLuma is already ready' {
    $plan = Get-LaunchPlan -SnowLumaReady $true -CollectorConnected $false -DshRunning $false
    ($plan -join ',') | Should Be 'Reuse-SnowLuma,Start-Collector,Wait-Collector,Start-DSH'
  }
}

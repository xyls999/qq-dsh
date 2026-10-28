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

  It 'retries while SnowLuma brings up its listener ports' {
    Get-SnowLumaWaitAction -State 'partial' | Should Be 'Retry'
  }

  It 'rejects a conflicting process instead of waiting for it' {
    Get-SnowLumaWaitAction -State 'conflict' | Should Be 'Fail'
  }

  It 'blocks startup when SnowLuma status replies are enabled' {
    Get-SnowLumaStatusCommandAction -Enabled $true | Should Be 'Block'
  }

  It 'allows startup when SnowLuma status replies are disabled' {
    Get-SnowLumaStatusCommandAction -Enabled $false | Should Be 'Allow'
  }

  It 'blocks startup when the required egress guard is missing' {
    Get-SnowLumaGuardAction -Required $true -Verified $false | Should Be 'Block'
  }

  It 'allows startup when the required egress guard is verified' {
    Get-SnowLumaGuardAction -Required $true -Verified $true | Should Be 'Allow'
  }

  It 'does not require the optional egress guard by default' {
    Get-SnowLumaGuardAction -Required $false -Verified $false | Should Be 'Allow'
  }
}

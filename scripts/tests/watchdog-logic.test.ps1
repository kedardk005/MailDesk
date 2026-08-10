<#
    Decision-logic tests for watchdog-windows.ps1.

    Runs the SHIPPED script as a child process with only its two probes
    (Get-ApiState, Test-MongoReachable) and two side effects (Restore-Commit,
    nssm) replaced. The overrides are spliced in immediately before the Main
    section so they win by being defined last — every line of logic under test
    is the real source, not a re-implementation.

    Runs anywhere PowerShell 7 runs, including macOS and Linux, because none of
    the Windows-only calls are reached.

        pwsh -File scripts/tests/watchdog-logic.test.ps1

    Exits non-zero if any case fails.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$src   = (Resolve-Path (Join-Path $here '..' 'watchdog-windows.ps1')).Path
$pwsh  = (Get-Process -Id $PID).Path      # re-enter with the same interpreter
$body  = Get-Content -LiteralPath $src -Raw
$marker = @"
# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
"@
if ($body -notmatch [regex]::Escape($marker)) { throw 'Main marker not found' }

$GOOD = 'aaaaaaa1111111111111111111111111111111111'
$BAD  = 'bbbbbbb2222222222222222222222222222222222'

function New-State {
    param($sha, $lkg, $fails = 0, $since = 0, $rbf = $null)
    [ordered]@{ sha = $sha; healthySince = $since; lastKnownGood = $lkg
                consecutiveFailures = $fails; rolledBackFrom = $rbf; updatedAt = $null }
}

function Invoke-Tick {
    param($ApiState, [bool]$MongoUp, $CurrentSha, $State, [bool]$RestoreWorks = $true)

    $root = Join-Path ([System.IO.Path]::GetTempPath()) "wd-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Path (Join-Path $root '.git')  -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root 'logs')  -Force | Out-Null
    $stateFile = Join-Path $root 'logs/watchdog-state.json'
    $traceFile = Join-Path $root 'logs/trace.txt'
    Set-Content -LiteralPath $stateFile -Value ($State | ConvertTo-Json -Depth 4) -Encoding utf8

    $fakes = @"
# ---- test overrides (defined last, so these win) ----
function Get-ApiState { '$ApiState' }
function Test-MongoReachable { `$$($MongoUp.ToString().ToLower()) }
function Invoke-Native { param(`$Exe, `$Arguments, `$WorkingDirectory) return '$CurrentSha' }
function Restore-Commit {
    param(`$Sha, `$Label)
    Add-Content -LiteralPath '$traceFile' -Value "restore:`$Sha"
    return `$$($RestoreWorks.ToString().ToLower())
}
function nssm { Add-Content -LiteralPath '$traceFile' -Value 'nssm-restart' }

$marker
"@

    # Plain string splice: -replace would mangle backslashes in the fakes.
    $tmpScript = Join-Path $root 'run.ps1'
    $idx = $body.IndexOf($marker)
    $composed = $body.Substring(0, $idx) + $fakes + $body.Substring($idx + $marker.Length)
    Set-Content -LiteralPath $tmpScript -Value $composed -Encoding utf8

    & $pwsh -NoProfile -File $tmpScript -InstallDir $root -SoakMinutes 60 *> $null
    $code = $LASTEXITCODE

    $trace = if (Test-Path $traceFile) { Get-Content $traceFile -Raw } else { '' }
    $after = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $alert = Test-Path (Join-Path $root 'logs/WATCHDOG-NEEDS-ATTENTION.txt')
    Remove-Item -Recurse -Force $root
    return @{ exit = $code; trace = $trace; state = $after; alert = $alert }
}

$script:pass = 0; $script:fail = 0
function Check {
    param($Name, $Cond, $Detail)
    if ($Cond) { $script:pass++; "  PASS  $Name" }
    else { $script:fail++; "  FAIL  $Name -> $Detail" }
}

''
'== 1. degraded (API answers, database gone) must NOT roll back =='
$r = Invoke-Tick -ApiState 'degraded' -MongoUp $true -CurrentSha $BAD -State (New-State $BAD $GOOD 5)
Check 'exit 5 (dependency)'    ($r.exit -eq 5)              "got $($r.exit)"
Check 'no rollback attempted'  ($r.trace -notmatch 'restore') "trace=$($r.trace)"
Check 'alert raised'           $r.alert                     'no alert file'

'== 2. API down AND Mongo down must NOT roll back =='
$r = Invoke-Tick -ApiState 'down' -MongoUp $false -CurrentSha $BAD -State (New-State $BAD $GOOD 5)
Check 'exit 5 (dependency)'    ($r.exit -eq 5)              "got $($r.exit)"
Check 'no rollback attempted'  ($r.trace -notmatch 'restore') "trace=$($r.trace)"

'== 3. down + Mongo up: FIRST failure restarts, does not roll back =='
$r = Invoke-Tick -ApiState 'down' -MongoUp $true -CurrentSha $BAD -State (New-State $BAD $GOOD 0)
Check 'exit 0 (restart, keep watching)' ($r.exit -eq 0)      "got $($r.exit)"
Check 'service restarted'      ($r.trace -match 'nssm-restart') "trace=$($r.trace)"
Check 'no rollback yet'        ($r.trace -notmatch 'restore') "trace=$($r.trace)"
Check 'failure counter -> 1'   ($r.state.consecutiveFailures -eq 1) "got $($r.state.consecutiveFailures)"

'== 4. SECOND consecutive failure rolls back to last-known-good =='
$r = Invoke-Tick -ApiState 'down' -MongoUp $true -CurrentSha $BAD -State (New-State $BAD $GOOD 1)
Check 'exit 3 (rolled back, healthy)' ($r.exit -eq 3)        "got $($r.exit)"
Check 'rolled back to GOOD'    ($r.trace -match "restore:$GOOD") "trace=$($r.trace)"
Check 'rolledBackFrom recorded' ($r.state.rolledBackFrom -eq $BAD) "got $($r.state.rolledBackFrom)"
Check 'alert raised'           $r.alert                     'no alert file'

'== 5. already ON last-known-good: nothing to roll back to =='
$r = Invoke-Tick -ApiState 'down' -MongoUp $true -CurrentSha $GOOD -State (New-State $GOOD $GOOD 1)
Check 'exit 4 (needs a human)' ($r.exit -eq 4)              "got $($r.exit)"
Check 'no rollback attempted'  ($r.trace -notmatch 'restore') "trace=$($r.trace)"

'== 6. refuses to roll back twice from the same commit (no flapping) =='
$r = Invoke-Tick -ApiState 'down' -MongoUp $true -CurrentSha $BAD -State (New-State $BAD $GOOD 2 $null $BAD)
Check 'exit 4 (needs a human)' ($r.exit -eq 4)              "got $($r.exit)"
Check 'no second rollback'     ($r.trace -notmatch 'restore') "trace=$($r.trace)"

'== 7. no commit has soaked yet: refuses to guess a target =='
$r = Invoke-Tick -ApiState 'down' -MongoUp $true -CurrentSha $BAD -State (New-State $BAD $null 1)
Check 'exit 4 (needs a human)' ($r.exit -eq 4)              "got $($r.exit)"
Check 'no rollback attempted'  ($r.trace -notmatch 'restore') "trace=$($r.trace)"

'== 8. rollback that does not restore health escalates =='
$r = Invoke-Tick -ApiState 'down' -MongoUp $true -CurrentSha $BAD -State (New-State $BAD $GOOD 1) -RestoreWorks $false
Check 'exit 4 (rollback did not help)' ($r.exit -eq 4)      "got $($r.exit)"
Check 'rollback was attempted' ($r.trace -match 'restore')   "trace=$($r.trace)"

'== 9. healthy but inside the soak window: NOT promoted =='
$r = Invoke-Tick -ApiState 'healthy' -MongoUp $true -CurrentSha $BAD `
        -State (New-State $BAD $GOOD 0 ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 600))
Check 'exit 0'                 ($r.exit -eq 0)              "got $($r.exit)"
Check 'last-known-good unchanged' ($r.state.lastKnownGood -eq $GOOD) "got $($r.state.lastKnownGood)"

'== 10. healthy past the soak window: promoted =='
$r = Invoke-Tick -ApiState 'healthy' -MongoUp $true -CurrentSha $BAD `
        -State (New-State $BAD $GOOD 0 ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 4500))
Check 'exit 0'                 ($r.exit -eq 0)              "got $($r.exit)"
Check 'promoted to last-known-good' ($r.state.lastKnownGood -eq $BAD) "got $($r.state.lastKnownGood)"

'== 11. a new commit resets the soak clock and the failure counter =='
$r = Invoke-Tick -ApiState 'healthy' -MongoUp $true -CurrentSha $BAD `
        -State (New-State $GOOD $GOOD 2 ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 4500) $GOOD)
Check 'failure counter cleared' ($r.state.consecutiveFailures -eq 0) "got $($r.state.consecutiveFailures)"
Check 'not promoted on first sight' ($r.state.lastKnownGood -eq $GOOD) "got $($r.state.lastKnownGood)"
Check 'rolledBackFrom cleared' ($null -eq $r.state.rolledBackFrom) "got $($r.state.rolledBackFrom)"

'== 12. mid-deploy (shuttingDown) is a no-op =='
$r = Invoke-Tick -ApiState 'restarting' -MongoUp $true -CurrentSha $BAD -State (New-State $BAD $GOOD 1)
Check 'exit 0'                 ($r.exit -eq 0)              "got $($r.exit)"
Check 'no rollback'            ($r.trace -notmatch 'restore') "trace=$($r.trace)"
Check 'no restart'             ($r.trace -notmatch 'nssm')  "trace=$($r.trace)"

''
"RESULT: $script:pass passed, $script:fail failed"
if ($script:fail) { exit 1 }

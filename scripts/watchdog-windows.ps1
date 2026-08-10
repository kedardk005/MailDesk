<#
.SYNOPSIS
    Watches the MailDesk API between deploys and rolls back to the last commit
    that was known good if the current one stops serving.

.DESCRIPTION
    deploy-windows.ps1 already rolls back a deploy that fails its own health
    check. This covers the other case: the deploy passed, and the API fell over
    two hours later under real traffic. Run this every few minutes from Task
    Scheduler and it will notice, act, and stop.

    WHAT IT WILL NOT DO IS THE POINT.

    An auto-rollback that fires on any unhealthy reading is worse than none.
    The API reports unhealthy when MongoDB is unreachable, and reverting the
    code cannot fix a stopped database — it just destroys the evidence, churns
    node_modules, and leaves you debugging yesterday's build. So:

      * API answers but says database: disconnected  -> dependency, NOT the
        code. Never rolls back. Exit 5.
      * API does not answer AND Mongo's port is also dead -> the machine or
        the database is the problem. Never rolls back. Exit 5.
      * API does not answer, Mongo is fine -> the code is a real suspect.
        First failure restarts the service, because most things are transient.
        Only a second consecutive failure rolls back.
      * Already running the last known good commit -> nothing to roll back to.
        Says so and stops. Exit 4.

    It rolls back AT MOST ONCE per commit and never loops. A watchdog that
    keeps flapping a service is an outage with extra steps.

    Last-known-good is earned, not assumed: a commit is promoted only after it
    has been continuously healthy for -SoakMinutes. A deploy at 03:30 that
    breaks at 03:35 rolls back to the commit before it, not to itself.

.PARAMETER SoakMinutes
    How long a commit must stay healthy before it is trusted as the rollback
    target. Default 60.

.PARAMETER Install
    Register as a scheduled task running every -EveryMinutes and exit.

.EXAMPLE
    .\watchdog-windows.ps1 -Install          # elevated, one time

.EXAMPLE
    .\watchdog-windows.ps1 -WhatIfRollback   # dry run: report, change nothing

.NOTES
    Pairs with deploy-windows.ps1 and shares its InstallDir and log directory.
    State lives in logs\watchdog-state.json.
#>

[CmdletBinding()]
param(
    [string]$InstallDir  = 'C:\apps\maildesk',
    [string]$ServiceName = 'MailDeskAPI',
    [string]$HealthUrl   = 'http://127.0.0.1:5015/api/health',
    [string]$MongoHost   = '127.0.0.1',
    [int]   $MongoPort   = 27017,
    [int]   $SoakMinutes = 60,
    [int]   $EveryMinutes = 5,
    [int]   $HealthTimeoutSeconds = 90,
    [switch]$WhatIfRollback,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# PowerShell 5.1 is what ships on Windows 10/Server, and on older .NET it
# negotiates TLS 1.0 by default — github.com refuses that, so Get-CiState would
# return 'unknown' on every run and the deploy would refuse forever while
# looking like a CI problem. .NET 4.7+ usually gets this right on its own;
# pinning costs nothing and removes the doubt. install-windows.ps1 does the
# same at its top.
if ([Net.ServicePointManager]::SecurityProtocol -notmatch 'Tls12') {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$LogDir    = Join-Path $InstallDir 'logs'
$LogFile   = Join-Path $LogDir 'watchdog.log'
$StateFile = Join-Path $LogDir 'watchdog-state.json'
$AlertFile = Join-Path $LogDir 'WATCHDOG-NEEDS-ATTENTION.txt'
$serverDir = Join-Path $InstallDir 'server'

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'OK', 'WARN', 'FAIL')]
        [string]$Level = 'INFO'
    )
    $line = "{0} [{1,-4}] {2}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message
    if (Test-Path -LiteralPath $LogDir) {
        if ((Test-Path -LiteralPath $LogFile) -and
            ((Get-Item -LiteralPath $LogFile).Length -gt 5MB)) {
            Move-Item -LiteralPath $LogFile -Destination "$LogFile.1" -Force
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
    }
    $colour = switch ($Level) { 'OK' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
    Write-Host $line -ForegroundColor $colour
}

function Invoke-Native {
    # Same contract as deploy-windows.ps1: throw on non-zero exit, and do not
    # let git's stderr progress output become a terminating error under
    # $ErrorActionPreference='Stop'.
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$WorkingDirectory
    )
    $prev = $null
    if ($WorkingDirectory) { $prev = Get-Location; Set-Location -LiteralPath $WorkingDirectory }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Exe @Arguments 2>&1
        $code   = $LASTEXITCODE
        if ($code -ne 0) {
            throw "$Exe $($Arguments -join ' ') exited $code`n$(($output | Out-String).Trim())"
        }
        return ($output | Out-String).Trim()
    }
    finally {
        $ErrorActionPreference = $prevEap
        if ($prev) { Set-Location -LiteralPath $prev }
    }
}

# --------------------------------------------------------------------------
# -Install
# --------------------------------------------------------------------------
if ($Install) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin  = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
                    [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host 'Run this in an elevated PowerShell (Run as Administrator).' -ForegroundColor Red
        exit 1
    }

    $self     = $MyInvocation.MyCommand.Path
    $taskName = 'MailDesk Watchdog'
    $argLine  = @(
        '-NoProfile', '-ExecutionPolicy Bypass', "-File `"$self`""
        "-InstallDir `"$InstallDir`"", "-HealthUrl `"$HealthUrl`""
        "-SoakMinutes $SoakMinutes"
    ) -join ' '

    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
                   -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' `
                     -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                     -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
                     -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null

    Write-Host ''
    Write-Host "Registered '$taskName', every $EveryMinutes minutes." -ForegroundColor Green
    Write-Host "  Log:    $LogFile"
    Write-Host "  State:  $StateFile"
    Write-Host "  Alert:  $AlertFile (created only when a human is needed)"
    exit 0
}

# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

function Read-State {
    $default = [ordered]@{
        sha                 = $null   # commit the watchdog last observed
        # Unix epoch SECONDS, deliberately not an ISO string. ConvertFrom-Json
        # silently rehydrates an ISO timestamp into a [datetime], whose
        # ToString() is "08/10/2026" — and re-parsing that under a dd/MM
        # culture turns 10 August into 8 October. Measured: a 75-minute-old
        # timestamp came back as -84885 minutes, so nothing ever completed its
        # soak, no commit was ever promoted, and the watchdog had no rollback
        # target. An integer has no culture and no timezone.
        healthySince        = 0       # when THIS sha first answered healthy
        lastKnownGood       = $null   # earned after SoakMinutes healthy
        consecutiveFailures = 0
        rolledBackFrom      = $null   # guard against rolling back twice
        updatedAt           = $null
    }
    if (-not (Test-Path -LiteralPath $StateFile)) { return $default }
    try {
        $raw = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        foreach ($k in @($default.Keys)) {
            if ($raw.PSObject.Properties.Name -contains $k) { $default[$k] = $raw.$k }
        }
        return $default
    }
    catch {
        # A truncated state file must not stop the watchdog from watching.
        Write-Log "state file unreadable ($($_.Exception.Message)) - starting fresh" 'WARN'
        return $default
    }
}

function Get-EpochSeconds {
    return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}

function Write-State {
    param($State)
    $State.updatedAt = (Get-Date).ToString('o')
    ($State | ConvertTo-Json -Depth 4) |
        Set-Content -LiteralPath $StateFile -Encoding utf8
}

function Set-Alert {
    param([string]$Text)
    @(
        "MailDesk watchdog needs attention"
        (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        ''
        $Text
        ''
        "Log:   $LogFile"
        "State: $StateFile"
        ''
        'Delete this file once the problem is resolved.'
    ) -join [Environment]::NewLine | Set-Content -LiteralPath $AlertFile -Encoding utf8
}

# --------------------------------------------------------------------------
# Probes
# --------------------------------------------------------------------------
function Get-ApiState {
    <#
        Returns 'healthy', 'degraded' (answers, but its database is gone),
        'restarting', or 'down' (no answer at all). A string, and every caller
        tests for an explicit value, so an unexpected result never silently
        takes the rollback path.
    #>
    try {
        $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 10
        if ($r.PSObject.Properties.Name -contains 'shuttingDown' -and $r.shuttingDown) {
            return 'restarting'
        }
        if ($r.database -eq 'connected') { return 'healthy' }
        return 'degraded'
    }
    catch {
        return 'down'
    }
}

function Test-MongoReachable {
    # Deliberately a bare TCP connect, not a driver call: the question is only
    # "is something listening", and this must work with no node process alive.
    try {
        $c = [System.Net.Sockets.TcpClient]::new()
        $ok = $c.ConnectAsync($MongoHost, $MongoPort).Wait(3000)
        $c.Close()
        return $ok
    }
    catch { return $false }
}

function Restore-Commit {
    param([string]$Sha, [string]$Label)

    Write-Log "[$Label] git reset --hard $($Sha.Substring(0,7))"
    Invoke-Native git @('reset', '--hard', $Sha) -WorkingDirectory $InstallDir | Out-Null
    Invoke-Native git @('clean', '-fd') -WorkingDirectory $InstallDir | Out-Null

    Write-Log "[$Label] npm ci --omit=dev"
    Invoke-Native npm @('ci', '--omit=dev') -WorkingDirectory $serverDir | Out-Null

    Write-Log "[$Label] syncing indexes"
    Invoke-Native node @('scripts/syncIndexes.js') -WorkingDirectory $serverDir | Out-Null

    Write-Log "[$Label] restarting $ServiceName"
    & nssm restart $ServiceName 2>&1 | Out-Null

    $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if ((Get-ApiState) -eq 'healthy') {
            Write-Log "[$Label] healthy again" 'OK'
            return $true
        }
    }
    return $false
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir '.git'))) {
    Write-Log "no git checkout at $InstallDir" 'FAIL'
    exit 1
}

# Never fight the deploy script. If it holds the lock it is mid-`npm ci`, and
# an unhealthy reading right then means nothing.
$deployLock = Join-Path $LogDir 'deploy.lock'
if (Test-Path -LiteralPath $deployLock) {
    try {
        $h = [System.IO.File]::Open($deployLock, 'Open', 'ReadWrite', 'None')
        $h.Close(); $h.Dispose()
    }
    catch {
        Write-Log 'a deploy is in progress - standing down' 'INFO'
        exit 0
    }
}

$state      = Read-State
$currentSha = Invoke-Native git @('rev-parse', 'HEAD') -WorkingDirectory $InstallDir
$short      = $currentSha.Substring(0, 7)

# A commit change means somebody (or the deploy task) moved the tree. Its
# health record starts over: the previous commit's good behaviour says nothing
# about this one.
if ($state.sha -ne $currentSha) {
    if ($state.sha) { Write-Log "commit changed $($state.sha.Substring(0,7)) -> $short" }
    $state.sha                 = $currentSha
    $state.healthySince        = 0
    $state.consecutiveFailures = 0
    $state.rolledBackFrom      = $null
}

$apiState = Get-ApiState

switch ($apiState) {

    'restarting' {
        Write-Log 'API reports shuttingDown - skipping this tick'
        Write-State $state
        exit 0
    }

    'healthy' {
        $state.consecutiveFailures = 0
        if (-not $state.healthySince) {
            $state.healthySince = Get-EpochSeconds
            Write-Log "$short healthy - soak clock started ($SoakMinutes min)"
        }

        $healthyFor = ((Get-EpochSeconds) - [int64]$state.healthySince) / 60.0
        if ($state.lastKnownGood -ne $currentSha -and $healthyFor -ge $SoakMinutes) {
            $was = if ($state.lastKnownGood) { $state.lastKnownGood.Substring(0,7) } else { 'none' }
            $state.lastKnownGood = $currentSha
            Write-Log "$short promoted to last-known-good after $([math]::Round($healthyFor)) min (was $was)" 'OK'
            if (Test-Path -LiteralPath $AlertFile) { Remove-Item -LiteralPath $AlertFile -Force }
        }
        else {
            Write-Log "$short healthy ($([math]::Round($healthyFor)) of $SoakMinutes min)"
        }
        Write-State $state
        exit 0
    }

    'degraded' {
        # The API is alive and answering; its database is not. Rolling back the
        # code cannot reconnect a database, so this is a page, not a rollback.
        $state.healthySince = 0
        Write-Log 'API is up but reports database: disconnected' 'FAIL'
        Write-Log 'this is a dependency failure - NOT rolling back' 'WARN'
        Set-Alert "The API is running but MongoDB is unreachable.`nCheck the MongoDB service. The application code is not at fault and has been left alone."
        Write-State $state
        exit 5
    }

    'down' {
        $state.healthySince = 0

        if (-not (Test-MongoReachable)) {
            Write-Log "API down AND Mongo unreachable at ${MongoHost}:${MongoPort}" 'FAIL'
            Write-Log 'looks like the machine or the database, not the deploy - NOT rolling back' 'WARN'
            Set-Alert "Neither the API nor MongoDB is answering.`nCheck that the machine is healthy and the MongoDB service is running.`nNo rollback was attempted: reverting code does not fix a stopped database."
            Write-State $state
            exit 5
        }

        $state.consecutiveFailures = [int]$state.consecutiveFailures + 1
        Write-Log "API not answering (consecutive failure $($state.consecutiveFailures)), Mongo is up" 'WARN'

        # Most outages are a wedged process, and a restart is far cheaper and
        # less destructive than a rollback. Earn the rollback.
        if ($state.consecutiveFailures -eq 1) {
            Write-Log "restarting $ServiceName before considering a rollback"
            if (-not $WhatIfRollback) { & nssm restart $ServiceName 2>&1 | Out-Null }
            Write-State $state
            exit 0
        }

        if (-not $state.lastKnownGood) {
            Write-Log 'no commit has completed its soak yet - nothing trusted to roll back to' 'FAIL'
            Set-Alert "The API is down and no commit has yet been healthy for $SoakMinutes minutes, so there is no trusted rollback target.`nInvestigate manually: logs\api.err.log"
            Write-State $state
            exit 4
        }

        if ($state.lastKnownGood -eq $currentSha) {
            Write-Log "already on last-known-good $short - a rollback would change nothing" 'FAIL'
            Set-Alert "The API is down while running the last commit known to be good ($short).`nThe cause is not a recent code change. Investigate manually: logs\api.err.log"
            Write-State $state
            exit 4
        }

        if ($state.rolledBackFrom -eq $currentSha) {
            Write-Log "already rolled back away from $short once - refusing to loop" 'FAIL'
            Set-Alert "The API is down and a rollback has already been attempted for this commit.`nRepeating it would flap the service. Investigate manually."
            Write-State $state
            exit 4
        }

        $target = $state.lastKnownGood
        Write-Log "rolling back $short -> $($target.Substring(0,7))" 'WARN'

        if ($WhatIfRollback) {
            Write-Log 'dry run (-WhatIfRollback): stopping here, nothing changed' 'INFO'
            exit 0
        }

        $state.rolledBackFrom = $currentSha
        Write-State $state          # persist BEFORE acting, so a crash mid-rollback cannot loop

        try {
            if (Restore-Commit -Sha $target -Label 'rollback') {
                $state.sha          = $target
                $state.healthySince = Get-EpochSeconds
                $state.consecutiveFailures = 0
                Write-State $state
                Write-Log "rolled back to $($target.Substring(0,7)) - API is healthy" 'OK'
                Set-Alert "The API stopped responding on commit $short and was automatically rolled back to $($target.Substring(0,7)), which is healthy now.`n`nThe app is UP, but it is running older code. Fix the problem on main before the next scheduled deploy, or the same commit lands again."
                exit 3
            }
            Write-Log 'rollback completed but the API is still not healthy' 'FAIL'
        }
        catch {
            Write-Log "rollback failed: $($_.Exception.Message)" 'FAIL'
        }

        Write-State $state
        Set-Alert "The API is DOWN and the automatic rollback did not bring it back.`nThis needs a human now. Start with logs\api.err.log and logs\watchdog.log."
        Write-Log 'THE API IS DOWN AND NEEDS A HUMAN.' 'FAIL'
        exit 4
    }

    default {
        Write-Log "unexpected API state '$apiState' - taking no action" 'WARN'
        Write-State $state
        exit 1
    }
}

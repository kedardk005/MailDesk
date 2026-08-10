<#
.SYNOPSIS
    Pulls the latest green commit from main and redeploys the MailDesk API on
    this Windows machine. Designed to run unattended from Task Scheduler.

.DESCRIPTION
    The client is NOT deployed by this script — Vercel builds and serves it
    straight from GitHub. This script owns the backend half only:

        fetch -> is there a new commit? -> is its CI green? -> deploy -> verify
                                                                     |
                                                            fails -> roll back

    Everything here is a no-op when main has not moved, so running it daily
    (or hourly) costs one `git fetch` and nothing else.

    THE ROLLBACK IS THE POINT. An unattended `git pull && restart` will happily
    deploy a commit that does not boot and leave the office with a dead API
    until somebody notices. This script records the SHA it is replacing, and if
    the new one fails to come back healthy it puts the old one back, reinstalls
    its dependencies and re-verifies before giving up. A failed deploy should
    cost you a log entry, not a working day.

.PARAMETER InstallDir
    Where install-windows.ps1 put the checkout. Must match.

.PARAMETER Branch
    Branch to track. Defaults to main.

.PARAMETER SkipCiCheck
    Deploy the newest commit without asking GitHub whether its CI passed.
    Use this only if the repo is private and you have not set GITHUB_TOKEN,
    and understand you are deploying untested code.

.PARAMETER Install
    Do not deploy. Register this script as a daily Scheduled Task and exit.

.PARAMETER At
    Time of day for -Install, 24h "HH:mm". Default 03:30 — outside office hours,
    so a bad deploy plus rollback happens while nobody is using the app.

.PARAMETER Force
    Redeploy even when the SHA has not changed. For testing the pipeline.

.EXAMPLE
    # one-time: register the daily task (elevated PowerShell)
    .\deploy-windows.ps1 -Install

.EXAMPLE
    # run a deploy right now and watch it
    .\deploy-windows.ps1

.NOTES
    Requires: git, node, npm, nssm on PATH, and MailDeskAPI already installed
    by scripts/install-windows.ps1.
#>

[CmdletBinding()]
param(
    [string]$InstallDir  = 'C:\apps\maildesk',
    [string]$Branch      = 'main',
    [string]$Remote      = 'origin',
    [string]$ServiceName = 'MailDeskAPI',
    # Node's own port, not Caddy's. Health-checking through the proxy would
    # pass while the API is dead if the proxy ever serves a cached or static
    # response, and would fail for proxy-only problems that are not this
    # deploy's fault. install-windows.ps1 writes PORT=5015.
    [string]$HealthUrl   = 'http://127.0.0.1:5015/api/health',
    [int]   $HealthTimeoutSeconds = 90,
    [switch]$SkipCiCheck,
    [switch]$Install,
    [string]$At = '03:30',
    [switch]$Force
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

# --------------------------------------------------------------------------
# Logging - every run appends here; Task Scheduler swallows stdout otherwise
# --------------------------------------------------------------------------
$LogDir  = Join-Path $InstallDir 'logs'
$LogFile = Join-Path $LogDir 'deploy.log'

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'OK', 'WARN', 'FAIL')]
        [string]$Level = 'INFO'
    )
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line  = "{0} [{1,-4}] {2}" -f $stamp, $Level, $Message

    if (Test-Path -LiteralPath $LogDir) {
        # Keep the log from growing without bound on a machine nobody logs into.
        if ((Test-Path -LiteralPath $LogFile) -and
            ((Get-Item -LiteralPath $LogFile).Length -gt 5MB)) {
            Move-Item -LiteralPath $LogFile -Destination "$LogFile.1" -Force
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
    }

    $colour = switch ($Level) {
        'OK'   { 'Green' }
        'WARN' { 'Yellow' }
        'FAIL' { 'Red' }
        default { 'Gray' }
    }
    Write-Host $line -ForegroundColor $colour
}

function Get-NpmExe {
    <#
        Returns the npm entry point to invoke.

        On Windows, `npm` on PATH resolves to npm.ps1 first, and PowerShell
        refuses to run it under the default Restricted/AllSigned execution
        policy:

            npm.ps1 cannot be loaded because running scripts is disabled

        That would fail every `npm ci` here — so a deploy could never install
        dependencies, and, worse, a ROLLBACK could not either. npm.cmd is a
        batch shim, not a script, so the policy does not apply to it. Preferring
        it means this works on a locked-down machine without asking anyone to
        weaken their execution policy, which is not ours to change.
    #>
    $cmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return 'npm'
}

function Invoke-Native {
    <#
        Runs an external command and throws on a non-zero exit code.
        PowerShell does NOT do this by itself: $ErrorActionPreference='Stop'
        has no effect on native exit codes, so `git reset` could fail silently
        and the script would sail on into restarting the service. Every git and
        npm call in this script goes through here.
    #>
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$WorkingDirectory
    )

    $prev = $null
    if ($WorkingDirectory) { $prev = Get-Location; Set-Location -LiteralPath $WorkingDirectory }

    # `2>&1` on a native command turns its stderr into ErrorRecords, and with
    # $ErrorActionPreference='Stop' in scope PowerShell raises those as
    # terminating NativeCommandError. git writes ordinary progress to stderr
    # ("Fetching origin"), so leaving Stop in place here makes a perfectly
    # successful `git fetch` throw. Drop to Continue for the call itself; the
    # exit code below is what actually decides success.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Exe @Arguments 2>&1
        $code   = $LASTEXITCODE
        if ($code -ne 0) {
            $joined = ($output | Out-String).Trim()
            throw "$Exe $($Arguments -join ' ') exited $code`n$joined"
        }
        return ($output | Out-String).Trim()
    }
    finally {
        $ErrorActionPreference = $prevEap
        if ($prev) { Set-Location -LiteralPath $prev }
    }
}

# --------------------------------------------------------------------------
# -Install: register the Scheduled Task and leave
# --------------------------------------------------------------------------
if ($Install) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin  = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
                    [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host 'Run this in an elevated PowerShell (Run as Administrator).' -ForegroundColor Red
        exit 1
    }

    $self = $MyInvocation.MyCommand.Path
    $taskName = 'MailDesk Auto Deploy'

    $argLine = @(
        '-NoProfile'
        '-ExecutionPolicy Bypass'
        "-File `"$self`""
        "-InstallDir `"$InstallDir`""
        "-Branch $Branch"
        "-HealthUrl `"$HealthUrl`""
    )
    if ($SkipCiCheck) { $argLine += '-SkipCiCheck' }

    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($argLine -join ' ')
    $trigger = New-ScheduledTaskTrigger -Daily -At $At
    # SYSTEM so it runs with nobody logged in - this is a server.
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' `
                     -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet `
                     -StartWhenAvailable `
                     -DontStopOnIdleEnd `
                     -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
                     -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null

    Write-Host ''
    Write-Host "Registered scheduled task '$taskName', daily at $At." -ForegroundColor Green
    Write-Host "  Log:      $LogFile"
    Write-Host "  Run now:  Start-ScheduledTask -TaskName '$taskName'"
    Write-Host "  Remove:   Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
    exit 0
}

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

Write-Log '--------------------------------------------------------------'
Write-Log "deploy start (branch=$Branch, dir=$InstallDir)"

if (-not (Test-Path -LiteralPath (Join-Path $InstallDir '.git'))) {
    Write-Log "no git checkout at $InstallDir - run install-windows.ps1 first" 'FAIL'
    exit 1
}

foreach ($tool in 'git', 'npm', 'node', 'nssm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Log "$tool is not on PATH" 'FAIL'
        exit 1
    }
}

# A second deploy starting while the first is mid-`npm ci` would be a bad day.
# MultipleInstances IgnoreNew covers the scheduled path; this covers a human
# running the script by hand at the same moment.
$lockFile = Join-Path $LogDir 'deploy.lock'
$lock = $null
try {
    $lock = [System.IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None')
}
catch {
    Write-Log 'another deploy is already running - exiting' 'WARN'
    exit 0
}

# --------------------------------------------------------------------------
# The deploy itself
# --------------------------------------------------------------------------
$serverDir  = Join-Path $InstallDir 'server'
$previousSha = $null
$deployed    = $false
# Set the moment `git reset` moves the working tree. Rolling back is only
# meaningful after that point — a failure during fetch or the CI check has
# changed nothing, and "rolling back" there would mean an npm ci and a service
# restart for no reason, turning a harmless no-op into an outage window.
$checkoutChanged = $false

function Get-HeadSha {
    param([string]$Ref = 'HEAD')
    return (Invoke-Native git @('rev-parse', $Ref) -WorkingDirectory $InstallDir)
}

function Get-CiState {
    <#
        Asks GitHub whether this exact commit's checks passed. Returns the
        string 'green', 'red', or 'unknown' (no token on a private repo, GitHub
        down, checks still running, no checks configured). 'unknown' is treated
        as do-not-deploy, because "I could not verify" and "it is fine" are not
        the same claim.

        This returns a string rather than a bool deliberately, and the caller
        tests `-ne 'green'`. An earlier version returned $true/$false/$null,
        which fails OPEN: any stray pipeline output inside this function makes
        the return value an array, and then both `$x -eq $false` and
        `$null -eq $x` are falsy, so a red commit sails through the gate. With
        a string and an -ne test, anything unexpected refuses to deploy.
    #>
    param([string]$Sha)

    $originUrl = Invoke-Native git @('remote', 'get-url', $Remote) -WorkingDirectory $InstallDir
    if ($originUrl -notmatch 'github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)') {
        Write-Log "remote '$originUrl' is not a GitHub URL - cannot check CI" 'WARN'
        return 'unknown'
    }
    $owner = $Matches['owner']
    $repo  = $Matches['repo']

    $headers = @{
        'Accept'               = 'application/vnd.github+json'
        'User-Agent'           = 'maildesk-deploy'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }

    $uri = "https://api.github.com/repos/$owner/$repo/commits/$Sha/check-runs?per_page=100"
    try {
        $resp = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 30
    }
    catch {
        Write-Log "GitHub check-runs query failed: $($_.Exception.Message)" 'WARN'
        return 'unknown'
    }

    if (-not $resp.check_runs -or $resp.check_runs.Count -eq 0) {
        Write-Log "no check-runs reported for $($Sha.Substring(0,7))" 'WARN'
        return 'unknown'
    }

    $incomplete = @($resp.check_runs | Where-Object { $_.status -ne 'completed' })
    if ($incomplete.Count -gt 0) {
        Write-Log "CI still running ($($incomplete.Count) of $($resp.check_runs.Count) incomplete)" 'WARN'
        return 'unknown'
    }

    # 'neutral' and 'skipped' are not failures; anything else is.
    $bad = @($resp.check_runs | Where-Object {
        $_.conclusion -notin @('success', 'neutral', 'skipped')
    })
    if ($bad.Count -gt 0) {
        foreach ($b in $bad) { Write-Log "  check '$($b.name)' -> $($b.conclusion)" 'WARN' }
        return 'red'
    }

    Write-Log "CI green ($($resp.check_runs.Count) checks)" 'OK'
    return 'green'
}

function Install-And-Restart {
    <#
        Dependencies + index sync + service restart + health gate.
        Throws if the API does not come back healthy. Used for both the forward
        deploy and the rollback, so the rollback is verified the same way.
    #>
    param([string]$Label)

    Write-Log "[$Label] npm ci --omit=dev"
    Invoke-Native (Get-NpmExe) @('ci', '--omit=dev') -WorkingDirectory $serverDir | Out-Null

    # Idempotent, and index definitions change between releases. The backfill
    # scripts in server/scripts are deliberately NOT run here: they are one-time
    # data migrations and must be run by a human who has taken a backup.
    Write-Log "[$Label] syncing indexes"
    Invoke-Native node @('scripts/syncIndexes.js') -WorkingDirectory $serverDir | Out-Null

    Write-Log "[$Label] restarting $ServiceName"
    & nssm restart $ServiceName 2>&1 | Out-Null

    Write-Log "[$Label] waiting for health at $HealthUrl"
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
    $lastError = 'never responded'
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        try {
            $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
            # 'Server is running' with a disconnected DB is not healthy, and the
            # endpoint already 503s in that case - but check explicitly so a
            # future change to the endpoint cannot quietly weaken this gate.
            if ($r.database -eq 'connected' -and -not $r.shuttingDown) {
                Write-Log "[$Label] healthy (uptime $([math]::Round($r.uptime,1))s)" 'OK'
                return
            }
            $lastError = "database=$($r.database) shuttingDown=$($r.shuttingDown)"
        }
        catch {
            $lastError = $_.Exception.Message
        }
    }
    throw "[$Label] API did not become healthy within ${HealthTimeoutSeconds}s: $lastError"
}

try {
    # -- 1. what is on the remote? -----------------------------------------
    Invoke-Native git @('fetch', $Remote, $Branch, '--prune') -WorkingDirectory $InstallDir | Out-Null

    $previousSha = Get-HeadSha
    $targetSha   = Get-HeadSha "$Remote/$Branch"

    Write-Log "local  $($previousSha.Substring(0,7))"
    Write-Log "remote $($targetSha.Substring(0,7))"

    if ($previousSha -eq $targetSha -and -not $Force) {
        Write-Log 'already up to date - nothing to do' 'OK'
        exit 0
    }

    # -- 2. is it safe to deploy? ------------------------------------------
    if ($SkipCiCheck) {
        Write-Log 'CI check skipped by flag - deploying unverified code' 'WARN'
    }
    else {
        # -ne 'green' so that anything other than an explicit pass refuses.
        $ciState = Get-CiState -Sha $targetSha
        if ($ciState -ne 'green') {
            if ($ciState -eq 'red') {
                Write-Log "CI is RED for $($targetSha.Substring(0,7)) - refusing to deploy" 'FAIL'
            }
            else {
                Write-Log "could not confirm CI status (got '$ciState') - refusing to deploy" 'FAIL'
                Write-Log 'set GITHUB_TOKEN, or pass -SkipCiCheck to accept the risk' 'INFO'
            }
            exit 2
        }
    }

    # -- 3. take the new code ----------------------------------------------
    $dirty = Invoke-Native git @('status', '--porcelain') -WorkingDirectory $InstallDir
    if ($dirty) {
        # reset --hard is about to discard these. Say so loudly rather than
        # letting someone's hand-edit vanish without a trace.
        Write-Log 'working tree has local modifications - they will be DISCARDED:' 'WARN'
        foreach ($line in ($dirty -split "`n")) { Write-Log "  $line" 'WARN' }
    }

    Write-Log "checking out $($targetSha.Substring(0,7))"
    $checkoutChanged = $true
    Invoke-Native git @('reset', '--hard', $targetSha) -WorkingDirectory $InstallDir | Out-Null
    # .env and logs are gitignored, so they survive reset --hard; -x would
    # delete them, which is exactly why this is -fd and not -fdx.
    Invoke-Native git @('clean', '-fd') -WorkingDirectory $InstallDir | Out-Null

    Install-And-Restart -Label 'deploy'
    $deployed = $true

    Write-Log "deployed $($previousSha.Substring(0,7)) -> $($targetSha.Substring(0,7))" 'OK'
}
catch {
    Write-Log "deploy failed: $($_.Exception.Message)" 'FAIL'

    if ($checkoutChanged -and $previousSha -and -not $deployed) {
        Write-Log "rolling back to $($previousSha.Substring(0,7))" 'WARN'
        try {
            Invoke-Native git @('reset', '--hard', $previousSha) -WorkingDirectory $InstallDir | Out-Null
            Install-And-Restart -Label 'rollback'
            Write-Log "rolled back to $($previousSha.Substring(0,7)) - API is healthy on the old code" 'OK'
            Write-Log 'the API is UP but running yesterday code. Fix main, then rerun.' 'WARN'
            exit 3
        }
        catch {
            Write-Log "ROLLBACK ALSO FAILED: $($_.Exception.Message)" 'FAIL'
            Write-Log 'THE API IS DOWN AND NEEDS A HUMAN.' 'FAIL'
            exit 4
        }
    }

    exit 1
}
finally {
    if ($lock) { $lock.Close(); $lock.Dispose() }
    Write-Log 'deploy end'
}

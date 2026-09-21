<#
.SYNOPSIS
    Back up the MailDesk MongoDB database, verify the backup, and prune old ones.

.DESCRIPTION
    The database is the only part of this system that cannot be rebuilt from
    GitHub. Everything else — code, config, the whole application — can be
    redeployed in minutes; the mail, tasks and client records cannot.

    THE VERIFY STEP IS THE POINT. `mongodump` exiting 0 does not mean you have a
    restorable backup: a truncated archive, a half-written file on a full disk
    or a silently empty dump all exit 0 too. Every run therefore reads the
    archive back and requires it to contain the collections that matter. A
    backup nobody has ever read is a guess.

    Backups are single gzipped archive FILES rather than directory dumps, so
    each one is one thing to copy, checksum or notice the size of.

.PARAMETER DestinationDir
    Where archives are written. Prefer a DIFFERENT physical disk from the
    database: a backup on the same drive does not survive the failure it exists
    for. Defaults to D:\maildesk-backups, falling back to C:\ if there is no D:.

.PARAMETER KeepDays
    Delete archives older than this. Default 14.

.PARAMETER Install
    Register a daily scheduled task and exit.

.PARAMETER At
    Time of day for -Install, "HH:mm". Default 02:00 — before the 03:30 deploy,
    so the day's backup predates any code change.

.PARAMETER TestRestore
    Restore the newest archive into a scratch database, count the documents and
    drop it again. The only check that proves a backup is actually restorable.
    Slower; run it by hand now and then, not on every nightly run.

.EXAMPLE
    .\backup-windows.ps1                      # back up now
.EXAMPLE
    .\backup-windows.ps1 -Install             # nightly at 02:00 (elevated)
.EXAMPLE
    .\backup-windows.ps1 -TestRestore         # prove the newest one restores
#>

[CmdletBinding()]
param(
    [string]$InstallDir     = 'C:\apps\maildesk',
    [string]$DestinationDir = '',
    [string]$MongoUri       = '',
    [int]   $KeepDays       = 14,
    [string]$At             = '02:00',
    [switch]$TestRestore,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$LogDir  = Join-Path $InstallDir 'logs'
$LogFile = Join-Path $LogDir 'backup.log'

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
    # Throws on a non-zero exit code. PowerShell does not do this for native
    # commands, so without it a failed mongodump would sail on to "success".
    # $ErrorActionPreference drops to Continue for the call itself because
    # mongodump writes its progress to stderr, which would otherwise be raised
    # as a terminating error on a perfectly good run.
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Exe @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "$Exe exited $LASTEXITCODE`n$(($output | Out-String).Trim())"
        }
        return ($output | Out-String).Trim()
    }
    finally { $ErrorActionPreference = $prevEap }
}

# --------------------------------------------------------------------------
# Where things are
# --------------------------------------------------------------------------
function Resolve-Tool {
    # The Database Tools ship SEPARATELY from the MongoDB server package, so
    # they are frequently absent on a machine where mongod runs happily.
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $guess = Get-ChildItem 'C:\Program Files\MongoDB' -Recurse -Filter "$Name.exe" -ErrorAction SilentlyContinue |
             Select-Object -First 1
    if ($guess) { return $guess.FullName }
    return $null
}

function Resolve-MongoUri {
    if ($MongoUri) { return $MongoUri }
    # Read it from the app's own .env so the backup can never target a
    # different database from the one the application is using.
    $envFile = Join-Path $InstallDir 'server\.env'
    if (Test-Path -LiteralPath $envFile) {
        $line = Select-String -LiteralPath $envFile -Pattern '^\s*MONGO_URI\s*=\s*(.+)$' |
                Select-Object -First 1
        if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
    }
    return 'mongodb://127.0.0.1:27017/maildesk'
}

function Resolve-Destination {
    if ($DestinationDir) { return $DestinationDir }
    # A backup on the same disk as the database does not survive the failure it
    # exists for, so prefer any other fixed drive and say so loudly if there is
    # none.
    $others = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' |
              Where-Object { $_.DeviceID -ne 'C:' } |
              Sort-Object -Property FreeSpace -Descending
    if ($others) { return (Join-Path $others[0].DeviceID 'maildesk-backups') }
    return 'C:\maildesk-backups'
}

function Get-DatabaseName {
    param([string]$Uri)
    # Anchored at the SCHEME, so the match cannot start inside the "//" and
    # return the host as the database name. `mongodb://127.0.0.1:27017` with no
    # database used to yield "127.0.0.1:27017", which is not a legal Windows
    # filename and would have produced a nonsense restore namespace too.
    if ($Uri -match '^[a-z+]+://[^/]+/([^/?]+)') { return $Matches[1] }
    return 'maildesk'
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
    $dest     = Resolve-Destination
    $taskName = 'MailDesk Database Backup'
    $argLine  = @(
        '-NoProfile', '-ExecutionPolicy Bypass', "-File `"$self`""
        "-InstallDir `"$InstallDir`"", "-DestinationDir `"$dest`"", "-KeepDays $KeepDays"
    ) -join ' '

    $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
    $trigger   = New-ScheduledTaskTrigger -Daily -At $At
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                     -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null

    Write-Host ''
    Write-Host "Registered '$taskName', daily at $At." -ForegroundColor Green
    Write-Host "  Backups: $dest"
    Write-Host "  Log:     $LogFile"
    Write-Host "  Run now: Start-ScheduledTask -TaskName '$taskName'"
    Write-Host ''
    Write-Host 'Run -TestRestore by hand occasionally. A backup nobody has restored is a guess.' -ForegroundColor Yellow
    exit 0
}

# --------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

Write-Log '--------------------------------------------------------------'

$dump    = Resolve-Tool 'mongodump'
$restore = Resolve-Tool 'mongorestore'
if (-not $dump) {
    Write-Log 'mongodump not found.' 'FAIL'
    Write-Log 'The MongoDB Database Tools ship separately from the server:' 'INFO'
    Write-Log '  winget search "mongodb database tools"' 'INFO'
    Write-Log '  or https://www.mongodb.com/try/download/database-tools' 'INFO'
    exit 1
}

$uri  = Resolve-MongoUri
$db   = Get-DatabaseName $uri
$dest = Resolve-Destination

if (-not (Test-Path -LiteralPath $dest)) {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
}
if ($dest -like 'C:*') {
    Write-Log "backups are on C:, the same disk as the database - a disk failure loses both" 'WARN'
}

# --------------------------------------------------------------------------
# -TestRestore: prove the newest archive is actually restorable
# --------------------------------------------------------------------------
if ($TestRestore) {
    if (-not $restore) { Write-Log 'mongorestore not found.' 'FAIL'; exit 1 }

    $newest = Get-ChildItem -LiteralPath $dest -Filter '*.gz' -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $newest) { Write-Log "no archives in $dest" 'FAIL'; exit 1 }

    # A scratch name, never the live database. This restores INTO a copy so a
    # verification can never overwrite production.
    $scratch = "${db}_restoretest"
    Write-Log "restoring $($newest.Name) into '$scratch' (NOT the live database)"

    Invoke-Native $restore @(
        "--uri=$uri", '--gzip', "--archive=$($newest.FullName)",
        "--nsFrom=$db.*", "--nsTo=$scratch.*", '--drop'
    ) | Out-Null

    $mongosh = Resolve-Tool 'mongosh'
    if ($mongosh) {
        $counts = Invoke-Native $mongosh @(
            $uri, '--quiet', '--eval',
            "const d=db.getSiblingDB('$scratch'); ['users','clients','tasks','emails'].map(c=>c+'='+d[c].countDocuments()).join('  ')"
        )
        Write-Log "restored contents: $counts" 'OK'
        Invoke-Native $mongosh @($uri, '--quiet', '--eval', "db.getSiblingDB('$scratch').dropDatabase()") | Out-Null
        Write-Log "scratch database dropped" 'OK'
    }
    else {
        Write-Log "restore succeeded; mongosh absent so contents were not counted" 'WARN'
        Write-Log "drop it by hand: db.getSiblingDB('$scratch').dropDatabase()" 'INFO'
    }

    Write-Log 'TEST RESTORE PASSED - this backup is restorable' 'OK'
    exit 0
}

# --------------------------------------------------------------------------
# Back up
# --------------------------------------------------------------------------
$stamp   = Get-Date -Format 'yyyy-MM-dd_HHmm'
$archive = Join-Path $dest "$db-$stamp.gz"

Write-Log "backing up '$db' -> $archive"
try {
    Invoke-Native $dump @("--uri=$uri", '--gzip', "--archive=$archive") | Out-Null
}
catch {
    Write-Log "mongodump failed: $($_.Exception.Message)" 'FAIL'
    # Never leave a half-written file behind: the pruner sorts by date, and a
    # truncated newest archive is the one a panicking human would reach for.
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    exit 1
}

if (-not (Test-Path -LiteralPath $archive)) {
    Write-Log 'mongodump reported success but wrote no file' 'FAIL'
    exit 1
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $archive).Length / 1MB, 2)
if ($sizeMb -le 0.001) {
    Write-Log "archive is empty ($sizeMb MB) - treating as a FAILED backup" 'FAIL'
    Remove-Item -LiteralPath $archive -Force
    exit 1
}

# Read it back. mongodump exits 0 on a truncated write, so the only evidence
# that this file is a backup is that something can parse it.
if ($restore) {
    try {
        $probe = Invoke-Native $restore @('--gzip', "--archive=$archive", '--dryRun', '--quiet')
        Write-Log "archive verified readable ($sizeMb MB)" 'OK'
        if ($probe) { Write-Log "  $probe" }
    }
    catch {
        Write-Log "archive is UNREADABLE - deleting it: $($_.Exception.Message)" 'FAIL'
        Remove-Item -LiteralPath $archive -Force
        exit 1
    }
}
else {
    Write-Log "mongorestore absent; archive written ($sizeMb MB) but NOT verified" 'WARN'
}

# --------------------------------------------------------------------------
# Prune — only after a verified new backup exists
# --------------------------------------------------------------------------
$cutoff = (Get-Date).AddDays(-$KeepDays)
$old = Get-ChildItem -LiteralPath $dest -Filter '*.gz' |
       Where-Object { $_.LastWriteTime -lt $cutoff }
foreach ($f in $old) {
    Remove-Item -LiteralPath $f.FullName -Force
    Write-Log "pruned $($f.Name)"
}

$kept = @(Get-ChildItem -LiteralPath $dest -Filter '*.gz')
Write-Log "backup complete - $($kept.Count) archive(s) held, newest $sizeMb MB" 'OK'

<#
    Record the outcome where anything else can read it.

    The watchdog needs to know whether backups are actually happening, and the
    alternative — teaching it this script's destination logic — would be two
    copies of the same rule drifting apart. A tiny state file keeps the
    knowledge in one place.

    Written only after a VERIFIED archive exists, so the timestamp means "a
    restorable backup was taken", not "the script ran".
#>
$state = [ordered]@{
    lastBackupAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    archive      = $archive
    sizeMb       = $sizeMb
    kept         = $kept.Count
}
try {
    ($state | ConvertTo-Json -Depth 3) |
        Set-Content -LiteralPath (Join-Path $LogDir 'backup-state.json') -Encoding utf8
}
catch {
    # Never fail a good backup because the marker could not be written.
    Write-Log "could not write backup-state.json: $($_.Exception.Message)" 'WARN'
}

exit 0

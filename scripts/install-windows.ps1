#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot installer for K M KOTHARI (MailDesk) on a self-hosted Windows Server.

.DESCRIPTION
    Installs and configures everything natively — no Docker. Chocolatey, Git,
    Node 22, MongoDB 7, Caddy and NSSM, then clones the repo, generates secrets,
    builds the client, runs the database migrations and registers two Windows
    Services (API + reverse proxy).

    The script is IDEMPOTENT: re-running it upgrades the checkout, reinstalls
    dependencies and restarts services without destroying an existing .env or
    any data. Anything already correct is skipped.

    Run -DryRun first. It prints every action and changes nothing.

.PARAMETER Domain
    Public hostname, e.g. mail.yourcompany.com. Used for TLS, CORS and the
    Google OAuth redirect URI. Use "localhost" for a LAN-only trial (no HTTPS).

.PARAMETER InstallDir
    Where to install. Default C:\apps\maildesk.

.PARAMETER RepoUrl
    Git remote to clone.

.PARAMETER Branch
    Branch to deploy. Default main.

.PARAMETER WithRedis
    Also install Memurai (Windows-native, Redis-compatible) and point the app at
    it. Optional — without it the app runs correctly as a single instance using
    in-process fallbacks. See docs/DEPLOY-WINDOWS.md section 5.

.PARAMETER SkipPrereqs
    Don't install packages; assume Node/MongoDB/Caddy/NSSM are already present.

.PARAMETER DryRun
    Print what would happen and exit without changing anything.

.EXAMPLE
    .\install-windows.ps1 -Domain mail.yourcompany.com -DryRun

.EXAMPLE
    .\install-windows.ps1 -Domain mail.yourcompany.com

.NOTES
    Must be run from an elevated PowerShell ("Run as Administrator").
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Domain,

    [string]$InstallDir = 'C:\apps\maildesk',
    [string]$RepoUrl    = 'https://github.com/kedardk005/MailDesk.git',
    [string]$Branch     = 'main',

    [switch]$WithRedis,
    [switch]$SkipPrereqs,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------
$script:StepNo = 0

function Write-Step {
    param([string]$Message)
    $script:StepNo++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:StepNo, $Message) -ForegroundColor Cyan
}

function Write-Ok   { param([string]$m) Write-Host "    OK   $m" -ForegroundColor Green }
function Write-Skip { param([string]$m) Write-Host "    --   $m (already done)" -ForegroundColor DarkGray }
function Write-Warn { param([string]$m) Write-Host "    !    $m" -ForegroundColor Yellow }
function Write-Info { param([string]$m) Write-Host "         $m" -ForegroundColor Gray }

function Write-Fail {
    param([string]$m)
    Write-Host ''
    Write-Host "  FAILED: $m" -ForegroundColor Red
    exit 1
}

function Invoke-Step {
    <# Runs a scriptblock unless -DryRun, in which case it just describes it. #>
    param(
        [string]$Description,
        [scriptblock]$Action
    )
    if ($DryRun) {
        Write-Host "    DRY  $Description" -ForegroundColor Magenta
        return
    }
    & $Action
}

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
    <# Chocolatey edits the machine PATH; this pulls it into the running shell
       so freshly installed tools are usable without restarting PowerShell. #>
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function New-Secret {
    <# 32 random bytes as 64 hex chars. TOKEN_ENCRYPTION_KEY requires exactly
       this shape; the others simply need to be long and random. #>
    $bytes = New-Object 'System.Byte[]' 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

# --------------------------------------------------------------------------
# Banner and preflight
# --------------------------------------------------------------------------
Write-Host ''
Write-Host '===========================================================' -ForegroundColor White
Write-Host '  K M KOTHARI (MailDesk) - Windows Server installer' -ForegroundColor White
Write-Host '===========================================================' -ForegroundColor White
Write-Host "  Domain      : $Domain"
Write-Host "  Install dir : $InstallDir"
Write-Host "  Branch      : $Branch"
Write-Host "  Redis       : $(if ($WithRedis) { 'Memurai' } else { 'none (in-process fallbacks)' })"
if ($DryRun) { Write-Host '  MODE        : DRY RUN - nothing will be changed' -ForegroundColor Magenta }
Write-Host ''

Write-Step 'Preflight checks'

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Fail 'This script must be run from an elevated PowerShell. Right-click PowerShell and choose "Run as Administrator".'
}
Write-Ok 'Running as Administrator'

# Older Windows defaults to TLS 1.0, which chocolatey.org and nodejs.org refuse.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Ok 'TLS 1.2 enabled for this session'

$isLocalOnly = ($Domain -eq 'localhost' -or $Domain -match '^\d{1,3}(\.\d{1,3}){3}$')
if ($isLocalOnly) {
    Write-Warn "Domain '$Domain' is not a public hostname - Caddy cannot issue a TLS certificate."
    Write-Info 'The site will be served over plain HTTP. Fine for a LAN trial; do NOT use for production.'
    Write-Info 'Session tokens are sent as Bearer headers and are readable in transit over HTTP.'
}

# --------------------------------------------------------------------------
# Package installation
# --------------------------------------------------------------------------
if (-not $SkipPrereqs) {

    Write-Step 'Chocolatey package manager'
    if (Test-CommandExists 'choco') {
        Write-Skip 'Chocolatey present'
    } else {
        Invoke-Step 'install Chocolatey' {
            Set-ExecutionPolicy Bypass -Scope Process -Force
            Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
            Update-SessionPath
        }
        Write-Ok 'Chocolatey installed'
    }

    Write-Step 'Core packages (Git, Node 22, MongoDB 7, Caddy, NSSM)'
    $packages = @(
        @{ Name = 'git';        Probe = 'git' },
        @{ Name = 'nodejs-lts'; Probe = 'node' },
        @{ Name = 'mongodb';    Probe = 'mongod' },
        @{ Name = 'caddy';      Probe = 'caddy' },
        @{ Name = 'nssm';       Probe = 'nssm' }
    )
    if ($WithRedis) { $packages += @{ Name = 'memurai-developer'; Probe = 'memurai-cli' } }

    foreach ($pkg in $packages) {
        if (Test-CommandExists $pkg.Probe) {
            Write-Skip "$($pkg.Name)"
        } else {
            Invoke-Step "choco install $($pkg.Name)" {
                choco install $pkg.Name -y --no-progress | Out-Null
                if ($LASTEXITCODE -ne 0) { Write-Fail "choco install $($pkg.Name) failed (exit $LASTEXITCODE)" }
                Update-SessionPath
            }
            Write-Ok "$($pkg.Name) installed"
        }
    }
} else {
    Write-Step 'Package installation skipped (-SkipPrereqs)'
}

Update-SessionPath

# --------------------------------------------------------------------------
# Version gates - these are the two that actually break the app
# --------------------------------------------------------------------------
Write-Step 'Verifying versions'

if (-not $DryRun) {
    if (-not (Test-CommandExists 'node')) { Write-Fail 'node not found on PATH. Open a new PowerShell and re-run.' }
    $nodeMajor = ((node -v) -replace '^v', '').Split('.')[0] -as [int]
    if ($nodeMajor -lt 20) { Write-Fail "Node 20+ required, found $(node -v)." }
    if ($nodeMajor -lt 22) { Write-Warn "Node $(node -v) works, but 22 LTS is what CI builds against." }
    Write-Ok "Node $(node -v)"

    # MongoDB 7.0 is MANDATORY: the SLA reports use the $median and $percentile
    # aggregation operators added in 7.0. On 6.x the app boots and runs
    # normally, then SLA reports fail at query time - easy to miss until
    # somebody opens that tab. Fail here instead.
    if (Test-CommandExists 'mongod') {
        $mongoVersionLine = (mongod --version | Select-Object -First 1)
        if ($mongoVersionLine -match 'v(\d+)\.(\d+)') {
            $mongoMajor = [int]$Matches[1]
            if ($mongoMajor -lt 7) {
                Write-Fail "MongoDB 7.0+ is required (found $mongoVersionLine). SLA reports use `$median/`$percentile, which 6.x does not support."
            }
            Write-Ok "MongoDB $mongoVersionLine"
        } else {
            Write-Warn "Could not parse MongoDB version from: $mongoVersionLine - verify it is 7.0+ manually."
        }
    } else {
        Write-Warn 'mongod not on PATH; skipping the version gate. Verify MongoDB is 7.0+ before going live.'
    }
}

Write-Step 'MongoDB service'
Invoke-Step 'ensure the MongoDB service is running and set to auto-start' {
    $svc = Get-Service -Name 'MongoDB' -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        Write-Warn 'No "MongoDB" service found. The Chocolatey package normally registers one.'
        Write-Info 'Check the install, or start mongod manually, then re-run with -SkipPrereqs.'
    } else {
        Set-Service -Name 'MongoDB' -StartupType Automatic
        if ($svc.Status -ne 'Running') { Start-Service -Name 'MongoDB' }
        Write-Ok 'MongoDB service running (auto-start)'
    }
}

# --------------------------------------------------------------------------
# Source checkout
# --------------------------------------------------------------------------
Write-Step "Source code -> $InstallDir"
Invoke-Step "clone or update $RepoUrl ($Branch)" {
    if (Test-Path (Join-Path $InstallDir '.git')) {
        Push-Location $InstallDir
        git fetch origin --quiet
        git checkout $Branch --quiet
        git pull --ff-only origin $Branch --quiet
        Pop-Location
        Write-Ok "Updated existing checkout to latest $Branch"
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir -Parent) | Out-Null
        git clone --branch $Branch $RepoUrl $InstallDir
        if ($LASTEXITCODE -ne 0) { Write-Fail 'git clone failed' }
        Write-Ok "Cloned $Branch"
    }
}

$ServerDir = Join-Path $InstallDir 'server'
$ClientDir = Join-Path $InstallDir 'client'
$LogDir    = Join-Path $InstallDir 'logs'

Invoke-Step 'create log directory' {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

# --------------------------------------------------------------------------
# Server environment - never overwrite an existing .env
# --------------------------------------------------------------------------
Write-Step 'Server configuration (.env)'
$EnvPath = Join-Path $ServerDir '.env'
$scheme  = if ($isLocalOnly) { 'http' } else { 'https' }
$origin  = if ($isLocalOnly) { "http://${Domain}:8080" } else { "https://$Domain" }

if (Test-Path $EnvPath) {
    Write-Skip '.env exists - left untouched (secrets and Google credentials preserved)'
    Write-Info "If the domain changed, update FRONTEND_URL and GOOGLE_REDIRECT_URI in $EnvPath"
} else {
    Invoke-Step 'generate .env with fresh secrets' {
        $jwt   = New-Secret
        $tok   = New-Secret
        $oauth = New-Secret

        $redisLine = if ($WithRedis) { 'REDIS_URL=redis://127.0.0.1:6379' } else { '# REDIS_URL=redis://127.0.0.1:6379   # optional; see docs/DEPLOY-WINDOWS.md section 5' }

        $content = @"
# Generated by scripts/install-windows.ps1 - treat as a secret, never commit.
NODE_ENV=production
PORT=5015
MONGO_URI=mongodb://127.0.0.1:27017/maildesk
APP_TIMEZONE=Asia/Kolkata

# Public origin. CORS is checked against this EXACTLY.
FRONTEND_URL=$origin

JWT_SECRET=$jwt
TOKEN_ENCRYPTION_KEY=$tok
OAUTH_STATE_SECRET=$oauth

$redisLine

# ---------------------------------------------------------------------------
# FILL THESE IN before connecting Gmail. The redirect URI below must be
# registered verbatim in the Google Cloud Console, or the connect flow fails.
# ---------------------------------------------------------------------------
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=$origin/api/gmail/oauth/callback

SENDER_EMAIL=
SENDER_APP_PASSWORD=
GEMINI_API_KEY=
"@
        # ASCII avoids a UTF-8 BOM, which dotenv reads as part of the first key.
        Set-Content -Path $EnvPath -Value $content -Encoding ASCII
        Write-Ok "Wrote $EnvPath with freshly generated secrets"
        Write-Warn 'GOOGLE_CLIENT_ID / SECRET, SENDER_* and GEMINI_API_KEY are blank - fill them in before Gmail or AI will work.'
    }
}

# --------------------------------------------------------------------------
# Dependencies and client build
# --------------------------------------------------------------------------
Write-Step 'Server dependencies'
Invoke-Step 'npm ci --omit=dev (server)' {
    Push-Location $ServerDir
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail 'npm ci failed in server/' }
    Pop-Location
    Write-Ok 'Server dependencies installed'
}

Write-Step 'Client build'
# VITE_* are inlined at BUILD time, not read at runtime. If the public URL ever
# changes, the client must be rebuilt - editing a .env on the server does nothing.
Invoke-Step 'write client/.env.production and build' {
    $clientEnv = @"
VITE_API_URL=$origin/api
VITE_SOCKET_URL=$origin
"@
    Set-Content -Path (Join-Path $ClientDir '.env.production') -Value $clientEnv -Encoding ASCII

    Push-Location $ClientDir
    npm ci
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail 'npm ci failed in client/' }
    npm run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail 'client build failed' }
    Pop-Location
    Write-Ok "Client built to $ClientDir\dist"
}

# --------------------------------------------------------------------------
# Migrations - the new indexes and fields are inert until these run
# --------------------------------------------------------------------------
Write-Step 'Database migrations'
Invoke-Step 'sync indexes and backfill' {
    Push-Location $ServerDir
    Write-Info 'sync-indexes...'
    npm run sync-indexes -- --apply
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Fail 'sync-indexes failed - is MongoDB running?' }

    Write-Info 'backfill email snippets...'
    npm run backfill-emails

    Write-Info 'backfill threads...'
    node scripts/backfillEmailThreads.js --apply

    Write-Info 'backfill task completedAt...'
    node scripts/backfillTaskCompletedAt.js --apply

    Pop-Location
    Write-Ok 'Migrations complete'
}

# --------------------------------------------------------------------------
# Reverse proxy
# --------------------------------------------------------------------------
Write-Step 'Caddy reverse proxy'
$CaddyFile = Join-Path $InstallDir 'Caddyfile'
Invoke-Step 'write Caddyfile' {
    $site = if ($isLocalOnly) { ":8080" } else { $Domain }
    $distPath = Join-Path $ClientDir 'dist'

    $caddyConfig = @"
$site {
    encode gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:5015
    }
    handle /socket.io/* {
        reverse_proxy 127.0.0.1:5015
    }

    handle {
        root * $distPath
        try_files {path} /index.html
        file_server
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
"@
    Set-Content -Path $CaddyFile -Value $caddyConfig -Encoding ASCII
    Write-Ok "Wrote $CaddyFile"
}

# --------------------------------------------------------------------------
# Windows Services
# --------------------------------------------------------------------------
function Install-NssmService {
    param(
        [string]$Name,
        [string]$Exe,
        [string]$Arguments,
        [string]$WorkingDir,
        [string]$StdOut,
        [string]$StdErr
    )

    $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        nssm stop $Name confirm 2>&1 | Out-Null
        nssm remove $Name confirm 2>&1 | Out-Null
        Start-Sleep -Seconds 2
    }

    nssm install $Name $Exe $Arguments 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "nssm install $Name failed" }

    nssm set $Name AppDirectory $WorkingDir           2>&1 | Out-Null
    nssm set $Name AppStdout    $StdOut               2>&1 | Out-Null
    nssm set $Name AppStderr    $StdErr               2>&1 | Out-Null
    nssm set $Name AppRotateFiles 1                   2>&1 | Out-Null
    nssm set $Name AppRotateBytes 10485760            2>&1 | Out-Null
    nssm set $Name Start SERVICE_AUTO_START           2>&1 | Out-Null
    # Restart on crash, with a short backoff.
    nssm set $Name AppExit Default Restart            2>&1 | Out-Null
    nssm set $Name AppRestartDelay 5000               2>&1 | Out-Null

    nssm start $Name 2>&1 | Out-Null
}

Write-Step 'Windows Services'
Invoke-Step 'register and start MailDeskAPI' {
    $nodeExe = (Get-Command node).Source
    Install-NssmService -Name 'MailDeskAPI' `
        -Exe $nodeExe `
        -Arguments (Join-Path $ServerDir 'index.js') `
        -WorkingDir $ServerDir `
        -StdOut (Join-Path $LogDir 'api.log') `
        -StdErr (Join-Path $LogDir 'api.err.log')
    Write-Ok 'MailDeskAPI installed and started'
}

Invoke-Step 'register and start MailDeskProxy (Caddy)' {
    $caddyExe = (Get-Command caddy).Source
    Install-NssmService -Name 'MailDeskProxy' `
        -Exe $caddyExe `
        -Arguments "run --config `"$CaddyFile`" --adapter caddyfile" `
        -WorkingDir $InstallDir `
        -StdOut (Join-Path $LogDir 'caddy.log') `
        -StdErr (Join-Path $LogDir 'caddy.err.log')
    Write-Ok 'MailDeskProxy installed and started'
}

# --------------------------------------------------------------------------
# Firewall - expose only the proxy, never Mongo or Node
# --------------------------------------------------------------------------
Write-Step 'Windows Firewall'
Invoke-Step 'allow inbound 80/443, keep 5015 and 27017 private' {
    $ports = if ($isLocalOnly) { @(8080) } else { @(80, 443) }
    foreach ($p in $ports) {
        $ruleName = "MailDesk HTTP $p"
        if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
            Write-Skip $ruleName
        } else {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $p | Out-Null
            Write-Ok "Opened TCP $p"
        }
    }
    Write-Info 'MongoDB (27017) and Node (5015) are intentionally NOT opened - they stay loopback-only.'
}

# --------------------------------------------------------------------------
# Health check
# --------------------------------------------------------------------------
Write-Step 'Health check'
if ($DryRun) {
    Write-Host '    DRY  poll http://127.0.0.1:5015/api/health' -ForegroundColor Magenta
} else {
    $healthy = $false
    for ($i = 1; $i -le 20; $i++) {
        Start-Sleep -Seconds 3
        try {
            $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:5015/api/health' -TimeoutSec 5
            if ($resp.database -eq 'connected') { $healthy = $true; break }
        } catch {
            # not up yet
        }
    }

    if ($healthy) {
        Write-Ok 'API is healthy and connected to MongoDB'
    } else {
        Write-Warn 'API did not become healthy within 60s.'
        Write-Info "Check $LogDir\api.err.log and confirm the MongoDB service is running."
        Write-Info 'A 503 with "database":"disconnected" means Mongo is unreachable.'
    }
}

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
Write-Host ''
Write-Host '===========================================================' -ForegroundColor White
if ($DryRun) {
    Write-Host '  DRY RUN COMPLETE - nothing was changed' -ForegroundColor Magenta
    Write-Host '  Re-run without -DryRun to apply.' -ForegroundColor Magenta
} else {
    Write-Host '  INSTALL COMPLETE' -ForegroundColor Green
}
Write-Host '===========================================================' -ForegroundColor White
Write-Host ''
Write-Host "  Site        : $origin"
Write-Host "  API health  : http://127.0.0.1:5015/api/health"
Write-Host "  Logs        : $LogDir"
Write-Host "  Config      : $EnvPath"
Write-Host "  Services    : MailDeskAPI, MailDeskProxy, MongoDB"
Write-Host ''
Write-Host '  REMAINING MANUAL STEPS' -ForegroundColor Yellow
Write-Host '  ---------------------------------------------------------'
Write-Host '  1. Fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET and the'
Write-Host "     SENDER_* values in $EnvPath, then:"
Write-Host '         Restart-Service MailDeskAPI'
Write-Host ''
Write-Host '  2. In the Google Cloud Console, add this EXACT redirect URI:'
Write-Host "         $origin/api/gmail/oauth/callback" -ForegroundColor White
Write-Host '     A mismatch here is the most common cause of a failed connect.'
Write-Host ''
Write-Host "  3. Open $origin/register and sign up. The FIRST account created on"
Write-Host '     an empty database automatically becomes an approved Admin.'
Write-Host '     Every later self-registration is Pending until an Admin approves'
Write-Host '     it, and receives no session token until then. Register yourself'
Write-Host '     before anyone else can reach the server.' -ForegroundColor Yellow
Write-Host ''
Write-Host '  4. Schedule a daily backup - this is the only copy of your data:'
Write-Host '         mongodump --uri="mongodb://127.0.0.1:27017/maildesk" --out=D:\backups\maildesk'
Write-Host '     Then rehearse a restore once. An untested backup is not a backup.'
Write-Host ''
if (-not $isLocalOnly) {
    Write-Host '  5. Point DNS for' $Domain 'at this server and forward TCP 80/443,'
    Write-Host '     or use a Cloudflare Tunnel (no inbound ports). Caddy will then'
    Write-Host '     obtain a TLS certificate automatically on first request.'
    Write-Host ''
}
Write-Host '  Full guide: docs\DEPLOY-WINDOWS.md' -ForegroundColor Gray
Write-Host ''

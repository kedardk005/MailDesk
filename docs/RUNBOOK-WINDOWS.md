# MailDesk — Windows server runbook

Everything you need to run, check, fix and update the office deployment.
Every command here was run on the real machine during the deployment.

**Run everything in PowerShell as Administrator** (right-click Start →
Terminal (Admin)) on the Windows PC. The folder does not matter unless a
command says otherwise.

---

## 1. What is deployed, and where

| Piece | Where it runs | Address |
| --- | --- | --- |
| Frontend (React) | Vercel | `https://maildesk.kmkothari.com` |
| API (Node) | Windows PC, service `MailDeskAPI` | `http://127.0.0.1:5015` |
| Public API URL | Tailscale Funnel | `https://kmk-server.tail0dbcb3.ts.net` |
| Database | Windows PC, service `MongoDB` | `mongodb://127.0.0.1:27017/maildesk` |

```
  Browser ──► maildesk.kmkothari.com        (Vercel, static files)
                     │
                     │  XHR + WebSocket
                     ▼
        kmk-server.tail0dbcb3.ts.net        (Tailscale Funnel, HTTPS)
                     │
                     ▼
        127.0.0.1:5015  MailDeskAPI  ──►  127.0.0.1:27017  MongoDB
```

Key paths:

| | |
| --- | --- |
| Code | `C:\apps\maildesk` |
| Config | `C:\apps\maildesk\server\.env` |
| Logs | `C:\apps\maildesk\logs\` |
| MongoDB | `C:\Program Files\MongoDB\Server\7.0` |

Versions that matter: **Node 24.19.0**, **MongoDB 7.0.28**, **PowerShell 5.1**.

---

## 2. Is everything working? (start here)

```powershell
# The three services that must be running, plus the API's own opinion of itself.
Get-Service MongoDB,MailDeskAPI,Tailscale | Select-Object Name,Status,StartType
Invoke-RestMethod http://127.0.0.1:5015/api/health | ConvertTo-Json -Compress
```

Healthy looks like `Running` / `Automatic` for all three, and
`{"status":"Server is running","database":"connected","shuttingDown":false}`.

```powershell
# Is the API reachable from the OUTSIDE? This is what Vercel actually needs.
Invoke-RestMethod https://kmk-server.tail0dbcb3.ts.net/api/health | ConvertTo-Json -Compress
```

If the local check passes but this one fails, the app is fine and the **tunnel**
is the problem — see §8.

---

## 3. Services

```powershell
# Restart the API. Do this after ANY change to server\.env — the file is read
# once at boot, so an edited .env does nothing until you restart.
nssm restart MailDeskAPI

# Stop / start individually.
nssm stop MailDeskAPI
nssm start MailDeskAPI

# Same for the database.
Restart-Service MongoDB
```

```powershell
# Confirm a service will come back after a Windows reboot. Anything not
# 'Automatic' will leave you offline after an overnight update.
Get-Service MongoDB,MailDeskAPI,Tailscale | Select-Object Name,Status,StartType
```

```powershell
# What is the service actually running? Useful when a restart "works" but the
# old code seems to still be live.
Get-CimInstance Win32_Service -Filter "Name='MailDeskAPI'" | Select-Object PathName,StartName,State | Format-List
```

---

## 4. Logs

```powershell
# API output — the first place to look for anything.
Get-Content C:\apps\maildesk\logs\api.log -Tail 40

# API errors only.
Get-Content C:\apps\maildesk\logs\api.err.log -Tail 40

# Follow live while you reproduce a problem.
Get-Content C:\apps\maildesk\logs\api.log -Tail 20 -Wait
```

```powershell
# Deploy history — every automatic deploy writes here.
Get-Content C:\apps\maildesk\logs\deploy.log -Tail 40

# Watchdog history.
Get-Content C:\apps\maildesk\logs\watchdog.log -Tail 40
```

```powershell
# The watchdog writes this file ONLY when it needs a human. Its presence is the
# alert; read it, fix the cause, then delete it.
Get-Content C:\apps\maildesk\logs\WATCHDOG-NEEDS-ATTENTION.txt
```

```powershell
# MongoDB's own log, for database-level problems.
Get-Content "C:\Program Files\MongoDB\Server\7.0\log\mongod.log" -Tail 30
```

---

## 5. Configuration (`server\.env`)

```powershell
notepad C:\apps\maildesk\server\.env
```

**Always `nssm restart MailDeskAPI` afterwards.**

```powershell
# Show the settings WITHOUT printing secrets — safe to screenshot or paste.
Get-Content C:\apps\maildesk\server\.env | ForEach-Object {
  if ($_ -match '^(JWT_SECRET|TOKEN_ENCRYPTION_KEY|OAUTH_STATE_SECRET|BREVO_API_KEY|GOOGLE_CLIENT_SECRET|GEMINI_API_KEY)=(.*)$') {
    "$($Matches[1]): $($Matches[2].Length) chars"
  } elseif ($_ -match '^[A-Z]') { $_ }
}
```

The values that matter most:

| Key | Value | Notes |
| --- | --- | --- |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/maildesk` | **Local.** Never point this at a cloud cluster by accident |
| `FRONTEND_URL` | `https://maildesk.kmkothari.com,https://kmkothari-alpha.vercel.app` | Comma-separated allowlist. Exact match — scheme required, no trailing slash |
| `PORT` | `5015` | The tunnel forwards here |
| `TOKEN_ENCRYPTION_KEY` | 64 hex characters | Exactly 64, or AES-256 refuses |
| `ALLOW_LEGACY_PLAINTEXT_TOKENS` | `false` | Keep false in production |

```powershell
# Generate a fresh secret if you ever need one (never paste secrets into chat).
function New-Hex([int]$n){ $b=[byte[]]::new($n); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
New-Hex 32   # 64 chars — for TOKEN_ENCRYPTION_KEY
New-Hex 48   # 96 chars — for JWT_SECRET / OAUTH_STATE_SECRET
```

> Changing `JWT_SECRET` signs everybody out immediately. Changing
> `TOKEN_ENCRYPTION_KEY` makes every stored Gmail token undecryptable and
> everyone must reconnect their mailbox. Do not rotate these casually.

---

## 6. Deploying new code

The deploy is **CI-gated**: it refuses to install a commit whose tests did not
pass. A daily task runs at 03:30; this is the same thing on demand.

```powershell
# Deploy now. Fetches, checks CI, installs, restarts, health-checks,
# and rolls back automatically if the new version does not come up.
powershell -NoProfile -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\deploy-windows.ps1
```

`-ExecutionPolicy Bypass` is a per-process flag. It does **not** change any
machine setting — it just lets this one script run.

| Exit code | Meaning |
| --- | --- |
| 0 | Deployed, or already up to date |
| 1 | Failed before changing anything |
| 2 | Refused: CI red, still running, or unverifiable |
| 3 | Deploy failed → **rolled back, API healthy on the old commit** |
| 4 | Deploy failed **and rollback failed — needs a human** |

```powershell
# Scheduled task control.
Start-ScheduledTask -TaskName 'MailDesk Auto Deploy'          # run it now
Get-ScheduledTask   -TaskName 'MailDesk Auto Deploy'          # is it registered
Unregister-ScheduledTask -TaskName 'MailDesk Auto Deploy' -Confirm:$false
```

```powershell
# What is actually deployed right now?
cd C:\apps\maildesk; git log --oneline -1
```

> **"CI still running"** shortly after a push is normal and correct — wait a few
> minutes and re-run. It does **not** mean you need a GitHub token; the repo is
> public and no credentials are required.

> The deploy runs `git reset --hard`, which discards uncommitted changes under
> `C:\apps\maildesk`. `.env`, `logs\` and `node_modules\` are excluded and
> survive. Do not hand-edit tracked files on this machine.

---

## 7. Watchdog

Checks every 5 minutes. If the API stops responding it restarts it, and if that
does not help it rolls back to the last commit that was healthy for an hour.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\watchdog-windows.ps1 -WhatIfRollback   # dry run
Get-Content C:\apps\maildesk\logs\watchdog.log -Tail 30
Get-Content C:\apps\maildesk\logs\watchdog-state.json
```

It deliberately **will not** roll back when the database is the problem —
reverting code cannot restart MongoDB. In that case it writes the alert file
and stops.

---

## 8. The tunnel (public access)

```powershell
tailscale status                 # is this machine on the tailnet
tailscale funnel status          # is the public URL serving
```

```powershell
# Restart the funnel — first thing to try if the API works locally but not
# from the internet.
tailscale funnel --https=443 off
tailscale funnel --bg 5015
tailscale funnel status
```

```powershell
# Certificate trouble. Unlike 'funnel', this reports the real reason.
tailscale cert kmk-server.tail0dbcb3.ts.net
```

Admin pages: [machines](https://login.tailscale.com/admin/machines) ·
[DNS](https://login.tailscale.com/admin/dns) — **MagicDNS** and **HTTPS
Certificates** must both stay ON, or Funnel silently stops serving.

---

## 9. Vercel (frontend)

Settings → Environment Variables, **Production and Preview**:

```
VITE_API_URL        https://kmk-server.tail0dbcb3.ts.net/api
VITE_SOCKET_URL     https://kmk-server.tail0dbcb3.ts.net
```

`/api` on the first, **not** on the second.

> These are baked into the JavaScript at **build** time. After changing them you
> must **Redeploy with "Use existing Build Cache" unticked**, or the old values
> ship and it looks like nothing happened.

If you later move the API to `api.kmkothari.com`, change these two values,
redeploy, and add the new origin to `FRONTEND_URL`. Nothing else changes.

---

## 10. Database

`mongosh` (the shell) and `mongodump` (the tools) are **separate downloads**
from the MongoDB server package and may not be present. If a command below says
"not recognized", that is why — install them from
[mongodb.com/try/download/shell](https://www.mongodb.com/try/download/shell) and
[/database-tools](https://www.mongodb.com/try/download/database-tools), or use
the Node fallback further down, which always works because the app already
depends on Mongoose.

```powershell
# Rough size of the live database.
& "C:\Program Files\MongoDB\Server\7.0\bin\mongosh.exe" --quiet --eval "db.getSiblingDB('maildesk').stats().dataSize"

# Row counts.
& "C:\Program Files\MongoDB\Server\7.0\bin\mongosh.exe" --quiet --eval "const d=db.getSiblingDB('maildesk'); ['users','tasks','clients','emails'].forEach(c=>print(c+': '+d[c].countDocuments()))"
```

```powershell
# Fallback that needs nothing extra installed — uses the app's own Mongoose.
cd C:\apps\maildesk\server
@'
const m = require('mongoose')
;(async () => {
  await m.connect('mongodb://127.0.0.1:27017/maildesk')
  for (const c of ['users', 'tasks', 'clients', 'emails']) {
    console.log(c + ': ' + await m.connection.db.collection(c).countDocuments())
  }
  await m.disconnect()
})()
'@ | Set-Content count-tmp.js -Encoding ascii
node count-tmp.js
Remove-Item count-tmp.js
```

### Backup — set this up

Nothing backs up this database yet. It is the only part of the system that
cannot be rebuilt from GitHub.

```powershell
# Needs MongoDB Database Tools, which do NOT come with the server package.
# Check what winget offers first:  winget search "mongodb database tools"
$stamp = Get-Date -Format 'yyyy-MM-dd'
mongodump --uri="mongodb://127.0.0.1:27017/maildesk" --out="D:\maildesk-backups\$stamp"
```

```powershell
# Restore a backup into a SCRATCH database first and check it before ever
# restoring over the live one.
mongorestore --uri="mongodb://127.0.0.1:27017" --nsFrom="maildesk.*" --nsTo="maildesk_restoretest.*" "D:\maildesk-backups\2026-08-21\maildesk"
```

---

## 11. Users

The **first** account registered became the Admin (`kmk@kmkothari.com`).
Everyone else registers at `https://maildesk.kmkothari.com/register` and stays
`Pending` until an Admin approves them in **Admin → Users**.

Minimum password length is **12** characters.

---

## 12. Troubleshooting — problems we actually hit

**`npm` fails: "running scripts is disabled on this system"**
PowerShell blocks `npm.ps1`. Use `npm.cmd` — it is a batch file, so the policy
does not apply. Do not change the machine's execution policy.
```powershell
cd C:\apps\maildesk\server; npm.cmd ci --omit=dev
```

**A command "is not recognized" right after installing it**
PATH has not refreshed. Either open a new window, or:
```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
```

**MongoDB service will not start**
Run the binary by hand — the service error never says why:
```powershell
& "C:\Program Files\MongoDB\Server\7.0\bin\mongod.exe" --version; "exit code: $LASTEXITCODE"
```
Exit code `-1073741511` (`0xC0000139`) means the binary cannot run on this
Windows build — that is why this machine runs MongoDB **7.0** and not 8.x.
Do not "upgrade" MongoDB here without testing that command first.

**Browser says "blocked by CORS policy"**
The origin you are browsing from is not in `FRONTEND_URL`. Add it to the
comma-separated list and restart. The message names the origin it *did* allow,
which tells you exactly what is configured.

**Site loads but nothing works / login does nothing**
The Vercel build has the wrong API URL baked in. Redeploy with the build cache
**unticked**.

**Site shows "Not Secure"**
You are on `http://`. Use `https://` and hard-refresh (Ctrl+Shift+R).

**Everything is fine locally but dead from outside**
The tunnel. See §8.

---

## 13. Still outstanding

- [ ] **Database backups** (§10) — nothing is backed up today
- [ ] **Sleep settings.** This is a desktop Windows; if it sleeps, the app is
      offline and neither scheduled task fires. Needs the owner's agreement:
      `powercfg /change standby-timeout-ac 0`
- [ ] **Gmail OAuth has never been tested against a real mailbox** — the largest
      untested area of the app
- [ ] **Encrypt existing OAuth tokens** once mailboxes are connected:
      `node scripts/encryptExistingTokens.js --apply`
- [ ] **Branch protection on `main`** so a red commit cannot be merged
- [ ] Windows 10 build 19041 is **out of support** (no security updates since
      Dec 2021). Worth raising with the machine's owner.

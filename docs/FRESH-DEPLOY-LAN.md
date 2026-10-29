# Fresh LAN deployment — tear down the app, keep the data

Rebuilds MailDesk from scratch on the office Windows PC and brings it up on
`http://kmk-server/`, serving the frontend and the API from one process.

**What gets deleted:** `C:\apps\maildesk` (code, node_modules, logs), the
`MailDeskAPI` service registration, the scheduled tasks.

**What is never touched:** MongoDB and all its data, the backups on `K:`, and
your `server\.env`.

---

## Why we are doing this rather than a one-line fix

The actual fault is small — `nssm` fell off the machine PATH, so every 03:30
deploy aborted at the tool check before doing anything. It could be fixed in a
minute.

A rebuild is still the better call here, because the install has drifted in
ways that are each individually survivable and together are not worth
untangling:

- `nssm` unreachable by the scheduled task (the live fault)
- `FRONTEND_URL` defined **twice** in `.env`; dotenv takes the **last** one, so
  the first line has been silently dead
- Tailscale leftovers from an approach that was abandoned
- five weeks of drift between what is deployed and what is on `main`

A clean checkout removes all of it at once, and the installer we have is safe
for data.

---

## The one thing that can actually hurt you

`TOKEN_ENCRYPTION_KEY` in `server\.env` encrypts every stored Gmail OAuth
token in the database.

**Lose that value and every connected mailbox becomes undecryptable** — the
data is still there, but no token can be read, and every mailbox has to be
reconnected by hand from the server machine.

So phase 0 is not a formality. Do not delete anything until the copy is
verified.

---

## Phase 0 — capture what must survive, and verify it

Nothing here changes the running system.

```powershell
# A safe home OUTSIDE the folder we are about to delete.
New-Item -ItemType Directory -Force -Path C:\maildesk-keep | Out-Null

Copy-Item C:\apps\maildesk\server\.env C:\maildesk-keep\.env.backup -Force
Copy-Item C:\apps\maildesk\logs -Destination C:\maildesk-keep\logs -Recurse -Force -ErrorAction SilentlyContinue
```

Verify the copy is real and complete — **read this output before continuing**:

```powershell
"=== .env copied? ==="
$src = Get-Item C:\apps\maildesk\server\.env
$dst = Get-Item C:\maildesk-keep\.env.backup
"source : $($src.Length) bytes"
"copy   : $($dst.Length) bytes"
if ($src.Length -ne $dst.Length) { "STOP - sizes differ, copy failed" } else { "sizes match" }

"`n=== the key that must survive ==="
if (Select-String -Path C:\maildesk-keep\.env.backup -Pattern '^\s*TOKEN_ENCRYPTION_KEY\s*=\s*.+$' -Quiet) {
  "TOKEN_ENCRYPTION_KEY present in the backup"
} else {
  "STOP - TOKEN_ENCRYPTION_KEY missing from the backup"
}

"`n=== settings present (values hidden) ==="
Select-String -Path C:\maildesk-keep\.env.backup -Pattern '^\s*([A-Z_]+)\s*=' |
  ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique

"`n=== duplicate keys (the FRONTEND_URL problem) ==="
Select-String -Path C:\maildesk-keep\.env.backup -Pattern '^\s*([A-Z_]+)\s*=' |
  ForEach-Object { $_.Matches[0].Groups[1].Value } |
  Group-Object | Where-Object Count -gt 1 | Select-Object Name, Count
```

Confirm MongoDB's data lives **outside** the folder we are deleting:

```powershell
"=== mongod data directory ==="
(Get-CimInstance Win32_Service -Filter "Name='MongoDB'").PathName
$cfg = 'C:\Program Files\MongoDB\Server\7.0\bin\mongod.cfg'
if (Test-Path $cfg) { Select-String -Path $cfg -Pattern 'dbPath|path:' }
```

The path must **not** start with `C:\apps\maildesk`. If it does, stop and tell
me — the plan changes.

Take a fresh backup right now, on top of last night's:

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\backup-windows.ps1
Get-ChildItem K:\maildesk-backups | Sort-Object LastWriteTime -Desc | Select-Object -First 2 Name, LastWriteTime, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
```

Record where nssm actually is — we will call it by full path so PATH can never
break the deploy again:

```powershell
"=== nssm ==="
$nssm = @("C:\Program Files\nssm","C:\Program Files (x86)\nssm","C:\ProgramData\chocolatey\bin","C:\tools","C:\nssm","$env:LOCALAPPDATA\Microsoft\WinGet\Links") |
  ForEach-Object { Get-ChildItem -Path $_ -Filter nssm.exe -Recurse -ErrorAction SilentlyContinue } |
  Select-Object -First 1 -ExpandProperty FullName
if ($nssm) { "FOUND: $nssm" } else { "NOT FOUND - stop, we need to reinstall nssm first" }

"=== node ==="
(Get-Command node).Source
```

**Do not continue until:** sizes match, `TOKEN_ENCRYPTION_KEY` is present, the
mongo data path is outside `C:\apps\maildesk`, a fresh backup exists, and nssm
was found.

---

## Phase 1 — tear the application down

The office cannot use the app from here until phase 4. Do it outside working
hours if you can.

```powershell
$nssm = '<the path phase 0 printed>'

& $nssm stop   MailDeskAPI confirm
& $nssm remove MailDeskAPI confirm
```

Remove the proxy service too if it exists — the LAN design serves everything
from one process and does not use Caddy:

```powershell
if (Get-Service MailDeskProxy -ErrorAction SilentlyContinue) {
  & $nssm stop   MailDeskProxy confirm
  & $nssm remove MailDeskProxy confirm
}
```

```powershell
Get-ScheduledTask | Where-Object TaskName -like '*MailDesk*' |
  Unregister-ScheduledTask -Confirm:$false
```

Confirm MongoDB is still up — it must be, we never touched it:

```powershell
Get-Service MongoDB | Select-Object Name, Status
```

Now delete the folder:

```powershell
Remove-Item C:\apps\maildesk -Recurse -Force
Test-Path C:\apps\maildesk
```

Must print `False`.

---

## Phase 2 — fresh checkout and build

```powershell
git clone https://github.com/kedardk005/MailDesk.git C:\apps\maildesk
cd C:\apps\maildesk
git log --oneline -3
```

Restore the config:

```powershell
Copy-Item C:\maildesk-keep\.env.backup C:\apps\maildesk\server\.env -Force
```

Now fix the two things that were wrong in it. Open it:

```powershell
notepad C:\apps\maildesk\server\.env
```

Make these exactly right — **delete the duplicate `FRONTEND_URL` line, there
must be only one**:

```
PORT=80
FRONTEND_URL=http://kmk-server
GOOGLE_REDIRECT_URI=http://localhost/api/gmail/oauth/callback
```

Leave every other line exactly as it was, above all `TOKEN_ENCRYPTION_KEY`,
`JWT_SECRET`, `MONGO_URI` and the Google and Brevo credentials.

Check there are no duplicates left:

```powershell
Select-String -Path C:\apps\maildesk\server\.env -Pattern '^\s*([A-Z_]+)\s*=' |
  ForEach-Object { $_.Matches[0].Groups[1].Value } |
  Group-Object | Where-Object Count -gt 1 | Select-Object Name, Count
```

**No output is the correct answer.**

Install and build:

```powershell
cd C:\apps\maildesk\server
npm ci --omit=dev
```

```powershell
cd C:\apps\maildesk\client
npm ci
```

```powershell
cd C:\apps\maildesk\client
$env:VITE_API_URL='/api'; $env:VITE_SOCKET_URL='/'; npm run build
Remove-Item Env:\VITE_API_URL, Env:\VITE_SOCKET_URL
```

The relative values matter: they are what let one build serve
`http://kmk-server/`, the raw LAN IP and `http://localhost/` at once.

```powershell
Test-Path C:\apps\maildesk\client\dist\index.html
(Get-ChildItem C:\apps\maildesk\client\dist -Recurse -File).Count
```

`True`, and a few dozen files.

```powershell
New-Item -ItemType Directory -Force -Path C:\apps\maildesk\logs | Out-Null
cd C:\apps\maildesk\server
npm run sync-indexes
```

---

## Phase 3 — register the service, the tasks and the firewall

### 3a. Put nssm on the MACHINE PATH

This is the actual fix for the five weeks of silent failure. The 03:30 task
runs as SYSTEM, which cannot see a per-user PATH.

```powershell
$nssmDir = Split-Path '<the nssm path from phase 0>'
$machinePath = [Environment]::GetEnvironmentVariable('Path','Machine')
if ($machinePath -notlike "*$nssmDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$machinePath;$nssmDir", 'Machine')
  "added $nssmDir to the machine PATH"
} else { "already on the machine PATH" }
```

Prove SYSTEM will see it — this reads the machine PATH, not yours:

```powershell
([Environment]::GetEnvironmentVariable('Path','Machine') -split ';') -match 'nssm'
```

### 3b. Register the API service

```powershell
$nssm = '<the nssm path from phase 0>'
$node = (Get-Command node).Source

& $nssm install MailDeskAPI $node C:\apps\maildesk\server\index.js
& $nssm set MailDeskAPI AppDirectory     C:\apps\maildesk\server
& $nssm set MailDeskAPI AppStdout        C:\apps\maildesk\logs\api.log
& $nssm set MailDeskAPI AppStderr        C:\apps\maildesk\logs\api.err.log
& $nssm set MailDeskAPI AppRotateFiles   1
& $nssm set MailDeskAPI AppRotateBytes   10485760
& $nssm set MailDeskAPI Start            SERVICE_AUTO_START
& $nssm set MailDeskAPI AppExit Default  Restart
& $nssm set MailDeskAPI AppRestartDelay  5000
& $nssm start MailDeskAPI
```

```powershell
Start-Sleep -Seconds 10
Get-Service MailDeskAPI | Select-Object Name, Status, StartType
Invoke-RestMethod http://127.0.0.1/api/health | ConvertTo-Json -Compress
```

Expect `database: connected`.

### 3c. Firewall — office network only

```powershell
New-NetFirewallRule -DisplayName 'MailDesk LAN 80' -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 80 -Profile Private,Domain
```

```powershell
Get-NetFirewallRule -DisplayName 'MailDesk LAN 80' | Select-Object DisplayName, Enabled, Profile
```

MongoDB must stay closed:

```powershell
Get-NetFirewallRule -Direction Inbound -Enabled True |
  Get-NetFirewallPortFilter | Where-Object LocalPort -eq 27017
```

No output is correct.

### 3d. Re-register the scheduled tasks

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\deploy-windows.ps1   -Install
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\watchdog-windows.ps1 -Install
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\backup-windows.ps1   -Install
```

```powershell
Get-ScheduledTask | Where-Object TaskName -like '*MailDesk*' | Select-Object TaskName, State
```

---

## Phase 4 — verify

On the server:

```powershell
(Invoke-WebRequest http://127.0.0.1/ -UseBasicParsing).StatusCode
(Invoke-WebRequest http://127.0.0.1/clients -UseBasicParsing).StatusCode
try { Invoke-WebRequest http://127.0.0.1/api/nope -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

Expect `200`, `200`, `404`.

Confirm the data survived — this is the one that matters:

```powershell
$t = (Invoke-RestMethod http://127.0.0.1/api/health)
"health: $($t.database)"
```

Then log in from a browser and check the client list still shows your ~1000
clients. If it is empty, **stop and tell me** — do not re-import.

From **another office PC**: open `http://kmk-server/`, log in, open a task,
leave the tab a minute to confirm notifications arrive.

Prove the deploy pipeline is alive again — the thing that was broken:

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\deploy-windows.ps1 -Force
Get-Content C:\apps\maildesk\logs\deploy.log -Tail 20
```

It must get past the tool check. No `nssm is not on PATH`.

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\watchdog-windows.ps1
Get-Content C:\apps\maildesk\logs\watchdog.log -Tail 10
Test-Path C:\apps\maildesk\logs\WATCHDOG-NEEDS-ATTENTION.txt
```

Healthy, and `False`.

---

## Phase 5 — Gmail

The consent screen is still in **Testing**, which expires refresh tokens after
7 days. It has been far longer, so every mailbox is almost certainly
disconnected already.

1. Google Cloud console → OAuth consent screen → switch to **Internal**.
2. Authorised redirect URIs → add `http://localhost/api/gmail/oauth/callback`.
3. **On the server machine itself**, open `http://localhost/` and reconnect
   each mailbox. Google rejects `http://` redirects for anything but
   `localhost`, so this cannot be done from another desk.

Once connected, syncing runs server-side and nobody needs to repeat it.

---

## If it goes wrong

Everything you need is in `C:\maildesk-keep` and `K:\maildesk-backups`.

The database was never touched, so the worst case is re-running phase 2 and 3.
To restore the database anyway:

```powershell
Get-ChildItem K:\maildesk-backups | Sort-Object LastWriteTime -Desc | Select-Object -First 5
```

```powershell
& 'C:\Program Files\MongoDB\Tools\100\bin\mongorestore.exe' --gzip --archive=K:\maildesk-backups\<file>.gz --drop
```

`--drop` replaces the current contents. Only run it if you mean to.

Delete `C:\maildesk-keep` only once the app has been working for a few days.

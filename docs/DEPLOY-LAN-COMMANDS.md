# LAN switch — every command, in order

Copy-paste sheet for moving MailDesk to `http://kmk-server/`.
Explanations live in [DEPLOY-LAN-WINDOWS.md](DEPLOY-LAN-WINDOWS.md); this is
just the commands.

**Read this first:**

- Do it in order. Phases C and D must happen **before** E, because E changes the
  port and only the *new* scripts know how to read it.
- Every `powershell` line runs in an **elevated** PowerShell (right-click →
  Run as administrator) on the Windows PC, unless it says "on your Mac".
- Nothing here touches the office's own software or data. If a step's check
  fails, stop and read the rollback section at the bottom — none of it is
  one-way.

---

## Phase A — on your Mac: merge the code

```bash
gh pr checks 40
```

Wait for green. Then:

```bash
gh pr merge 40 --squash
```

PR #39 (backup staleness alert + watchdog soak fix) is also still open:

```bash
gh pr checks 39 && gh pr merge 39 --squash
```

Confirm `main` now has both:

```bash
git fetch origin && git log --oneline origin/main -3
```

---

## Phase B — on the server: look before touching anything

### B1. Is port 80 free?

**This decides everything below.**

```powershell
Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess,
    @{n='Process';e={(Get-Process -Id $_.OwningProcess).ProcessName}}
```

- **No output** → port 80 is free. Continue, use `80` everywhere below.
- **Something listed** → do **not** stop it, it may be the office's own
  software. Use `8080` everywhere below instead, and people open
  `http://kmk-server:8080/`.

### B2. Is everything healthy right now?

Do not start a migration on top of an existing problem.

```powershell
Get-Service MailDeskAPI, MongoDB | Select-Object Name, Status, StartType
```

```powershell
Invoke-RestMethod http://127.0.0.1:5015/api/health | ConvertTo-Json -Compress
```

Expect `database: connected`.

### B3. What is the machine's name and IP? (people will need these)

```powershell
$env:COMPUTERNAME
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
  Select-Object IPAddress, InterfaceAlias
```

### B4. Take a backup before changing anything

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\backup-windows.ps1
```

```powershell
Get-ChildItem K:\maildesk-backups | Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

The newest file must be from today.

---

## Phase C — pull the new code (app stays on 5015, nothing changes yet)

This runs the **old** deploy script, whose only job here is to bring the new
code — including the new scripts — onto the machine. The app keeps running
exactly as it does today, because there is no client build yet.

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\deploy-windows.ps1
```

Check it succeeded:

```powershell
Get-Content C:\apps\maildesk\logs\deploy.log -Tail 20
```

```powershell
Invoke-RestMethod http://127.0.0.1:5015/api/health | ConvertTo-Json -Compress
```

Confirm the new code is actually on disk:

```powershell
cd C:\apps\maildesk; git log --oneline -3
```

```powershell
Test-Path C:\apps\maildesk\docs\DEPLOY-LAN-WINDOWS.md
```

Must print `True`.

---

## Phase D — parse-check the new scripts

**Do not skip this.** The PowerShell changes could not be parse-checked where
they were written. A syntax error would first appear at 03:30, unattended, in
the script that is supposed to be the safety net.

```powershell
foreach ($f in Get-ChildItem C:\apps\maildesk\scripts\*.ps1) {
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
  if ($errs) { "FAIL $($f.Name)"; $errs | ForEach-Object { "   line $($_.Extent.StartLineNumber): $($_.Message)" } }
  else { "ok   $($f.Name)" }
}
```

All four must print `ok`. **If any says FAIL, stop and send me the output** —
do not continue, and do not let the 03:30 task run.

---

## Phase E — switch the port

```powershell
notepad C:\apps\maildesk\server\.env
```

Change these two lines (use `8080` instead of `80` if B1 said port 80 is taken):

```
PORT=80
FRONTEND_URL=http://kmk-server
```

Save and close. Check it took:

```powershell
Select-String -Path C:\apps\maildesk\server\.env -Pattern '^(PORT|FRONTEND_URL)='
```

`.env` is read once at boot, so nothing happens until the restart in Phase G.

---

## Phase F — open the port to the office network only

```powershell
New-NetFirewallRule -DisplayName 'MailDesk LAN 80' -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 80 -Profile Private,Domain
```

Check:

```powershell
Get-NetFirewallRule -DisplayName 'MailDesk LAN 80' |
  Select-Object DisplayName, Enabled, Direction, Action, Profile
```

MongoDB (27017) stays closed. Confirm nobody opened it:

```powershell
Get-NetFirewallRule -Direction Inbound -Enabled True |
  Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq 27017 }
```

Expect **no output**.

---

## Phase G — deploy again, this time building the client

`-Force` is required: the SHA has not changed since Phase C, so without it the
script correctly says "already up to date" and never builds the client.

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\deploy-windows.ps1 -Force
```

This one takes several minutes — it installs the client's build tools and
builds the bundle.

Confirm the build landed:

```powershell
Get-Content C:\apps\maildesk\logs\deploy.log -Tail 30
```

```powershell
Test-Path C:\apps\maildesk\client\dist\index.html
```

Must print `True`.

```powershell
(Get-ChildItem C:\apps\maildesk\client\dist -Recurse -File).Count
```

Should be a few dozen files, not 0.

---

## Phase H — restart and verify on the server itself

```powershell
Restart-Service MailDeskAPI
Start-Sleep -Seconds 10
Get-Service MailDeskAPI | Select-Object Name, Status
```

```powershell
Invoke-RestMethod http://127.0.0.1/api/health | ConvertTo-Json -Compress
```

Is it actually listening on 80?

```powershell
Get-NetTCPConnection -LocalPort 80 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Does it serve the app, not just the API?

```powershell
(Invoke-WebRequest http://127.0.0.1/ -UseBasicParsing).StatusCode
```

Expect `200`.

```powershell
(Invoke-WebRequest http://127.0.0.1/ -UseBasicParsing).Content.Substring(0,200)
```

Expect HTML containing `<div id="root">`.

Does a client-side route work?

```powershell
(Invoke-WebRequest http://127.0.0.1/clients -UseBasicParsing).StatusCode
```

Expect `200`.

Does an unknown API path still return JSON, not the app?

```powershell
try { Invoke-WebRequest http://127.0.0.1/api/nope -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

Expect `404`.

---

## Phase I — verify from a different office PC

On **someone else's machine**, open a browser:

```
http://kmk-server/
```

If the name does not resolve, use the IP from B3, e.g. `http://192.168.1.40/`.

Check, in this order:

1. The login page loads.
2. You can log in.
3. The inbox and the clients list load.
4. Open a task, leave the tab open a minute — notifications still arrive.
   (That is the WebSocket working.)

If it loads on the server but not from another PC, it is the firewall or the
network, not the app — re-run the Phase F check.

---

## Phase J — confirm the automation survived the port change

Both scripts now read `PORT` from `.env`. Prove it rather than assume it.

Watchdog, run once by hand:

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\watchdog-windows.ps1
```

```powershell
Get-Content C:\apps\maildesk\logs\watchdog.log -Tail 15
```

It must report the API **healthy**. If it reports a failure, it is still
checking the wrong port — stop, and revert with the rollback below.

No alert file should exist:

```powershell
Test-Path C:\apps\maildesk\logs\ALERT.txt
```

Expect `False`.

Scheduled tasks still registered:

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -like '*MailDesk*' } |
  Select-Object TaskName, State, @{n='Next';e={($_ | Get-ScheduledTaskInfo).NextRunTime}}
```

---

## Day-to-day checks (after the switch)

```powershell
# One-line "is it all fine?"
Get-Service MailDeskAPI, MongoDB | Select-Object Name, Status
Invoke-RestMethod http://127.0.0.1/api/health | ConvertTo-Json -Compress
Test-Path C:\apps\maildesk\logs\ALERT.txt      # False = nothing needs a human
```

```powershell
# Last night's automatic deploy
Get-Content C:\apps\maildesk\logs\deploy.log -Tail 25
```

```powershell
# Watchdog history
Get-Content C:\apps\maildesk\logs\watchdog.log -Tail 25
```

```powershell
# Backups - newest must be from last night
Get-ChildItem K:\maildesk-backups | Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

```powershell
# API errors only
Select-String -Path C:\apps\maildesk\logs\api.log -Pattern '"level":50' | Select-Object -Last 20
```

```powershell
# Follow live while reproducing a problem
Get-Content C:\apps\maildesk\logs\api.log -Wait -Tail 5
```

```powershell
# Who is connected / what port is it on
Get-NetTCPConnection -LocalPort 80 -State Listen | Select-Object LocalAddress, LocalPort
```

---

## Rollback

Nothing above is one-way. To go back to exactly how it was:

```powershell
notepad C:\apps\maildesk\server\.env
```

Set back:

```
PORT=5015
FRONTEND_URL=https://maildesk.kmkothari.com
```

Then:

```powershell
Restart-Service MailDeskAPI
Start-Sleep -Seconds 10
Invoke-RestMethod http://127.0.0.1:5015/api/health | ConvertTo-Json -Compress
```

```powershell
Remove-NetFirewallRule -DisplayName 'MailDesk LAN 80'
```

To also stop the API serving the client at all — it then behaves exactly as it
did before this release:

```powershell
Remove-Item C:\apps\maildesk\client\dist -Recurse -Force
Restart-Service MailDeskAPI
```

To roll the *code* back to the previous release:

```powershell
cd C:\apps\maildesk
git log --oneline -5
git reset --hard <sha-from-before>
cd server; npm ci --omit=dev
Restart-Service MailDeskAPI
```

---

## If something goes wrong

| Symptom | First command to run |
|---|---|
| Blank page in the browser | `Test-Path C:\apps\maildesk\client\dist\index.html` — if False, re-run Phase G |
| "Can't reach this site" from another PC, fine on the server | Phase F firewall check |
| Works on the server, blank from another PC | Browser console → if it calls `localhost`, the build missed `VITE_API_URL`; re-run Phase G |
| Deploy rolled itself back | `Get-Content C:\apps\maildesk\logs\deploy.log -Tail 40` |
| Watchdog keeps restarting the service | `Get-Content C:\apps\maildesk\logs\watchdog.log -Tail 40` — check it is probing the right port |
| Notifications stopped, rest works | WebSocket. Check the browser console on the client PC |
| Everything down | `Get-Service MongoDB` first — the API cannot start without it |

Send me the output of whichever command you run; do not guess at a fix on a
machine the office depends on.

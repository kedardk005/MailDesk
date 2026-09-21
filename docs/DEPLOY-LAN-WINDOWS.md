# MailDesk — office LAN deployment (no tunnel, no Vercel)

One Windows machine serves **both** the React app and the API on **one port**.
Everyone in the office opens `http://kmk-server/` and that is the whole thing.

Nothing is exposed to the internet.

---

## Why this replaced the tunnel

| Attempt | What happened |
|---|---|
| Cloudflare quick tunnel | Office firewall blocks outbound 7844. Connected once, then died. |
| Tailscale Funnel | Broke twice in two days. The machine has nine user accounts, and Tailscale's per-user tray app takes the connection over whenever somebody else logs in. Even with `--unattended`, the node online, a valid cert and a clean `netcheck`, public ingress still reset TLS. |

Everyone who uses MailDesk sits in the same office, so the public hop was
solving a problem nobody had — while being the single largest source of
outages. Serving on the LAN removes the tunnel, HTTPS/mixed-content, **and**
CORS in one move, because the app and the API become the same origin.

---

## What changed in the code

The API now serves the built client when one is present:

- `/assets/*` — hashed files, cached for a year (`immutable`).
- `/` and every client-side route — `index.html`, `no-cache` so a deploy is
  picked up on the next refresh.
- `/api/*` — unchanged, and an unknown `/api` path still returns **JSON 404**,
  not the app shell. (Getting that backwards turns every API typo into a 200
  HTML page and breaks error handling everywhere at once.)

If `client/dist` does not exist the whole block is skipped, so a server-only
checkout and `npm run dev` against Vite behave exactly as before.

The client is built with **relative** URLs (`VITE_API_URL=/api`,
`VITE_SOCKET_URL=/`). That is what lets one build serve `http://kmk-server/`,
`http://192.168.1.40/` and `http://localhost/` at the same time — an absolute
URL would pin the bundle to one spelling of the address and need a rebuild the
day the machine's IP changes.

---

## Deploying it

### 1. Check port 80 is actually free

**Do this first.** IIS, Skype, or a vendor tool may already own it.

```powershell
Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess,
    @{n='Process';e={(Get-Process -Id $_.OwningProcess).ProcessName}}
```

No output means port 80 is free — continue.

If something IS listening, do **not** stop it (it may be the office's own
software). Use port 8080 instead and tell people to open
`http://kmk-server:8080/`. Everything below is identical apart from the number.

### 2. Point the server at port 80

Edit `C:\apps\maildesk\server\.env`:

```
PORT=80
FRONTEND_URL=http://kmk-server
```

`FRONTEND_URL` is the address used to BUILD links in emails (password reset,
task links), so put the name you want people to see. Other LAN addresses still
work without being listed — see "Reaching it by IP" below.

`.env` is read once at boot, so nothing happens until the service restarts.

### 3. Open the port on the private network only

```powershell
New-NetFirewallRule -DisplayName 'MailDesk LAN 80' -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 80 -Profile Private,Domain
```

`-Profile Private,Domain` matters: it allows the office network and leaves the
Public profile closed, so the app stays unreachable if the machine ever joins
an untrusted network.

MongoDB (27017) stays loopback-only. Do not open it.

### 3b. Parse-check the scripts, and deploy by hand once

**Do this before the 03:30 scheduled task runs.** The PowerShell changes in
this release could not be parse-checked where they were written (no Windows,
and PowerShell under emulation segfaulted). The JavaScript is fully tested;
the `.ps1` files are reviewed but not executed.

A parse error would only surface at 03:30, unattended, in the script that is
supposed to be the safety net.

```powershell
foreach ($f in Get-ChildItem C:\apps\maildesk\scripts\*.ps1) {
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
  if ($errs) { "FAIL $($f.Name)"; $errs | ForEach-Object { "   line $($_.Extent.StartLineNumber): $($_.Message)" } }
  else { "ok   $($f.Name)" }
}
```

All four must say `ok`. Then run the deploy manually once (step 4) and watch it
finish before trusting the scheduled one.

Also confirm the health URL resolved to the port you set — both scripts now
read `PORT` from `server\.env` instead of assuming 5015, which is what stops a
healthy server on :80 being rolled back as a failed deploy:

```powershell
Select-String -Path C:\apps\maildesk\logs\deploy.log -Pattern 'health' | Select-Object -Last 3
```

### 4. Deploy

```powershell
powershell -ExecutionPolicy Bypass -File C:\apps\maildesk\scripts\deploy-windows.ps1
```

The deploy script now builds the client as well as the server. It:

- installs server deps with `--omit=dev`,
- installs client deps **with** dev deps (vite is one — a production-only
  install cannot build anything),
- builds into `client\dist.building` and swaps it into `client\dist` only
  after the build succeeds. A build that writes straight into `dist` empties it
  first, so a failure half way through would leave the office on a blank page
  with the API perfectly healthy — which neither the health gate nor the
  watchdog would catch.

### 5. Restart and verify

```powershell
Restart-Service MailDeskAPI
Start-Sleep -Seconds 8
Invoke-RestMethod http://127.0.0.1/api/health
```

Then **from a different machine in the office**:

```
http://kmk-server/
```

Log in, open a task, and leave the tab open for a minute to confirm
notifications still arrive (that is the WebSocket working).

---

## Reaching it by IP as well as by name

People will reach the machine however their PC resolves it — `kmk-server`,
`kmk-server.local`, or the raw `192.168.1.40`. `FRONTEND_URL` can only name one
of those.

The server therefore also accepts any **private-network** origin: loopback,
`10.x`, `192.168.x`, `172.16–31.x`, CGNAT, link-local, `.local`, and dotless
single-label hostnames (which cannot be public DNS names). Anything routable
from the internet still has to be listed in `FRONTEND_URL` explicitly.

Scope, measured rather than assumed: this governs Socket.io's **polling
fallback** and cross-origin REST. It does not govern the WebSocket transport,
which engine.io accepts from any origin because CORS does not apply to
WebSocket at all. Authentication does not depend on it either way — the
handshake carries a JWT that no other origin can read out of our localStorage.

---

## Gmail: connect mailboxes **from the server machine**

Google rejects `http://` redirect URIs for anything except `localhost`, so the
OAuth callback cannot be `http://kmk-server`.

Connect each mailbox **on the server machine itself** (or over RDP to it),
using `http://localhost/` in the browser there. Tokens persist and syncing runs
server-side afterwards, so this is once per mailbox, not once per person.

Add `http://localhost/api/gmail/callback` to the authorised redirect URIs in
the Google Cloud console, and set `GOOGLE_REDIRECT_URI` to match.

> Still outstanding: the OAuth consent screen is in **Testing** mode, which
> expires refresh tokens after 7 days. Switch it to **Internal** or mailboxes
> will silently disconnect every week.

---

## Rolling back to the old setup

Nothing here is one-way.

```powershell
# server\.env
PORT=5015
FRONTEND_URL=https://maildesk.kmkothari.com

Restart-Service MailDeskAPI
Remove-NetFirewallRule -DisplayName 'MailDesk LAN 80'
```

The Vercel deployment is left in place and untouched. It keeps working against
whatever `FRONTEND_URL`/CORS allows, so it is a fallback, not a dependency.

To stop the API serving the client at all, delete `client\dist` — the server
then behaves exactly as it did before this change.

# Split deployment — client on Vercel, API on the Windows PC

This is the deployment shape you asked for: Vercel serves the React app, the
office Windows machine runs the API, Mongo and Redis, and a scheduled task
pulls `main` once a day and redeploys the backend.

`docs/DEPLOY-WINDOWS.md` describes the all-on-one-box variant, where Caddy
serves the built client too. This document replaces the client half of that
guide and adds the auto-deploy loop. Everything else in it still applies.

```
  developer push
        |
        +--> GitHub main --> Vercel build --> https://maildesk.vercel.app
        |                                            |
        |                                            | XHR + WebSocket
        |                                            v
        +--> (daily 03:30) Windows Task Scheduler --> https://api.<your-domain>
                     |                                        |
                     v                                   Cloudflare Tunnel
             scripts/deploy-windows.ps1                       |
             fetch, CI gate, reset, npm ci,             MailDeskAPI (node, :5015)
             syncIndexes, restart, health,              MongoDB, Redis
             roll back on failure                       -- all on the office PC
```

---

## The one thing that has to be solved first: HTTPS on the API

Vercel serves the client over **https**. A page served over https is not
allowed by the browser to call an **http** API — the request is blocked as
mixed content, with no prompt and no way for a user to override it. So
`https://maildesk.vercel.app` cannot talk to `http://<office-ip>:5015`. Not
"should not" — *cannot*.

The API therefore needs a public hostname with a valid TLS certificate. Two
ways to get one:

### Option A — Cloudflare Tunnel (recommended here)

`cloudflared` runs as a Windows service and makes an **outbound** connection to
Cloudflare. Cloudflare then routes `https://api.<your-domain>` down that
connection to `127.0.0.1:5015`.

Why this one, for this situation:

- **No router configuration.** No port forwarding, no inbound firewall rule, no
  static IP, no call to whoever manages the office network. You said not to
  touch their setup — this doesn't.
- **Nothing is exposed.** The office PC accepts no inbound connections. If the
  tunnel is stopped, the API is simply unreachable, not open.
- The certificate is Cloudflare's problem, and it renews itself.
- WebSockets pass through, which Socket.io needs.

Cost: a domain name, on Cloudflare's free plan. If you do not own one, that is
the only thing to buy.

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login                      # opens a browser, pick your domain
cloudflared tunnel create maildesk
cloudflared tunnel route dns maildesk api.<your-domain>
```

Write `C:\Users\<you>\.cloudflared\config.yml`:

```yaml
tunnel: maildesk
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json

ingress:
  - hostname: api.<your-domain>
    service: http://127.0.0.1:5015
  - service: http_status:404
```

Then install it as a service so it survives a reboot:

```powershell
cloudflared service install
Start-Service cloudflared
```

Verify from your Mac, not from the office PC — the point is that it works from
outside:

```bash
curl -s https://api.<your-domain>/api/health
```

You want `{"status":"Server is running","database":"connected",...}`.

> With a tunnel in front, **Caddy is no longer needed**. `install-windows.ps1`
> installs it as `MailDeskProxy` to terminate TLS and serve the client — a
> tunnel does the first job and Vercel does the second. Leave the service
> stopped (`nssm stop MailDeskProxy`) or skip it at install time. Leaving it
> running is harmless but it will keep trying to obtain a certificate for a
> domain that no longer points at it, and failing noisily in `caddy.err.log`.

### Option B — port forward + Caddy

Keep `MailDeskProxy`, point an A record at the office's public IP, forward 80
and 443 to the machine, and Caddy gets a Let's Encrypt certificate on its own.
This is the standard approach and it works — but it needs router access, a
stable public IP, and it puts the office machine on the open internet. Given
that it is not your network, Option A is the better citizen.

---

## Vercel setup

The repo has no root `package.json`, so Vercel must be told the app lives in
`client/`.

1. Import `kedardk005/MailDesk` at vercel.com/new.
2. **Root Directory: `client`**. Everything else is already in
   `client/vercel.json` — framework, build command, output directory, the SPA
   rewrite that stops `/inbox` 404ing on refresh, and cache headers.
3. Environment variables, for **Production** *and* **Preview**:

   | Name               | Value                            |
   | ------------------ | -------------------------------- |
   | `VITE_API_URL`     | `https://api.<your-domain>/api`  |
   | `VITE_SOCKET_URL`  | `https://api.<your-domain>`      |

   Both are **required**. `client/src/lib/config.js` throws on a production
   build with either missing, and because that throw happens when the module
   loads in the browser, the symptom is a **white screen with an error in the
   console**, not a failed build. If the deployed site is blank, check these
   two first.

   Note `VITE_API_URL` includes `/api`; `VITE_SOCKET_URL` does not.

Vercel redeploys on every push to `main` by itself. There is no script for the
client half and none is needed.

## Server setup

In `server/.env` on the Windows box:

```ini
FRONTEND_URL=https://maildesk.vercel.app
```

This is the CORS allowlist and the Socket.io origin check — a **single** origin
(`server/index.js:143` and `:327`). Consequences worth knowing up front:

- Use the **production** Vercel URL, not a deployment-specific one.
- **Preview deployments will not work against this API.** Every preview gets a
  fresh `maildesk-<hash>-<scope>.vercel.app` origin, and none of them are this
  value, so their API calls fail CORS. That is the correct default for an app
  holding client mail — a preview build should not be talking to production
  data. If you later want previews to work, point them at a separate staging
  API rather than widening this to a wildcard.
- If you attach a custom domain to the Vercel project, update this to match, or
  the app breaks the moment you start using the new domain.

Restart the API after changing it: `nssm restart MailDeskAPI`.

## Auto-deploy

One-time registration, in an **elevated** PowerShell on the Windows machine:

```powershell
cd C:\apps\maildesk\scripts
.\deploy-windows.ps1 -Install
```

That creates a Scheduled Task, *MailDesk Auto Deploy*, running as SYSTEM daily
at 03:30. Change the time with `-At 02:00`.

Each run does:

1. `git fetch`. If `main` has not moved, it exits — a no-op costs one fetch.
2. **Asks GitHub whether that exact commit's CI passed.** Red, still running,
   or unknown → it refuses and leaves the running version alone. The repo is
   public, so this needs no credentials; if you make it private, set a
   `GITHUB_TOKEN` environment variable with `repo` scope.
3. `git reset --hard` to the new commit (`git clean -fd`, *not* `-fdx`, so
   `server/.env`, `logs/` and `node_modules/` survive).
4. `npm ci --omit=dev`, then `node scripts/syncIndexes.js`.
5. `nssm restart MailDeskAPI`, then polls `/api/health` for up to 90s and
   requires `database: connected`.
6. **If any of that fails, it puts the previous commit back**, reinstalls its
   dependencies, restarts, and health-checks *again* before reporting. A bad
   commit costs a log line, not a working day.

Exit codes, which Task Scheduler records in its History tab:

| Code | Meaning |
| ---- | ------- |
| 0 | Deployed, or nothing to do |
| 1 | Failed before touching anything |
| 2 | Refused: CI red or unverifiable |
| 3 | Deploy failed, **rolled back, API is healthy on the old commit** |
| 4 | Deploy failed **and rollback failed — API is down, needs a human** |

Log: `C:\apps\maildesk\logs\deploy.log`, rotated at 5 MB.

```powershell
Get-Content C:\apps\maildesk\logs\deploy.log -Tail 40      # what happened
Start-ScheduledTask -TaskName 'MailDesk Auto Deploy'       # run it now
.\deploy-windows.ps1 -Force                                # redeploy same SHA
Unregister-ScheduledTask -TaskName 'MailDesk Auto Deploy' -Confirm:$false
```

### If the API dies *after* a successful deploy

`deploy-windows.ps1` only guards its own deploy window. If a commit passes its
health check at 03:31 and then falls over at 11:00 under real traffic, nothing
above notices. `scripts/watchdog-windows.ps1` covers that.

```powershell
cd C:\apps\maildesk\scripts
.\watchdog-windows.ps1 -Install        # elevated; runs every 5 minutes
```

**What it refuses to do is the point.** An auto-rollback that fires on any
unhealthy reading is worse than none, because the API also reports unhealthy
when MongoDB stops — and reverting code cannot restart a database. It would
churn `node_modules`, destroy the evidence, and leave you debugging the wrong
build. So:

| What it sees | What it does |
| --- | --- |
| API answers, `database: disconnected` | **No rollback.** Dependency failure. Alert, exit 5 |
| API silent **and** Mongo's port dead | **No rollback.** Machine or database. Alert, exit 5 |
| API silent, Mongo fine — 1st time | Restart the service. Most failures are transient |
| API silent, Mongo fine — 2nd time | **Roll back** to last-known-good, verify, exit 3 |
| Already on last-known-good | Nothing to roll back to. Alert, exit 4 |
| Already rolled back from this commit | Refuses to loop. Alert, exit 4 |
| `shuttingDown: true`, or a deploy holds the lock | No-op |

Last-known-good is **earned, not assumed**: a commit is promoted only after it
has been continuously healthy for `-SoakMinutes` (default 60). So a deploy at
03:30 that breaks at 03:35 rolls back to the commit *before* it, never to
itself. It rolls back at most once per commit — a watchdog that flaps a service
is an outage with extra steps.

When a human is needed it writes `logs\WATCHDOG-NEEDS-ATTENTION.txt` saying
what happened and what it did not do. Delete that file once you have dealt with
it; a successful promotion clears it automatically.

Dry run, changes nothing:

```powershell
.\watchdog-windows.ps1 -WhatIfRollback
```

The decision table above is covered by 31 assertions in
`scripts/tests/watchdog-logic.test.ps1`, which run on any machine with
PowerShell 7 — no Windows required:

```powershell
pwsh -File scripts/tests/watchdog-logic.test.ps1
```

### What it deliberately does not do

- **It does not run the backfill scripts** in `server/scripts/`
  (`backfillEmailThreads.js`, `encryptExistingTokens.js`,
  `reconcileEmailAssignments.js`, …). Those are one-time data migrations that
  rewrite documents; they need a human who has taken a backup first. Only
  `syncIndexes.js`, which is idempotent, runs automatically.
- **It does not touch the client.** Vercel owns that.
- **It does not back up the database.** Nothing here does yet — see below.

### Before you trust it unattended

- Run it once by hand and watch it succeed.
- Then test the *failure* path, because an untested rollback is not a rollback.
  Push a commit to a scratch branch that crashes on boot, point the script at
  it with `-Branch <scratch> -SkipCiCheck`, and confirm you get exit code 3 and
  a working API.
- **Turn on branch protection for `main`** — required status checks, so a red
  commit cannot land in the first place. The CI gate in this script is the
  second line of defence, not the first. (This is not hypothetical: a red
  commit was merged to `main` during development because nothing stopped it.)
- **Set up a database backup.** A daily `mongodump` to a second disk is the
  minimum. Auto-deploy raises how often the code changes; it does nothing for
  the data, and the data is the part you cannot re-clone from GitHub.
- **Run `node scripts/encryptExistingTokens.js` once**, then set
  `ALLOW_LEGACY_PLAINTEXT_TOKENS=false`. Gmail refresh tokens are currently
  stored in plaintext; the API logs a warning about this on every boot. Take a
  backup first.

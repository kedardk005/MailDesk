# Deploying on a self-hosted Windows Server

Everything — app, database, cache — runs on your own machine. No Atlas, no
managed Redis, no cluster. This is a supported configuration, not a compromise:
every Redis-dependent subsystem was written with a working in-process fallback
specifically so a single-box install is valid.

---

## 1. What you actually need

| Component | Version | Notes |
|---|---|---|
| **Windows Server** | 2019 / 2022 | 4 GB RAM minimum, 8 GB comfortable |
| **Node.js** | 22 LTS | Windows x64 MSI |
| **MongoDB Community** | **7.0 or newer — mandatory** | Windows MSI, installs as a Windows Service |
| **Redis** | optional | See §5 before deciding |
| **Caddy** | 2.x | Single .exe. Reverse proxy + automatic HTTPS |

> **MongoDB 7.0 is a hard requirement.** The SLA reports use the `$median` and
> `$percentile` aggregation operators, introduced in 7.0. On 6.x the app boots
> and runs normally and then **SLA reports fail at query time** — easy to miss
> until someone opens that tab. Check with `mongosh --eval "db.version()"`.

Docker Desktop is *not* recommended on Windows Server — licensing and Hyper-V
interactions make it more trouble than a native install here.

---

## 2. Install order

1. **MongoDB 7.0** — MSI, choose "Run as a Network Service user" so it starts as
   a Windows Service. Leave it bound to `127.0.0.1` (the default). It must not
   be reachable from the internet.
2. **Node.js 22 LTS** — MSI. Verify: `node -v`.
3. **Deploy the code** to e.g. `C:\apps\maildesk`:
   ```
   git clone https://github.com/kedardk005/MailDesk.git C:\apps\maildesk
   cd C:\apps\maildesk\server
   npm ci --omit=dev
   ```
4. **Build the client** (see §4 — the API URL is baked in at build time).

---

## 3. Server configuration

Create `C:\apps\maildesk\server\.env`. **Generate fresh secrets — never reuse
the development ones.**

```
NODE_ENV=production
PORT=5015
MONGO_URI=mongodb://127.0.0.1:27017/maildesk
APP_TIMEZONE=Asia/Kolkata

# Public origin of the site. CORS is checked against this exactly.
FRONTEND_URL=https://mail.yourcompany.com

JWT_SECRET=<64 random hex chars>
TOKEN_ENCRYPTION_KEY=<exactly 32 bytes as 64 hex chars>
OAUTH_STATE_SECRET=<32+ random chars>

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://mail.yourcompany.com/api/gmail/oauth/callback

SENDER_EMAIL=...
SENDER_APP_PASSWORD=...
GEMINI_API_KEY=...

# Leave REDIS_URL unset for a single-instance install. See §5.
```

Generate each secret with:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then run the migrations **once**, in this order:
```
npm run sync-indexes -- --apply
npm run backfill-emails
node scripts/backfillEmailThreads.js --apply
node scripts/backfillTaskCompletedAt.js --apply
```
The new indexes and fields are inert until these run.

---

## 3a. Encrypt stored OAuth tokens — do this before the first Gmail connect

**Audit L-4.** `TOKEN_ENCRYPTION_KEY` encrypts Google refresh tokens at rest,
but only for tokens written *after* it was configured. Any account connected
before that still holds its refresh token in **plaintext** in the `users`
collection — and a Gmail refresh token is a standing grant to the whole
mailbox, so a stolen database dump is a stolen mailbox.

The API tells you when this is the case. At startup, with plaintext tokens
present, it logs once:

```
"OAuth tokens are stored in PLAINTEXT for some accounts. See docs/DEPLOY-WINDOWS.md."
  accounts: 8
  allowLegacyPlaintextTokens: true
  remediation: node scripts/encryptExistingTokens.js --apply
```

### The operator step, exactly

From `C:\apps\maildesk\server`, with the same `.env` the service uses:

```
:: 1. DRY RUN. Reads only, writes nothing, prints how many tokens are affected.
node scripts/encryptExistingTokens.js

:: 2. Rewrite them. Prints the target host/database and asks you to type the
::    database name back before it writes anything. Add --yes to skip the
::    prompt in an unattended run.
node scripts/encryptExistingTokens.js --apply
```

The script:
- refuses to start without `MONGO_URI` **and** a usable `TOKEN_ENCRYPTION_KEY`
  (it encrypts and decrypts a probe value first, so a malformed key fails
  before a single record is touched);
- skips values that are already encrypted, and identifies them structurally
  (`iv:ciphertext:tag`, hex, correct IV and tag lengths) rather than by looking
  for a colon;
- verifies every value it writes decrypts back to the original before saving;
- never prints a token;
- reports each failure by email address and exits non-zero, rather than
  aborting mid-collection.

**Then, and only after a clean run:**

```
ALLOW_LEGACY_PLAINTEXT_TOKENS=false
```

and restart the API service. From that point an unencrypted token is a hard
error on read (that mailbox reports a sync failure) instead of being used
silently.

> With `NODE_ENV=production` and `ALLOW_LEGACY_PLAINTEXT_TOKENS` **unset**, the
> guard is already closed — production fails safe by default. Setting it to
> `true` in production is a deliberate, visible choice to run before the
> migration.

**Never run this against a database you have not backed up** (§9), and never
against production from a developer machine — `dotenv` loads whatever
`MONGO_URI` your local `.env` happens to point at, which is why `--apply` makes
you type the database name.

---

## 3b. Password policy

**Audit L-3.** The shipped minimum was **6 characters**. It is now **12**, with
no composition rule — length is what resists an offline attack on a bcrypt
hash, while a forced symbol/digit rule mostly produces `Passw0rd!`.

This governs **new** passwords only: registration, Admin user creation,
password reset and change-password. **No existing account is locked out** —
sign-in accepts whatever password the account already has, and the new floor
applies the next time that password is set.

`PASSWORD_MIN_LENGTH` overrides it and is clamped to `[8, 64]`, so it can only
be used to tighten the policy. Leave it unset unless you have a reason.

If you want existing six-character passwords gone, there is no forced-rotation
mechanism in the product: set the affected accounts back to `Pending` in
**Users & Approvals**, or use the password-reset flow per user.

---

## 4. Build the client

`VITE_*` variables are inlined at **build** time, not read at runtime. If the
public URL ever changes, you must rebuild.

```
cd C:\apps\maildesk\client
```
Create `.env.production`:
```
VITE_API_URL=https://mail.yourcompany.com/api
VITE_SOCKET_URL=https://mail.yourcompany.com
```
```
npm ci
npm run build
```
This produces `client\dist` — static files Caddy serves directly.

---

## 5. Redis: optional, and what you give up

**With `REDIS_URL` unset the app works correctly on one instance.** What changes:

| Subsystem | Without Redis |
|---|---|
| Cache | In-process LRU with TTL. Correct, just not shared |
| Job queue | In-process runner. Still async and off the request path, but **jobs are lost on restart** |
| Cron | Runs in-process. Correct for one instance; **would double-fire if you ever ran two** |
| Socket.io | Single-instance adapter. Fine for one process |
| Rate limits | In-memory. Counters reset on restart |

The queue caveat is the only one with real bite, and it is mild: Gmail sync is
re-triggered by cron every 10 minutes and ingestion de-duplicates on message id,
so a sync lost to a restart is picked up on the next pass.

**If you want durability**, install **Memurai** — a Windows-native,
Redis-protocol-compatible server that runs as a Windows Service. Set
`REDIS_URL=redis://127.0.0.1:6379` and the app switches to BullMQ, a shared
cache, a distributed cron lock and a shared rate-limit store automatically. No
code change. Redis on WSL2 also works but is one more moving part to supervise.

---

## 5a. Rate limiting — read this before the whole office is locked out

Your staff sit behind **one public IP**. Any rate limit keyed on the client
address is therefore a budget for the *entire firm*, not per person. That is
exactly what the pre-deployment audit found (H-8): with the old per-IP defaults
of 300 requests / 15 min and **10 sign-ins / 15 min**, and a dashboard load
costing about **11 counted API calls**, the office got roughly 27 dashboard
loads per quarter hour between them, and the eleventh person to sign in on a
Monday morning was told *"Too many authentication attempts from this IP"* — as
was everyone after them.

The limits are now keyed differently, and you should still size them for your
office:

| Variable | Default | Counted per | What it protects |
|---|---|---|---|
| `RATE_LIMIT_GENERAL_MAX` | `1000` / 15 min | **signed-in user** (IP when anonymous) | one runaway client or scraper |
| `RATE_LIMIT_AUTH_ACCOUNT_MAX` | `10` / 15 min | **email address**, failed attempts only | password guessing / credential stuffing |
| `RATE_LIMIT_AUTH_IP_MAX` | `200` / 15 min | IP address, all `/api/auth/*` calls | bulk abuse from one source |
| `AI_RATE_LIMIT_PER_MINUTE` | `10` / min | IP address | the unmetered LLM proxy |

Sizing notes:

- **`RATE_LIMIT_GENERAL_MAX` is per person.** A busy hour is roughly 60-100
  requests per person; 1000 leaves a wide margin. Raise it, do not lower it,
  unless you have a specific reason.
- **`RATE_LIMIT_AUTH_ACCOUNT_MAX` is the real password-guessing control**, and a
  *successful* sign-in costs nothing against it. Someone who types their own
  password correctly never consumes budget, so there is no reason to raise this
  to accommodate the office. 10 failed attempts in 15 minutes for one account is
  generous for a human and useless for a bot.
- **`RATE_LIMIT_AUTH_IP_MAX` must comfortably exceed** (staff count × sign-ins
  per morning). For 15 people, 200 is roughly 13 attempts each; raise it for a
  larger office or a shared terminal.
- `RATE_LIMIT_AUTH_MAX` is kept as a deprecated alias for
  `RATE_LIMIT_AUTH_IP_MAX` so an existing `.env` keeps working.

**`trust proxy` matters.** The API sets `app.set('trust proxy', 1)` — exactly one
hop. Behind Caddy (§7) that is correct. If you add a second proxy in front
(Cloudflare Tunnel *and* Caddy, §8B), the IP-keyed limiters will see the inner
proxy's address and collapse into a single bucket; the per-user and per-account
limiters are unaffected, which is another reason those carry the real load.

**Without Redis the counters are per process and reset on restart.** With
`REDIS_URL` set they are shared and durable (§5). The store initialises its
Redis connection with the offline queue enabled — without that it failed to
start and silently fell back to in-memory counting, which under PM2 clustering
means N× the intended budget.

---

## 6. Run the API as a Windows Service

Node must survive reboots and crashes. Use **NSSM** (simplest) or PM2.

```
nssm install MailDeskAPI "C:\Program Files\nodejs\node.exe" "C:\apps\maildesk\server\index.js"
nssm set MailDeskAPI AppDirectory C:\apps\maildesk\server
nssm set MailDeskAPI AppStdout C:\apps\maildesk\logs\api.log
nssm set MailDeskAPI AppStderr C:\apps\maildesk\logs\api.err.log
nssm set MailDeskAPI Start SERVICE_AUTO_START
nssm start MailDeskAPI
```

NSSM sends a real `CTRL+C`/terminate on stop, which lets the app's graceful
shutdown drain in-flight requests and close Mongo cleanly.

Confirm it is healthy — this must return **200**, and reports `"database":
"connected"`:
```
curl http://127.0.0.1:5015/api/health
```

---

## 7. Reverse proxy and HTTPS (Caddy)

Caddy obtains and renews a Let's Encrypt certificate automatically. Create
`C:\apps\maildesk\Caddyfile`:

```
mail.yourcompany.com {
    encode gzip

    # API and websockets
    handle /api/* {
        reverse_proxy 127.0.0.1:5015
    }
    handle /socket.io/* {
        reverse_proxy 127.0.0.1:5015
    }

    # Static client; React Router owns every other path
    handle {
        root * C:\apps\maildesk\client\dist
        try_files {path} /index.html
        file_server
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
```

Run Caddy as a service too (`nssm install Caddy ...`).

**HTTPS is not optional here.** The session token is sent as a Bearer header; over
plain HTTP it is readable in transit on the network path.

---

## 8. Reaching it from anywhere

Two options. **B is safer for a business server.**

### A — Public IP + port forwarding
Forward TCP **80 and 443** to the server, point an A record at your public IP,
and Caddy handles certificates. Requires a static IP (or DDNS). Your server is
directly exposed, so Windows Firewall should allow only 80/443 inbound — never
27017 (MongoDB) or 5015 (Node) from outside.

### B — Cloudflare Tunnel (recommended)
Install `cloudflared` as a Windows Service. The server makes an **outbound**
connection to Cloudflare, so:
- no open inbound ports,
- no static public IP needed,
- works behind NAT/CGNAT,
- TLS and DDoS protection terminate at Cloudflare,
- you can put access policies in front of the app.

```
cloudflared tunnel login
cloudflared tunnel create maildesk
cloudflared tunnel route dns maildesk mail.yourcompany.com
cloudflared service install
```
Point the tunnel at `http://127.0.0.1:5015` for `/api` and `/socket.io`, and at
Caddy (or a local file server) for the static client.

**Either way**: register `https://mail.yourcompany.com/api/gmail/oauth/callback`
as an authorised redirect URI in the Google Cloud Console, and make
`GOOGLE_REDIRECT_URI` and `FRONTEND_URL` match the public origin exactly. A
mismatch is the most common cause of a failing Gmail connect.

---

## 9. Backups — set this up before go-live

MongoDB is now the only copy of your mail metadata, tasks and audit trail.

Scheduled Task, daily:
```
"C:\Program Files\MongoDB\Tools\100\bin\mongodump.exe" --uri="mongodb://127.0.0.1:27017/maildesk" --out="D:\backups\maildesk\%DATE%"
```
Keep at least 14 days, copy off-machine (a NAS or object storage), and
**rehearse a restore once** — an untested backup is not a backup.

---

## 10. Windows-specific notes

- `npm run check:syntax` is a Node script, so it runs on PowerShell/cmd. The
  earlier `find | xargs` version did not.
- Application code uses no POSIX-only paths, so nothing else needs changing.
- Exclude `C:\apps\maildesk` from real-time antivirus scanning — Defender
  scanning `node_modules` measurably slows startup and file watching.
- Set the server's timezone, and keep `APP_TIMEZONE` matching it. Deadlines and
  business-hours SLA maths are interpreted in `APP_TIMEZONE`.
- Windows Update reboots will restart the service; that is fine, but see the
  queue-durability note in §5.

---

## 11. Go-live checklist

- [ ] `mongosh --eval "db.version()"` reports **7.x**
- [ ] Fresh production secrets generated; `.env` is not in git (it is gitignored)
- [ ] All four migration scripts run
- [ ] `node scripts/encryptExistingTokens.js` reports **0 plaintext token fields** (§3a)
- [ ] `ALLOW_LEGACY_PLAINTEXT_TOKENS=false` in `.env`, and the API restarted since (§3a)
- [ ] `PASSWORD_MIN_LENGTH` left at its default of 12, or raised — never lowered (§3b)
- [ ] `GET /api/health` returns 200 with `"database":"connected"`
- [ ] HTTPS works and HTTP redirects to it
- [ ] `FRONTEND_URL`, `VITE_API_URL` and `GOOGLE_REDIRECT_URI` all use the same public origin
- [ ] Gmail connect completes end to end and mail syncs **(never yet tested against a real mailbox)**
- [ ] MongoDB and Node ports are not reachable from the internet
- [ ] Backup task scheduled **and one restore rehearsed**
- [ ] Both services set to auto-start; server rebooted once to prove it comes back

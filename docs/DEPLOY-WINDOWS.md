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
- [ ] `GET /api/health` returns 200 with `"database":"connected"`
- [ ] HTTPS works and HTTP redirects to it
- [ ] `FRONTEND_URL`, `VITE_API_URL` and `GOOGLE_REDIRECT_URI` all use the same public origin
- [ ] Gmail connect completes end to end and mail syncs **(never yet tested against a real mailbox)**
- [ ] MongoDB and Node ports are not reachable from the internet
- [ ] Backup task scheduled **and one restore rehearsed**
- [ ] Both services set to auto-start; server rebooted once to prove it comes back

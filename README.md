# MediaSphere

All-in-one, high-performance web platform that extracts, processes, transcribes, trims, and converts public media content from across the internet — YouTube, TikTok, Instagram, X (Twitter), Reddit, Pinterest, Facebook, LinkedIn, Twitch, and Vimeo.

Strict URL sandboxing · client-side tracking removal · background job queues · real-time WebSocket progress · server-side FFmpeg · AI transcript generation.

See [`ROADMAP.md`](ROADMAP.md) for the audited architecture, verified limitations, prioritized backlog, and GitHub Project handover instructions. Advertised capabilities are not all production-verified.

## Architecture

```
[ Next.js 15 Frontend ] ──(WS/WSS progress)─┐
        │ (POST /api/v1/extract)            │
        ▼                                   │
[ FastAPI Gateway ] ────────────────────────┤
        │ (Dispatch Job)                    │
        ▼                                   │
[ Redis Broker ] ───────────────────────────┤
        │ (Consume Job)                     │
        ▼                                   │
[ Celery / Thread Workers ] ────────────────┘
  ├── Link Sanitizer & SSRF Sandbox
  ├── yt-dlp Extractor
  ├── FFmpeg Pipeline (trim / convert)
  └── Faster-Whisper AI Engine
        │
        ▼
[ Ephemeral Storage (15m TTL) / S3 ]
```

## Quick start (local dev)

### 1. Backend (FastAPI)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

API docs: http://localhost:8000/docs · Health: http://localhost:8000/api/v1/health

### 2. Frontend (Next.js 15)

```bash
npm install
npm run dev
```

Open http://localhost:3000 (`next.config.js` automatically proxies `/api/v1/*` and `/ws/*` to `API_PROXY_TARGET`, defaulting to `http://127.0.0.1:8000`).

### 3. Full stack (Docker Compose)

```bash
docker compose up --build
```

- Web: http://localhost:3000
- API: http://localhost:8000/docs
- Celery Worker: `celery -A app.celery_app worker`
- Redis: `localhost:6379`

### 4. Vercel deployment

Importing this repository into Vercel works out of the box:
- **With external FastAPI backend**: set `API_PROXY_TARGET=https://your-api-host.example.com` in Vercel project environment variables.
- **Standalone zero-config preview**: when deployed on Vercel without `API_PROXY_TARGET`, built-in Next.js App Router `/api/v1/*` serverless fallback routes handle URL sanitization, SSRF validation, preview extraction, job lifecycle, transcripts/SRT, and downloads automatically.

## Running tests

```bash
# Backend unit + API lifecycle tests
.venv/bin/python -m unittest discover -s backend/tests -v

# Frontend security tests, lint, TypeScript & production build check
npm test && npm run lint && npm run typecheck && npm run build

# Shell script checks
bash -n setup_project_board.sh && shellcheck setup_project_board.sh
```

These same checks run automatically on every pull request and on pushes to `main`
via [`.github/workflows/ci.yml`](.github/workflows/ci.yml). CI needs no secrets and
makes no live provider calls: the backend suite sets `MEDIASPHERE_TEST_MOCK=true`.
Use `npm run lint:fix` to apply autofixable lint changes locally.

## API reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/health` | Service health check |
| POST | `/api/v1/extract` | Sanitize + return preview cards |
| POST | `/api/v1/jobs` | Dispatch single processing job |
| POST | `/api/v1/batch` | Dispatch batch jobs (max 20) |
| GET | `/api/v1/jobs` | List jobs (including transcripts) |
| GET | `/api/v1/jobs/{id}` | Job detail (+ transcript/SRT) |
| DELETE | `/api/v1/jobs/{id}` | Cancel active job |
| GET | `/api/v1/jobs/{id}/download` | Stream or download (`?download=true`) finished file |
| GET | `/api/v1/jobs/{id}/transcript` | Transcript / summary / SRT |
| WS | `/ws/queue` | Multi-subscriber live job progress + 2s heartbeat |

## Security (Module A)

- Strips tracking vectors: `utm_*`, `igsh`, `si`, `fbclid`, `t`, `ref_src`, `feature`, `is_from_webapp`, `sender_device`, `gclid`, `msclkid`, `yclid`, …
- Enforces `https://` only
- Strict whitelist regex across canonical, mobile (`m.`, `mobile.`, `old.`), and short-link (`youtu.be`, `vm.tiktok.com`, `vt.tiktok.com`, `pin.it`, `redd.it`, `fb.watch`) domains
- Blocks IPv4 & IPv6 SSRF ranges: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, cloud metadata IPs


### Outbound network safety and compatibility

Provider, relay, subtitle and media requests use guarded HTTP transports. They
reject credentials, non-HTTP(S) schemes and non-public addresses, validate every
DNS answer at connection time, pin the connection to a validated answer, and
recheck redirects. The Next.js image optimizer does not accept remote images.
The configured API reverse proxy and administrator-configured Whisper model are
trusted infrastructure and are outside this outbound-media guard. Network-level
egress restrictions remain recommended as defense in depth.

FFmpeg is restricted to staged local media and an input format/protocol
allowlist. The Node pipeline stages unencrypted, finite MPEG-TS HLS playlists,
including nested variants, through the guarded transport; encrypted, live,
byte-range, fMP4 and separate-rendition HLS playlists fail closed. The backend
uses one direct HTTP media stream (no adaptive multi-stream merging or HLS), so
some resolutions or providers may not be available. yt-dlp proxies (including
`YTDLP_PROXY` and `HTTPS_PROXY`) are disabled because remote proxy resolution
cannot be pinned, and the yt-dlp dependency is pinned because the guard uses its
networking integration. Review and test that integration before upgrading it.

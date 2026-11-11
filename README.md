# MediaSphere

All-in-one, high-performance web platform that extracts, processes, transcribes, trims, and converts public media content from across the internet — YouTube, TikTok, Instagram, X (Twitter), Reddit, Pinterest, Facebook, LinkedIn, Twitch, and Vimeo.

Strict URL sandboxing · client-side tracking removal · background job queues · real-time WebSocket progress · server-side FFmpeg · AI transcript generation.

## Architecture

```
[ Next.js 15 Frontend ] ──(WSS progress)──┐
        │ (POST /api/v1/extract)          │
        ▼                                 │
[ FastAPI Gateway ] ──────────────────────┤
        │ (Dispatch Job)                  │
        ▼                                 │
[ Redis Broker ] ─────────────────────────┤
        │ (Consume Job)                   │
        ▼                                 │
[ Celery / Thread Workers ] ──────────────┘
  ├── Link Sanitizer & SSRF Sandbox
  ├── yt-dlp Extractor
  ├── FFmpeg Pipeline (trim / convert)
  └── Faster-Whisper AI Engine
        │
        ▼
[ Ephemeral Storage / S3 ]
```

## Quick start (local dev)

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

API docs: http://localhost:8000/docs · Health: http://localhost:8000/api/v1/health

### Frontend

```bash
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Open http://localhost:3000

### Full stack (Docker)

```bash
docker compose up --build
```

- Web: http://localhost:3000
- API: http://localhost:8000/docs
- Redis: localhost:6379

## API reference

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/extract` | Sanitize + return preview cards |
| POST | `/api/v1/jobs` | Dispatch single processing job |
| POST | `/api/v1/batch` | Dispatch batch jobs (max 20) |
| GET | `/api/v1/jobs` | List jobs |
| GET | `/api/v1/jobs/{id}` | Job detail (+ transcript) |
| DELETE | `/api/v1/jobs/{id}` | Cancel job |
| GET | `/api/v1/jobs/{id}/download` | Download finished file |
| GET | `/api/v1/jobs/{id}/transcript` | Transcript / summary / SRT |
| WS | `/ws/queue` | Live job progress (200ms pushes) |

## Security (Module A)

- Strips tracking vectors: `utm_*`, `igsh`, `si`, `fbclid`, `t`, `ref_src`, `feature`, `is_from_webapp`, `sender_device`, …
- `https://` only
- Strict whitelist regex: youtube.com, youtu.be, tiktok.com, instagram.com, x.com, twitter.com, reddit.com, pinterest.com, vimeo.com, twitch.tv, facebook.com, linkedin.com
- Blocks SSRF ranges: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, metadata IP

## Processing (Module C)

- Trim: `ffmpeg -ss -to -c copy` (stream-copy) with frame-accurate transcode fallback
- Convert: MP4 / WebM / MP3 / WAV
- AI: Faster-Whisper (`small`/`large-v3`) → `.srt`, raw transcript, key-point summary
- Storage: ephemeral disk with 15-min TTL cleanup (`processor.cleanup_old_files`, run via CRON)

## Frontend tabs

1. **Extraction Workspace** — paste bar, auto-paste, instant Green/Red validation badges, resolution/format/trim/AI controls, preview grid
2. **Active Downloads** — live queue board (Queued → Extracting → Trimming → Transcribing → Ready), % bars, MB/s, ETA, cancel
3. **Completed** — card grid with HTML5 players, Save File, Drive/Dropbox export, Copy Transcript, .SRT download
4. **History & Collections** — IndexedDB table, platform filter chips, search, re-extract

## End-to-end scenario

Paste 3 URLs (YouTube + TikTok + Instagram with tracking params) → frontend sanitizer cleans them instantly → `POST /api/v1/extract` returns preview cards → pick 1080p MP4 + trim 01:15–02:30 + AI on → jobs #101–103 dispatched → WSS pushes live progress → Completed tab shows players + transcript drawer → Save to Device + IndexedDB history entry with platform badges.

## Tech stack

- Frontend: Next.js 15, React 19, Tailwind CSS, Lucide, Zustand, native WebSocket (+ socket.io-client dep)
- Backend: FastAPI, Pydantic v2
- Queue: Redis 7 + Celery 5 (thread fallback when Redis unavailable)
- Media/AI: yt-dlp, FFmpeg 6+, Faster-Whisper

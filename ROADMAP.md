# MediaSphere roadmap and repository audit

Audit date: 2026-11-13. Baseline: `ac8c8e4eb1f2238e9230529f4493c77779b5b446` on `main`.

This is a code-level audit and delivery plan, not a claim that every advertised platform works in production. The companion [`setup_project_board.sh`](setup_project_board.sh) creates GitHub issues for every **High/Medium task that is not Done** and adds them to the existing user project `kennedy-blip/#3`.

## Current architecture

- **Web:** Next.js 15 App Router, React 19, TypeScript, Tailwind, Zustand, and browser IndexedDB history. `app/page.tsx` composes extraction, active/completed jobs, history, and batch components.
- **API client and progress:** `lib/api.ts` uses same-origin routes by default. `lib/socket.ts` attempts native WebSocket progress and falls back to HTTP polling. `socket.io-client` is declared but not used.
- **Dedicated backend:** FastAPI routes in `backend/app/routes.py`; Pydantic validation; URL sanitization; yt-dlp extraction; FFmpeg processing; platform captions/Faster-Whisper; daemon threads or Celery/Redis workers. Job snapshots are held in process memory and optionally Redis.
- **Next.js execution path:** App Router routes under `app/api/v1/` call `lib/serverlessEngine.ts`, with metadata/provider resolution in `lib/realExtractor.ts` and `lib/youtubeProviders.ts`, FFmpeg in `lib/realProcessor.ts`, and caption/lyric/extractive-summary logic in `lib/realTranscriber.ts`. Jobs use a global map plus a `/tmp` JSON snapshot; media is cached in `/tmp`.
- **Routing:** `next.config.js` proxies API and WebSocket paths when a backend target is configured. Without a target on Vercel, the Node routes handle API requests; there is no equivalent Node WebSocket endpoint.
- **Deployment:** Docker Compose defines web, API, worker, Redis, and a shared media volume. A Vercel project named `media-sphere` is linked to this repository and reports a READY production deployment. Its observed production commit `517834103f9ab4c02c261478652c04729f51b8ea` is **two commits ahead** of the audited `main`; automatic Git deployments are disabled in the observed project settings. Production readiness is not an end-to-end media test.

```text
Browser UI / Zustand / IndexedDB
        |
        | same-origin API, or configured public API base
        v
Next.js routing / optional backend proxy
        |                              |
        v                              v
FastAPI gateway                 Next.js Node routes
        |                              |
threads or Celery/Redis         global map + /tmp snapshots
        |                              |
yt-dlp / FFmpeg / Whisper       provider relays / FFmpeg / captions
        |                              |
shared media volume             instance-local /tmp media cache
```

## Verification performed

| Check | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Passed |
| `npx tsc --noEmit --incremental false` | Passed |
| `npm run build` | Passed with Next.js 15.5.29 |
| Backend `unittest` suite in an isolated Python 3.11 environment | 9 tests passed; lifecycle tests use `MEDIASPHERE_TEST_MOCK=true`, plus a real local FFmpeg trim/conversion smoke test |
| `npm run lint` | Initially not a usable CI gate (no ESLint config; Next.js prompted interactively). Now configured via `eslint.config.mjs` and passing; the one error it surfaced (dead `PipedResponse` interface) was removed. |
| Serverless cancellation probe with a local cached-file fixture | A cancelled job still resolved through `ensureDownloadableFile` |
| Serverless stale-snapshot probe | An older `ready` disk snapshot overwrote a newer cancelled state |
| Serverless option-validation probe | Numeric `resolution` raised `TypeError`, rather than returning the intended validation result |
| Stream URL normalization probe | `http://127.0.0.1/internal` was accepted as a stream URL |
| Local FFmpeg trim probe | Requested `1s -> 3s` produced about `2.04s`; trim semantics need explicit tests |
| TypeScript SRT probe | `1.9999s` emitted milliseconds `1000`, an invalid SRT millisecond value |

Live third-party extraction, real Redis/Celery distributed execution, Docker startup, browser accessibility, and deployed end-to-end downloads were **not** validated. No application behavior was changed by this audit.

The board script passed Bash syntax and ShellCheck checks. Its live `--dry-run` resolved the real project/repository and planned 14 issues without writing to GitHub. A local GitHub CLI double also exercised field/issue/item creation, pagination, rerun deduplication, preservation of edited board values, and recovery after a simulated partial failure. Live GitHub write mutations remain deferred for the reviewed script execution.

## Roadmap

Priority describes delivery risk. Status is the repository/project workflow state, not proof of production readiness. Done rows record already verified baseline work and do not need new issues.

| ID | Actionable task and next step | Priority | Status | Evidence / completion condition |
| --- | --- | --- | --- | --- |
| H01 | Reconcile the two deployment-only provider commits with `main` before making more provider changes; review, integrate through a PR, and deploy the reviewed revision. | High | Todo | Production is ahead by commits `383163e` and `5178341`; deployed SHA must match the reviewed release. |
| H02 | Centralize outbound SSRF protection across initial URLs, redirects, DNS answers, relay-returned streams, and FFmpeg/HLS inputs in both runtimes. | High | Todo | `normalizeHttpUrl` accepts private HTTP targets; source-domain allowlisting alone is insufficient. Add redirect/DNS/HLS regression fixtures. |
| H03 | Bind jobs, listings, progress, transcripts, and downloads to an authenticated or anonymous session owner; enforce authorization server-side. | High | Todo | Backend listings are global; Node state/cache is shared per instance and reconstructable IDs are not access credentials. Two-client isolation tests must pass. |
| H04 | Replace instance-local job coordination with durable atomic state; make cancellation terminal and gate downloads on authorized `ready` state. | High | Todo | Cancelled-download and stale-ready resurrection bugs reproduced locally. Cold-start/restart/concurrent-cancel tests must pass. |
| H05 | Add request, concurrency, duration, byte, disk, and wall-clock budgets, with bounded queues and cleanup of abandoned work. | High | Todo | A 20-URL batch is not a resource budget; processing timeouts can exceed route budgets. Test overload, expiry, and partial failure. |
| H06 | Unify request validation and enforce the promised media-processing contract, including trim bounds, FFmpeg availability, container, and resolution behavior. | High | Todo | Non-string input can become HTTP 400; missing backend FFmpeg can silently rename an unprocessed file. Both engines must reject or explicitly report unsupported work. |
| M01 | Add noninteractive CI for frontend type/build/lint, backend tests, Node route/state tests, and deployment packaging. | Medium | In Progress | ESLint flat config + `.github/workflows/ci.yml` landed (frontend lint/type/build, backend suite, ShellCheck). Still needed: Node route/state tests and Docker packaging checks. |
| M02 | Make transcript/SRT provenance truthful; distinguish captions, speech-to-text, lyrics, and description fallback, and fix timestamp formatting/windowing. | Medium | Todo | Descriptions/lyrics can be presented as transcripts; fabricated description cues are not speech subtitles; Node has no Whisper path. |
| M03 | Make batch and “dispatch all” operations preserve per-item options and partial successes, with clear skipped/failed results. | Medium | Todo | `dispatchAll` uses `Promise.all` and can hide created jobs when one request fails; the drawer silently drops invalid URLs before submission. |
| M04 | Harden browser job recovery and history: restore the current session's pending jobs, merge updates safely, and expose cancel/retry/storage failures. | Medium | Todo | Initial list fetching can race polling; active jobs are not restored from local history; several UI actions swallow errors. |
| M05 | Implement actual Drive/Dropbox export and the documented storage option, or remove/relabel unsupported controls and claims. | Medium | Todo | Current cloud buttons only open home pages; S3 variables are documented but no S3 implementation exists. |
| M06 | Write architecture, environment, deployment, API-parity, security, and operations documentation from verified behavior. | Medium | Todo | Document both engines, WebSocket limitations, model/cache requirements, best-effort TTL, Node version differences, CORS, and release procedure. |
| M07 | Establish a provider capability/health matrix and fixture-based tests for every advertised platform; configure provider allowlists and failover budgets. | Medium | Todo | Many hardcoded third-party relays and dynamic instances exist; platform advertised support is not verified. Cancel losing requests and surface actionable failures. |
| M08 | Finish this handover: review the PR, merge it, dry-run and execute the board script, then verify fields/issues/statuses and record issue links. | Medium | In Progress | Roadmap and script are prepared; GitHub mutations are intentionally deferred until review. |
| L01 | Implement collections and preserve original job options in history, or rename the collections UI to match current behavior. | Low | Todo | History supports search/filter/delete/re-extract only; re-extraction forces subtitles and summary on. |
| L02 | Improve keyboard accessibility, dialog focus/Escape behavior, control names, progress semantics, and narrow-screen layouts. | Low | Todo | Batch drawer lacks dialog/focus management; icon-only actions and custom tabs/progress need accessible semantics. |
| L03 | Add licensing, contribution, security-reporting, and issue/PR template documentation after the owner chooses a license. | Low | Todo | No LICENSE, CONTRIBUTING, SECURITY, or GitHub templates are tracked. Do not assume a license. |
| L04 | Clean reproducibility and maintenance gaps: deterministic Docker installs, configured ESLint, unused dependencies, and IndexedDB connection cleanup. | Low | Todo | Docker uses `npm install`; `socket.io-client` is unused; IndexedDB helpers do not close connections. |
| D01 | Existing UI, API routes, backend pipeline, and deployment configuration baseline. | Low | Done | Implemented in the audited tree; production feature correctness remains subject to the tasks above. |
| D02 | Baseline build and offline backend verification. | Low | Done | TypeScript and production build passed; all 9 backend tests passed in the isolated environment. |

## Delivery order

1. **Establish the release baseline:** H01, then M01/M06 so changes are tested and documented against the revision actually deployed.
2. **Secure public execution:** H02 and H03, followed by H04 and H05. Do not treat URL allowlisting, random-looking IDs, or `/tmp` as security boundaries.
3. **Make core results trustworthy:** H06, M02, M03, and M07, with deterministic media fixtures before live-provider smoke tests.
4. **Complete the experience:** M04, M05, then the Low-priority usability and maintenance work.
5. **Handover:** M08 runs alongside the work. The setup script is safe to rerun after partial failures; it reuses marker-matched issues and preserves existing issue bodies and board values.

## Project board contract

- Owner: `@kennedy-blip`; existing Project number: `3`; repository: `kennedy-blip/Media-sphere`.
- Custom single-select `Priority`: `High`, `Medium`, `Low`.
- Existing single-select `Status`: `Todo`, `In Progress`, `Done`.
- New work starts in `Todo`; M08 starts in `In Progress`.
- Issue titles use stable prefixes such as `[MS-H02]`; bodies contain a hidden roadmap marker for reliable reuse.
- The script creates **14 issues**: H01–H06 and M01–M08. Low-priority backlog items remain documented here until promoted; Done rows are not recreated as issues.

See the script header for authentication requirements, dry-run usage, and rerun behavior. Never put GitHub tokens or other credentials in the script, issue bodies, or command arguments.

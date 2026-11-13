#!/usr/bin/env bash
# MediaSphere GitHub Project handover.
#
# Target: existing Project #3 owned by @kennedy-blip and this repository only.
# Usage:
#   bash setup_project_board.sh --dry-run   # authenticated reads; no GitHub writes
#   bash setup_project_board.sh             # create/reuse issues and populate board
#
# Requirements: Bash, GitHub CLI (gh), jq, and an authenticated GitHub account
# with repository issue-write access and write access to the user-owned project.
# For a classic PAT, gh's `repo` and `project` scopes are needed. If using another
# token type, ensure it grants repository issue writes and write access to this
# user-owned project. Authentication is handled by gh; never put tokens here.
#
# This script uses `gh api graphql` for Projects v2 so it also works with older
# gh releases that do not yet include the `gh project` subcommand. GraphQL input
# schemas were checked against GitHub; the read-only path was exercised with gh
# 2.23.0. Live write commands are intentionally not executed during preparation.
#
# Rerun behavior: stable title prefixes/body markers reuse existing issues, even
# closed ones. Existing issue bodies and existing board values are preserved;
# missing Priority/Status values are filled. Do not run copies concurrently.
# A failure after a remote write can be retried; this is not a transaction.

# GraphQL $variables are intentionally single-quoted for GitHub, not Bash.
# shellcheck disable=SC2016

set -euo pipefail

readonly PROJECT_OWNER="kennedy-blip"
readonly REPO_NAME="Media-sphere"
readonly REPO="kennedy-blip/Media-sphere"
readonly PROJECT_NUMBER=3
DRY_RUN=false

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=true ;;
  -h|--help) usage; exit 0 ;;
  *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then
  printf 'Only one optional argument is supported: --dry-run\n' >&2
  exit 2
fi

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || die "GitHub CLI is required: https://cli.github.com/"
command -v jq >/dev/null 2>&1 || die "jq 1.6+ is required for JSON parsing."
gh auth status --hostname github.com >/dev/null 2>&1 || \
  die "Authenticate first with: gh auth login --hostname github.com --git-protocol https"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
: > "$WORK_DIR/fields.jsonl"
: > "$WORK_DIR/issues.jsonl"
: > "$WORK_DIR/items.jsonl"

gql() {
  local query="$1"
  shift
  gh api graphql -f query="$query" "$@"
}

BASE_QUERY='
query($owner:String!, $repo:String!, $number:Int!) {
  user(login:$owner) {
    projectV2(number:$number) { id title url closed }
  }
  repository(owner:$owner, name:$repo) {
    id nameWithOwner url hasIssuesEnabled
  }
}'
gql "$BASE_QUERY" -f owner="$PROJECT_OWNER" -f repo="$REPO_NAME" -F number="$PROJECT_NUMBER" \
  > "$WORK_DIR/base.json"

PROJECT_ID="$(jq -r '.data.user.projectV2.id // empty' "$WORK_DIR/base.json")"
PROJECT_TITLE="$(jq -r '.data.user.projectV2.title // empty' "$WORK_DIR/base.json")"
PROJECT_URL="$(jq -r '.data.user.projectV2.url // empty' "$WORK_DIR/base.json")"
[[ -n "$PROJECT_ID" ]] || die "Project #$PROJECT_NUMBER was not found for @$PROJECT_OWNER."
[[ "$(jq -r '.data.user.projectV2.closed' "$WORK_DIR/base.json")" == "false" ]] || \
  die "Project #$PROJECT_NUMBER is closed; reopen it before running this script."
[[ "$(jq -r '.data.repository.nameWithOwner // empty' "$WORK_DIR/base.json")" == "$REPO" ]] || \
  die "Repository identity check failed for $REPO."
[[ "$(jq -r '.data.repository.hasIssuesEnabled' "$WORK_DIR/base.json")" == "true" ]] || \
  die "GitHub Issues are disabled for $REPO."

printf 'Target: %s | Project #%s: %s\n' "$REPO" "$PROJECT_NUMBER" "$PROJECT_TITLE"
printf 'Project URL: %s\n' "$PROJECT_URL"

FIELDS_QUERY='
query($owner:String!, $number:Int!, $cursor:String) {
  user(login:$owner) {
    projectV2(number:$number) {
      fields(first:100, after:$cursor) {
        nodes {
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}'
ISSUES_QUERY='
query($owner:String!, $repo:String!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    issues(first:100, after:$cursor, orderBy:{field:CREATED_AT, direction:ASC}) {
      nodes { id number title body url state }
      pageInfo { hasNextPage endCursor }
    }
  }
}'
ITEMS_QUERY='
query($owner:String!, $number:Int!, $cursor:String) {
  user(login:$owner) {
    projectV2(number:$number) {
      items(first:100, after:$cursor) {
        nodes {
          id
          content {
            __typename
            ... on Issue { id number repository { nameWithOwner } }
          }
          priority: fieldValueByName(name:"Priority") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          status: fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}'

load_pages() {
  # load_pages <fields|issues|items> <query> <jq-path-to-connection>
  local kind="$1" query="$2" path="$3" cursor="" page has_next
  local -a args
  : > "$WORK_DIR/$kind.jsonl"
  while true; do
    args=(-f owner="$PROJECT_OWNER")
    if [[ "$kind" == "issues" ]]; then
      args+=(-f repo="$REPO_NAME")
    else
      args+=(-F number="$PROJECT_NUMBER")
    fi
    if [[ -n "$cursor" ]]; then
      args+=(-f cursor="$cursor")
    fi
    page="$(gql "$query" "${args[@]}")"
    printf '%s\n' "$page" | jq -c "$path.nodes[]" >> "$WORK_DIR/$kind.jsonl"
    has_next="$(printf '%s\n' "$page" | jq -r "$path.pageInfo.hasNextPage")"
    [[ "$has_next" == "true" ]] || break
    cursor="$(printf '%s\n' "$page" | jq -r "$path.pageInfo.endCursor // empty")"
    [[ -n "$cursor" ]] || die "GitHub returned an incomplete $kind pagination cursor."
  done
}

load_fields() { load_pages fields "$FIELDS_QUERY" '.data.user.projectV2.fields'; }
load_fields
load_pages issues "$ISSUES_QUERY" '.data.repository.issues'
load_pages items "$ITEMS_QUERY" '.data.user.projectV2.items'

find_named_field() {
  jq -s --arg name "$1" '[.[] | select(.name == $name)]' "$WORK_DIR/fields.jsonl"
}

require_select_options() {
  # require_select_options <field-json> <field-name> <option>...
  local field="$1" name="$2" option
  shift 2
  [[ "$(printf '%s\n' "$field" | jq -r '.dataType')" == "SINGLE_SELECT" ]] || \
    die "Field '$name' exists but is not SINGLE_SELECT. Resolve the conflict in Project settings; no field was replaced."
  for option in "$@"; do
    printf '%s\n' "$field" | jq -e --arg option "$option" \
      'any(.options[]?; .name == $option)' >/dev/null || \
      die "Field '$name' is missing option '$option'. Add it in Project settings and rerun; existing options were not replaced."
  done
}

priority_matches="$(find_named_field Priority)"
priority_count="$(printf '%s\n' "$priority_matches" | jq 'length')"
[[ "$priority_count" -le 1 ]] || die "Multiple Priority fields exist; resolve the ambiguity manually."
priority_field="$(printf '%s\n' "$priority_matches" | jq -c '.[0] // empty')"
if [[ -n "$priority_field" ]]; then
  require_select_options "$priority_field" Priority High Medium Low
fi

status_matches="$(find_named_field Status)"
[[ "$(printf '%s\n' "$status_matches" | jq 'length')" -eq 1 ]] || \
  die "Expected exactly one built-in Status field."
status_field="$(printf '%s\n' "$status_matches" | jq -c '.[0]')"
require_select_options "$status_field" Status Todo "In Progress" Done
STATUS_FIELD_ID="$(printf '%s\n' "$status_field" | jq -r '.id')"
TODO_ID="$(printf '%s\n' "$status_field" | jq -r '.options[] | select(.name == "Todo") | .id')"
IN_PROGRESS_ID="$(printf '%s\n' "$status_field" | jq -r '.options[] | select(.name == "In Progress") | .id')"
DONE_ID="$(printf '%s\n' "$status_field" | jq -r '.options[] | select(.name == "Done") | .id')"

# ID|Priority|initial Status|issue title (without stable prefix)
TASKS=(
  'H01|High|Todo|Reconcile deployment-only provider changes with main'
  'H02|High|Todo|Enforce SSRF protection on every outbound media request'
  'H03|High|Todo|Isolate and authorize jobs, downloads, transcripts, and progress'
  'H04|High|Todo|Make job state durable and cancellation race-safe'
  'H05|High|Todo|Bound API abuse and media-processing resource usage'
  'H06|High|Todo|Enforce consistent input and media-processing contracts'
  'M01|Medium|Todo|Add noninteractive CI and cross-runtime regression coverage'
  'M02|Medium|Todo|Make transcript and SRT provenance truthful and correct'
  'M03|Medium|Todo|Preserve batch options and partial successes'
  'M04|Medium|Todo|Harden browser job recovery, history, and error feedback'
  'M05|Medium|Todo|Implement or honestly relabel cloud export and storage'
  'M06|Medium|Todo|Document architecture, environments, deployment, and operations'
  'M07|Medium|Todo|Verify provider capabilities and bound failover behavior'
  'M08|Medium|In Progress|Review and verify the project-board handover'
)

issue_body() {
  case "$1" in
    H01) cat <<'EOF'
## Description
The observed Vercel production deployment is commit `517834103f9ab4c02c261478652c04729f51b8ea`, two commits ahead of audited `main` (`ac8c8e4`). Review and reconcile the deployment-only provider work before layering more fixes on an outdated baseline.

## Evidence
GitHub compare reports `383163e` and `5178341` ahead of `main`, changing `lib/realExtractor.ts` and `lib/youtubeProviders.ts`. Vercel Git-triggered deployments are disabled in the observed project settings.

## Acceptance criteria
- [ ] Review both commits and decide explicitly what belongs in `main`.
- [ ] Integrate the approved changes through a reviewable PR without losing newer fixes.
- [ ] Run frontend checks and deterministic provider tests on the reconciled revision.
- [ ] Deploy that reviewed revision and record its SHA and smoke-test results.
- [ ] Document whether releases are manual or Git-triggered; do not assume a READY deployment proves media extraction works.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    H02) cat <<'EOF'
## Description
Source URL allowlisting does not protect the subsequent network requests made by relays, fetch redirects, yt-dlp, FFmpeg, or HLS playlist processing. Centralize egress validation for both execution paths.

## Evidence
`lib/youtubeProviders.ts::normalizeHttpUrl` accepts `http://127.0.0.1/internal`. `lib/realProcessor.ts` follows redirects and passes remote inputs to FFmpeg. Initial sanitizers do not validate every resolved destination or media segment.

## Acceptance criteria
- [ ] Reject non-HTTPS destinations unless an explicitly reviewed exception is required; block loopback, private, link-local, reserved, and metadata addresses.
- [ ] Validate every redirect hop and resolved DNS answer, with protection against DNS rebinding at connection time.
- [ ] Apply the same policy to relay responses, caption fetches, FFmpeg remote inputs, and HLS segments/keys.
- [ ] Use a reviewed provider allowlist and bounded response sizes/timeouts.
- [ ] Add offline redirect, DNS, IPv4/IPv6, and HLS regression tests for both runtimes.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    H03) cat <<'EOF'
## Description
Jobs and artifacts need an owner boundary. A random-looking or reconstructable job ID must not become a public capability for another user's media, transcript, or queue activity.

## Evidence
FastAPI `list_jobs`, job detail, download, transcript, and WebSocket snapshots are not session-scoped. The Node engine uses a shared global map, instance-local disk snapshots/cache, and IDs containing encoded request parameters.

## Acceptance criteria
- [ ] Choose and document an authenticated or anonymous-session ownership model.
- [ ] Bind job creation to that owner and enforce it on detail, list, cancel, download, transcript, and progress feeds.
- [ ] Return consistent not-found/forbidden behavior without leaking existence or metadata.
- [ ] Ensure content-addressed media reuse does not leak another owner's job metadata or text outputs.
- [ ] Add two-client isolation tests, including cold-start reconstruction and WebSocket updates.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    H04) cat <<'EOF'
## Description
Replace ad-hoc global-map plus `/tmp` snapshot synchronization with durable, atomic job transitions. Cancellation must remain terminal, and downloads must require an authorized ready artifact.

## Evidence
Local probes reproduced both failures: `ensureDownloadableFile` resolved a cached file for a cancelled job, and `syncFromDisk` let an older ready snapshot overwrite a newer cancelled state. Backend Redis reads/writes also need a reviewed concurrency protocol.

## Acceptance criteria
- [ ] Define one durable state store and legal status transitions for each runtime.
- [ ] Make updates atomic/versioned so stale workers cannot overwrite cancellation or newer progress.
- [ ] Reject downloads unless the job is ready, owned by the caller, and its artifact exists.
- [ ] Propagate cancellation to active download/FFmpeg work and clean partial artifacts.
- [ ] Test concurrent cancel/complete, process restart, multiple isolates/workers, and expired artifacts.

Depends on the ownership decision in H03.
Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    H05) cat <<'EOF'
## Description
The public API needs enforceable work and resource budgets, not just a maximum URL count. Prevent a small number of requests from exhausting CPU, disk, memory, provider quota, or function duration.

## Evidence
There is no application rate/concurrency limit. A batch can start 20 jobs; the workspace can dispatch 20 single jobs concurrently. Backend FFmpeg calls allow 600 seconds while Node routes declare 180 seconds and FFmpeg allows 110 seconds per pass.

## Acceptance criteria
- [ ] Define per-owner/IP rate, active-job, queue, duration, downloaded-byte, output-byte, and disk budgets.
- [ ] Enforce request-body and URL-length limits before expensive work.
- [ ] Align deadlines across routes, providers, downloads, and FFmpeg; leave cleanup headroom.
- [ ] Return clear 429/413/422 or job-failure responses and clean abandoned/partial files.
- [ ] Add overload, timeout, expiry, and restart tests showing work cannot accumulate without bound.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    H06) cat <<'EOF'
## Description
Unify validation and make processing outcomes match the requested format, resolution, and trim window. Unsupported processing must fail clearly rather than silently returning renamed source bytes.

## Evidence
Node `validateJobOptions({resolution:123})` raises TypeError and the route reports invalid JSON. Backend `run_job` renames the raw file when FFmpeg is absent. A local FFmpeg probe requesting 1s-to-3s produced about 2.04s, so trim semantics need explicit coverage.

## Acceptance criteria
- [ ] Share equivalent validation fixtures across Pydantic, Node routes, and UI; malformed types return 422.
- [ ] Validate trim syntax, ordering, source duration, and maximum clip length consistently.
- [ ] Never mark untrimmed/unconverted output ready when FFmpeg is required but unavailable.
- [ ] Verify output container/codecs and duration; define whether resolution is a ceiling or exact target and disclose fallbacks.
- [ ] Add real local FFmpeg tests for audio/video, open-ended trims, fractional boundaries, and missing-binary failure.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    M01) cat <<'EOF'
## Description
Add a deterministic CI gate covering both execution paths and deployment packaging. Current backend coverage is useful but mostly mock lifecycle coverage, and frontend lint is not configured.

## Evidence
No GitHub workflow files are tracked. `npm run lint` enters an interactive ESLint setup prompt. TypeScript/build and all 9 offline backend tests passed during the audit.

## Acceptance criteria
- [ ] Configure noninteractive ESLint and a lockfile-based frontend install/type/lint/build job.
- [ ] Run backend tests with pinned/tested dependencies and local FFmpeg fixtures.
- [ ] Add Node route, state-store, cancellation, validation, and SSRF tests without live media credentials.
- [ ] Check Docker packaging and API contract parity; use Redis/Celery services for distributed-state tests.
- [ ] Document required PR checks and keep flaky live-provider smoke tests separate.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    M02) cat <<'EOF'
## Description
Expose where text and subtitles came from and stop presenting descriptions or approximate lyrics as speech transcripts. Correct timestamp formatting and trim-window behavior.

## Evidence
Both engines can return description text as transcript/SRT. Node can substitute LRCLIB lyrics and has no Faster-Whisper path. A TypeScript probe emitted SRT milliseconds `1000` for 1.9999 seconds.

## Acceptance criteria
- [ ] Add provenance/capability metadata for platform captions, speech-to-text, lyrics, and description fallback.
- [ ] Never fabricate timed speech cues from a description; return an explicit unavailable/fallback state.
- [ ] Verify lyric matching before labeling it, and distinguish extractive summaries from generative AI.
- [ ] Fix millisecond rollover, cue ordering, clipping, and empty-window behavior in both engines.
- [ ] Add caption/VTT/LRC/SRT fixtures and document Whisper model download/cache requirements.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    M03) cat <<'EOF'
## Description
Make batch dispatch preserve each card's settings and report partial success without losing track of jobs that were created before another request failed.

## Evidence
`ExtractionWorkspace.dispatchAll` uses Promise.all and only upserts jobs if every request succeeds. BatchDrawer filters invalid URLs before submission and reports only a count of skipped items.

## Acceptance criteria
- [ ] Use per-item outcomes so successful jobs remain visible when another item fails.
- [ ] Preserve per-card resolution, format, trim, subtitles, and summary settings.
- [ ] Show invalid/skipped URLs and server errors with retry actions.
- [ ] Define duplicate-submit behavior and prevent accidental double dispatch while requests are pending.
- [ ] Add UI/API tests for mixed valid/invalid batches and partial network failure.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    M04) cat <<'EOF'
## Description
Harden client state recovery and surface failures instead of silently ignoring them. History should help the current owner recover work without importing global server jobs.

## Evidence
Initial `listJobs().then(setJobs)` can race polling updates. Only ready jobs seen by the feed are recorded locally; active job IDs are not restored after reload. Cancel/retry and IndexedDB failures are often swallowed.

## Acceptance criteria
- [ ] Merge job updates monotonically and prevent stale initial responses from overwriting newer state.
- [ ] Persist and restore the current session's pending job references, respecting H03 ownership.
- [ ] Record terminal outcomes consistently and preserve original processing options.
- [ ] Show cancel/retry/history-storage failures and expired-artifact states with useful recovery actions.
- [ ] Test reload, reconnect, polling overlap, denied storage, and multi-tab behavior.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    M05) cat <<'EOF'
## Description
The completed-job UI implies cloud upload and the README implies S3 storage, but neither is implemented. Decide the supported scope and make controls and documentation truthful.

## Evidence
Drive/Dropbox buttons link to their home pages. `.env.example` lists S3 variables, but no S3 client/upload/signing path exists.

## Acceptance criteria
- [ ] Decide whether cloud export is in scope for the next release.
- [ ] If implemented, use explicit user authorization, upload progress, success/failure states, and tests; never embed credentials in browser code.
- [ ] If not implemented, remove or clearly relabel the controls as external navigation.
- [ ] Implement the documented storage backend or remove its claims/configuration.
- [ ] Document artifact lifetime and what happens when a cached file expires.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    M06) cat <<'EOF'
## Description
Document the actual two-runtime architecture and a reproducible development/deployment/operations path, including capability differences and security boundaries.

## Evidence
README describes one pipeline and zero-config parity, while Node and FastAPI differ in transcription, progress transport, storage, and job persistence. Vercel reports Node 26.x while local/Docker use Node 22. Several implemented environment variables are undocumented.

## Acceptance criteria
- [ ] Add architecture and request/job lifecycle documentation for both execution modes.
- [ ] Provide an environment matrix including API_PROXY_TARGET, BACKEND_URL, NEXT_PUBLIC_API_URL, Redis/Celery, storage, proxy, and Whisper settings.
- [ ] Document WebSocket versus polling, model/network requirements, CORS policy, artifact TTL limitations, and provider restrictions.
- [ ] Verify quickstarts and record supported Node/Python versions and the release/promotion procedure.
- [ ] Link the roadmap and explain which advertised features are implemented versus verified.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    M07) cat <<'EOF'
## Description
Turn advertised multi-platform support into a tested capability matrix and make provider failover observable, configurable, and bounded.

## Evidence
The Node path depends on numerous hardcoded relays and dynamically discovered Piped/Invidious instances. Live extraction was not validated in this audit. Raced requests can continue after a winner is selected, and failures are often collapsed into generic messages.

## Acceptance criteria
- [ ] Publish a per-platform matrix for metadata, video/audio, captions, trimming, and known authentication/public-content limits.
- [ ] Add deterministic provider-response fixtures and an opt-in live smoke suite using authorized public test media.
- [ ] Make provider endpoints/allowlists configurable and review third-party terms and data handling.
- [ ] Bound total failover time and cancel losing requests; expose provider health without leaking sensitive URLs/headers.
- [ ] Define supported fallbacks and actionable errors when no provider can satisfy the requested quality.

Sequence after H01. Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    M08) cat <<'EOF'
## Description
Finish the repository-to-project handover. This issue is created by the setup script itself and tracks the remaining human review and execution verification.

## Evidence
ROADMAP.md and setup_project_board.sh are prepared for review. The script creates/reuses 14 High/Medium issues and targets existing Project #3 owned by @kennedy-blip.

## Acceptance criteria
- [ ] Review the PR diff and confirm the roadmap priorities and issue acceptance criteria.
- [ ] Merge the PR using the repository's normal review process.
- [ ] Pull the merged revision and run `bash setup_project_board.sh --dry-run`, then `bash setup_project_board.sh` with appropriate gh permissions.
- [ ] Verify Priority has High/Medium/Low, all 14 issues are on Project #3, new work is Todo, and this handover item is In Progress.
- [ ] Record execution results and update this item/roadmap to Done when verified.

Roadmap: https://github.com/kennedy-blip/Media-sphere/blob/main/ROADMAP.md
EOF
;;
    *) die "Missing issue body for roadmap task $1." ;;
  esac
}

find_issue() {
  local id="$1"
  jq -s --arg marker "<!-- mediasphere-roadmap:$id:v1 -->" --arg prefix "[MS-$id] " \
    '[.[] | select(((.body // "") | contains($marker)) or (.title | startswith($prefix)))]' \
    "$WORK_DIR/issues.jsonl"
}

find_item() {
  jq -s --arg issue_id "$1" \
    '[.[] | select(.content.__typename == "Issue" and .content.id == $issue_id)]' \
    "$WORK_DIR/items.jsonl"
}

if [[ "$DRY_RUN" == true ]]; then
  if [[ -z "$priority_field" ]]; then
    printf 'WOULD CREATE field Priority (SINGLE_SELECT: High, Medium, Low)\n'
  else
    printf 'REUSE field Priority\n'
  fi
  planned_issues=0
  planned_items=0
  for task in "${TASKS[@]}"; do
    IFS='|' read -r id priority status title <<< "$task"
    matches="$(find_issue "$id")"
    [[ "$(printf '%s\n' "$matches" | jq 'length')" -le 1 ]] || die "Multiple issues match MS-$id; resolve duplicates first."
    issue="$(printf '%s\n' "$matches" | jq -c '.[0] // empty')"
    if [[ -z "$issue" ]]; then
      printf 'WOULD CREATE [MS-%s] %s | Priority=%s | initial Status=%s\n' "$id" "$title" "$priority" "$status"
      planned_issues=$((planned_issues + 1))
      planned_items=$((planned_items + 1))
    else
      item_matches="$(find_item "$(printf '%s\n' "$issue" | jq -r '.id')")"
      [[ "$(printf '%s\n' "$item_matches" | jq 'length')" -le 1 ]] || die "Multiple project items match MS-$id."
      if [[ "$(printf '%s\n' "$item_matches" | jq 'length')" -eq 0 ]]; then
        printf 'REUSE issue; WOULD ADD [MS-%s] %s\n' "$id" "$title"
        planned_items=$((planned_items + 1))
      else
        printf 'REUSE issue and project item [MS-%s] %s\n' "$id" "$title"
      fi
    fi
  done
  printf 'Dry run complete: %s new issues, %s new project items. No GitHub writes performed.\n' "$planned_issues" "$planned_items"
  exit 0
fi

if [[ -z "$priority_field" ]]; then
  CREATE_FIELD_MUTATION='
  mutation($projectId:ID!) {
    createProjectV2Field(input:{
      projectId:$projectId, dataType:SINGLE_SELECT, name:"Priority",
      singleSelectOptions:[
        {name:"High", color:RED, description:"Release blockers and critical correctness/security work"},
        {name:"Medium", color:YELLOW, description:"Important reliability, feature, and documentation work"},
        {name:"Low", color:GREEN, description:"Follow-up polish and maintenance"}
      ]
    }) {
      field { ... on ProjectV2SingleSelectField { id name options { id name } } }
    }
  }'
  gql "$CREATE_FIELD_MUTATION" -f projectId="$PROJECT_ID" >/dev/null
  load_fields
  priority_matches="$(find_named_field Priority)"
  [[ "$(printf '%s\n' "$priority_matches" | jq 'length')" -eq 1 ]] || die "Priority creation could not be verified."
  priority_field="$(printf '%s\n' "$priority_matches" | jq -c '.[0]')"
  require_select_options "$priority_field" Priority High Medium Low
  printf 'Created custom field: Priority\n'
else
  printf 'Reusing custom field: Priority\n'
fi

PRIORITY_FIELD_ID="$(printf '%s\n' "$priority_field" | jq -r '.id')"
HIGH_ID="$(printf '%s\n' "$priority_field" | jq -r '.options[] | select(.name == "High") | .id')"
MEDIUM_ID="$(printf '%s\n' "$priority_field" | jq -r '.options[] | select(.name == "Medium") | .id')"
LOW_ID="$(printf '%s\n' "$priority_field" | jq -r '.options[] | select(.name == "Low") | .id')"

priority_option_id() {
  case "$1" in
    High) printf '%s' "$HIGH_ID" ;;
    Medium) printf '%s' "$MEDIUM_ID" ;;
    Low) printf '%s' "$LOW_ID" ;;
    *) die "Unknown priority: $1" ;;
  esac
}

status_option_id() {
  case "$1" in
    Todo) printf '%s' "$TODO_ID" ;;
    "In Progress") printf '%s' "$IN_PROGRESS_ID" ;;
    Done) printf '%s' "$DONE_ID" ;;
    *) die "Unknown status: $1" ;;
  esac
}

ADD_ITEM_MUTATION='
mutation($projectId:ID!, $contentId:ID!) {
  addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}) {
    item { id }
  }
}'
SET_VALUE_MUTATION='
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
  updateProjectV2ItemFieldValue(input:{
    projectId:$projectId, itemId:$itemId, fieldId:$fieldId,
    value:{singleSelectOptionId:$optionId}
  }) { projectV2Item { id } }
}'
VERIFY_ITEM_QUERY='
query($itemId:ID!) {
  node(id:$itemId) {
    ... on ProjectV2Item {
      priority: fieldValueByName(name:"Priority") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
      status: fieldValueByName(name:"Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }
}'

set_item_select() {
  local item_id="$1" field_id="$2" option_id="$3" result returned_id
  result="$(gql "$SET_VALUE_MUTATION" -f projectId="$PROJECT_ID" -f itemId="$item_id" \
    -f fieldId="$field_id" -f optionId="$option_id")"
  returned_id="$(printf '%s\n' "$result" | jq -r '.data.updateProjectV2ItemFieldValue.projectV2Item.id // empty')"
  [[ "$returned_id" == "$item_id" ]] || die "GitHub did not confirm the field update for item $item_id."
}

created_count=0
reused_count=0
added_count=0
existing_item_count=0

for task in "${TASKS[@]}"; do
  IFS='|' read -r id priority status title <<< "$task"
  body_file="$WORK_DIR/$id.md"
  issue_body "$id" > "$body_file"
  printf '\n<!-- mediasphere-roadmap:%s:v1 -->\n' "$id" >> "$body_file"

  matches="$(find_issue "$id")"
  [[ "$(printf '%s\n' "$matches" | jq 'length')" -le 1 ]] || die "Multiple issues match MS-$id; resolve duplicates first."
  issue="$(printf '%s\n' "$matches" | jq -c '.[0] // empty')"
  if [[ -z "$issue" ]]; then
    issue_url="$(gh issue create --repo "$REPO" --title "[MS-$id] $title" --body-file "$body_file")"
    [[ "$issue_url" =~ ^https://github\.com/kennedy-blip/Media-sphere/issues/[0-9]+$ ]] || \
      die "Unexpected issue-create output for MS-$id; inspect the repository before retrying."
    issue_number="${issue_url##*/}"
    issue_node_id="$(gh api "repos/$REPO/issues/$issue_number" --jq '.node_id')"
    [[ -n "$issue_node_id" ]] || die "Could not resolve the new issue's GraphQL ID."
    issue="$(jq -nc --arg id "$issue_node_id" --arg url "$issue_url" --arg title "[MS-$id] $title" \
      --argjson number "$issue_number" '{id:$id, url:$url, title:$title, number:$number, state:"OPEN"}')"
    printf '%s\n' "$issue" >> "$WORK_DIR/issues.jsonl"
    created_count=$((created_count + 1))
    printf 'Created issue #%s: [MS-%s] %s\n' "$issue_number" "$id" "$title"
  else
    reused_count=$((reused_count + 1))
  fi

  issue_node_id="$(printf '%s\n' "$issue" | jq -r '.id')"
  issue_number="$(printf '%s\n' "$issue" | jq -r '.number')"
  issue_url="$(printf '%s\n' "$issue" | jq -r '.url')"
  item_matches="$(find_item "$issue_node_id")"
  [[ "$(printf '%s\n' "$item_matches" | jq 'length')" -le 1 ]] || die "Multiple project items match issue #$issue_number."
  item="$(printf '%s\n' "$item_matches" | jq -c '.[0] // empty')"
  current_priority=""
  current_status=""
  if [[ -z "$item" ]]; then
    item_id="$(gql "$ADD_ITEM_MUTATION" -f projectId="$PROJECT_ID" -f contentId="$issue_node_id" \
      --jq '.data.addProjectV2ItemById.item.id')"
    [[ -n "$item_id" ]] || die "GitHub did not return a project item ID for issue #$issue_number."
    added_count=$((added_count + 1))
  else
    item_id="$(printf '%s\n' "$item" | jq -r '.id')"
    current_priority="$(printf '%s\n' "$item" | jq -r '.priority.name // empty')"
    current_status="$(printf '%s\n' "$item" | jq -r '.status.name // empty')"
    existing_item_count=$((existing_item_count + 1))
  fi

  desired_priority_id="$(priority_option_id "$priority")"
  desired_status_id="$(status_option_id "$status")"
  [[ -n "$desired_priority_id" && -n "$desired_status_id" ]] || die "Missing select option ID for MS-$id."
  if [[ -z "$current_priority" ]]; then
    set_item_select "$item_id" "$PRIORITY_FIELD_ID" "$desired_priority_id"
  fi
  if [[ -z "$current_status" ]]; then
    set_item_select "$item_id" "$STATUS_FIELD_ID" "$desired_status_id"
  fi

  verified="$(gql "$VERIFY_ITEM_QUERY" -f itemId="$item_id")"
  final_priority="$(printf '%s\n' "$verified" | jq -r '.data.node.priority.name // empty')"
  final_status="$(printf '%s\n' "$verified" | jq -r '.data.node.status.name // empty')"
  [[ -n "$final_priority" && -n "$final_status" ]] || \
    die "Priority/Status verification failed for issue #$issue_number; rerun after checking project permissions."
  printf 'VERIFIED #%s | Priority=%s | Status=%s | %s\n' "$issue_number" "$final_priority" "$final_status" "$issue_url"
done

printf '\nDone. Issues created: %s; reused: %s. Project items added: %s; reused: %s.\n' \
  "$created_count" "$reused_count" "$added_count" "$existing_item_count"
printf 'Review the board: %s\n' "$PROJECT_URL"
printf 'Existing issue bodies and board values were preserved. Update ROADMAP.md as work progresses.\n'

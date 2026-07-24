# AGENTS.md

## Hard Rules

- Do not create commits on the main branch unless the human explicitly asks
  for a commit. Inside a git worktree (any non-main branch), commit every
  change immediately and autonomously — do not ask first, and do not leave
  in-flight work uncommitted.
- Before claiming work is complete, run the relevant verification command and
  read the result. Worktree commits are the exception: commit them directly
  without running any test, lint, or typecheck first. Verification belongs to
  the completion and merge-to-main gate, not to each in-flight worktree
  commit.
- This file describes only the current system. Removed concepts must not
  appear anywhere in the repo — code, comments, tests, docs, this file
  included. Migrations are the only place an old name is allowed to survive.
  Do not write "do not reintroduce X" notes that name dead concepts; their
  absence from the working tree is the statement.
- Keep this file aligned with real architecture. When something changes,
  rewrite the relevant section; do not accrete contradictory notes.

## Pull Requests

Open a Pull Request only when the human explicitly includes PR work in the
request. That request authorizes creating the PR; do not ask for a separate
approval when the PR is ready to open.

For stacked PRs, every PR that does not target `main` must remain a draft.
After any PR in the stack is merged, reevaluate the remaining stack. For each
PR whose dependencies are now all present on `main`, retarget it to `main` if
needed and publish it by marking it ready for review. PRs with unmerged
dependencies remain targeted at their predecessor branches and remain drafts.

## Project

Floway is an LLM API gateway. It exposes OpenAI Completions, Anthropic
Messages, OpenAI Responses, OpenAI Chat Completions, Embeddings, OpenAI
Images, OpenAI Audio Transcriptions, Cohere/Jina/Voyage-compatible Rerank,
and Google Gemini-compatible APIs over a unified upstream
model. Provider kinds are
`copilot`, `custom`, `azure`, `codex` (ChatGPT subscription via the
Codex CLI's OAuth client), `claude-code` (Claude.ai Pro/Max subscription
via the Claude Code CLI's OAuth client), and `ollama` (any Ollama-
compatible HTTP server — ollama.com by default, or a self-hosted daemon).

The product name is **Floway** — capitalized in all prose, comments,
test names, assertion messages, and log output. Lowercase `floway` only
appears inside technical identifiers that are part of an existing
contract: the `@floway-dev/*` npm scope, `FLOWAY_*` env vars, the
`x-floway-session` HTTP header, CSS class names, storage keys, fake test
fixtures, and user-facing file/volume names. Never write `` `floway` ``
as a name for the project itself.

As a gateway, preserve upstream status, headers, and body as directly as
possible; surface internal failures with stack traces rather than masking
them. Code-level rules about error handling, comments, and style live in the
global agent instructions and in ESLint config — read those, not a copy
here.

## Design Principle: Upstream Models And Field Values Are Opaque

Floway assumes each upstream speaks the protocol declared for it. The
model catalog and the enum values in open-string protocol slots are
upstream-owned; Floway must not silently collapse either onto a fixed
vendor family.

Allowed:

- **Identified-model special cases** — `if (model.id === 'X')`,
  `if (isOpus47Plus(id))`, `if (isClaudeFamily(id))`. Vendor knowledge
  lives in the code that talks to that vendor.
- **Provider-wide uniform defaults on a bounded scope** — e.g.,
  `provider-ollama` advertising `reasoning.effort: { supported: ['low',
  'medium', 'high'] }` for every thinking-capable Ollama model. The
  scope is bounded by the provider itself.
- **Metadata-first id-inference fallbacks.** Endpoint capability comes
  from upstream metadata first (Copilot `supported_endpoints`, a
  Floway-shaped upstream's `kind`, capabilities blocks, operator
  override); a name-token or prefix fallback that fires AFTER the
  metadata check is silent is fine, provided it lives in the provider
  package that owns the workaround and — for upstream-bug workarounds
  — carries a reference URL and a listing in the
  `audit-copilot-workarounds` skill or equivalent.
- **Client-tool-compat name filters.** Dashboard helpers that build a
  config for a CLI which itself expects a name family (Claude Code CLI
  expects `claude-*`, Codex CLI expects `gpt-5-*`) MAY filter that
  picker by the same pattern. Mirroring the CLI's own expectation, not
  Floway asserting an endpoint mapping. Scope must be the CLI setup
  helper; general model pickers still read `endpoints` from the DTO.

Forbidden — silent narrowing at wire / translate / control-plane
boundaries. Open-string fields declared `| (string & {})` or bare
`string` in `packages/protocols/` (`reasoning_effort`, `verbosity`,
`service_tier`, `reasoning.summary`, `thinkingLevel`, `speed`, Messages
`thinking.display`, …) MUST be forwarded verbatim: `z.string()` in
control-plane schemas, direct pass-through in translators, no `switch`
default that drops unknown values. The upstream owns the accept/reject
decision. Cross-protocol synthesis between different shapes — Gemini
`includeThoughts: true` ↔ Responses `summary`, Messages
`thinking.type: 'enabled'` (no effort) ↔ Chat `reasoning_effort` — is
legit translation, distinct from within-protocol enum gating.

**Every vendor constant needs a reference URL** — image caps, effort→
budget bin edges, canonical enum values, header sets, protocol quirks.
Prose like "per Anthropic's vision docs" without a permalink doesn't
count.

Beyond the allowed patterns above, three carve-outs also fall outside
the prohibition: per-provider pricing tables (`pricing.ts` — return
null for unknown keys); provider config discriminators naming the OWN
kind (`kind: 'claude-code'`); and vendor-locked provider packages
(`provider-claude-code`, `provider-codex`) doing fixed-catalog
request/header mimicry captured verbatim from a live wire probe with a
reference URL.

## Architecture

Stack: Hono on Web APIs, TypeScript, pnpm, Vitest. The dashboard is a
Vue + Vite SPA. Cloudflare Workers is the production deployment target;
Node.js (`node:sqlite` + `sharp` + filesystem) is a parallel deployment
target with the same Hono app and the same `packages/gateway/migrations`
SQL. The `@floway-dev/platform` package owns the abstract runtime
contracts (`FileProvider`, `ImageProcessor`, `ExternalResourceFetcher`,
`SqlDatabase`, `BackgroundScheduler`, `EnvGetter`, `SocketDial`); each
`apps/platform-*` app supplies the concrete impls and its own entry.

Audio transcription is a buffered OpenAI-compatible multipart passthrough.
The full body is parsed before routing because `model` may follow `file`; an
ordered semantic form preserves duplicate text fields and uploaded file
bytes/name/type while each candidate replaces only the upstream model id.
Models use kind `transcription` and declare `audioTranscriptions`. Custom
catalogs may publish that kind, fall back to standard transcription model-id
inference, or use an operator-authored row. Azure and Ollama transcription rows
are operator-authored.
All three providers implement the call. Azure selects the configured deployment
in its dated operation URL and omits the multipart `model`; the same route
serves Whisper and GPT transcription deployments. Successful bodies remain raw
across JSON, verbose JSON, text, SRT, and VTT. Streaming responses
reuse the shared SSE writer and terminate on `transcript.text.done` without a
Chat `[DONE]` sentinel. Usage records always count the request. Token details
split known audio tokens into `input_audio_tokens` and leave the remaining
input on `input_tokens`; without details, the aggregate remains general input.
Output maps to `output_tokens`, while duration maps to `input_audio_seconds`.
Malformed usage never replaces or truncates a successful upstream response; it
is logged and the request is recorded without a metric breakdown.
Rates are canonical decimal strings per one token or second, and a model may
price all metrics simultaneously. Missing measurements remain request-only,
while measured metrics without configured rates remain unpriced.

## Workspace Layout

```text
Floway/
├── packages/
│   ├── agent-setup/          # @floway-dev/agent-setup — Agent Setup domain: config schema, installers, route factories, lease repository contract
│   ├── gateway/              # @floway-dev/gateway — Hono app, control/data planes, repo, migrations
│   ├── http/                 # @floway-dev/http — HTTP/1.1 + userspace TLS + WebSocket upgrade over a duplex byte stream
│   ├── interceptor/          # @floway-dev/interceptor — generic interceptor framework
│   ├── platform/             # @floway-dev/platform — runtime contracts + portable helpers
│   ├── protocols/            # @floway-dev/protocols — protocol type defs
│   ├── provider/             # @floway-dev/provider — upstream provider contracts
│   ├── provider-azure/       # @floway-dev/provider-azure — Azure OpenAI provider
│   ├── provider-claude-code/ # @floway-dev/provider-claude-code — Claude Code (Claude.ai subscription) provider
│   ├── provider-codex/       # @floway-dev/provider-codex — ChatGPT Codex (subscription) provider
│   ├── provider-copilot/     # @floway-dev/provider-copilot — GitHub Copilot provider
│   ├── provider-custom/      # @floway-dev/provider-custom — configurable multi-protocol HTTP provider
│   ├── provider-ollama/      # @floway-dev/provider-ollama — Ollama (ollama.com or self-hosted)
│   ├── proxy/                # @floway-dev/proxy — proxy URI parsing + per-protocol byte-stream dialers
│   ├── test-utils/           # @floway-dev/test-utils — shared Vitest fixtures and stubs (test-only)
│   ├── translate/            # @floway-dev/translate — cross-protocol translation pairs
│   └── ui/                   # @floway-dev/ui — internal Vue component library
└── apps/
    ├── platform-cloudflare/  # @floway-dev/platform-cloudflare — CF impls + Worker entry
    ├── platform-node/        # @floway-dev/platform-node — Node impls + node-server entry
    └── web/                  # @floway-dev/web — Vue + Vite SPA dashboard
```

Dependency direction is strict. The leaf-most packages are `protocols`,
`interceptor`, and `http` (HTTP/1.1 over a duplex byte stream + userspace
TLS + WebSocket upgrade, no runtime dependencies). `translate` depends on
`protocols`. `agent-setup` is the self-contained Agent Setup domain —
configuration schema, language-native installer prefix rendering, canonical
Bash/PowerShell common fragments plus per-agent fragments, dependency-injected
Hono public and control route factories, and the lease
`AgentSetupRepository` contract — and depends only on `hono` / `zod` /
`@hono/zod-validator`; it never imports the gateway or any app, and knows
nothing of databases, HTTP auth/CORS/logging, host mount paths, or runtimes.
`proxy` depends on `http`; it parses subscription-style proxy URIs,
dispatches to per-protocol byte-stream dialers, and exposes request runners
for both proxy-backed and direct TCP streams. Both compose dial → optional
userspace TLS → fetch-on-stream. All dialers — including `vless-ws`, which layers
`wsUpgradeAndFrame` over the runtime's TLS-wrapped duplex — stay
runtime-agnostic by taking the raw TCP `socketDial` primitive through
`DialOptions`, so they never import `@floway-dev/platform`. `provider`
depends on `platform` + `protocols` + `interceptor`; the per-vendor
`provider-*` packages depend on `provider`.
`gateway` depends on `platform` + `protocols` + `translate` + `http` +
`proxy` + `agent-setup` + all `provider-*`, and is the runtime-agnostic
gateway core; it threads `getSocketDial()` from `@floway-dev/platform` into
the proxy library at the dial-layer composition root, and supplies the SQL /
in-memory `AgentSetupRepository` implementations. A successful Agent Setup
insert stores the replacement lease before pruning only that user's
already-expired siblings. The gateway also supplies the auth-derived user id
and the single host-owned route path used to mount both setup surfaces and
project public script URLs. The public routes sit ahead of logger / CORS / auth
middleware. `apps/platform-*` depend on
`platform` + `gateway` plus their target's runtime libraries
(`@cloudflare/workers-types`; `sharp` + `@hono/node-server`); they are the
only places runtime-specific symbols (D1, R2, Images, KV, ExecutionContext,
sharp, node:sqlite, fs) appear. `apps/web` depends on `ui` + `proxy` (the
latter only via its `/url`, `/url-kind`, `/proxy-config`, and `/constants`
subpath exports — chosen so the dashboard's proxy editor reuses URI
parse/format and config types without pulling dialers, userspace TLS, or
Node `crypto` into the SPA bundle), and type-imports
`@floway-dev/gateway/app-type` for Hono RPC client typing. It does not depend
on `@floway-dev/agent-setup` — the dashboard derives the Agent Setup
configuration type from the RPC client — and ESLint blocks a runtime import of
that package from `apps/web`.

ESLint forbids any workspace file from importing `@floway-dev/platform-*`
by package name, plus a `no-restricted-paths` zone forbidding the
platform-target apps from reaching into each other via relative paths.
Each `apps/platform-*` ships with no `exports`/`main` field, so deep
imports also fail at module resolution. Each platform-target app's
`entry.ts` reaches its impls only via local relative imports.

Each package's public surface is its `exports` map. Deep imports
(`@floway-dev/<pkg>/src/...`) are banned by ESLint; cross-package code must
use declared subpath exports. Tests are co-located as `*_test.ts`; each
package has its own `vitest.config.ts`, and the root config aggregates them
through `test.projects`.

Client-carried affinity is a source-protocol membrane. Shared codec, routing,
and request context live under `data-plane/chat/shared/affinity`; each source
protocol owns its `affinity/ingress.ts` and `affinity/egress.ts`. Wire behavior
lives in `docs/AFFINITY.md`, and candidate ordering lives in `docs/RESOLUTION.md`.

Native Responses persistence is independent from affinity and opt-in per API
key. Retention is stored and transferred in seconds so it shares the same
duration representation as dumps, but every positive value is a whole number
of days with a one-day minimum; zero disables every durable lookup and write.
`refreshed_at` is the start of the UTC day containing the latest successful
reuse. Reuse within that same day performs no refresh write. Visibility and
cleanup apply the configured rolling window plus one fixed day of expiration
grace, so quantization never expires state early and may retain it for up to one
extra day. Increasing the configured duration may expose a row that cleanup has
not deleted yet. A completed output item becomes reusable at its first
`response.output_item.done`, so its row commits before that event is published;
the response snapshot commits at the successful terminal event. Repository
writes treat exact item/private-payload reuse as idempotent and reject a
different live row under the same API-key-scoped ID.

Large Responses payloads and dump bodies use immutable objects with per-write
unique keys. The shared `spilled_files` registry records each object as staged
before its file write, atomically adopts it with its owner row, and retires it
when that row is replaced or deleted. One collector claims staged or retired
records regardless of their source domain and deletes only their registered
object keys; domain-specific code never scans or deletes file prefixes.

Responses and dump reads both apply their API key's current rolling retention
before physical cleanup. One `expiration_sweeps` due queue orders work across
both domains. Its single bounded driver claims a key, dispatches either the
Responses or dump adapter, and completes through a revision check. A drained
completion preserves concurrent earlier work; partial and error completions set
a bounded retry so a hot or failing key yields to other due keys. The adapters
only define their indexed stored-row deletion and oldest-row probe; scheduling,
fairness, claim recovery, and retries are shared. New stored rows schedule
their API key directly. A bounded, monotonic cursor per source table backfills
the due queue and exact dump-file registry entries for existing stored rows; it
never pre-seeds API keys without stored state or scans file storage.

HTTP `store: false` can read enabled durable Responses state but never writes or
refreshes it. WebSocket state is always session-local; `store: true`
additionally writes durable state when the key has opted in.

Everything else — provider interfaces, request execution flow, interceptor
shapes, control-plane route surface, flag resolution, pricing — lives in
the code and its comments. Translation pair layout, model resolution, and
affinity wire behavior have dedicated specs under `docs/`.

## Verification

```bash
pnpm run test                # vitest across all packages
pnpm run lint                # eslint across the workspace
pnpm run typecheck           # tsc --noEmit per package
pnpm run test:agent-setup-installers  # assembled Agent Setup scripts vs. fake CLIs/installers (not in `test`)
```

To work on a single package, use pnpm filters (e.g.
`pnpm --filter @floway-dev/translate run typecheck`). Wrangler commands
go through the local dependency with `pnpm wrangler` or package scripts.
When deploying, do not pass `--dry-run`.

## Development

```bash
pnpm run dev                 # parallel wrangler dev (8788) + Vite dev (5174)
pnpm run dev:node            # Node.js entry (tsx apps/platform-node/entry.ts)
pnpm run deploy              # builds apps/web, then wrangler deploys apps/platform-cloudflare
pnpm run db:migrate          # local D1
pnpm run db:migrate:remote   # production D1
```

`dev` runs the Worker on `http://127.0.0.1:8788` and the SPA on
`http://localhost:5174`. For frontend development open the Vite SPA
(5174): Vite proxies the gateway's HTTP paths to the Worker (see the
canonical list in `apps/web/vite.config.ts`'s `wranglerProxiedPaths`),
so relative-URL fetches in `apps/web` work identically in dev and prod.
The Worker port serves the last built `apps/web/dist` via Workers Static
Assets; direct SPA routes (e.g. `/login`, `/dashboard/...`) require
`assets.not_found_handling: "single-page-application"` plus the
backend-only `assets.run_worker_first` route list in the gitignored
`wrangler.jsonc` (see `wrangler.example.jsonc`).

`dev:node` boots the Node deployment target. Configure via
`FLOWAY_DB_PATH` (sqlite file path), `FLOWAY_FILES_DIR` (filesystem
store root), `ADMIN_KEY` (admin secret; optional on dev, mandatory when
`NODE_ENV=production`), `PORT`, and optionally `RUNTIME_LOCATION`
(instance tag used as the perf-telemetry `runtimeLocation` dimension and
the dial-time colo-whitelist key — uppercased on read, defaults to
`LOCAL` when unset). The Node entry runs `applyMigrations` against
`packages/gateway/migrations/*.sql` at boot, then serves the same Hono
app through `@hono/node-server`. Static-asset serving is Workers-only;
the Node target serves no SPA.

The public Agent Setup installers are composed from the checked-in
`packages/agent-setup/installers/{bash,powershell}/common/` fragments
and the adjacent `{claude,codex}.{sh,ps1}` agent fragments. Each source
fragment is embedded verbatim into
`packages/agent-setup/src/script-assets.generated.ts`; regenerate with
`pnpm --filter @floway-dev/agent-setup run generate-assets` (pass
`--check` to fail on drift) after editing any fragment.

`ADMIN_KEY` is optional on dev instances so a fresh checkout is usable
without any secret setup: with the env var unset (which is the default
once `.dev.vars` is deleted), the login page grants seed-admin access to
a blank username + any password. Real deployments must set it — the Node
entry refuses to boot under `NODE_ENV=production` with an empty
`ADMIN_KEY`, and the Cloudflare-side request handler refuses passwordless
logins whenever the request carries a `CF-Ray` header (workerd's local
inbound used by `wrangler dev` never writes CF-Ray; only Cloudflare's
edge does).

For manual data-plane validation, log into the dashboard with the
`ADMIN_KEY` backdoor (or, on a dev instance, the passwordless shortcut)
or with your own user, then create or pick an API key under your account
and use it as `x-api-key`. `ADMIN_KEY` is not a data-plane credential;
its only purpose is to let an operator who lost the admin password log
in via `POST /auth/login`.

When investigating Copilot upstream quirks, compare at least one other
Copilot gateway implementation before inventing a policy. For generic
adapter behavior, compare at least one Copilot gateway and one general
LLM gateway. Do not cargo-cult from a single project.

## Deployment

A production deploy can disconnect the agent that triggers it, especially
when the deploy includes a D1 migration and the live schema briefly does
not match the code that the same agent is still running against. That
window is hard to avoid, so every production deploy must be a deliberate,
announced step.

Tell the user once, before Step 1 begins. If the user already asked for
the deploy up front, you do not need to re-ask, but you still explicitly
announce that the deploy is starting. That announcement is the only place
during a deploy where the agent talks *to* the user instead of running the
next tool.

After that announcement the deploy is autonomous and must not stop —
except at Step 2 when breaking changes require user confirmation. Each
turn ends on a tool call; the only legitimate reasons to stop are: the
Worker is live and Step 4 succeeded, Step 2 is awaiting user
confirmation of breaking changes, or a tool exited non-zero and the
failure genuinely requires human judgement.

When the user's request is the deploy itself — the human asked to deploy
and not to deploy as the tail of a wider piece of work — git is read-only
for the duration of the deploy flow. This constraint covers git only;
code and config edits are not bound by it and remain a per-situation
judgement call. Inspection commands such as `git branch`, `git status`,
`git log`, `git diff`, and `git show` are fine and are often needed to
gather state for Steps 1 and 2. Anything that mutates repository
state is forbidden: `git stash`, `git reset`, `git checkout` of files or
branches, `git commit`, `git rebase`, `git merge`, `git pull`,
`git push`, and any branch or tag creation/deletion.

Substitute `<WORKER_NAME>` (top-level `name`) and `<DB_NAME>` (the D1
binding's `database_name`) from `wrangler.jsonc` wherever those
placeholders appear below.

**Step 1 — gather current state.** Read `wrangler.jsonc` for `<WORKER_NAME>`
and `<DB_NAME>`, then chain:

```bash
pnpm wrangler deployments list \
  && pnpm wrangler d1 migrations list <DB_NAME> --remote
```

`deployments list` shows recent deployments with their version ids and
marks the currently active one — that gives both the active deployment
timestamp, the version id you would later roll back to, and the deploy
message (which records the commit revision of that deployment).
`d1 migrations list --remote` prints applied migrations and the pending
diff this deploy would apply.

**Step 2 — declare breaking changes and collect recommended actions.**
Extract the deploy message of the currently active deployment from Step 1's
output. The message is a short commit revision (recorded by the previous
deploy's `--message` flag). Use it to diff `CHANGELOG.md` between that revision
and the current working tree:

```bash
git diff <PREVIOUS_COMMIT_REV> -- CHANGELOG.md
```

If the active deployment has no message, or its message is not a
recognizable commit revision (i.e. it predates the introduction of this
workflow), and the database shows applied migrations (confirming Floway
is already running in production), treat the entire content of
`CHANGELOG.md` as potentially new to the user.

Classify every new entry by its heading. `hard` and `minor` entries are
breaking changes; summarize their combined user-facing impact. When the same
area was broken by consecutive entries, synthesize the net effect instead of
enumerating intermediate states. Tell the user that all listed breaking
changes are intentional, describe their impact, and ask the user to confirm
before proceeding. This is the **only** point in the deploy flow where the
agent pauses before deployment.

`advisory` entries do not trigger confirmation. Recommended operations may
appear in `hard`, `minor`, or `advisory` entries; collect all of them for the
post-deploy report. A note is information, not authority to mutate state.

When there are no new `hard` or `minor` entries, or when `CHANGELOG.md` does
not exist at the previous revision and is empty now, skip confirmation and
proceed to Step 3 immediately.

**Step 3 — report findings and stage the rollback.** Tell the user the
active version id, the active deployment timestamp, the latest applied
migration, and the migrations this deploy will apply (or that there are
none).

If migrations are pending, capture a Time Travel bookmark of the current
database state so a rollback can restore to that exact point:

```bash
pnpm wrangler d1 time-travel info <DB_NAME> --json
```

The output is `{ "bookmark": "..." }`; that bookmark string is the
restore target. Nothing leaves Cloudflare, and D1 retains bookmarks for
30 days.

Report the captured bookmark, then give the user two rollback commands,
in this order:

- Restore the database: `CI=1 pnpm wrangler d1 time-travel restore
  <DB_NAME> --bookmark <bookmark>`.
- Roll back the Worker code:
  `CI=1 pnpm wrangler rollback <PREVIOUS_VERSION_ID> -m "Emergency rollback"`.

Both commands must be paste-and-run during an incident, so they are
prefixed with `CI=1` to make wrangler treat them as non-interactive — it
otherwise prompts to confirm the restore and to enter a rollback
message. The `-m` flag on `wrangler rollback` supplies that message
directly, because wrangler's documented `-y/--yes` flag is not actually
honored by the rollback handler.

If no migrations are pending, skip the bookmark capture and the
database-rollback command; give only the code-rollback command and
proceed straight to Step 4.

**Step 4 — deploy with one chained command.** Migrate (when needed) and
publish in the same command so the system spends as little time as
possible in an inconsistent state. The deploy message is the short commit
revision of HEAD at deploy time (`git rev-parse --short HEAD`):

```bash
pnpm run db:migrate:remote && pnpm run deploy -- --message "$(git rev-parse --short HEAD)"
```

Print this exact command before running it, and tell the user that if the
deploy stops halfway they can rerun the same command to recover —
`wrangler d1 migrations apply --remote` is idempotent on already-applied
migrations and `wrangler deploy` always publishes the current code. When
there are no pending migrations, the command reduces to
`pnpm run deploy -- --message "$(git rev-parse --short HEAD)"`.

After the Worker is live, report every recommended operation collected from
the new Deployment Notes. Perform read-only checks directly when they are
within scope. For any state-changing operation that was not already explicitly
authorized, explain the recommendation and ask the user before doing it; never
fold it silently into deployment automation. The deployment itself is complete
even when a recommended follow-up remains for a later user turn.

Worker rollback by version id (`pnpm wrangler rollback <VERSION_ID>`)
works across the 100 most recent versions, but Cloudflare blocks rollback
when intervening deployments changed Durable Object migrations or removed
referenced KV/R2/Queue bindings. The Worker's bindings (D1, R2, Images,
KV) only ever grow, never shrink — `pnpm run deploy` runs
`pnpm install --frozen-lockfile` first (so a fast-forward that introduced
a new workspace package wires its symlinks before the build runs) then
`scripts/check-wrangler.ts` and refuses to publish if `wrangler.jsonc`
drifts from `wrangler.example.jsonc` in either direction — every key,
value, and binding in the example must appear in the real config, and
the real config must not carry anything the example doesn't pin (aside
from `account_id`, the one personal-only key the gate allowlists). So
plain code rollback stays safe; D1 state is rolled back separately as
above.

A complete deploy without `hard` or `minor` notes fits in a strict turn budget:
**three agent turns when migrations are pending** (Step 1 = gather,
Step 3 = bookmark + report + two rollback commands, Step 4 = deploy)
and **two agent turns when no migrations are pending** (Step 3 collapses
into Turn 1: gather + report + single code-rollback command; Turn 2 =
deploy). Step 2 adds one turn only when new `hard` or `minor` entries exist.
Reporting recommended operations after deploy does not add a deployment turn;
executing one may require a separate authorization turn.

## Deployment Notes (CHANGELOG.md)

`CHANGELOG.md` records user-facing breaking changes and recommended deployment
operations. It is prepend-only: new entries go at the top, below the file
header. Each entry has a date heading, an impact level, and a description of
what users need to know or do.

Each entry carries one of three levels:

- **hard** — all users are affected; previously working functionality fails or
  behaves differently.
- **minor** — a specific behavior, field, or integration pattern changes;
  affected users need to adapt, but primary functionality continues to work.
- **advisory** — no previously working behavior breaks, but the deployment
  creates or reveals a condition for which an agent or operator should consider
  a concrete follow-up action.

The date heading format is `## YYYY-MM-DD · hard`,
`## YYYY-MM-DD · minor`, or `## YYYY-MM-DD · advisory`. Recommended operations
may appear in any level; they do not need a separate advisory entry when they
belong to the same hard or minor change.

A change qualifies as a breaking change when it causes previously working
user-facing behavior to stop working or behave differently in a way
users must be aware of. Examples:

- Affinity or routing redesigns that invalidate existing conversation
  context, causing requests to route to unexpected upstreams.
- Dropping stored state (Responses items, snapshots) that clients may
  reference by id.
- Removing or renaming fields from public API responses (`/models`,
  data-plane output) that downstream consumers or cascaded Floway
  instances read.

An advisory qualifies only when there is a concrete deployment-related action
to report. The following must not appear by themselves:

- Database schema migrations (internal storage detail).
- Control-plane API changes (admin-only surface).
- Export version bumps, internal refactors, and new features that neither alter
  existing behavior nor require an operator action.

When working on a change and it is unclear whether it constitutes a
`hard` or `minor` breaking change, do not classify it unilaterally — ask the
user to make the call. The user declares what is breaking; the agent records
it. An advisory must state the recommended action, its reason, and enough scope
to avoid accidentally applying it to unrelated state.

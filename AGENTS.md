# AGENTS.md

## Hard Rules

- Do not open a Pull Request without explicit human approval. The human must
  understand the goal and risk, read the AI-generated code and PR text, and
  believe code, docs, and tests are internally consistent.
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

## Project

Floway is an LLM API gateway. It exposes OpenAI Completions, Anthropic
Messages, OpenAI Responses, OpenAI Chat Completions, Embeddings, OpenAI
Images, and Google Gemini-compatible APIs over a unified upstream
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

Stack: Hono on Web APIs, TypeScript, pnpm, Vitest. The dashboard is a
Vue + Vite SPA. Cloudflare Workers is the production deployment target;
Node.js (`node:sqlite` + `sharp` + filesystem) is a parallel deployment
target with the same Hono app and the same `packages/gateway/migrations` SQL.
The `@floway-dev/platform` package owns the abstract runtime contracts
(`FileProvider`, `ImageProcessor`, `SqlDatabase`, `BackgroundScheduler`,
`EnvGetter`, `SocketDial`); each `apps/platform-*` app supplies the
concrete impls (including the runtime's root-CA list as a plain
`readonly string[]`) and its own entry. `packages/gateway` (the gateway
core) imports only platform contracts and is ESLint-prohibited from
reaching into any `apps/platform-*`.

## Workspace Layout

```text
Floway/
├── packages/
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
│   ├── provider-custom/      # @floway-dev/provider-custom — generic OpenAI-compatible
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
`protocols`. `proxy` depends on `http`; it parses subscription-style
proxy URIs, dispatches to per-protocol byte-stream dialers, and exposes a
`runProxiedRequest` orchestrator that composes dial → optional userspace
TLS → fetch-on-stream. All dialers — including `vless-ws`, which layers
`wsUpgradeAndFrame` over the runtime's TLS-wrapped duplex — stay
runtime-agnostic by taking the raw TCP `socketDial` primitive through
`DialOptions`, so they never import `@floway-dev/platform`. `provider`
depends on `platform` + `protocols` + `interceptor`; the per-vendor
`provider-*` packages depend on `provider`.
`gateway` depends on `platform` + `protocols` + `translate` + `http` +
`proxy` + all `provider-*`, and is the runtime-agnostic gateway core; it
threads `getSocketDial()` from `@floway-dev/platform` into the proxy
library at the dial-layer composition root. `apps/platform-*` depend on
`platform` + `gateway` plus their target's runtime libraries
(`@cloudflare/workers-types`; `sharp` + `@hono/node-server`); they are the
only places runtime-specific symbols (D1, R2, Images, KV, ExecutionContext,
sharp, node:sqlite, fs) appear. `apps/web` depends on `ui` + `proxy` (the
latter only via its `/url`, `/url-kind`, `/proxy-config`, and `/constants`
subpath exports — chosen so the dashboard's proxy editor reuses URI
parse/format and config types without pulling dialers, userspace TLS, or
Node `crypto` into the SPA bundle), and type-imports
`@floway-dev/gateway/app-type` for Hono RPC client typing.

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

Everything else — provider interfaces, request execution flow, interceptor
shapes, translation pair layout, control-plane route surface, flag
resolution, pricing — lives in the code and its comments. Read the relevant
directory.

## Verification

Run from the repo root:

```bash
pnpm run test                # vitest across all packages
pnpm run lint                # eslint across the workspace
pnpm run typecheck           # tsc --noEmit per package
pnpm run dev                 # parallel wrangler dev (8788) + Vite dev (5174)
pnpm run dev:node            # Node.js entry (tsx apps/platform-node/entry.ts)
pnpm run deploy              # builds apps/web, then wrangler deploys apps/platform-cloudflare
pnpm run db:migrate          # local D1
pnpm run db:migrate:remote   # production D1
```

`dev` runs the Worker on `http://127.0.0.1:8788` and the SPA on
`http://localhost:5174`. For frontend development open the Vite SPA (5174):
Vite proxies the gateway's HTTP paths to the Worker (see the canonical
list in `apps/web/vite.config.ts`'s `wranglerProxiedPaths`), so relative-URL
fetches in `apps/web` work identically in dev and prod. The Worker port
serves the last built
`apps/web/dist` via Workers Static Assets; direct SPA routes (e.g.
`/login`, `/dashboard/...`) require
`assets.not_found_handling: "single-page-application"` plus the
backend-only `assets.run_worker_first` route list in the gitignored
`wrangler.jsonc` (see `wrangler.example.jsonc`). To work on a single
package, use pnpm filters (e.g.
`pnpm --filter @floway-dev/translate run typecheck`).

`dev:node` boots the Node deployment target. Configure via
`FLOWAY_DB_PATH` (sqlite file path), `FLOWAY_FILES_DIR` (filesystem store
root), `ADMIN_KEY` (admin secret), `PORT`, and optionally
`RUNTIME_LOCATION` (instance tag used as the perf-telemetry
`runtimeLocation` dimension and the dial-time colo-whitelist key —
uppercased on read, defaults to `LOCAL` when unset). Default ports/paths in
`apps/platform-node/entry.ts`. The Node entry runs `applyMigrations` against
`packages/gateway/migrations/*.sql` at boot, then serves the same Hono app
through `@hono/node-server`. Static-asset serving is Workers-only; the Node
target serves no SPA.

Wrangler commands go through the local dependency with `pnpm wrangler` or
package scripts. When deploying, do not pass `--dry-run`.

For manual data-plane validation, log into the dashboard with the
`ADMIN_KEY` backdoor or with your own user, then create or pick an API
key under your account and use it as `x-api-key`. `ADMIN_KEY` is not a
data-plane credential; its only purpose is to let an operator who lost
the admin password log in via `POST /auth/login`.

When investigating Copilot upstream quirks, compare at least one other
Copilot gateway implementation before inventing a policy. For generic
adapter behavior, compare at least one Copilot gateway and one general LLM
gateway. Do not cargo-cult from a single project.

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

After that announcement the deploy is fully autonomous and must not stop.
Never end a turn waiting for the user to reply or to take any action — no
"shall I continue?", no "ready for Step 3?", no implicit pause after
printing rollback commands, no waiting for the user to acknowledge the
backup path. As soon as a step's tool output is in hand, the very next
agent turn must call the next step's tool. The only legitimate reasons to
stop are: the Worker is live and Step 3 succeeded, or a tool exited
non-zero and the failure genuinely requires human judgement. Reporting
findings, printing commands, and announcing the next step are inlined
*alongside* the next tool call in the same turn — never as a standalone
turn that ends and waits.

When the user's request is the deploy itself — the human asked to deploy
and not to deploy as the tail of a wider piece of work — git is read-only
for the duration of the deploy flow. This constraint covers git only;
code and config edits are not bound by it and remain a per-situation
judgement call. Inspection commands such as `git branch`, `git status`,
`git log`, `git diff`, and `git show` are fine and are often needed to
gather state for Step 1 and Step 2. Anything that mutates repository
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
timestamp and the version id you would later roll back to.
`d1 migrations list --remote` prints applied migrations and the pending
diff this deploy would apply.

**Step 2 — report findings and stage the rollback.** Tell the user the
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
proceed straight to Step 3.

**Step 3 — deploy with one chained command.** Migrate (when needed) and
publish in the same command so the system spends as little time as
possible in an inconsistent state:

```bash
pnpm run db:migrate:remote && pnpm run deploy
```

Print this exact command before running it, and tell the user that if the
deploy stops halfway they can rerun the same command to recover —
`wrangler d1 migrations apply --remote` is idempotent on already-applied
migrations and `wrangler deploy` always publishes the current code. When
there are no pending migrations, the command reduces to `pnpm run deploy`.

Worker rollback by version id (`pnpm wrangler rollback <VERSION_ID>`)
works across the 100 most recent versions, but Cloudflare blocks rollback
when intervening deployments changed Durable Object migrations or removed
referenced KV/R2/Queue bindings. The Worker's bindings (D1, R2, Images,
KV) only ever grow, never shrink — `pnpm run deploy` runs
`pnpm install --frozen-lockfile` first (so a fast-forward that introduced
a new workspace package wires its symlinks before the build runs) then
`scripts/check-wrangler.ts` and refuses to publish if `wrangler.jsonc`
drifts from `wrangler.example.jsonc` (bindings, `main`,
`compatibility_date`, `triggers.crons`, the SPA `assets` block, and the
Worker-first route list) — so plain code rollback stays safe; D1 state is
rolled back separately as above.

A complete deploy fits in a strict turn budget: **three agent turns when
migrations are pending** (Step 1 = gather, Step 2 = bookmark + report +
two rollback commands, Step 3 = deploy) and **two agent turns when no
migrations are pending** (Step 2 collapses into Turn 1: gather + report +
single code-rollback command; Turn 2 = deploy). A turn boundary in this
flow exists only because a tool result has to arrive before the next tool
call can be issued — it is never a checkpoint where the agent stops and
waits for the user. Every turn in this budget ends on its step's tool
call, and the agent re-enters the loop the instant that tool result
returns. Do not insert extra turns to ask for confirmation along the way,
and do not let any turn end on a text-only message that has no tool call
attached.

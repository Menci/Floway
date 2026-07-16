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
  Do not write notes naming dead concepts; their absence is the statement.
- Keep this file aligned with real architecture. When something changes,
  rewrite the relevant section; do not accrete contradictory notes.

## Project

Floway is an LLM API gateway. It exposes OpenAI Completions, Anthropic
Messages, OpenAI Responses, OpenAI Chat Completions, Embeddings, OpenAI
Images, and Google Gemini-compatible APIs over a unified upstream model.
Provider kinds are `copilot`, `custom`, `azure`, `codex` (ChatGPT
subscription through the Codex CLI OAuth client), `claude-code` (Claude.ai
Pro/Max subscription through the Claude Code CLI OAuth client), and `ollama`
(ollama.com or a self-hosted compatible server).

The product name is **Floway** — capitalized in prose, comments, test names,
assertion messages, and log output. Lowercase `floway` appears only in
technical contracts such as the `@floway-dev/*` scope, `FLOWAY_*` environment
variables, `x-floway-session`, CSS classes, storage keys, fixtures, and
user-facing files or volumes. Never write `` `floway` `` as the project name.

As a gateway, preserve upstream status, headers, and bodies as directly as
possible; surface internal failures with stack traces. Error handling,
comment, and style rules live in the global instructions and ESLint config.

## Design Principle: Upstream Models And Field Values Are Opaque

Floway assumes each upstream speaks the protocol declared for it. Model
catalogs and values in open-string protocol slots are upstream-owned and must
not be silently collapsed onto a fixed vendor family.

Allowed:

- identified-model special cases in code owned by the relevant provider;
- provider-wide defaults inside that provider's bounded catalog;
- metadata-first endpoint inference with provider-owned name fallbacks only
  after upstream metadata is silent;
- client-tool setup filters that mirror the target CLI's own model-name
  expectation, scoped to that setup helper.

Open-string fields declared as bare `string` or `| (string & {})` in
`packages/protocols` (`reasoning_effort`, `verbosity`, `service_tier`,
`reasoning.summary`, `thinkingLevel`, `speed`, Messages `thinking.display`,
and others) pass through control-plane schemas and translators verbatim. The
upstream owns rejection. Cross-protocol synthesis between different shapes is
legitimate; within-protocol enum gating is not.

Every vendor constant needs a reference URL, preferably a GitHub permalink.
This includes image limits, effort/budget boundaries, canonical enum values,
header sets, and protocol quirks.

Pricing tables may return null for unknown keys. Provider config
discriminators may name their own kind. Vendor-locked `provider-codex` and
`provider-claude-code` packages may implement fixed request/header mimicry
captured from live probes with references.

## Runtime And Dependency Architecture

The stack is Hono on Web APIs, TypeScript, pnpm, and Vitest. The dashboard is a
Vue + Vite SPA. Cloudflare Workers is the production target; Node.js
(`node:sqlite`, `sharp`, and filesystem storage) is a parallel target with the
same Hono app and `packages/gateway/migrations` SQL.

`@floway-dev/platform` owns portable runtime contracts: `FileProvider`,
`ImageProcessor`, `ExternalResourceFetcher`, `SqlDatabase`,
`BackgroundScheduler`, `EnvGetter`, and `SocketDial`. Each `apps/platform-*`
app provides concrete implementations and its own entry. External-resource
fetchers make one credential-free GET with redirects exposed to the caller.
The Node implementation pins DNS resolution to public addresses. The gateway
external-image loader owns redirect traversal, timeout and byte limits and
maps structured fetch failures through translation policy.

`packages/gateway` imports platform contracts only and is ESLint-prohibited
from importing concrete platform apps.

## Workspace Layout

```text
Floway/
├── packages/
│   ├── gateway/              # Hono app, data/control planes, repo, migrations
│   ├── http/                 # HTTP/1.1, userspace TLS, WebSocket over byte streams
│   ├── interceptor/          # generic interceptor framework
│   ├── platform/             # portable runtime contracts and helpers
│   ├── protocols/            # protocol types, parsers, reassemblers, renderers
│   ├── provider/             # upstream provider contracts
│   ├── provider-azure/
│   ├── provider-claude-code/
│   ├── provider-codex/
│   ├── provider-copilot/
│   ├── provider-custom/
│   ├── provider-ollama/
│   ├── proxy/                # proxy parsing and protocol byte-stream dialers
│   ├── test-utils/
│   ├── translate/            # pure pairwise cross-protocol translation
│   └── ui/
└── apps/
    ├── platform-cloudflare/
    ├── platform-node/
    └── web/
```

The leaf packages are `protocols`, `interceptor`, and `http`. `translate`
depends on `protocols`. `proxy` depends on `http`; direct and proxy-backed
request runners compose dial, optional userspace TLS, and fetch-on-stream. All
dialers take `SocketDial` through options and remain runtime-agnostic.

`provider` depends on platform, protocols, and interceptor; vendor packages
depend on provider. `gateway` depends on platform, protocols, translate, http,
proxy, and vendor packages. Platform apps depend on platform and gateway plus
their runtime libraries. Only platform apps may mention D1, R2, Images, KV,
ExecutionContext, `sharp`, `node:sqlite`, or filesystem runtime symbols.

`apps/web` depends on UI and selected proxy subpath exports and type-imports
`@floway-dev/gateway/app-type`. It must not pull dialers, userspace TLS, or
Node crypto into the browser bundle.

Each package's `exports` map is its public API. Cross-package deep imports are
banned. Tests are co-located as `*_test.ts`; package Vitest configs are
aggregated by root `test.projects`.

## Chat Data Plane

Request translation is direct and pairwise. The source attempt chooses one
target protocol from the selected candidate's endpoint metadata; nested
attempts reuse the same candidate. Translators do not know provider identity,
API keys, aliases, affinity, or persistence. Alias rules apply after
translation on the target IR immediately before the wire call.

Every attempt receives its own structured payload clone and `Headers` object.
Pre-stream API/internal errors advance to the next candidate. An opened event
stream or successful plain result is final; a later stream error cannot start
a fallback after client output has begun.

Provider calls parse upstream streams into typed events. Gateway and provider
interceptors operate on typed protocol shapes. Source responders own final
JSON, SSE, and WebSocket rendering.

## Client-carried Affinity

Shared model names and aliases can resolve to different upstream accounts,
canonical models, and rule variants. Opaque reasoning state is target-bound.
Floway therefore adds authenticated provenance to client-carried opaque state
and expects continued requests to pass through Floway.

Each API key has a hidden random 256-bit `serverSecret` for gateway-private
per-key data. Normal API-key CRUD and dashboard DTOs never expose it. Admin
data transfer format version 10 includes it so a restored deployment can
recover that private state. Key updates preserve it. Affinity derives its own
encryption key from the server secret.

The version 1 AES-256-GCM envelope contains optional original encoding plus:

```text
upstream ID
canonical model ID
alias-rule presence and value
optional protocol restore state
```

Routing strength is request-local. Ingress derives prefer/force from the
carrier's current protocol location; it is never serialized. Compaction and
program state force their associated target, while ordinary assistant state
only prefers it.

AEAD additional data binds a length-delimited protocol/slot domain and the
original bytes. A trailer cannot authenticate after moving to another carrier
or attaching it to different opaque content.

Wire framing is `originalBytes || IV[12] || ciphertext+tag || length:u16be`,
then canonical Base64/Base64URL. There is no magic value or delimiter.
Canonical encoded input is decoded before framing; raw input is UTF-8. A
synthetic carrier has no original value. Unauthenticated or unrecognized
values are foreign and pass byte-for-byte, which gives cascaded Floway
instances natural nesting.

Affinity is an early-ingress/late-egress membrane:

1. source ingress authenticates owned carriers before ordinary gateway work;
2. exact force/prefer affinity filters or orders normal viable candidates;
3. every attempt gets a clean source clone: compatible original values are
   restored, incompatible owned values are removed, foreign values remain;
4. the request then crosses normal interceptors, translation, and provider
   dispatch without Floway affinity metadata;
5. after target events return to the source shape, the inner egress transform
   wraps every natural opaque value;
6. the outer egress transform ensures the first assistant element carries a
   blob, augmenting it or inserting a protocol-native prefix element.

Force means the request contains non-discardable state such as Responses
compaction/program state. Conflicting or unavailable force targets fail before
dispatch. Prefer moves the latest available exact target first; unavailable
preferred state leaves normal order and is omitted on incompatible attempts.

Protocol streaming rules:

- Chat `reasoning_opaque` is a per-choice last-write-wins snapshot. Egress
  retains only opaque snapshots until finish; visible deltas remain immediate.
- Messages `signature_delta` is last-write-wins. Readable thinking streams
  immediately; a first thinking block receives a wrapped or originless final
  signature. A non-carrier first block is shifted behind a redacted prefix.
- Gemini uses a sliding one-event lookahead. Same-element continuations release
  the older event unsigned and keep the newer event buffered until a natural
  signature or a definite element boundary determines the carrier.
- Responses augments a carrier-capable first item at close or emits a synthetic
  reasoning prefix through added/done before shifting later item indexes.

Chat, Messages, and Responses buffer only opaque carrier state. Gemini is the
sole exception: it deliberately holds at most one complete source event to
keep one authoritative signature on content-bearing output.

## Stateful Responses

Responses state is independent from affinity. The store owns complete
Responses items and snapshots; affinity owns routing provenance.

Native inbound order is:

```text
previous_response_id expansion
→ complete item hydration
→ affinity extraction/routing
→ candidate-specific opaque restoration
→ attempt
```

Native outbound order is:

```text
source-shaped events
→ affinity wrapping
→ gateway response/item ID rewrite
→ complete item persistence
→ snapshot commit
→ client
```

Successful item writes complete before `output_item.done`; snapshot writes
complete before the terminal event. A compaction item makes the snapshot an
atomic replacement. Normal generation appends previous history, new input, and
new output. Stored items are API-key scoped complete payloads with a content
hash, creation time, and optional private server-tool payload.

HTTP `store: false` may read existing durable history but performs no state
writes and leaves upstream item/response IDs unchanged.
WebSocket `store: false` uses a session-owned memory backing so same-socket
references work without durable storage. Stored HTTP/WS items and snapshots
expire 30 days after creation; compressed payload files follow the same
lifetime.

Translated inner Responses calls use only request-local hosted-tool state.
Only a native Responses source constructs a persistence store and applies
client item IDs and retention.

## Verification

Run from the repository root:

```bash
pnpm run test
pnpm run lint
pnpm run typecheck
pnpm run dev
pnpm run dev:node
pnpm run deploy
pnpm run db:migrate
pnpm run db:migrate:remote
```

`dev` runs the Worker at `http://127.0.0.1:8788` and Vite at
`http://localhost:5174`. Open the Vite SPA during frontend work; its proxy list
is canonical in `apps/web/vite.config.ts`. Worker Static Assets serves the
last built dashboard and uses SPA fallback plus the backend-first route list in
`wrangler.example.jsonc`.

`dev:node` reads `FLOWAY_DB_PATH`, `FLOWAY_FILES_DIR`, `ADMIN_KEY`, `PORT`, and
optional `RUNTIME_LOCATION` (uppercased, default `LOCAL`). It applies gateway
migrations at boot and serves no SPA.

Wrangler commands use the local dependency through `pnpm wrangler`. Do not use
`--dry-run` for deployment.

`ADMIN_KEY` is optional in local development and mandatory for real
deployments. The Node production entry refuses to boot without it. Cloudflare
edge requests identified by `CF-Ray` never permit passwordless login.

For manual data-plane validation, log in through `ADMIN_KEY` or a real user,
create an API key, and send it as `x-api-key`. `ADMIN_KEY` is only an operator
login recovery credential, not a data-plane key.

When investigating Copilot quirks, compare at least one other Copilot gateway.
For generic adapter behavior, compare one Copilot gateway and one general LLM
gateway. Do not derive policy from one implementation.

## Deployment

A production deploy can disconnect the agent that triggers it, especially when
a migration briefly makes the live schema incompatible with the code the agent
is using. Every production deployment is deliberate and announced once before
Step 1. If the user already requested deployment, announce the start but do not
ask again.

After that announcement the deploy is autonomous. Do not pause for approval or
end a turn between steps. Stop only after the Worker is live and Step 3
succeeds, or after a non-zero tool result genuinely requires human judgment.

When deployment itself is the user's request, git is read-only for the entire
flow. `git status`, `branch`, `log`, `diff`, and `show` are allowed. Do not
stash, reset, checkout, commit, rebase, merge, pull, push, or create/delete
branches or tags.

Read `<WORKER_NAME>` from top-level `name` and `<DB_NAME>` from the D1 binding's
`database_name` in `wrangler.jsonc`.

### Step 1 — gather current state

```bash
pnpm wrangler deployments list \
  && pnpm wrangler d1 migrations list <DB_NAME> --remote
```

Record the active deployment timestamp and version ID, latest applied
migration, and pending migrations.

### Step 2 — report and stage rollback

Report those values. When migrations are pending, capture the exact D1 state:

```bash
pnpm wrangler d1 time-travel info <DB_NAME> --json
```

Report the returned bookmark, then print these incident commands in order:

```bash
CI=1 pnpm wrangler d1 time-travel restore <DB_NAME> --bookmark <bookmark>
CI=1 pnpm wrangler rollback <PREVIOUS_VERSION_ID> -m "Emergency rollback"
```

If no migration is pending, skip the bookmark and database command and print
only the Worker rollback command.

### Step 3 — migrate and deploy

Print the exact command before running it:

```bash
pnpm run db:migrate:remote && pnpm run deploy
```

Tell the user that the same command can be rerun after a partial failure. D1
migration apply is idempotent and deploy always publishes current code. With no
pending migration, run only `pnpm run deploy`.

Worker version rollback works across the latest 100 versions unless an
intervening deployment changed Durable Object migrations or removed referenced
bindings. Floway bindings only grow. Deploy runs frozen install and
`scripts/check-wrangler.ts`; publication fails if real and example Wrangler
configs drift in either direction, except for personal `account_id`.

A deployment uses three agent turns when migrations are pending and two when
none are pending. Turn boundaries exist only to receive a required tool result;
every turn in the flow ends on the next tool call, never on a text-only
checkpoint.

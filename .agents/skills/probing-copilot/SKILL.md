---
name: probing-copilot
description: Use when probing GitHub Copilot upstream behavior directly. Pulls a
  usable Copilot credential from D1, exchanges the PAT for a short-lived Copilot
  token, and calls api.*.githubcopilot.com with the headers Copilot Chat sends.
  Never routes through our gateway; never asks the human for credentials.
  Mid-task probes belong in a subagent.
---

# Probing Copilot

Calls the Copilot upstream the way Copilot Chat does, against an account we
already own.

## Pick a credential

1. Read `<DB_NAME>` from `wrangler.jsonc`
   (`d1_databases[0].database_name`).
2. Query enabled copilot upstreams. Default to local
   (`pnpm wrangler d1 execute <DB_NAME> --command "..."`); use `--remote` when
   the probe specifically needs production accounts or local has none.

   ```sql
   SELECT id, name,
          json_extract(config_json, '$.accountType') AS account_type,
          json_extract(config_json, '$.githubToken') AS github_token
   FROM upstreams
   WHERE provider = 'copilot' AND enabled = 1;
   ```

3. Pick any returned row — order doesn't matter unless the probe needs a
   specific account type, in which case filter
   `json_extract(config_json, '$.accountType')` against
   `individual` / `business` / `enterprise`. Don't ask the human.

4. Treat the PAT as a secret: do not echo it into commit messages, code
   comments, or the chat transcript.

## Exchange the PAT

`GET https://api.github.com/copilot_internal/v2/token` with
`authorization: token <PAT>` returns `{ token, expires_at, refresh_in }`. The
returned token is short-lived (~30 min); re-exchange when it expires. The
method is GET, not POST — POST returns 404 from this endpoint.

## Call the upstream

Base URL by account type:

- `individual`  → `https://api.githubcopilot.com`
- `business`    → `https://api.business.githubcopilot.com`
- `enterprise`  → `https://api.enterprise.githubcopilot.com`

Paths (host root, no API prefix):

- `/models`
- `/chat/completions` (OpenAI Chat)
- `/responses` (OpenAI Responses)
- `/v1/messages`, `/v1/messages/count_tokens` (Anthropic-shaped)
- `/embeddings`

Required headers — matching VSCode Copilot Chat. Diverging makes the probe
non-representative; missing them produces opaque 400/403s.

```
Authorization: Bearer <exchanged-token>
Content-Type: application/json
editor-version: vscode/<VSCODE_VERSION>
editor-plugin-version: copilot-chat/<COPILOT_VERSION>
user-agent: GitHubCopilotChat/<COPILOT_VERSION>
x-github-api-version: <COPILOT_API_VERSION>
x-vscode-user-agent-library-version: electron-fetch
x-request-id: <uuid>                       # same UUID for both ids; real
x-agent-task-id: <uuid>                    # VSCode regenerates per request
copilot-integration-id: vscode-chat
openai-intent: conversation-agent
x-interaction-type: conversation-agent
```

`apps/api/src/shared/copilot.ts` is the source of truth for the version
constants, the header set, and the account-type→base-URL map. Read the
current values from there rather than hardcoding them in probe scripts.
For Messages probes needing Claude beta features, also send
`anthropic-beta: <feature-list>`.

## Constraints

- **Never go through our gateway.** No `pnpm run dev`, no deployed Worker.
  Hit `api.*.githubcopilot.com` directly.
- **Don't write probe code into the repo** unless the human asks. One-shot
  `curl` (or a throwaway script piped through `jq`) is enough.
- **Mid-task probes use a subagent.** Probes dump noisy request/response
  bodies; dispatch a read-only subagent and have it report only the
  observation that answers the question.
- **Token cache.** The gateway caches the exchanged token (in-process + KV);
  a direct probe doesn't share that cache, so each fresh probe pays one
  `/copilot_internal/v2/token` round-trip.

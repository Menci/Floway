---
name: probing-copilot
description: Use when probing GitHub Copilot upstream behavior directly. Pulls a
  usable Copilot credential from D1, exchanges the PAT for a short-lived Copilot
  token and its data-plane endpoint, and calls that endpoint with the headers
  Copilot Chat sends. Never routes through our gateway; never asks the human for
  credentials. Mid-task probes belong in a subagent.
---

# Probing Copilot

Calls the Copilot upstream the way Copilot Chat does, against an account we
already own.

## Pick a credential and egress candidate

1. Read `<DB_NAME>` from `wrangler.jsonc`
   (`d1_databases[0].database_name`).
2. Run the fallback inventory query below against production. Production is the
   default because the probe must mirror the real account and its ordered proxy
   fallback list. Only fall back to local D1 when production is unreachable or
   the probe is specifically validating a local-only seed.
3. Pick any returned upstream unless the probe needs a specific one, in which
   case select it by `id` or `name`. For the runtime location being mirrored,
   discard only the entries whose non-NULL `fallback_colos` omits that location.
   A NULL `fallback_colos` is an unrestricted entry that runs in every colo, and
   those are the entries production normally carries. Stored colo codes are
   uppercased on write and the dial-time location is uppercased on read, so
   uppercase both sides before comparing by hand. Production attempts the
   remaining rows with NULL `active_backoff_expires_at` in fallback order, then
   retries the active-backoff rows in fallback order. If every persisted entry is
   excluded, record that production collapses the list to an implicit
   `direct_connect` before probing.
4. Treat the PAT as a secret: do not echo it into commit messages, code comments,
   or the chat transcript.

### Fallback inventory query

Return one row per fallback entry instead of selecting the first proxy row that
happens to join. An empty persisted list is expanded to the runtime's implicit
`direct_connect` candidate so direct egress is always visible.

The query carries both single-quoted SQL literals and a double-quoted JSON
literal, so no inline shell quoting survives it. Feed it to `--command` through a
quoted heredoc, which passes the bytes through unexpanded:

```bash
pnpm wrangler d1 execute <DB_NAME> --remote --command "$(cat <<'SQL'
SELECT u.id,
       u.name,
       json_extract(u.config_json, '$.githubToken') AS github_token,
       CAST(j.key AS INTEGER) AS fallback_index,
       json_extract(j.value, '$.id') AS fallback_id,
       json_extract(j.value, '$.colos') AS fallback_colos,
       p.url AS proxy_url,
       b.expires_at AS active_backoff_expires_at
FROM upstreams u
JOIN json_each(
  CASE
    WHEN json_array_length(u.proxy_fallback_list_json) = 0
      THEN '[{"id":"direct_connect"}]'
    ELSE u.proxy_fallback_list_json
  END
) AS j
LEFT JOIN proxies p
  ON p.id = json_extract(j.value, '$.id')
LEFT JOIN proxy_upstream_backoffs b
  ON b.proxy_id = json_extract(j.value, '$.id')
 AND b.upstream_id = u.id
 AND b.expires_at > CAST(strftime('%s', 'now') AS INTEGER)
WHERE u.provider = 'copilot' AND u.enabled = 1
ORDER BY u.sort_order, u.id, CAST(j.key AS INTEGER);
SQL
)"
```

## Route through the selected fallback

Use the same selected fallback for both the GitHub token exchange and the
Copilot data-plane call. If an attempt fails and the probe is meant to exercise
fallback behavior, advance in the same order; never substitute direct egress
unless the selected entry is explicitly `direct_fetch` or `direct_connect`.

- `direct_fetch`, `direct_connect` — direct egress is intentional and visible in
  the query result.
- `http://`, `https://` — curl-native; use `curl -x "$proxy_url" …`.
- `socks5://` — Floway sends the target hostname to the proxy for resolution,
  while curl resolves it locally under this scheme. Convert it before use with
  `curl_proxy_url="socks5h://${proxy_url#socks5://}"`, then run
  `curl -x "$curl_proxy_url" …` so the probe follows the production DNS path.
- `ss://`, `trojan://`, `vless://` — curl cannot speak these. Use a throwaway
  script outside the repository with the current `@floway-dev/proxy` dialer, or
  report that a faithful probe is blocked. Do not go direct.
- A non-built-in `fallback_id` with NULL `proxy_url` is a dangling reference to a
  deleted proxy row. Production records it as a dial failure for that entry alone
  and advances to the next entry in the list, so do the same, and report the
  dangling reference.

## Exchange the PAT

Always exchange against the fixed GitHub management-plane endpoint:

`GET https://api.github.com/copilot_internal/v2/token`

Do not append the exchange path to a Copilot data-plane host. Send the headers
from `githubHeaders` in `packages/provider-copilot/src/auth.ts`:

```
authorization: token <PAT>
accept: application/json
user-agent: GitHubCopilotChat/<COPILOT_VERSION>
x-github-api-version: <GITHUB_API_VERSION>
x-vscode-user-agent-library-version: electron-fetch
```

The management-plane `x-github-api-version` is GitHub's REST version, not the
Copilot data-plane version. The exchange returns
`{ token, expires_at, refresh_in, endpoints: { api } }`. The method is GET, not
POST — POST returns 404 from this endpoint.

Use `endpoints.api` only as the data-plane base URL. Keep it with the exchanged
token and refresh both together when the token expires; do not infer or hardcode
the host.

## Call the upstream

Append one of these paths to the `endpoints.api` base URL (host root, no API
prefix):

- `/models`
- `/chat/completions` (OpenAI Chat)
- `/responses` (OpenAI Responses)
- `/v1/messages`, `/v1/messages/count_tokens` (Anthropic-shaped)
- `/embeddings`

Required data-plane headers — matching VSCode Copilot Chat. Diverging makes the
probe non-representative; missing them produces opaque 400/403s.

```
Authorization: Bearer <exchanged-token>
Content-Type: application/json
editor-version: vscode/<VSCODE_VERSION>
editor-plugin-version: copilot-chat/<COPILOT_VERSION>
editor-device-id: <uuid>                    # stable for the probe process
user-agent: GitHubCopilotChat/<COPILOT_VERSION>
x-github-api-version: <COPILOT_API_VERSION>
x-vscode-user-agent-library-version: electron-fetch
x-request-id: <uuid>                        # same UUID for both request ids
x-agent-task-id: <same-uuid>                # regenerate the pair per request
copilot-integration-id: vscode-chat
openai-intent: conversation-agent
x-interaction-type: conversation-agent
```

`packages/provider-copilot/src/auth.ts` is the source of truth for both header
sets, their distinct version constants, extraction of `endpoints.api`, and
data-plane dispatch in `copilotAuthedFetch`. Read the current values and flow
from there rather than hardcoding them in probe scripts. For Messages probes
needing Claude beta features, also send `anthropic-beta: <feature-list>`.

## Constraints

- **Never go through our gateway.** No `pnpm run dev`, no deployed Worker. Hit
  the token-advertised Copilot data-plane endpoint directly.
- **Don't write probe code into the repo** unless the human asks. One-shot
  `curl` or a throwaway script outside the working tree is enough.
- **Mid-task probes use a subagent.** Probes dump noisy request/response bodies;
  dispatch a read-only subagent and have it report only the observation that
  answers the question.
- **Token cache.** The gateway uses a 60-second in-process memo keyed by upstream
  id, backed by the per-upstream `state_json.copilotToken` value in `upstreams`.
  A direct probe shares neither layer, so each fresh probe pays one
  `/copilot_internal/v2/token` round-trip.

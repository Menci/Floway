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

## Pick a credential

1. Read `<DB_NAME>` from `wrangler.jsonc`
   (`d1_databases[0].database_name`).
2. Query enabled Copilot upstreams against production
   (`pnpm wrangler d1 execute <DB_NAME> --remote --command "..."`). Production
   is the default because we want to mirror the real account, including its
   proxy chain. Only fall back to local D1 when production is unreachable
   or the probe is specifically validating a local-only seed.

   The query also pulls the first proxy URL from the upstream's
   `proxy_fallback_list_json` so the probe can route through the same egress
   production uses for this account:

   ```sql
   SELECT u.id, u.name,
          json_extract(u.config_json, '$.githubToken') AS github_token,
          (SELECT p.url FROM proxies p, json_each(u.proxy_fallback_list_json) j
           WHERE json_extract(j.value, '$.id') = p.id
           ORDER BY j.key
           LIMIT 1) AS proxy_url
   FROM upstreams u
   WHERE u.provider = 'copilot' AND u.enabled = 1;
   ```

3. Pick any returned row unless the probe needs a specific upstream, in which
   case select it by `id` or `name`. Don't ask the human.
4. Treat the PAT as a secret: do not echo it into commit messages, code
   comments, or the chat transcript.

## Route through the upstream's proxy

If `proxy_url` came back non-null, pass it as curl's `-x` so both the
token exchange and the upstream call traverse the same egress production
uses. `api.github.com` is not geo-restricted for token exchange, but
keeping a single egress path makes the probe a faithful mirror and avoids
mismatched IP reputations.

- `http://`, `https://`, `socks5://` — curl-native; use `curl -x "$proxy_url" …`.
- `ss://`, `trojan://`, `vless://` — only our `@floway-dev/proxy` dialers
  speak these; curl cannot. Skip the proxy and go direct, and call that
  out in the probe report so the human knows the probe doesn't share
  egress with production.

Token exchange is not bound to the data-plane host; the same `-x` applies
to the `api.github.com` call.

## Exchange the PAT

`GET https://api.github.com/copilot_internal/v2/token` with
`authorization: token <PAT>` returns
`{ token, expires_at, refresh_in, endpoints: { api } }`. The method is GET,
not POST — POST returns 404 from this endpoint.

Use `endpoints.api` from that response as the data-plane base URL. Keep it
with the exchanged token and refresh both together when the token expires
(usually after about 30 minutes); do not infer or hardcode the host.

## Call the upstream

Append one of these paths to the `endpoints.api` base URL (host root, no API
prefix):

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

`packages/provider-copilot/src/auth.ts` is the source of truth for the
version constants, the per-request header set, extraction of `endpoints.api`,
and data-plane dispatch in `copilotAuthedFetch`. Read the current values and
flow from there rather than hardcoding them in probe scripts. For Messages
probes needing Claude beta features, also send
`anthropic-beta: <feature-list>`.

## Constraints

- **Never go through our gateway.** No `pnpm run dev`, no deployed Worker.
  Hit the token-advertised Copilot data-plane endpoint directly.
- **Don't write probe code into the repo** unless the human asks. One-shot
  `curl` (or a throwaway script piped through `jq`) is enough.
- **Mid-task probes use a subagent.** Probes dump noisy request/response
  bodies; dispatch a read-only subagent and have it report only the
  observation that answers the question.
- **Token cache.** The gateway caches the exchanged token (in-process + KV);
  a direct probe doesn't share that cache, so each fresh probe pays one
  `/copilot_internal/v2/token` round-trip.

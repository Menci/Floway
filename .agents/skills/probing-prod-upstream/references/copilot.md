# Copilot upstream access

Read this only after the explicit probe authorization required by
[probing-prod-upstream](../SKILL.md). For the selected upstream, extract
`config_json.githubToken` and `config_json.githubHost`; reuse an unexpired
`state_json.copilotToken` when available. Otherwise exchange the GitHub PAT
as described below. This exchange does not use an OAuth refresh token.

## Exchange the PAT

Read the management-plane URL construction in `packages/provider-copilot/src/auth.ts`
for the configured GitHub host. For github.com, the token exchange endpoint is:

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
token. If it expires, exchange the PAT again and keep the new endpoint and token
together; do not infer or hardcode the data-plane host.

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
from there rather than hardcoding them in probe scripts. For Anthropic Messages probes
needing Claude beta features, also send `anthropic-beta: <feature-list>`.

## Token cache

The gateway uses a 60-second in-process memo keyed by upstream id, backed by
`state_json.copilotToken`. A direct probe shares neither cache; keep any
PAT-exchange result in probe-process memory and never write it back to production.

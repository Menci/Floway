---
name: probing-prod-upstream
description: Probe a production upstream directly only when the human explicitly
  requests a probe. Read the selected upstream's production configuration and
  existing access credential, reproduce its proxy fallback route, and follow
  the owning provider's wire behavior. Never use refresh tokens.
---

# Probing Production Upstreams

## Authorization and token renewal

The human must explicitly request an upstream probe before any production
upstream configuration or credential is read, or any probe is sent. A request
to investigate, audit, debug, review, or edit this skill does not grant that
authorization. Keep configuration reads and calls within the requested probe's
provider, account, and behavior scope. Until authorized, use repository code
and non-production fixtures only.

**Never use a production refresh token.** An independent refresh can rotate the
refresh token and leave production holding an invalid predecessor, interrupting
production token renewal. This is a production continuity constraint. Do not
extract refresh tokens, invoke refresh endpoints, call automatic-refresh helpers
(including `ensureCodexAccessToken` and `ensureClaudeCodeAccessToken`), or route
through a gateway operation that may trigger renewal. For providers with
refresh-token renewal, use the existing access token. If it is missing, expired,
or rejected, stop probing that account and report the blocker; let production
own renewal. Never write probe credentials
or token state back to production.

## Select the upstream and egress

After authorization:

1. Read the D1 database name from `wrangler.jsonc`
   (`d1_databases[0].database_name`), and follow the `wrangler` skill before
   running Wrangler commands.
2. Inventory only upstreams within the requested scope. The query below lists
   enabled upstreams and fallback routes without credentials; narrow its `WHERE`
   clause by the requested provider or upstream id before running it. Pass the
   SQL through a quoted heredoc to preserve SQL and JSON quoting:

   ```bash
   pnpm wrangler d1 execute <DB_NAME> --remote --command "$(cat <<'SQL'
   SELECT u.id,
          u.name,
          u.provider,
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
   WHERE u.enabled = 1 AND u.id = '<UPSTREAM_ID>'
   ORDER BY u.sort_order, u.id, CAST(j.key AS INTEGER);
   SQL
   )"
   ```

3. Read the owning provider's `config.ts`, `state.ts` when present, and fetch
   implementation under `packages/provider-<kind>/src/`. Extract only the chosen
   upstream's endpoint, existing access token or API key, expiry, and required
   account/header fields with targeted `json_extract` expressions. Do not select
   entire credential-bearing config/state documents. Keep credentials and proxy
   URLs containing credentials out of the chat transcript, comments, and commits.
4. For the runtime location being mirrored, discard entries whose non-NULL
   `fallback_colos` omits that location, comparing codes in uppercase. NULL means
   unrestricted. Attempt rows without active backoff in fallback order, followed
   by active-backoff rows in fallback order. If all persisted entries are
   excluded, production uses an implicit `direct_connect`; record that fact.
   An empty persisted list is already expanded by the query.

Production is the target of this skill. If it is unreachable, report that the
production probe is blocked; a local fixture cannot establish production behavior.

## Reproduce the selected route

Use the same selected fallback for any permitted credential exchange and the
data-plane call. When exercising fallback, advance in production order.

- `direct_fetch`, `direct_connect`: direct egress is intentional.
- `http://`, `https://`: use `curl -x "$proxy_url"`.
- `socks5://`: Floway resolves the target through the proxy. Convert the URL with
  `curl_proxy_url="socks5h://${proxy_url#socks5://}"` and use
  `curl -x "$curl_proxy_url"` to match that DNS path.
- `ss://`, `trojan://`, `vless://`: use the current `@floway-dev/proxy` dialer in
  a throwaway script, or report that faithful probing is blocked. Do not
  substitute direct egress.
- A non-built-in `fallback_id` with NULL `proxy_url` is a dangling reference.
  Record its dial failure and advance, matching production.

## Call the owning provider

Derive the URL, API path, authentication, beta/version headers, and account
identity from the current provider implementation and selected configuration.
Do not import a provider entrypoint that can renew tokens or persist state.

- **Copilot:** follow [the Copilot access reference](references/copilot.md) for
  PAT exchange, token-advertised endpoints, and Copilot Chat headers.
- **Codex / Claude Code:** use the selected account's persisted
  `state_json.accounts[].accessToken.token` and its expiry. Read `fetch.ts` and
  the protocol transport for headers and endpoints; join the credential to the
  configured account identity. All refresh-token paths remain forbidden.
- **Custom / Azure / Ollama:** read `config.ts` and the protocol fetch functions
  for the configured endpoint, API key or bearer, and custom headers. Preserve
  operator-configured paths and protocol choices.

Call the upstream directly, never a deployed Floway endpoint or a local gateway.
Keep the request limited to the behavior the human asked to probe. Report the
observed status, relevant response fields, and account/model coverage without
exposing credentials.

## Probe execution

Use one-shot `curl` or a temporary script; do not add probe code to tracked
sources unless requested. Remove temporary files when finished.

Mid-task probes belong in a read-only subagent so noisy request/response bodies
stay out of the parent context. Pass the explicit human authorization, requested
scope, and no-refresh constraint into its task. Tell it not to create further
subagents and to return only observations answering the probe question.

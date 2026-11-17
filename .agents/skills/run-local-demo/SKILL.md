---
name: run-local-demo
description: Start, inspect, and stop a local Floway demo from the current worktree. Use when a human asks for a local demo instance, a live dashboard, an end-to-end local check, or a review instance that should remain available during a task.
---

# Run a Local Demo

Keep one local instance per worktree. The instance comprises a Node gateway and
the web dashboard served by Vite. Its state lives in `.tmp/run-local-demo/`
inside that worktree; never reuse another worktree's state or ports.

## Start

1. Work from the root of the checkout that contains the change being reviewed.
2. Run the launcher with the default Node runtime:

   ```bash
   pnpm --silent --filter @floway-dev/tools run local-demo up
   ```

   Use `--runtime workerd` only when the task specifically exercises behavior
   that exists on Cloudflare Workers and cannot be observed through Node. Do not
   choose workerd for ordinary dashboard, control-plane, API, provider, or
   translation work.

3. Keep the launcher's live output attached while it starts. It prints the
   dashboard URL, the API origin, and the authentication mode after it has
   verified all of them. If it exits unsuccessfully, read the diagnostic and
   fix the instance rather than reporting a guessed URL.
4. Open the printed dashboard URL before describing the demo as available.

The launcher initially starts with an empty `ADMIN_KEY` on both runtimes. On the
default Node runtime, login uses a blank username and a blank password. It
stores state and logs under `.tmp/run-local-demo/`, which is ignored by Git.

### Workerd fallback

The launcher first verifies empty-password login for workerd too. Only if that
request is rejected does it generate a random admin key, restart the instance
with that key, verify login, and print the full key. Treat its printed
`admin_key` value as a credential for the human. When the key is non-empty,
every task update that mentions the running instance must include both the URL
and the complete key value in the message. Never replace the value with a path,
a redacted form, or an instruction to inspect a file.

## Report while running

Before each work update, run:

```bash
pnpm --silent --filter @floway-dev/tools run local-demo status
```

If the instance is running, include its dashboard URL in that update. Include
the full admin key whenever `status` reports a non-empty one. Continue doing
this for every update until the instance stops, including updates about
unrelated implementation work in the same task. Report the key only in the
conversation and logs required by this workflow; never commit it.

Use the same command to detect an unexpectedly stopped process. Start it again
only when the task still needs a live instance.

## Stop and clean up

Stop the instance when the task ends, before handing off a completed task, or
after the pull request is merged:

```bash
pnpm --silent --filter @floway-dev/tools run local-demo stop
```

Run `stop` in a `finally`-style sequence even when verification fails. It
terminates only the process groups recorded in this worktree's state file,
waits for them to exit, and removes the run directory. Do not kill processes by
port or executable name, because those can belong to another checkout.

## Runtime details

- The default gateway command is
  `pnpm --filter @floway-dev/platform-node exec tsx entry.ts`, run from
  `apps/platform-node`. It serves the gateway on `127.0.0.1:8788` by default.
- The default web command is `pnpm --filter @floway-dev/web run dev`. Vite
  proxies gateway-owned paths to `FLOWAY_DEV_GATEWAY_ORIGIN` and listens on
  `FLOWAY_DEV_WEB_PORT`, defaulting to `5174`.
- The launcher allocates ports from the requested base and refuses occupied
  ports instead of attaching to an unknown process. Pass `--web-port` or
  `--gateway-port` when a specific pair is needed.
- The Node runtime uses a private SQLite database and files directory under
  the run directory. It sets `NODE_ENV=development` so empty `ADMIN_KEY` login
  is permitted. Do not use the demo launcher for production.
- `workerd` runs through `wrangler dev` with a generated local Wrangler config.
  It starts with an empty `ADMIN_KEY` and uses the fallback above when the
  runtime rejects that login. It is a local demo only; Cloudflare deployment
  belongs to `$deploy-to-cloudflare`.

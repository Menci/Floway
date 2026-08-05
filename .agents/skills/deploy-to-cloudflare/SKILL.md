---
name: deploy-to-cloudflare
description: Deploy Floway to Cloudflare Workers through its checked-in Wrangler configuration. Use whenever the user mentions a Cloudflare deployment, including deployment planning, a routine production update, a first deployment, rollback preparation, or post-deploy checks. Default an actual deployment to the routine update flow; enter the first-deployment flow only when the user explicitly identifies it as new or confirms that it is new after `wrangler.jsonc` is found missing.
---

# Deploy to Cloudflare

Announce an actual production deployment once before inspecting remote state. Continue autonomously after the announcement, pausing only for the breaking-change confirmation defined below or for a failure that requires human judgment.

Treat git as read-only when deployment is the entire user request. Read repository state freely; keep commits, pulls, pushes, rebases, merges, checkouts, resets, stashes, and branch or tag changes outside that deployment run.

Run Wrangler through `pnpm wrangler` and preserve its live terminal output. Read `wrangler.jsonc` for the Worker name and the D1 `database_name` before substituting command placeholders.

## Select the flow

1. Check whether `wrangler.jsonc` exists at the repository root.
2. Use the routine update flow when it exists, unless the user explicitly requested a new deployment.
3. Ask whether this is a new deployment when it is absent and the user has not already said so. Continue with first-deployment preparation after confirmation.
4. Enter the first-deployment flow directly when the user explicitly requested a new deployment.
5. Treat authentication, network, and generic Wrangler failures as failures. An explicit Worker-not-found result may corroborate a first deployment; it does not replace the selection rules above.

## Prepare a first deployment

1. Run `pnpm install --frozen-lockfile` and `pnpm wrangler whoami`.
2. Copy `wrangler.example.jsonc` to the gitignored root `wrangler.jsonc` when it is absent.
3. Resolve every `<YOUR_*>` value using the target account and resource names supplied by the user. Create the D1 database, R2 bucket, and KV namespace with Wrangler when they do not exist, then write their returned identifiers into `wrangler.jsonc`.
4. Run `pnpm jiti scripts/check-wrangler.ts`.
5. Run `pnpm wrangler deployments status --json`. Continue only when Wrangler explicitly reports that the configured Worker does not exist. Stop when it reports an existing deployment or any authentication, network, account, or ambiguous failure.
6. Run `pnpm run build:web`, because the shared Wrangler configuration includes `apps/web/dist/client` as its Static Assets directory.
7. Publish the bootstrap probe while retaining the final Worker name, bindings, Durable Object migration, assets, cron, and routes. This first version installs the configured `new_sqlite_classes` migration:

   ```bash
   pnpm wrangler deploy .agents/skills/deploy-to-cloudflare/assets/binding-probe.js \
     --config wrangler.jsonc --strict \
     --message "Initial binding bootstrap before $(git rev-parse --short HEAD)"
   ```

8. Publish the same probe a second time after the Durable Object migration exists. This creates the version used for end-to-end binding verification:

   ```bash
   pnpm wrangler deploy .agents/skills/deploy-to-cloudflare/assets/binding-probe.js \
     --config wrangler.jsonc --strict \
     --message "Initial binding verification before $(git rev-parse --short HEAD)"
   ```

   The bootstrap upload establishes the Worker service and atomically applies its initial Durable Object class migration. Re-uploading the same probe through Wrangler's existing-Worker/no-pending-migration path makes the same-worker namespace callable before it is used as evidence. This is Floway's experimentally validated workaround for current upstream behavior, not a documented platform requirement. Wrangler 4.81 selects those two upload paths from Worker existence and pending migrations: [deployment branch](https://github.com/cloudflare/workers-sdk/blob/36c2c130b991743ff203a31aff007850f08acb95/packages/wrangler/src/deploy/deploy.ts#L924-L939), [legacy migration upload](https://github.com/cloudflare/workers-sdk/blob/36c2c130b991743ff203a31aff007850f08acb95/packages/wrangler/src/deploy/deploy.ts#L1091-L1115), and [existing-Worker version upload](https://github.com/cloudflare/workers-sdk/blob/36c2c130b991743ff203a31aff007850f08acb95/packages/wrangler/src/deploy/deploy.ts#L1033-L1058).

9. Read the deployed workers.dev URL from the second Wrangler result. Request its Worker-first probe path with bounded retries:

   ```bash
   curl --fail-with-body --include --retry 5 --retry-all-errors --retry-delay 2 \
     <DEPLOYED_ORIGIN>/api/deployment-probe
   ```

10. Require HTTP 200, the exact body `Hello World`, and `x-floway-binding-probe: DB,FILES,IMAGES,KV,BROADCAST_DO`. The probe performs a D1 query, an R2 read, a KV read, an Images inspection, and a Durable Object request. Stop before migrations when any check fails.
11. Set `ADMIN_KEY` with `pnpm wrangler secret put ADMIN_KEY`; accept the value only through Wrangler's secret prompt or redirected secure input. Confirm its name in `pnpm wrangler secret list`.
12. Continue with the deployment-state collection below. Treat the probe deployment as the current code version and omit the historical Floway `CHANGELOG.md` diff because no previous Floway deployment exists at this Worker name.

## Collect deployment state

Run all three commands and read their complete output:

```bash
pnpm wrangler deployments status --json
pnpm wrangler d1 migrations list <DB_NAME> --remote
pnpm wrangler d1 execute <DB_NAME> --remote --json \
  --command 'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1'
```

For a routine update, read the active version id, active deployment timestamp, and `workers/message` deploy annotation from the status JSON. The deploy message is normally the short commit revision stamped by `pnpm run deploy`.

Read every pending migration from `migrations list` and the latest applied migration from the `d1_migrations` query. An empty query result means no migration has been applied.

## Evaluate deployment notes for an update

Diff the human-owned deployment notes from the active revision:

```bash
git diff <PREVIOUS_COMMIT_REV> -- CHANGELOG.md
```

Treat the entire current `CHANGELOG.md` as potentially new when the active deployment has no recognizable commit message and the database has applied migrations. Classify new entries by their `## YYYY-MM-DD · hard|minor|advisory` heading.

Combine consecutive entries affecting the same area into their net user-facing effect. Present all new `hard` and `minor` effects as intentional breaking changes and wait for explicit confirmation. Collect recommended operations from every level for the post-deploy report. Continue immediately when there are no new `hard` or `minor` entries.

## Stage rollback

Report the active version, deployment time, latest applied migration, and pending migrations before publishing Floway.

When migrations are pending, capture the current D1 state:

```bash
pnpm wrangler d1 time-travel info <DB_NAME> --json
```

Read the bookmark from the JSON output and report this paste-ready database restore command:

```bash
CI=1 pnpm wrangler d1 time-travel restore <DB_NAME> --bookmark <BOOKMARK>
```

For a routine update, also report this code rollback command using the pre-update version:

```bash
CI=1 pnpm wrangler rollback <PREVIOUS_VERSION_ID> -m "Emergency rollback"
```

For a first deployment, identify the probe version as the only code fallback and explain that it serves only the deployment probe. The database bookmark remains the state rollback whenever migrations are pending.

## Publish Floway

Print the exact applicable command before running it. State that rerunning the same command recovers safely after a partial failure because remote D1 migration application is idempotent and Wrangler republishes the current code.

Use the chained command when migrations are pending:

```bash
pnpm run db:migrate:remote && pnpm run deploy
```

Use the deploy command when no migration is pending:

```bash
pnpm run deploy
```

Read the successful Wrangler result before reporting that Floway is live. Report every recommended operation collected from `CHANGELOG.md`. Perform read-only checks within scope; obtain authority before each unrequested state-changing follow-up.

## Shape human-requested deployment notes

Edit `CHANGELOG.md` only when the human explicitly requests exact content. Prepend entries below its header, keeping each paragraph on one line:

```markdown
## YYYY-MM-DD · hard|minor|advisory

### Short title

Description
```

Use `hard` for changes affecting all users, `minor` for changes affecting a bounded integration or behavior, and `advisory` for a concrete deployment operation that preserves existing behavior. Ask the human to choose the level when it was not supplied. State an advisory's action, reason, and scope.

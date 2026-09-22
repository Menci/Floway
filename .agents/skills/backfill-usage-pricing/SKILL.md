---
name: backfill-usage-pricing
description: Inspect, plan, and apply usage.unit_price backfills against a Floway Node SQLite database or Cloudflare D1. Use when filling NULL usage prices or correcting a selected historical usage range.
---

# Backfill Usage Pricing

Use `pnpm --silent tools:backfill-usage-pricing`. The CLI is non-interactive and emits
versioned JSON. Never bypass it with handwritten SQL or manually transcribed
scalar rates.

## Workflow

1. Announce the database target and environment. Use the Node database path for
   Node deployments. For D1, specify `--remote` or `--local`; production D1 is
   `--remote`.
2. Inspect enabled upstreams and grouped NULL-price slices:

   ```bash
   pnpm --silent tools:backfill-usage-pricing inspect --database node --database-path <path>
   pnpm --silent tools:backfill-usage-pricing inspect --database d1 --remote --binding DB
   ```

3. Establish the exact upstream ID, public model, wire model key, half-open UTC
   hour range, human timezone, metrics, and write mode. Use `fill` to change only
   NULL prices and `overwrite` to replace prices throughout the selected slice.
4. Create a plan inside the repository:

   ```bash
   pnpm --silent tools:backfill-usage-pricing plan \
     --database d1 --remote --binding DB \
     --upstream <id> --model <public-id> --model-key <wire-id> \
     --start-hour <YYYY-MM-DDTHH> --end-hour <YYYY-MM-DDTHH> \
     --timezone <IANA-timezone> --mode <fill-or-overwrite> \
     --metric <metric> --output .tmp/backfill-usage-pricing/<name>.json
   ```

5. Read the complete plan. Report its database identity, plan ID, pricing
   source, selected and affected row counts, selector/metric/rate operations,
   skipped metrics, expected remaining NULL rows, and blockers. Do not apply a
   blocked plan.
6. Treat a production apply as a deploy-grade mutation. Obtain authorization
   for the exact plan when the user's request did not already authorize that
   production write.
7. Apply only the saved plan:

   ```bash
   pnpm --silent tools:backfill-usage-pricing apply --plan .tmp/backfill-usage-pricing/<name>.json
   ```

8. Report every verified operation, total rows updated, and remaining NULL
   rows. Delete the temporary plan after successful verification.

The CLI refuses stale or modified plans, catalog ambiguity, historical selector
drift, database identity changes, and schema mismatches. A missing metric rate
remains NULL; a non-NULL aggregate cost does not prove the slice is fully
priced.

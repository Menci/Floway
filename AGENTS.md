# Repository Agent Protocol

## Requirements

| Scope | Requirement | Enforcement |
|---|---|---|
| Protocol shape | Keep this file as the two tables named `Requirements` and `Index`. | `pnpm run check:agent-protocol` |
| Task scope | Derive every action from the user's request and preserve unrelated working-tree state. | Final diff review |
| Questions | Answer requested questions from read-only evidence. | Final diff review |
| Findings | Reproduce the reported scenario and validate third-party findings against primary sources before acting. | Investigation evidence |
| Instruments | Establish that every verifier ran, observed the relevant property, and reached the state it claims to force. | Verification output |
| Tool edits | Read generated, autofixed, codemodded, and bulk-edited diffs against the resulting files. | Final diff review |
| Fix design | Restore the requested behavior and make the defect class structurally unable to recur. | Tests and final diff review |
| Replacement work | Preserve the replaced surface's behavior unless the user explicitly removes it. | Tests and compatibility review |
| Iterative fixes | Rebuild a degrading fix from the requirement after three unsuccessful patch iterations. | Final diff review |
| Error behavior | Propagate failures with their original error or error chain and expose invalid state through tests, startup, or request failure. | Tests and runtime boundaries |
| `main` delivery | Require the human's explicit permission for the exact commit before pushing it to `main`; apply each permission to the current local state only. | Human gate |
| `main` history | Keep `main` linear through fast-forward, rebase, or squash; preserve PR references in squash commits. | Git history review |
| Force push | Use `--force-with-lease` against the known remote commit and obtain renewed authority after a lease failure. | Git command and human gate |
| Work branches | Commit every worktree change immediately, push commits promptly, and merge `main` into the branch when updating it. | Git status and history |
| Commit identity | Use the repository's default Git identity, preserve author and committer metadata during rewrites, and omit AI co-author trailers. | Commit review |
| Pull request creation | Create or modify a Pull Request when the user's request includes Pull Request work. | Human request |
| Pull request merge | Require the human's explicit permission for the exact Pull Request before merging it. | Human gate |
| Stacked Pull Requests | Keep dependent Pull Requests draft and targeted at their predecessor; retarget and publish each one when all dependencies reach `main`. | Pull Request state |
| `CHANGELOG.md` | Apply only the exact content the human requests and otherwise leave the file untouched. | Human request and final diff review |
| Completion | Run and read every verification selected by the owning configuration before claiming completion. | Verification output |
| Test placement | Place package tests and test-only support under `__tests__/` mirroring production directories; keep root verifier entrypoints and `@floway-dev/test-utils` in their owning production locations. | Vitest configs and repository review |
| Generated files | Give every checked-in generator output a `.generated.` filename infix and keep generated and vendored attributes aligned. | `.gitattributes` and drift checks |
| Current concepts | Keep code, comments, tests, and documentation expressed in the current architecture; preserve historical names only in migrations. | Repository search and final diff review |
| Product name | Write **Floway** in prose, comments, test names, assertions, and logs; use lowercase `floway` only in established technical contracts. | Repository review |
| Gateway behavior | Preserve upstream status, headers, and body directly and surface internal failures with stack traces. | Data-plane tests |
| Upstream-owned values | Derive endpoint capability from metadata and operator configuration, forward open-string protocol values verbatim, and keep vendor knowledge inside the owning provider. | Protocol, translation, and provider tests |
| Vendor constants | Attach a reference URL to every vendor constant and wire workaround. | Owning code review |
| Upstream research | Compare a Copilot quirk with another Copilot gateway; compare generic adapter behavior with both a Copilot gateway and a general LLM gateway. | Research evidence |
| Workspace dependencies | Keep foundation packages runtime-independent and preserve the dependency direction encoded by workspace manifests and ESLint. | Package manifests, ESLint, and typecheck |
| Cross-package imports | Reach runtime code through declared package exports and keep platform-target apps isolated from one another. | ESLint |
| Runtime composition | Keep deployment-specific implementations and entrypoints in `apps/platform-*` and portable contracts in `packages/platform`. | Package manifests and typecheck |
| Browser boundary | Keep `apps/web` runtime imports browser-safe and gateway imports type-only through declared exports. | ESLint and web build |
| Fluent boundary | Import Fluent values through `apps/web/src/fluent.ts`, place generic controls under `components/ui/`, and keep domain imports outside those controls. | ESLint and component tests |
| WinUI derivation | Ground WinUI values and intentional departures in permalinks at their owning rules. | UI source review |
| Localization | Route user-visible strings through the typed i18n boundary and keep `en` and `zh-Hans` resources structurally equivalent. | ESLint and locale tests |
| Cloudflare deployment | Load and follow `$deploy-to-cloudflare` whenever the user mentions a Cloudflare deployment. | `.agents/skills/deploy-to-cloudflare/SKILL.md` |

## Index

| Scope | Canonical source |
|---|---|
| Project use and operator setup | `README.md` |
| Workspace commands | `package.json` |
| Continuous verification | `.github/workflows/verify.yaml` |
| TypeScript projects | `tsconfig.base.json`, `tsconfig.scripts.json`, and package `tsconfig.json` files |
| Lint boundaries | `eslint.config.ts` |
| Test discovery | `vitest.config.ts` and package `vitest.config.ts` files |
| Workspace dependency graph | `pnpm-workspace.yaml` and package manifests |
| Protocol contracts | `packages/protocols` |
| Protocol translation | `packages/translate` |
| Provider contracts | `packages/provider` |
| Provider implementations | `packages/provider-*` |
| Gateway composition | `packages/gateway` |
| Model catalog resolution and refresh coordination | `packages/gateway/src/data-plane/providers` and `packages/gateway/src/repo/models-refresh-contract.ts` |
| Portable runtime contracts | `packages/platform` |
| Deployment runtimes | `apps/platform-*` |
| Dashboard | `apps/web` |
| Agent Setup generation | `packages/agent-setup/scripts/generate-assets.ts` |
| Database migrations | `packages/gateway/migrations` |
| Wrangler configuration shape | `wrangler.example.jsonc` and `scripts/check-wrangler.ts` |
| Cloudflare deployment | `$deploy-to-cloudflare` |
| Copilot upstream probing | `$probing-copilot` |
| Copilot workaround audit | `$audit-copilot-workarounds` |
| Model pricing research | `$fetching-models-pricing` |
| Recorded usage repricing | `$backfill-model-pricing` |

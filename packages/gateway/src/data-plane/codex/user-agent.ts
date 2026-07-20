// Codex uses `codex_cli_rs/<version>` for the normal CLI/TUI client and
// `codex_exec/<version>` for exec-mode requests. Keep both products anchored
// at the start of the User-Agent so wrappers that merely mention Codex do not
// receive its private models catalog.
//
// Official `codex_cli_rs` identity and wire shape:
// https://github.com/openai/codex/blob/687f05cb946d10c96f90dd7ce82e11465c6e20a7/codex-rs/login/src/auth/default_client.rs
// https://github.com/openai/codex/blob/687f05cb946d10c96f90dd7ce82e11465c6e20a7/.github/workflows/rust-release-prepare.yml
const CODEX_USER_AGENT = /^(?:codex_cli_rs|codex_exec)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/;

export const parseCodexVersion = (userAgent: string | undefined): string | null =>
  userAgent?.match(CODEX_USER_AGENT)?.[1] ?? null;

export const isCodexUserAgent = (userAgent: string | undefined): boolean =>
  parseCodexVersion(userAgent) !== null;

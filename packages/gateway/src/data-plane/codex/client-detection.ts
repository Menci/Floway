import type { Context } from 'hono';

const CODEX_USER_AGENT_PATTERN = /\b(?:codex_exec|codex_cli_rs)\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;

export const isCodexClientRequest = (c: Context): boolean =>
  CODEX_USER_AGENT_PATTERN.test(c.req.header('user-agent') ?? '')
  || c.req.header('originator') === 'codex_cli_rs';

import type { Context } from 'hono';

import { models } from './serve.ts';
import { codexModels } from '../codex/models.ts';
import { isCodexUserAgent } from '../codex/user-agent.ts';

export const dispatchModels = (c: Context): Promise<Response> =>
  isCodexUserAgent(c.req.header('user-agent')) ? codexModels(c) : models(c);

import type { Context } from 'hono';

import { codexModels } from '../codex/models.ts';
import { isCodexUserAgent } from '../codex/user-agent.ts';
import { models } from './serve.ts';

export const dispatchModels = (c: Context): Promise<Response> =>
  isCodexUserAgent(c.req.header('user-agent')) ? codexModels(c) : models(c);

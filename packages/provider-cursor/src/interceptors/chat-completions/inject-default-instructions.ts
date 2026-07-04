import type { ChatCompletionsBoundaryCtx } from './types.ts';

// Cursor agent runs in AGENT mode and benefits from a system prompt. Native
// chat-completions callers may omit a system message; source-protocol
// translators synthesize one only when the caller supplied it. When no system
// message is present we prepend a neutral default so every request shape
// satisfies the agent's expectation of grounded instructions.
export const injectDefaultInstructions = async <TResult>(
  ctx: ChatCompletionsBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const hasSystem = ctx.payload.messages.some(m => m.role === 'system' || m.role === 'developer');
  if (!hasSystem) {
    ctx.payload = {
      ...ctx.payload,
      messages: [
        { role: 'system', content: "You're a helpful assistant." },
        ...ctx.payload.messages,
      ],
    };
  }
  return await run();
};

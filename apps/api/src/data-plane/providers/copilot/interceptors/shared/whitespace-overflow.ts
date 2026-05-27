/**
 * Degenerate Copilot tool-call streams have been observed to emit nothing but
 * line breaks / tabs in function `arguments` until `max_tokens`, which keeps
 * the client hanging while never producing valid JSON.
 *
 * Two interceptors (Chat Completions and Responses) share this counter and
 * threshold so the defense fires the same way on both upstream shapes.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/4c0d775e1dc6b8648c7ad5f21fb783fc3246facf
 * - https://github.com/caozhiyuan/copilot-api/commit/3cdc32c0811469da9eebec5ca3892caf068df542
 */
export const MAX_CONSECUTIVE_WHITESPACE = 20;

export interface WhitespaceOverflowResult {
  count: number;
  exceeded: boolean;
}

export const checkWhitespaceOverflow = (text: string, currentCount: number): WhitespaceOverflowResult => {
  let wsCount = currentCount;
  for (const ch of text) {
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      wsCount++;
      if (wsCount > MAX_CONSECUTIVE_WHITESPACE) {
        return { count: wsCount, exceeded: true };
      }
    } else if (ch !== ' ') {
      wsCount = 0;
    }
  }
  return { count: wsCount, exceeded: false };
};

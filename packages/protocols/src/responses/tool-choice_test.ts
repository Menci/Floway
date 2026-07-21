import { expect, test } from 'vitest';

import type { ResponsesTool, ResponsesToolChoice } from './index.ts';

const builtInPairs = [
  {
    tool: { type: 'file_search', vector_store_ids: ['vs_1'] },
    choice: { type: 'file_search' },
  },
  {
    tool: { type: 'computer' },
    choice: { type: 'computer' },
  },
  {
    tool: { type: 'computer_use_preview', display_height: 768, display_width: 1024, environment: 'browser' },
    choice: { type: 'computer_use_preview' },
  },
  {
    tool: { type: 'code_interpreter', container: 'auto' },
    choice: { type: 'code_interpreter' },
  },
  {
    tool: { type: 'mcp', server_label: 'docs' },
    choice: { type: 'mcp', server_label: 'docs' },
  },
] as const satisfies ReadonlyArray<{ tool: ResponsesTool; choice: ResponsesToolChoice }>;

test('built-in tool declarations admit their forced tool choices', () => {
  expect(builtInPairs).toHaveLength(5);
});

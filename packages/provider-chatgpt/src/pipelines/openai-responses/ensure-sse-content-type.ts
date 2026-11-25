import { defineStage } from './facts.ts';
import { getHeader, setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';

// Codex responses can stream SSE with a missing or different media type.
// https://github.com/openai/codex/blob/0a2eb4696c/codex-rs/codex-api/src/sse/responses.rs
export const ensureSseContentType = defineStage({
  name: 'chatgpt.ensure-openai-responses-sse-content-type',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['response.transport'], provides: ['response.transport'], consumes: [] },
  },
  execute: transform(() => ({
    response(back) {
      const transport = back['response.transport'];
      if (!transport.ok) return back;
      const { status, headers } = transport.value;
      const contentType = getHeader(headers, 'content-type');
      if (status < 200 || status >= 300 || (typeof contentType === 'string' && isEventStreamMediaType(contentType))) return back;
      return {
        ...back,
        'response.transport': move({ ...transport, value: { ...transport.value, headers: setHeader(headers, 'content-type', 'text/event-stream') } }),
      };
    },
  })),
});

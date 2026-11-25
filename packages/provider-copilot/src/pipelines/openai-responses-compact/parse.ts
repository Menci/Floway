import { compactionResponse } from '../../compaction.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { readJsonObject } from '../shared/read-json-object.ts';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import { decodeOpenAIResponsesCompactionResult, isOpenAIResponsesCompactionItem } from '@floway-dev/protocols/openai-responses';
import { parseResultResponse } from '@floway-dev/provider';

export const parse = parseResultResponse('openaiResponsesCompact', {
  needs: ['request.openaiResponsesCompact'],
  format: formatOpenAIError,
  decode(bytes, _http, facts) {
    const parsed = readJsonObject(bytes);
    if (!parsed.ok) return parsed;
    const { output } = parsed.value;
    if (!Array.isArray(output)) return { ok: false, error: new TypeError('Expected output in the Copilot compaction trigger result') };

    const items: JsonObject[] = [];
    for (const item of output) {
      if (!isJsonObject(item) || typeof item.type !== 'string') {
        return { ok: false, error: new TypeError('Invalid item in Copilot compaction trigger result') };
      }
      if (!isOpenAIResponsesCompactionItem({ type: item.type })) continue;
      const { id, encrypted_content: state, metadata } = item;
      if ((typeof state === 'string' && (typeof id !== 'string' || id.length === 0)) || (metadata !== undefined && !isJsonObject(metadata))) {
        return { ok: false, error: new TypeError('Malformed Copilot OpenAI Responses compaction item') };
      }
      items.push(item);
    }
    if (items.length === 0) return { ok: false, error: new TypeError('Copilot compaction trigger returned no compaction item') };

    const decoded = decodeOpenAIResponsesCompactionResult({ ...parsed.value, output: items });
    if (!decoded.ok) return decoded;
    return { ok: true, value: compactionResponse(facts['request.openaiResponsesCompact'].input, decoded.value) };
  },
});

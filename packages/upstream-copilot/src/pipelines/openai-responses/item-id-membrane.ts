import { defineCopilotStage } from '../facts.ts';
import { normalizeStreamEvent, restoreInputItem, type StreamItemState } from './item-id-membrane/normalize.ts';
import { mapChanged } from '../shared/map-changed.ts';

export const itemIdMembrane = defineCopilotStage({
  name: 'copilot.openaiResponses.itemIdMembrane',
  through: {
    request: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: ['openaiResponses'], provides: ['openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts['openaiResponses'];
    const input = mapChanged(payload.input, restoreInputItem);
    const back = await scope.next(input === payload.input ? facts : { ...facts, 'openaiResponses': { ...payload, input } });
    const outcome = back['openaiResponses'];
    if (outcome.kind !== 'stream') return back;
    const stream = scope.wrapStream(outcome.stream, async function* (source, producer) {
      const state: StreamItemState = { items: new Map() };
      for await (const item of producer.read(source)) {
        yield item.ok ? { ok: true, value: normalizeStreamEvent(item.value, state) } : item;
      }
    });
    return { ...back, 'openaiResponses': { kind: 'stream', stream } };
  },
});

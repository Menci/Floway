import { defineStage } from './facts.ts';
import { compactGenerationPayload } from './generation-payload.ts';
import { syntheticEventsFromCompaction } from '../../chat/openai-responses/items/output.ts';
import { projectOpenAIResponsesCollaboration } from '../../chat/openai-responses/pipeline/collaboration.ts';

export const applyOpenAIResponsesCompactCollaboration = defineStage({
  name: 'openaiResponsesCompact.apply-collaboration-namespace',
  through: {
    request: { needs: ['openaiResponsesCompact', 'model'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: ['openaiResponsesCompact'], provides: ['openaiResponsesCompact'], consumes: [] },
  },
  async execute(facts, scope) {
    if (!facts.model.enabledFlags.includes('openai-responses-collaboration-shim')) return await scope.next(facts);
    const request = facts.openaiResponsesCompact;
    const projection = projectOpenAIResponsesCollaboration(compactGenerationPayload(request));
    if (projection === undefined) return await scope.next(facts);
    const answer = await scope.next({
      ...facts, openaiResponsesCompact: {
        ...projection.payload, ...(request.prompt_cache_options === null ? { prompt_cache_options: null } : {}),
      },
    });
    const outcome = answer.openaiResponsesCompact;
    if (outcome.kind !== 'result') return answer;
    for await (const frame of syntheticEventsFromCompaction(outcome.result)) {
      if (frame.type !== 'event' || frame.event.type !== 'response.completed') continue;
      const event = projection.restoreEvent(frame.event);
      if (event.type !== 'response.completed') throw new TypeError('Expected a projected compaction resource');
      return { ...answer, openaiResponsesCompact: { kind: 'result', result: event.response } };
    }
    throw new TypeError('Expected a compaction terminal event');
  },
});

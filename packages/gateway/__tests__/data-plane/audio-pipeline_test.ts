// Audio transcription's pipeline, assembled. `compose` derives the entry contract and
// rejects an array that cannot work, so most of what this file establishes is established
// by the module importing at all — the assembly runs at load. What is worth writing down is
// the entry contract it derives, the keys it cannot see, and the one runtime property this
// family's code is shaped around that no declaration expresses.

import { describe, expect, it } from 'vitest';

import { audioTranscriptionServePipeline } from '../../src/data-plane/audio/pipeline.ts';
import { isOwned, move, run } from '@floway-dev/pipeline';

describe('the audio transcription pipeline', () => {
  it('assembles, and asks its caller for what the descending stages need', () => {
    expect([...audioTranscriptionServePipeline.entryNeeds].sort()).toEqual([
      'ingress.audioTranscription.responseFormat',
      'serve.model',
    ]);
  });

  // The ending stage reads `request.audioTranscription.form` and `ingress.http.headers`, and
  // the entry contract mentions neither. That is not this family's defect: a stage whose only
  // trait is `return` declares no request side at all, by ruling — "when it short-circuits,
  // only `provides`" — so assembly cannot see what an ending stage reads.
  //
  // It bites harder here than it does for a family whose edge needs the request payload to
  // render: this family's edge does not, so the payload the whole endpoint exists to send is
  // among the keys assembly cannot ask for. A caller who omits it reaches the deepest stage
  // before failing. The type layer still catches it at the definition site, which is why this
  // is a gap and not a break.
  it('cannot see the request payload, because only a return-only stage reads it', () => {
    expect(audioTranscriptionServePipeline.entryNeeds).not.toContain('request.audioTranscription.form');
    expect(audioTranscriptionServePipeline.entryNeeds).not.toContain('ingress.http.headers');
  });

  it('names the entry key a caller did not bring, before any stage runs', async () => {
    await expect(run(audioTranscriptionServePipeline, move({ 'serve.model': 'whisper-1' }) as never, {}))
      .rejects.toThrow('run(audioTranscriptionServe): audioTranscriptionServe needs');
  });

  // The streamed answer is a wrapper around its generator rather than the generator itself.
  // That was once load-bearing: the runner detected ownership structurally, an async
  // generator carries `Symbol.asyncDispose`, and the sweep would have called it — which for
  // a generator is `return()`, cancelling the iteration rather than draining it.
  //
  // The runner now claims ownership through `own()` instead of detecting it, so a bare
  // generator is safe in the record. The wrapper stays because it says which thing is the
  // resource: the upstream body at `response.http.body`, and nothing else here.
  it('keeps the events view clear of what answers to release', () => {
    const generator = (async function* () { yield 1; })();
    expect(Symbol.asyncDispose in generator).toBe(true);   // the language marks it
    expect(isOwned(generator)).toBe(false);                // the run does not
    expect(isOwned({ [Symbol.asyncIterator]: () => generator })).toBe(false);
  });
});

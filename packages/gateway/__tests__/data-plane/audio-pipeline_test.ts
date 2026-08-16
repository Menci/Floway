// Audio transcription's pipeline, assembled. `compose` derives the entry contract and
// rejects an array that cannot work, so most of what this file establishes is established
// by the module importing at all — the assembly runs at load. What is worth writing down is
// the entry contract it derives, the keys it cannot see, and the one runtime property this
// family's code is shaped around that no declaration expresses.

import { describe, expect, it } from 'vitest';

import { audioTranscriptionServePipeline } from '../../src/data-plane/audio/pipeline.ts';
import { isReleasable, move, run } from '@floway-dev/pipeline';

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

  // Why the streamed answer is handed over as a wrapper around its generator rather than as
  // the generator: an async generator carries `Symbol.asyncDispose`, so the runner would adopt
  // one in the record as a resource and the top-level sweep would call it — and for a
  // generator that call is `return()`, which cancels the iteration rather than draining it.
  // The resource is the upstream body, at `response.http.body`, and it is the only thing here
  // that should answer to release.
  it('makes an events view that the runner cannot mistake for the resource', () => {
    const generator = (async function* () { yield 1; })();
    expect(isReleasable(generator)).toBe(true);
    expect(isReleasable({ [Symbol.asyncIterator]: () => generator })).toBe(false);
  });
});

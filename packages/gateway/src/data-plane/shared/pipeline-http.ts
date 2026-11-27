import type { DumpAccumulator } from '../../dump/accumulator.ts';
import { recordSelectedDumpMetadata } from '../../dump/selected-usage.ts';
import type { UsageObservation } from '../pipeline/compute-usage.ts';
import type { SelectedCandidate } from '../pipeline/facts.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import { run, type Deferred, type Entry } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';

interface HttpPipelineOptions<Services> {
  services: Services;
  signal: AbortSignal;
  waitUntil: BackgroundScheduler;
  dump?: DumpAccumulator | null;
  panicPresentation?: HttpPanicPresentation | undefined;
}

interface HttpStreamPanicPresentation {
  delivered?(bytes: Uint8Array): void;
  panic(error: unknown): Uint8Array | undefined;
}

export interface HttpPanicPresentation {
  response(error: unknown): Response;
  stream?(headers: HttpResponseFact['headers'], dump: Pick<DumpAccumulator, 'frame'> | null): HttpStreamPanicPresentation | undefined;
}

interface HttpPipelineAnswer {
  http: HttpResponseFact | null;
  usage?: Deferred<UsageObservation>;
  candidate?: SelectedCandidate;
}

export const servePipelineHttp = async <Input, Output extends HttpPipelineAnswer, Services extends object>(
  entry: Entry<Input, Output, Services>,
  facts: NoInfer<Input>,
  options: HttpPipelineOptions<NoInfer<Services>>,
): Promise<Response> => {
  const controller = new AbortController();
  const running = run(entry, facts, {
    services: options.services,
    waitUntil: options.waitUntil,
    signal: AbortSignal.any([options.signal, controller.signal]),
  });
  let answer: Output;
  try {
    answer = await running.result;
  } catch (error) {
    controller.abort(error);
    if (options.panicPresentation === undefined) throw error;
    console.error('[pipeline-response]', error);
    const response = options.panicPresentation.response(error);
    options.dump?.failed(error);
    return options.dump?.finalize(response) ?? response;
  }

  let delivered = false;
  const finish = (reason?: unknown): void => {
    if (delivered) return;
    delivered = true;
    controller.abort(reason);
    running.discard(answer);
  };

  const finalize = (response: Response): Response => {
    const { dump } = options;
    if (dump == null) return response;
    const { candidate, usage } = answer;
    const metadata = candidate === undefined
      ? undefined
      : recordSelectedDumpMetadata(dump, candidate, usage === undefined ? undefined : running.read(usage));
    return dump.finalize(response, metadata);
  };

  try {
    if (answer.http === null) throw new TypeError('An HTTP ingress must encode a client response');
    const { status, statusText, headers, body } = answer.http;
    const headersInit = headers.map(([name, value]): [string, string] => {
      if (typeof value !== 'string') throw new TypeError(`HTTP response header ${name} contains a Secret`);
      return [name, value];
    });
    const init = { status, statusText, headers: headersInit };
    if (body === null || body instanceof Uint8Array) {
      const bytes = body === null || body.buffer instanceof ArrayBuffer ? body as Uint8Array<ArrayBuffer> | null : new Uint8Array(body);
      const response = finalize(new Response(bytes, init));
      finish();
      return response;
    }

    const reader = running.read(body);
    const presentation = options.panicPresentation?.stream?.(headers, options.dump ?? null);
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const item = await reader.next();
          if (delivered) return;
          if (item.done) {
            output.close();
            finish();
          } else if (item.value.ok) {
            presentation?.delivered?.(item.value.value);
            output.enqueue(item.value.value);
          } else {
            const { kind, cause } = item.value.error;
            if (kind === 'abort') output.close();
            else output.error(cause);
            finish(cause);
          }
        } catch (error) {
          console.error('[pipeline-response]', error);
          if (delivered) return;
          finish(error);
          if (presentation !== undefined) options.dump?.failed(error);
          const bytes = options.signal.aborted ? undefined : presentation?.panic(error);
          if (bytes === undefined) {
            output.error(error);
          } else {
            output.enqueue(bytes);
            output.close();
          }
        }
      },
      cancel: finish,
    }, { highWaterMark: 0 });
    return finalize(new Response(stream, init));
  } catch (error) {
    finish(error);
    throw error;
  }
};

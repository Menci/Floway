import { exchangeResponse, type HttpResponseFacts, type HttpServices } from '@floway-dev/http/pipeline';
import { move, run, setRelease, type Pipeline } from '@floway-dev/pipeline';

export const collectHttpPipeline = async <Entry extends object, Exit extends HttpResponseFacts>(pipeline: Pipeline<Entry, Exit>, entry: Entry, services: HttpServices): Promise<{ facts: Exit; response: Response }> => {
  const executed = await run(pipeline, move(entry), services);
  const exchange = executed.facts['response.http.exchange'];
  try {
    if (exchange.type === 'transportFailure') throw exchange.error;
    const response = exchangeResponse(exchange);
    const bytes = await response.arrayBuffer();
    if (exchange.body !== null) setRelease(exchange.body, async () => {});
    await executed.drain();
    return { facts: executed.facts, response: new Response(exchange.body === null ? null : bytes, { status: exchange.status, statusText: exchange.statusText, headers: response.headers }) };
  } catch (error) {
    try { await executed.drain(); } catch (cleanupError) {
      if (cleanupError !== error) throw new AggregateError([error, cleanupError], 'HTTP test call and cleanup failed', { cause: error });
    }
    throw error;
  }
};

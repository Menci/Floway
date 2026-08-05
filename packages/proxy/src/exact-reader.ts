// Buffered "read exactly N bytes" helper over a Web Streams reader.
// `label` only flavours the EOF error message.

import { copy } from './bytes.ts';

export const makeExactReader = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
): ((n: number) => Promise<Uint8Array<ArrayBuffer>>) => {
  let leftover: Uint8Array | undefined;
  return async (n: number): Promise<Uint8Array<ArrayBuffer>> => {
    const out = new Uint8Array(n);
    let got = 0;
    if (leftover?.byteLength) {
      const take = Math.min(n, leftover.byteLength);
      out.set(leftover.subarray(0, take), 0);
      got += take;
      leftover = take < leftover.byteLength ? leftover.subarray(take) : undefined;
    }
    while (got < n) {
      const r = await reader.read();
      if (r.done) throw new Error(`${label}: EOF, want ${n} got ${got}`);
      const need = n - got;
      if (r.value.byteLength <= need) {
        out.set(r.value, got);
        got += r.value.byteLength;
      } else {
        out.set(r.value.subarray(0, need), got);
        // Transport chunks may come from a reusable runtime pool. The tail
        // survives this read call, so detach it before retaining it.
        leftover = copy(r.value.subarray(need));
        got += need;
      }
    }
    return out;
  };
};

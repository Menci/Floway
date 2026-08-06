import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rm, mkdtemp } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve, type ServerType } from '@hono/node-server';

import { bootstrapNodePlatform } from '../src/bootstrap.ts';
import { FsFileStore } from '../src/fs-file-store.ts';
import { applyMigrations } from '../src/migrate.ts';
import {
  app,
  FileDumpStore,
  initBackgroundSchedulerResolver,
  initDumpStore,
  initRepo,
  SqlRepo,
} from '@floway-dev/gateway';
import { replayableBodySource } from '@floway-dev/provider';

const MIB = 1024 * 1024;
const IMAGE_BYTES = 49 * MIB;
const DUMP_CAPTURE_BYTES = MIB;
const LIVE_MEMORY_LIMIT_BYTES = 128 * MIB;
const API_KEY_ID = 'key_image_memory_verifier';
const API_KEY = 'floway-image-memory-verifier-key';
const MODEL = 'gpt-image-2';
const BOUNDARY = 'floway-memory-verifier-boundary';
const CHILD_FLAG = '--child';

interface MultipartShape {
  readonly head: Uint8Array;
  readonly tail: Uint8Array;
  readonly contentLength: number;
}

interface MemoryObservation {
  readonly arrayBuffersDelta: number;
  readonly positiveHeapUsedDelta: number;
  readonly liveBodyBytes: number;
  readonly rss: number;
  readonly rssDelta: number;
  readonly inboundBytes: number;
  readonly outboundBytes: number;
  readonly uploadBytes: number;
  readonly largeBackingBytes: number;
  readonly dumpCaptureBytes: number;
  readonly largeFileInstances: number;
}

type ChildMessage =
  | { readonly type: 'ready'; readonly port: number }
  | { readonly type: 'hold'; readonly observation: MemoryObservation }
  | { readonly type: 'complete'; readonly observation: MemoryObservation }
  | { readonly type: 'failure'; readonly message: string; readonly stack?: string };

type ParentMessage =
  | { readonly type: 'release' }
  | { readonly type: 'verify' };

const multipartShape = (imageBytes: number): MultipartShape => {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${BOUNDARY}\r\n`
    + 'Content-Disposition: form-data; name="model"\r\n\r\n'
    + `${MODEL}\r\n`
    + `--${BOUNDARY}\r\n`
    + 'Content-Disposition: form-data; name="prompt"\r\n\r\n'
    + 'memory verifier\r\n'
    + `--${BOUNDARY}\r\n`
    + 'Content-Disposition: form-data; name="image"; filename="large.png"\r\n'
    + 'Content-Type: image/png\r\n\r\n',
  );
  const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
  return { head, tail, contentLength: head.byteLength + imageBytes + tail.byteLength };
};

const invariant: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  try { return String(error); } catch { return 'unprintable failure'; }
};

const forceGc = async (): Promise<void> => {
  const gc = Reflect.get(globalThis, 'gc');
  invariant(typeof gc === 'function', 'memory verifier child must run Node with --expose-gc');
  Reflect.apply(gc, globalThis, []);
  await new Promise<void>(resolve => setImmediate(resolve));
  Reflect.apply(gc, globalThis, []);
};

class BackgroundWork {
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];

  readonly schedule = (work: Promise<unknown>): void => {
    let tracked!: Promise<void>;
    tracked = work.then(
      () => {},
      error => { this.failures.push(error); },
    ).finally(() => { this.pending.delete(tracked); });
    this.pending.add(tracked);
  };

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    if (this.failures.length > 0) {
      throw new AggregateError(this.failures.splice(0), 'background work failed');
    }
  }
}

class ObservedDumpStore extends FileDumpStore {
  private phase: 'warmup' | 'large' = 'warmup';
  private expectedRequestBytes = 0;
  private capturedRequest: Uint8Array | undefined;
  private largePutCount = 0;

  beginLarge(expectedRequestBytes: number): void {
    this.phase = 'large';
    this.expectedRequestBytes = expectedRequestBytes;
    this.capturedRequest = undefined;
    this.largePutCount = 0;
  }

  override async prepareRequestBody(
    body: Parameters<FileDumpStore['prepareRequestBody']>[0],
    options: Parameters<FileDumpStore['prepareRequestBody']>[1],
  ): ReturnType<FileDumpStore['prepareRequestBody']> {
    if (this.phase === 'large') {
      invariant(body.byteLength === DUMP_CAPTURE_BYTES, `dump captured ${body.byteLength} bytes, expected ${DUMP_CAPTURE_BYTES}`);
      invariant(body.buffer.byteLength === DUMP_CAPTURE_BYTES, 'dump capture retained a larger backing buffer');
      invariant(options.compression === 'identity', 'multipart dump capture must use identity storage');
      this.capturedRequest = body;
    }
    const prepared = await super.prepareRequestBody(body, options);
    if (this.phase === 'large') {
      invariant(prepared.bytes === body, 'identity dump preparation copied the multipart capture');
    }
    return prepared;
  }

  override async put(
    keyId: Parameters<FileDumpStore['put']>[0],
    record: Parameters<FileDumpStore['put']>[1],
  ): ReturnType<FileDumpStore['put']> {
    if (this.phase === 'large') {
      invariant(keyId === API_KEY_ID, `dump used unexpected API key ${keyId}`);
      invariant(record.meta.requestBytes === this.expectedRequestBytes, `dump metadata recorded ${record.meta.requestBytes} request bytes, expected ${this.expectedRequestBytes}`);
      invariant(record.request.body.bytes === this.capturedRequest, 'dump write did not retain the prepared 1 MiB capture identity');
      this.largePutCount += 1;
    }
    await super.put(keyId, record);
  }

  assertLargePut(): void {
    invariant(this.largePutCount === 1, `expected one large dump write, observed ${this.largePutCount}`);
  }

  preparedCapture(): Uint8Array {
    invariant(this.capturedRequest !== undefined, 'large request dump preparation was not observed');
    return this.capturedRequest;
  }
}

interface FileObserver {
  readonly largeInstances: () => number;
  readonly reset: () => void;
  readonly restore: () => void;
}

const observeLargeFiles = (): FileObserver => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'File');
  if (descriptor === undefined || typeof descriptor.value !== 'function' || descriptor.configurable !== true) {
    return { largeInstances: () => 0, reset: () => {}, restore: () => {} };
  }
  let count = 0;
  const NativeFile = descriptor.value as typeof File;
  const ObservedFile = new Proxy(NativeFile, {
    construct(target, args, newTarget) {
      const file = Reflect.construct(target, args, newTarget) as File;
      if (file.size > MIB) count += 1;
      return file;
    },
  });
  Object.defineProperty(globalThis, 'File', { ...descriptor, value: ObservedFile });
  return {
    largeInstances: () => count,
    reset: () => { count = 0; },
    restore: () => { Object.defineProperty(globalThis, 'File', descriptor); },
  };
};

const closeServer = async (server: ServerType): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve(); });
  });
};

const startServer = async (): Promise<{ readonly server: ServerType; readonly port: number }> => {
  let server!: ServerType;
  const info = await new Promise<{ readonly port: number }>(resolve => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, address => resolve(address));
  });
  return { server, port: info.port };
};

const sendIpc = (message: ChildMessage): void => {
  invariant(typeof process.send === 'function', 'memory verifier child requires an IPC channel');
  process.send(message);
};

const responseForImageEdit = (): Response => new Response(JSON.stringify({
  data: [{ b64_json: 'aGk=' }],
  usage: {
    total_tokens: 2,
    input_tokens: 1,
    output_tokens: 1,
    input_tokens_details: { text_tokens: 0, image_tokens: 1 },
  },
}), { headers: { 'content-type': 'application/json' } });

const drainBody = async (body: ReadableStream<Uint8Array>): Promise<number> => {
  const reader = body.getReader();
  let bytes = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) return bytes;
    bytes += result.value.byteLength;
  }
};

const warmupEndpoint = async (fetchImpl: typeof fetch, port: number): Promise<void> => {
  const shape = multipartShape(1);
  const body = new Uint8Array(shape.contentLength);
  body.set(shape.head);
  body[shape.head.byteLength] = 1;
  body.set(shape.tail, shape.head.byteLength + 1);
  const response = await fetchImpl(`http://127.0.0.1:${port}/v1/images/edits`, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      'content-length': String(body.byteLength),
      'x-api-key': API_KEY,
    },
    body,
  });
  const responseBytes = await response.arrayBuffer();
  invariant(response.status === 200, `warmup endpoint returned ${response.status}: ${new TextDecoder().decode(responseBytes)}`);
};

const runChild = async (): Promise<void> => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'floway-image-memory-'));
  process.env.FLOWAY_DB_PATH = ':memory:';
  process.env.FLOWAY_FILES_DIR = join(tempRoot, 'files');
  process.env.ADMIN_KEY = 'memory-verifier-admin';

  const background = new BackgroundWork();
  initBackgroundSchedulerResolver(() => background.schedule);
  const { db } = bootstrapNodePlatform();
  await applyMigrations(db);
  const repo = new SqlRepo(db);
  initRepo(repo);

  await repo.apiKeys.save({
    id: API_KEY_ID,
    userId: 1,
    name: 'Image memory verifier',
    key: API_KEY,
    serverSecret: '00'.repeat(32),
    createdAt: '2026-08-06T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: 3_600,
    responsesRetentionSeconds: 0,
  });
  await repo.upstreams.save({
    id: 'up_image_memory_verifier',
    kind: 'custom',
    name: 'Image memory verifier upstream',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [{ id: 'direct_fetch' }],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      baseUrl: 'https://memory-upstream.invalid',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-memory-verifier',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{ upstreamModelId: MODEL, endpoints: { imagesEdits: {} } }],
    },
  });

  const files = new FsFileStore(join(tempRoot, 'files'));
  const dumpStore = new ObservedDumpStore(db, files);
  initDumpStore(dumpStore);
  const fileObserver = observeLargeFiles();
  const nativeFetch = globalThis.fetch;
  let phase: 'warmup' | 'large' = 'warmup';
  let releaseLarge!: () => void;
  const largeReleased = new Promise<void>(resolve => { releaseLarge = resolve; });
  let baseline!: NodeJS.MemoryUsage;
  let observation: MemoryObservation | undefined;

  globalThis.fetch = async (input, init): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'memory-upstream.invalid') return await nativeFetch(input, init);
    invariant(init?.body instanceof ReadableStream, 'image edit egress did not use a streaming body');
    const source = replayableBodySource(init.body);
    invariant(source !== null, 'image edit egress stream was not replayable');
    invariant(Reflect.get(init, 'duplex') === 'half', 'Node image edit stream omitted duplex=half');
    invariant(new Headers(init.headers).get('content-length') === String(source.byteLength), 'outbound Content-Length did not match replayable segments');

    if (phase === 'warmup') {
      await drainBody(init.body);
      return responseForImageEdit();
    }

    const uploadSegments = source.segments.filter(segment => segment.byteLength === IMAGE_BYTES);
    invariant(uploadSegments.length === 1, `expected one ${IMAGE_BYTES}-byte upload segment, observed ${uploadSegments.length}`);
    const backingBuffers = new Set(source.segments.map(segment => segment.buffer));
    const largeBackings = [...backingBuffers].filter(buffer => buffer.byteLength > MIB);
    invariant(largeBackings.length === 1, `expected one large outbound backing buffer, observed ${largeBackings.length}`);
    const largeBacking = largeBackings[0]!;
    invariant(largeBacking.byteLength === multipartShape(IMAGE_BYTES).contentLength, `large backing is ${largeBacking.byteLength} bytes, expected the ${multipartShape(IMAGE_BYTES).contentLength}-byte inbound body`);
    invariant(uploadSegments[0]!.buffer === largeBacking, 'upload segment does not borrow the inbound multipart backing');
    const dumpCapture = dumpStore.preparedCapture();
    invariant(dumpCapture.buffer !== largeBacking, 'dump capture unexpectedly aliases the full multipart owner');

    await forceGc();
    const current = process.memoryUsage();
    const arrayBuffersDelta = Math.max(0, current.arrayBuffers - baseline.arrayBuffers);
    const positiveHeapUsedDelta = Math.max(0, current.heapUsed - baseline.heapUsed);
    const liveBodyBytes = arrayBuffersDelta + positiveHeapUsedDelta;
    observation = {
      arrayBuffersDelta,
      positiveHeapUsedDelta,
      liveBodyBytes,
      rss: current.rss,
      rssDelta: current.rss - baseline.rss,
      inboundBytes: largeBacking.byteLength,
      outboundBytes: source.byteLength,
      uploadBytes: uploadSegments[0]!.byteLength,
      largeBackingBytes: largeBacking.byteLength,
      dumpCaptureBytes: dumpCapture.byteLength,
      largeFileInstances: fileObserver.largeInstances(),
    };
    invariant(observation.largeFileInstances === 0, `raw upload constructed ${observation.largeFileInstances} production-sized File object(s)`);
    invariant(liveBodyBytes < LIVE_MEMORY_LIMIT_BYTES, `live image-edit memory ${liveBodyBytes} reached the ${LIVE_MEMORY_LIMIT_BYTES}-byte Worker limit`);
    sendIpc({ type: 'hold', observation });

    await largeReleased;
    const drainedBytes = await drainBody(init.body);
    invariant(drainedBytes === source.byteLength, `drained ${drainedBytes} outbound bytes, expected ${source.byteLength}`);
    return responseForImageEdit();
  };

  let server: ServerType | undefined;
  try {
    const started = await startServer();
    server = started.server;
    await warmupEndpoint(nativeFetch, started.port);
    await background.flush();
    fileObserver.reset();
    await forceGc();
    baseline = process.memoryUsage();
    const largeShape = multipartShape(IMAGE_BYTES);
    dumpStore.beginLarge(largeShape.contentLength);
    phase = 'large';
    sendIpc({ type: 'ready', port: started.port });

    await new Promise<void>((resolve, reject) => {
      process.on('message', message => {
        const command = message as ParentMessage;
        if (command.type === 'release') {
          releaseLarge();
          return;
        }
        if (command.type !== 'verify') return;
        void (async () => {
          await background.flush();
          dumpStore.assertLargePut();
          const [metadata] = await dumpStore.list(API_KEY_ID, { limit: 1 });
          invariant(metadata !== undefined, 'large request dump metadata was not persisted');
          invariant(metadata.requestBytes === largeShape.contentLength, `stored dump metadata recorded ${metadata.requestBytes} bytes`);
          const record = await dumpStore.get(API_KEY_ID, metadata.id);
          invariant(record !== null, 'large request dump record was not persisted');
          invariant(record.request.body.byteLength === DUMP_CAPTURE_BYTES, `stored dump request body is ${record.request.body.byteLength} bytes`);
          invariant(observation !== undefined, 'large request memory observation is missing');
          sendIpc({ type: 'complete', observation });
          resolve();
        })().catch(reject);
      });
    });
  } finally {
    globalThis.fetch = nativeFetch;
    fileObserver.restore();
    if (server !== undefined) await closeServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
};

class ChildMessages {
  private readonly queued: ChildMessage[] = [];
  private readonly waiters = new Map<ChildMessage['type'], Array<(message: ChildMessage) => void>>();
  private failure: Error | undefined;

  constructor(private readonly child: ChildProcess) {
    child.on('message', raw => {
      const message = raw as ChildMessage;
      if (message.type === 'failure') {
        this.failure = new Error(message.message);
        if (message.stack !== undefined) this.failure.stack = message.stack;
        for (const waiters of this.waiters.values()) {
          for (const resolve of waiters) resolve(message);
        }
        this.waiters.clear();
        return;
      }
      const waiters = this.waiters.get(message.type);
      const resolve = waiters?.shift();
      if (resolve !== undefined) resolve(message);
      else this.queued.push(message);
    });
  }

  async waitFor<Type extends ChildMessage['type']>(type: Type): Promise<Extract<ChildMessage, { readonly type: Type }>> {
    if (this.failure !== undefined) throw this.failure;
    const queuedIndex = this.queued.findIndex(message => message.type === type || message.type === 'failure');
    if (queuedIndex >= 0) {
      const [message] = this.queued.splice(queuedIndex, 1);
      if (message!.type === 'failure') throw new Error(message!.message);
      return message as Extract<ChildMessage, { readonly type: Type }>;
    }
    const message = await new Promise<ChildMessage>(resolve => {
      const waiters = this.waiters.get(type) ?? [];
      waiters.push(resolve);
      this.waiters.set(type, waiters);
    });
    if (message.type === 'failure') throw this.failure ?? new Error(message.message);
    return message as Extract<ChildMessage, { readonly type: Type }>;
  }
}

const sendParentMessage = (child: ChildProcess, message: ParentMessage): void => {
  invariant(child.connected, 'memory verifier child IPC channel is closed');
  child.send(message);
};

const sendLargeRequest = async (port: number): Promise<{ readonly status: number; readonly body: string }> => {
  const shape = multipartShape(IMAGE_BYTES);
  const response = new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/images/edits',
      headers: {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'content-length': String(shape.contentLength),
        'x-api-key': API_KEY,
      },
    }, incoming => {
      incoming.setEncoding('utf8');
      let body = '';
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
      incoming.on('error', reject);
    });
    request.on('error', reject);
    void (async () => {
      if (!request.write(shape.head)) await once(request, 'drain');
      const payload = new Uint8Array(64 * 1024);
      let remaining = IMAGE_BYTES;
      while (remaining > 0) {
        const chunk = remaining >= payload.byteLength ? payload : payload.subarray(0, remaining);
        if (!request.write(chunk)) await once(request, 'drain');
        remaining -= chunk.byteLength;
      }
      request.end(shape.tail);
    })().catch(error => request.destroy(error as Error));
  });
  return await response;
};

const runParent = async (): Promise<void> => {
  const child = spawn(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), CHILD_FLAG],
    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
  );
  const messages = new ChildMessages(child);
  let completed = false;
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && completed) resolve();
      else reject(new Error(`memory verifier child exited with code=${String(code)} signal=${String(signal)}`));
    });
  });
  try {
    const ready = await messages.waitFor('ready');
    const response = sendLargeRequest(ready.port);
    const held = await messages.waitFor('hold');
    sendParentMessage(child, { type: 'release' });
    const result = await response;
    invariant(result.status === 200, `large endpoint returned ${result.status}: ${result.body}`);
    sendParentMessage(child, { type: 'verify' });
    const complete = await messages.waitFor('complete');
    completed = true;
    await exited;
    const observation = complete.observation;
    console.log('49 MiB image-edit memory verification passed');
    console.log(JSON.stringify({
      ...observation,
      liveBodyMiB: Number((observation.liveBodyBytes / MIB).toFixed(2)),
      rssMiB: Number((observation.rss / MIB).toFixed(2)),
      rssDeltaMiB: Number((observation.rssDelta / MIB).toFixed(2)),
      limitMiB: LIVE_MEMORY_LIMIT_BYTES / MIB,
    }, null, 2));
  } catch (error) {
    if (!child.killed) child.kill();
    throw error;
  }
};

if (process.argv.includes(CHILD_FLAG)) {
  runChild().catch(error => {
    sendIpc({
      type: 'failure',
      message: errorMessage(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
    process.exit(1);
  });
} else {
  await runParent();
}

import type { GatewayCtx } from './gateway-ctx.ts';
import { settle } from './telemetry/settle.ts';
import { forwardUpstreamResponse } from './upstream-response.ts';
import type { TokenUsage } from '../../repo/types.ts';
import type { PerformanceTelemetryContext, TelemetryModelIdentity } from '@floway-dev/provider';

const DEFAULT_OBSERVED_FIELDS = ['usage', 'service_tier'] as const;
const MAX_OBSERVED_FIELD_CHARS = 64 * 1024;
const MAX_KEY_CHARS = 1024;

type ObjectMode = 'before-root' | 'key-or-end' | 'key' | 'colon' | 'value' | 'after-value' | 'done' | 'invalid';
type ValueKind = 'structured' | 'string' | 'primitive';

class JsonValueCursor {
  private readonly capture: boolean;
  private raw = '';
  private overflow = false;
  private kind: ValueKind;
  private depth = 0;
  private inString = false;
  private escaped = false;

  constructor(first: string, capture: boolean) {
    this.capture = capture;
    if (first === '{' || first === '[') {
      this.kind = 'structured';
      this.depth = 1;
    } else if (first === '"') {
      this.kind = 'string';
      this.inString = true;
    } else {
      this.kind = 'primitive';
    }
    this.append(first);
  }

  push(char: string): 'continue' | 'complete' | 'complete-before' {
    if (this.kind === 'primitive') {
      if (/\s/.test(char) || char === ',' || char === '}') return 'complete-before';
      this.append(char);
      return 'continue';
    }

    this.append(char);
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
      } else if (char === '\\') {
        this.escaped = true;
      } else if (char === '"') {
        this.inString = false;
        if (this.kind === 'string') return 'complete';
      }
      return 'continue';
    }

    if (char === '"') {
      this.inString = true;
    } else if (char === '{' || char === '[') {
      this.depth += 1;
    } else if (char === '}' || char === ']') {
      this.depth -= 1;
      if (this.depth === 0) return 'complete';
    }
    return 'continue';
  }

  result(): { overflow: boolean; raw: string } {
    return { overflow: this.overflow, raw: this.raw };
  }

  private append(value: string): void {
    if (!this.capture || this.overflow) return;
    if (this.raw.length + value.length > MAX_OBSERVED_FIELD_CHARS) {
      this.overflow = true;
      this.raw = '';
      return;
    }
    this.raw += value;
  }
}

class TopLevelJsonObserver {
  private mode: ObjectMode = 'before-root';
  private keyRaw = '';
  private keyOverflow = false;
  private keyEscaped = false;
  private currentKey: string | undefined;
  private valueCursor: JsonValueCursor | undefined;
  private readonly fields: Record<string, unknown> = {};
  private failure: string | null = null;

  constructor(private readonly observedFields: ReadonlySet<string>) {}

  feed(text: string): void {
    for (let index = 0; index < text.length;) {
      const char = text[index];
      const consumed = this.feedCharacter(char);
      if (consumed) index += 1;
      if (this.mode === 'invalid') return;
    }
  }

  finish(): { fields: Record<string, unknown>; failure: string | null } {
    if (this.mode === 'value' && this.valueCursor !== undefined) {
      const { raw } = this.valueCursor.result();
      if (raw !== '' && !/[}\]"]$/.test(raw)) this.finishValue();
    }
    if (this.mode !== 'done') this.invalidate('JSON document ended before its root object closed');
    return { fields: this.fields, failure: this.failure };
  }

  fail(message: string): void {
    this.invalidate(message);
  }

  private feedCharacter(char: string): boolean {
    switch (this.mode) {
    case 'before-root':
      if (/\s/.test(char)) return true;
      if (char !== '{') return this.invalidate('JSON response root must be an object');
      this.mode = 'key-or-end';
      return true;
    case 'key-or-end':
      if (/\s/.test(char)) return true;
      if (char === '}') {
        this.mode = 'done';
        return true;
      }
      if (char !== '"') return this.invalidate('JSON response contains an invalid object key');
      this.mode = 'key';
      this.keyRaw = '"';
      this.keyOverflow = false;
      this.keyEscaped = false;
      return true;
    case 'key':
      if (!this.keyOverflow) {
        if (this.keyRaw.length + 1 > MAX_KEY_CHARS) {
          this.keyOverflow = true;
          this.keyRaw = '';
        } else {
          this.keyRaw += char;
        }
      }
      if (this.keyEscaped) {
        this.keyEscaped = false;
      } else if (char === '\\') {
        this.keyEscaped = true;
      } else if (char === '"') {
        if (!this.keyOverflow) {
          try {
            this.currentKey = JSON.parse(this.keyRaw) as string;
          } catch {
            return this.invalidate('JSON response contains an invalid object key escape');
          }
        } else {
          this.currentKey = undefined;
        }
        this.mode = 'colon';
      }
      return true;
    case 'colon':
      if (/\s/.test(char)) return true;
      if (char !== ':') return this.invalidate('JSON response object key is missing a colon');
      this.mode = 'value';
      this.valueCursor = undefined;
      return true;
    case 'value':
      if (this.valueCursor === undefined) {
        if (/\s/.test(char)) return true;
        if (char === ',' || char === '}') return this.invalidate('JSON response object value is missing');
        this.valueCursor = new JsonValueCursor(char, this.currentKey !== undefined && this.observedFields.has(this.currentKey));
        return true;
      }
      switch (this.valueCursor.push(char)) {
      case 'continue': return true;
      case 'complete':
        this.finishValue();
        return true;
      case 'complete-before':
        this.finishValue();
        return false;
      }
    case 'after-value':
      if (/\s/.test(char)) return true;
      if (char === ',') {
        this.mode = 'key-or-end';
        return true;
      }
      if (char === '}') {
        this.mode = 'done';
        return true;
      }
      return this.invalidate('JSON response object has an invalid value separator');
    case 'done':
      if (/\s/.test(char)) return true;
      return this.invalidate('JSON response has trailing data');
    case 'invalid': return true;
    }
  }

  private finishValue(): void {
    if (this.valueCursor === undefined) return;
    const { overflow, raw } = this.valueCursor.result();
    if (this.currentKey !== undefined && this.observedFields.has(this.currentKey)) {
      if (overflow) {
        this.failure ??= `Observed JSON field ${this.currentKey} exceeds ${MAX_OBSERVED_FIELD_CHARS} characters`;
      } else {
        try {
          this.fields[this.currentKey] = JSON.parse(raw) as unknown;
        } catch {
          this.failure ??= `Observed JSON field ${this.currentKey} is malformed`;
        }
      }
    }
    this.valueCursor = undefined;
    this.currentKey = undefined;
    this.mode = 'after-value';
  }

  private invalidate(message: string): true {
    this.failure ??= message;
    this.mode = 'invalid';
    return true;
  }
}

interface ObserveJsonResponseOptions {
  readonly ctx: GatewayCtx;
  readonly response: Response;
  readonly performance: PerformanceTelemetryContext;
  readonly identity: TelemetryModelIdentity;
  readonly sourceApi: string;
  readonly extractBilling: (body: unknown) => TokenUsage | null;
  readonly observedFields?: readonly string[];
  readonly defaultContentType?: string | null;
  readonly settleFields?: (
    fields: Record<string, unknown>,
    outcome: { readonly failed: boolean; readonly error: unknown },
  ) => void;
}

export const observeJsonResponse = ({
  ctx,
  response,
  performance,
  identity,
  sourceApi,
  extractBilling,
  observedFields = DEFAULT_OBSERVED_FIELDS,
  defaultContentType,
  settleFields,
}: ObserveJsonResponseOptions): Response => {
  const upstreamBody = response.body;
  if (upstreamBody === null) {
    if (settleFields === undefined) {
      ctx.dump?.success(identity, null);
      settle(ctx, performance, identity, null, false);
    } else {
      try {
        settleFields({}, { failed: false, error: undefined });
      } catch (error) {
        ctx.dump?.failed(error);
        settle(ctx, performance, identity, null, true);
      }
    }
    return forwardUpstreamResponse(response, { defaultContentType });
  }

  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const observer = new TopLevelJsonObserver(new Set(observedFields));
  let decodingFailed = false;
  let settled = false;
  const finish = (failed: boolean, error?: unknown): unknown | null => {
    if (settled) return null;
    settled = true;
    let usage: TokenUsage | null = null;
    let fields: Record<string, unknown> = {};
    if (!failed) {
      try {
        if (!decodingFailed) {
          const finalText = decoder.decode();
          if (finalText) observer.feed(finalText);
        }
        const observed = observer.finish();
        if (observed.failure !== null) {
          console.warn(`json-response: failed to observe 2xx upstream body for ${sourceApi}; usage row will be request-only`, observed.failure);
        } else {
          fields = observed.fields;
          if (settleFields === undefined) usage = extractBilling(fields);
        }
      } catch (cause) {
        failed = true;
        error = cause;
      }
    }
    if (settleFields !== undefined) {
      try {
        settleFields(fields, { failed, error });
      } catch (cause) {
        failed = true;
        error = cause;
        ctx.dump?.failed(cause);
        settle(ctx, performance, identity, null, true);
      }
    } else {
      if (failed) ctx.dump?.failed(error ?? `${sourceApi} response body did not complete`);
      else ctx.dump?.success(identity, usage);
      settle(ctx, performance, identity, usage, failed);
    }
    return failed ? (error ?? new Error(`${sourceApi} response body did not complete`)) : null;
  };

  const body = new ReadableStream<Uint8Array>({
    type: 'bytes',
    pull: async controller => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          const terminalError = finish(false);
          if (terminalError === null) controller.close();
          else controller.error(terminalError);
          return;
        }
        try {
          observer.feed(decoder.decode(value, { stream: true }));
        } catch (error) {
          decodingFailed = true;
          observer.fail(error instanceof Error ? error.message : String(error));
        }
        controller.enqueue(value);
      } catch (error) {
        finish(true, error);
        controller.error(error);
      }
    },
    cancel: async reason => {
      try {
        await reader.cancel(reason);
      } finally {
        finish(true, reason);
      }
    },
  });
  return forwardUpstreamResponse(response, { body, defaultContentType });
};

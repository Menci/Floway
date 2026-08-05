import type { GatewayCtx } from './gateway-ctx.ts';
import { settle } from './telemetry/settle.ts';
import { forwardUpstreamResponse } from './upstream-response.ts';
import type { TokenUsage } from '../../repo/types.ts';
import type { PerformanceTelemetryContext, TelemetryModelIdentity } from '@floway-dev/provider';

const DEFAULT_OBSERVED_FIELDS = ['usage', 'service_tier'] as const;
const MAX_OBSERVED_FIELD_CHARS = 64 * 1024;
const MAX_KEY_CHARS = 1024;
const MAX_JSON_NESTING_DEPTH = 256;

type ObjectFrame = {
  readonly type: 'object';
  state: 'first-key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end';
  currentKey?: string;
};
type ArrayFrame = {
  readonly type: 'array';
  state: 'first-value-or-end' | 'value' | 'comma-or-end';
};
type ContainerFrame = ObjectFrame | ArrayFrame;
type NumberState = 'minus' | 'zero' | 'integer' | 'dot' | 'fraction' | 'exponent' | 'exponent-sign' | 'exponent-digits';
type StringLexeme = {
  readonly type: 'string';
  readonly role: 'key' | 'value';
  state: 'default' | 'escape' | 'unicode';
  unicodeDigits: number;
  raw: string;
  rawOverflow: boolean;
};
type NumberLexeme = { readonly type: 'number'; state: NumberState };
type LiteralLexeme = { readonly type: 'literal'; readonly expected: 'true' | 'false' | 'null'; index: number };
type Lexeme = StringLexeme | NumberLexeme | LiteralLexeme;
type ObservedValue = { readonly value: unknown; readonly failure?: never } | { readonly value?: never; readonly failure: string };

const isJsonWhitespace = (char: string): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r';
const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const isNonZeroDigit = (char: string): boolean => char >= '1' && char <= '9';
const isHexDigit = (char: string): boolean => isDigit(char) || (char >= 'A' && char <= 'F') || (char >= 'a' && char <= 'f');
const isNumberBoundary = (char: string): boolean => isJsonWhitespace(char) || char === ',' || char === '}' || char === ']';
const numberCanEnd = (state: NumberState): boolean => state === 'zero' || state === 'integer' || state === 'fraction' || state === 'exponent-digits';

// The observer validates the complete document while retaining only selected
// top-level values. Unobserved strings, numbers, arrays, and objects consume
// constant memory; selected values and object keys have explicit caps.
class TopLevelJsonObserver {
  private readonly stack: ContainerFrame[] = [];
  private readonly observedValues = new Map<string, ObservedValue>();
  private rootState: 'value' | 'complete' = 'value';
  private lexeme: Lexeme | undefined;
  private capture: { readonly key: string; raw: string; overflow: boolean } | undefined;
  private failure: string | null = null;

  constructor(private readonly observedFields: ReadonlySet<string>) {}

  feed(text: string): void {
    for (let index = 0; index < text.length;) {
      const consumed = this.feedCharacter(text[index]);
      if (consumed) index += 1;
      if (this.failure !== null) return;
    }
  }

  finish(): { fields: Record<string, unknown>; failure: string | null } {
    if (this.failure === null && this.lexeme?.type === 'number') {
      if (numberCanEnd(this.lexeme.state)) {
        this.lexeme = undefined;
        this.completeValue();
      } else {
        this.invalidate('JSON response ended in the middle of a number');
      }
    } else if (this.failure === null && this.lexeme !== undefined) {
      this.invalidate(`JSON response ended in the middle of a ${this.lexeme.type}`);
    }
    if (this.failure === null && (this.rootState !== 'complete' || this.stack.length !== 0)) {
      this.invalidate('JSON document ended before its root object closed');
    }

    const fields: Record<string, unknown> = {};
    if (this.failure === null) {
      for (const [key, observed] of this.observedValues) {
        if (observed.failure !== undefined) {
          this.failure = observed.failure;
          break;
        }
        fields[key] = observed.value;
      }
    }
    return { fields, failure: this.failure };
  }

  fail(message: string): void {
    this.invalidate(message);
  }

  private feedCharacter(char: string): boolean {
    if (this.lexeme !== undefined) return this.feedLexeme(char);
    if (this.capture !== undefined) this.appendCapture(char);

    const frame = this.stack.at(-1);
    if (frame === undefined) {
      if (this.rootState === 'complete') {
        return isJsonWhitespace(char) || this.invalidate('JSON response has trailing data');
      }
      if (isJsonWhitespace(char)) return true;
      if (char !== '{') return this.invalidate('JSON response root must be an object');
      return this.openContainer('object');
    }

    if (frame.type === 'object') return this.feedObject(frame, char);
    return this.feedArray(frame, char);
  }

  private feedObject(frame: ObjectFrame, char: string): boolean {
    switch (frame.state) {
    case 'first-key-or-end':
      if (isJsonWhitespace(char)) return true;
      if (char === '}') return this.closeContainer('object');
      if (char !== '"') return this.invalidate('JSON response contains an invalid object key');
      return this.startString('key');
    case 'key':
      if (isJsonWhitespace(char)) return true;
      if (char !== '"') return this.invalidate('JSON response object requires a key after a comma');
      return this.startString('key');
    case 'colon':
      if (isJsonWhitespace(char)) return true;
      if (char !== ':') return this.invalidate('JSON response object key is missing a colon');
      frame.state = 'value';
      return true;
    case 'value':
      if (isJsonWhitespace(char)) return true;
      return this.startValue(char);
    case 'comma-or-end':
      if (isJsonWhitespace(char)) return true;
      if (char === ',') {
        frame.state = 'key';
        return true;
      }
      if (char === '}') return this.closeContainer('object');
      return this.invalidate('JSON response object has an invalid value separator');
    }
  }

  private feedArray(frame: ArrayFrame, char: string): boolean {
    switch (frame.state) {
    case 'first-value-or-end':
      if (isJsonWhitespace(char)) return true;
      if (char === ']') return this.closeContainer('array');
      return this.startValue(char);
    case 'value':
      if (isJsonWhitespace(char)) return true;
      return this.startValue(char);
    case 'comma-or-end':
      if (isJsonWhitespace(char)) return true;
      if (char === ',') {
        frame.state = 'value';
        return true;
      }
      if (char === ']') return this.closeContainer('array');
      return this.invalidate('JSON response array has an invalid value separator');
    }
  }

  private startValue(char: string): boolean {
    const validStart = char === '{' || char === '[' || char === '"' || char === 't' || char === 'f' || char === 'n' || char === '-' || isDigit(char);
    if (!validStart) return this.invalidate('JSON response contains an invalid value');
    this.startCaptureIfObserved(char);

    if (char === '{') return this.openContainer('object');
    if (char === '[') return this.openContainer('array');
    if (char === '"') return this.startString('value');
    if (char === 't') this.lexeme = { type: 'literal', expected: 'true', index: 1 };
    else if (char === 'f') this.lexeme = { type: 'literal', expected: 'false', index: 1 };
    else if (char === 'n') this.lexeme = { type: 'literal', expected: 'null', index: 1 };
    else if (char === '-') this.lexeme = { type: 'number', state: 'minus' };
    else this.lexeme = { type: 'number', state: char === '0' ? 'zero' : 'integer' };
    return true;
  }

  private startString(role: 'key' | 'value'): true {
    this.lexeme = {
      type: 'string',
      role,
      state: 'default',
      unicodeDigits: 0,
      raw: role === 'key' ? '"' : '',
      rawOverflow: false,
    };
    return true;
  }

  private feedLexeme(char: string): boolean {
    const lexeme = this.lexeme;
    if (lexeme === undefined) return false;
    if (lexeme.type === 'string') return this.feedString(lexeme, char);
    if (lexeme.type === 'literal') return this.feedLiteral(lexeme, char);
    return this.feedNumber(lexeme, char);
  }

  private feedString(lexeme: StringLexeme, char: string): boolean {
    this.appendCapture(char);
    if (lexeme.role === 'key') this.appendKeyRaw(lexeme, char);
    switch (lexeme.state) {
    case 'default':
      if (char === '"') {
        this.lexeme = undefined;
        if (lexeme.role === 'key') this.completeKey(lexeme);
        else this.completeValue();
      } else if (char === '\\') {
        lexeme.state = 'escape';
      } else if (char.charCodeAt(0) < 0x20) {
        return this.invalidate('JSON response string contains an unescaped control character');
      }
      return true;
    case 'escape':
      if ('"\\/bfnrt'.includes(char)) {
        lexeme.state = 'default';
        return true;
      }
      if (char === 'u') {
        lexeme.state = 'unicode';
        lexeme.unicodeDigits = 0;
        return true;
      }
      return this.invalidate('JSON response string contains an invalid escape');
    case 'unicode':
      if (!isHexDigit(char)) return this.invalidate('JSON response string contains an invalid Unicode escape');
      lexeme.unicodeDigits += 1;
      if (lexeme.unicodeDigits === 4) lexeme.state = 'default';
      return true;
    }
  }

  private feedLiteral(lexeme: LiteralLexeme, char: string): boolean {
    if (char !== lexeme.expected[lexeme.index]) return this.invalidate(`JSON response contains an invalid ${lexeme.expected} literal`);
    this.appendCapture(char);
    lexeme.index += 1;
    if (lexeme.index === lexeme.expected.length) {
      this.lexeme = undefined;
      this.completeValue();
    }
    return true;
  }

  private feedNumber(lexeme: NumberLexeme, char: string): boolean {
    const next = this.nextNumberState(lexeme.state, char);
    if (next !== null) {
      this.appendCapture(char);
      lexeme.state = next;
      return true;
    }
    if (numberCanEnd(lexeme.state) && isNumberBoundary(char)) {
      this.lexeme = undefined;
      this.completeValue();
      return false;
    }
    return this.invalidate('JSON response contains an invalid number');
  }

  private nextNumberState(state: NumberState, char: string): NumberState | null {
    switch (state) {
    case 'minus': return char === '0' ? 'zero' : isNonZeroDigit(char) ? 'integer' : null;
    case 'zero':
      if (char === '.') return 'dot';
      if (char === 'e' || char === 'E') return 'exponent';
      return null;
    case 'integer':
      if (isDigit(char)) return 'integer';
      if (char === '.') return 'dot';
      if (char === 'e' || char === 'E') return 'exponent';
      return null;
    case 'dot': return isDigit(char) ? 'fraction' : null;
    case 'fraction':
      if (isDigit(char)) return 'fraction';
      if (char === 'e' || char === 'E') return 'exponent';
      return null;
    case 'exponent':
      if (char === '+' || char === '-') return 'exponent-sign';
      return isDigit(char) ? 'exponent-digits' : null;
    case 'exponent-sign': return isDigit(char) ? 'exponent-digits' : null;
    case 'exponent-digits': return isDigit(char) ? 'exponent-digits' : null;
    }
  }

  private openContainer(type: ContainerFrame['type']): true {
    if (this.stack.length >= MAX_JSON_NESTING_DEPTH) {
      return this.invalidate(`JSON response exceeds the maximum nesting depth of ${MAX_JSON_NESTING_DEPTH}`);
    }
    this.stack.push(type === 'object'
      ? { type, state: 'first-key-or-end' }
      : { type, state: 'first-value-or-end' });
    return true;
  }

  private closeContainer(type: ContainerFrame['type']): true {
    const frame = this.stack.at(-1);
    if (frame?.type !== type) return this.invalidate(`JSON response contains a mismatched ${type} delimiter`);
    this.stack.pop();
    this.completeValue();
    return true;
  }

  private completeKey(lexeme: StringLexeme): void {
    const frame = this.stack.at(-1);
    if (frame?.type !== 'object' || (frame.state !== 'first-key-or-end' && frame.state !== 'key')) {
      this.invalidate('JSON response contains a string where an object key was not expected');
      return;
    }
    if (lexeme.rawOverflow) {
      frame.currentKey = undefined;
    } else {
      try {
        frame.currentKey = JSON.parse(lexeme.raw) as string;
      } catch {
        this.invalidate('JSON response contains an invalid object key');
        return;
      }
    }
    frame.state = 'colon';
  }

  private completeValue(): void {
    const parent = this.stack.at(-1);
    if (parent === undefined) {
      this.rootState = 'complete';
      return;
    }
    if (this.capture !== undefined && this.stack.length === 1) this.finishCapture();
    if (parent.type === 'object') {
      if (parent.state !== 'value') {
        this.invalidate('JSON response completed a value in an invalid object position');
        return;
      }
      parent.state = 'comma-or-end';
      parent.currentKey = undefined;
    } else {
      if (parent.state !== 'first-value-or-end' && parent.state !== 'value') {
        this.invalidate('JSON response completed a value in an invalid array position');
        return;
      }
      parent.state = 'comma-or-end';
    }
  }

  private startCaptureIfObserved(first: string): void {
    const parent = this.stack.at(-1);
    if (this.capture !== undefined || this.stack.length !== 1 || parent?.type !== 'object' || parent.currentKey === undefined || !this.observedFields.has(parent.currentKey)) return;
    this.capture = { key: parent.currentKey, raw: '', overflow: false };
    this.appendCapture(first);
  }

  private appendCapture(value: string): void {
    if (this.capture === undefined || this.capture.overflow) return;
    if (this.capture.raw.length + value.length > MAX_OBSERVED_FIELD_CHARS) {
      this.capture.raw = '';
      this.capture.overflow = true;
      return;
    }
    this.capture.raw += value;
  }

  private finishCapture(): void {
    const capture = this.capture;
    if (capture === undefined) return;
    this.capture = undefined;
    if (capture.overflow) {
      this.observedValues.set(capture.key, { failure: `Observed JSON field ${capture.key} exceeds ${MAX_OBSERVED_FIELD_CHARS} characters` });
      return;
    }
    try {
      this.observedValues.set(capture.key, { value: JSON.parse(capture.raw) as unknown });
    } catch {
      this.observedValues.set(capture.key, { failure: `Observed JSON field ${capture.key} is malformed` });
    }
  }

  private appendKeyRaw(lexeme: StringLexeme, value: string): void {
    if (lexeme.rawOverflow) return;
    if (lexeme.raw.length + value.length > MAX_KEY_CHARS) {
      lexeme.raw = '';
      lexeme.rawOverflow = true;
      return;
    }
    lexeme.raw += value;
  }

  private invalidate(message: string): true {
    this.failure ??= message;
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
  let terminated = false;
  const finish = (failed: boolean, error?: unknown): unknown | null => {
    if (settled) return null;
    settled = true;
    let usage: TokenUsage | null = null;
    let fields: Record<string, unknown> = {};
    if (!failed) {
      if (!decodingFailed) {
        try {
          const finalText = decoder.decode();
          if (finalText) observer.feed(finalText);
        } catch (cause) {
          decodingFailed = true;
          observer.fail(cause instanceof Error ? cause.message : String(cause));
        }
      }
      try {
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
        while (true) {
          const { done, value } = await reader.read();
          if (terminated) return;
          if (done) {
            const terminalError = finish(false);
            terminated = true;
            if (terminalError === null) controller.close();
            else controller.error(terminalError);
            return;
          }
          if (value.byteLength === 0) continue;
          if (!decodingFailed) {
            try {
              observer.feed(decoder.decode(value, { stream: true }));
            } catch (error) {
              decodingFailed = true;
              observer.fail(error instanceof Error ? error.message : String(error));
            }
          }
          controller.enqueue(value);
          return;
        }
      } catch (error) {
        if (terminated) return;
        terminated = true;
        finish(true, error);
        controller.error(error);
      }
    },
    cancel: reason => {
      if (terminated) return;
      // Settlement must win the race with a pending reader.read() that an
      // upstream cancellation resolves as EOF. Cleanup is deliberately
      // detached so a hostile cancel hook cannot suppress request accounting.
      terminated = true;
      finish(true, reason);
      try {
        void reader.cancel(reason).catch(error => {
          const cancellationError = reason === undefined
            ? error
            : new AggregateError([reason, error], 'Upstream JSON response cancellation failed', { cause: reason });
          console.error('Failed to cancel upstream JSON response body:', cancellationError);
        });
      } catch (error) {
        console.error('Failed to cancel upstream JSON response body:', error);
      }
    },
  });
  return forwardUpstreamResponse(response, { body, defaultContentType });
};

import type { IR, IRAbsent, IRSourceCitation, IRTokenLogprob } from './types.ts';

// The structure of the IR, declared once. Every question about a path (is it an append
// target, may it hold `IRAbsent`, which lifecycle unit does it belong to) is answered by
// walking this schema, never by matching path shapes. The value type inferred from the
// schema is checked against the IR types at the bottom of this file.

// Items, content parts and choices have their own start and end in a stream.
export type IRUnitKind = 'choice' | 'item' | 'part';

export interface IRStringNode {
  readonly kind: 'string';
  // Receives its value as fragments appended to an initial empty string.
  readonly append?: true;
  // May instead be `IRAbsent`: determined to be absent, as opposed to not yet arrived.
  readonly absent?: true;
}
export interface IRNumberNode { readonly kind: 'number' }
export interface IRNullableNode<N extends IRSchemaNode = IRSchemaNode> { readonly kind: 'nullable'; readonly of: N }
export interface IRArrayNode<N extends IRSchemaNode = IRSchemaNode> { readonly kind: 'array'; readonly of: N }
export interface IRObjectNode<F extends IRSchemaFields = IRSchemaFields, O extends keyof F & string = string> {
  readonly kind: 'object';
  readonly fields: F;
  readonly optional: readonly O[];
  // At least one of these fields must be present once the enclosing unit has ended.
  readonly requiresAnyOf?: readonly string[];
  readonly unit?: IRUnitKind;
}
// One of several objects, told apart by the string in `discriminant`.
export interface IRUnionNode<D extends string = string, C extends Readonly<Record<string, IRObjectNode>> = Readonly<Record<string, IRObjectNode>>> {
  readonly kind: 'union';
  readonly discriminant: D;
  readonly cases: C;
  readonly unit?: IRUnitKind;
}
// A value that is only ever replaced as a whole. `value` exists for the type only.
export interface IROpaqueNode<V = unknown> { readonly kind: 'opaque'; readonly value?: V }
export type IRSchemaNode = IRStringNode | IRNumberNode | IRNullableNode | IRArrayNode | IRObjectNode | IRUnionNode | IROpaqueNode;
export interface IRSchemaFields { readonly [key: string]: IRSchemaNode }

const string = { kind: 'string' } as const;
const appendString = { kind: 'string', append: true } as const;
const callId = { kind: 'string', absent: true } as const;
const number = { kind: 'number' } as const;
const nullable = <N extends IRSchemaNode>(of: N): IRNullableNode<N> => ({ kind: 'nullable', of });
const array = <N extends IRSchemaNode>(of: N): IRArrayNode<N> => ({ kind: 'array', of });
const opaque = <V>(): IROpaqueNode<V> => ({ kind: 'opaque' });
const object = <F extends IRSchemaFields, const O extends readonly (keyof F & string)[] = readonly []>(
  fields: F,
  options: { optional?: O; requiresAnyOf?: readonly (keyof F & string)[]; unit?: IRUnitKind } = {},
): IRObjectNode<F, O[number]> => ({ kind: 'object', fields, optional: options.optional ?? [], ...options.requiresAnyOf === undefined ? {} : { requiresAnyOf: options.requiresAnyOf }, ...options.unit === undefined ? {} : { unit: options.unit } });
const allOptional = <F extends IRSchemaFields>(fields: F): IRObjectNode<F, keyof F & string> => ({ kind: 'object', fields, optional: Object.keys(fields) });
const union = <D extends string, C extends Readonly<Record<string, IRObjectNode>>>(discriminant: D, cases: C, unit?: IRUnitKind): IRUnionNode<D, C> =>
  ({ kind: 'union', discriminant, cases, ...unit === undefined ? {} : { unit } });

const contentPart = union('type', {
  text: object({ text: appendString, annotations: nullable(array(opaque<IRSourceCitation>())) }, { optional: ['annotations'] }),
  refusal: object({ refusal: appendString }),
  image: object({ image: object({ data: string, mime_type: string }, { optional: ['mime_type'] }) }),
  audio: object({
    audio: object({ data: appendString, transcript: appendString, mime_type: string }, { optional: ['data', 'transcript', 'mime_type'], requiresAnyOf: ['data', 'transcript'] }),
  }),
}, 'part');

const item = union('type', {
  message: object({ content: array(contentPart) }),
  reasoning: object({
    summary: array(appendString),
    content: array(appendString),
  }, { optional: ['summary', 'content'] }),
  function_call: object({ call_id: callId, name: string, arguments: appendString }, { optional: ['call_id'] }),
  custom_tool_call: object({ call_id: callId, name: string, input: appendString }, { optional: ['call_id'] }),
}, 'item');

const logprobs = nullable(array(union('scope', {
  choice: object({ tokens: array(opaque<IRTokenLogprob>()) }),
  text_part: object({ item_index: number, content_index: number, tokens: array(opaque<IRTokenLogprob>()) }),
})));

export const irSchema = object({
  choices: array(object({
    items: array(item),
    refusal: object({ category: nullable(string), explanation: nullable(string) }),
    logprobs,
  }, { optional: ['refusal', 'logprobs'], unit: 'choice' })),
  model: string,
  service_tier: string,
  usage: allOptional({
    input_tokens_inclusive: number,
    output_tokens_inclusive: number,
    total_tokens: number,
    cached_input_tokens: number,
    cache_creation_input_tokens: number,
    reasoning_tokens: number,
    input_audio_tokens: number,
    input_image_tokens: number,
    input_text_tokens: number,
    output_audio_tokens: number,
    output_text_tokens: number,
  }),
}, { optional: ['model', 'service_tier', 'usage'] });

type ObjectValue<F extends IRSchemaFields, O extends keyof F & string> =
  { readonly [K in Exclude<keyof F, O>]: ValueOf<F[K]> } & { readonly [K in O]?: ValueOf<F[K]> };

// The type of the values a schema node describes.
type ValueOf<N> =
  N extends IRStringNode & { readonly absent: true } ? string | IRAbsent
    : N extends IRStringNode ? string
      : N extends IRNumberNode ? number
        : N extends IRNullableNode<infer T> ? ValueOf<T> | null
          : N extends IRArrayNode<infer T> ? readonly ValueOf<T>[]
            : N extends IROpaqueNode<infer V> ? V
              : N extends IRObjectNode<infer F, infer O> ? ObjectValue<F, O>
                : N extends IRUnionNode<infer D, infer C> ? { [K in keyof C]: ValueOf<C[K]> & { readonly [P in D]: K } }[keyof C]
                  : never;

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compile-time proof that the schema and the IR types describe the same values: a field the
// schema declares optional, nullable, appendable or `IRAbsent`-capable differs from the IR type
// exactly when this stops being `true`.
export const irSchemaMatchesIRTypes: Mutual<ValueOf<typeof irSchema>, IR> = true;

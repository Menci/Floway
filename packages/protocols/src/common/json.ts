export type JsonObject = Record<string, unknown>;

// Preserve every number token that the parsed JavaScript value would not serialize identically.
// https://tc39.es/proposal-json-parse-with-source/#sec-json.rawjson
const jsonWithRawNumbers = JSON as typeof JSON & {
  rawJSON: (text: string) => { readonly rawJSON: string };
};

export const parseJSONWithRawNumbers = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value === 'number' && JSON.stringify(value) !== context!.source) return jsonWithRawNumbers.rawJSON(context!.source);
  return value;
});

/*
 * Derived from Anthropic's partial JSON parser (MIT), adapted to preserve source number tokens:
 * https://github.com/anthropics/anthropic-sdk-typescript/blob/2979ed5cef4b2f059b95af23e08728c01e588f86/src/_vendor/partial-json-parser/parser.ts
 * Copyright 2023 Anthropic, PBC.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
type PartialJSONToken = {
  type: 'brace' | 'paren' | 'separator' | 'delimiter' | 'string' | 'number' | 'name';
  value: string;
  unterminated?: boolean;
};

const tokenizePartialJSON = (input: string): PartialJSONToken[] => {
  const tokens: PartialJSONToken[] = [];
  let current = 0;

  while (current < input.length) {
    let char = input[current];
    if (char === '\\') {
      current++;
      continue;
    }

    if (char === '{' || char === '}') {
      tokens.push({ type: 'brace', value: char });
      current++;
      continue;
    }
    if (char === '[' || char === ']') {
      tokens.push({ type: 'paren', value: char });
      current++;
      continue;
    }
    if (char === ':' || char === ',') {
      tokens.push({ type: char === ':' ? 'separator' : 'delimiter', value: char });
      current++;
      continue;
    }

    if (char === '"') {
      const start = current + 1;
      let end = start;
      while (true) {
        end = input.indexOf('"', end);
        if (end === -1) {
          current = input.length;
          break;
        }

        let backslashes = 0;
        for (let index = end - 1; index >= start && input[index] === '\\'; index--) backslashes++;
        if (backslashes % 2 === 0) {
          tokens.push({ type: 'string', value: input.slice(start, end) });
          current = end + 1;
          break;
        }
        end++;
      }
      continue;
    }

    if (char !== undefined && /\s/.test(char)) {
      current++;
      continue;
    }

    if ((char !== undefined && /[0-9]/.test(char)) || char === '-' || char === '.') {
      let value = '';
      if (char === '-') {
        value += char;
        char = input[++current];
      }
      while (
        char !== undefined
        && (/[0-9]/.test(char)
          || char === '.'
          || char === 'e'
          || char === 'E'
          || ((char === '-' || char === '+') && (value.endsWith('e') || value.endsWith('E'))))
      ) {
        value += char;
        char = input[++current];
      }
      tokens.push({ type: 'number', value, unterminated: current === input.length });
      continue;
    }

    if (char !== undefined && /[a-z]/i.test(char)) {
      let value = '';
      while (char !== undefined && /[a-z]/i.test(char)) {
        value += char;
        char = input[++current];
      }
      if (value === 'true' || value === 'false' || value === 'null') {
        tokens.push({ type: 'name', value });
      } else {
        current++;
      }
      continue;
    }

    current++;
  }

  return tokens;
};

const stripIncompleteJSONSuffix = (tokens: PartialJSONToken[]): PartialJSONToken[] => {
  const openBrackets: string[] = [];
  for (const token of tokens) {
    if (token.type !== 'brace' && token.type !== 'paren') continue;
    if (token.value === '{' || token.value === '[') openBrackets.push(token.value);
    else openBrackets.pop();
  }

  const innermostOpenBracket = openBrackets.at(-1);
  const completeNumber = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/;
  let length = tokens.length;
  while (length > 0) {
    const last = tokens[length - 1]!;
    if (last.type === 'separator') {
      length--;
      continue;
    }
    if (last.type === 'number' && (last.unterminated || !completeNumber.test(last.value))) {
      length--;
      continue;
    }
    if (last.type === 'string') {
      const previous = tokens[length - 2];
      if (
        innermostOpenBracket === '{'
        && (previous?.type === 'delimiter' || previous?.type === 'brace' && previous.value === '{')
      ) {
        length--;
        continue;
      }
    }
    if (last.type === 'delimiter') length--;
    break;
  }
  return tokens.slice(0, length);
};

const closeOpenJSONContainers = (tokens: PartialJSONToken[]): PartialJSONToken[] => {
  const closers: string[] = [];
  for (const token of tokens) {
    if (token.type !== 'brace' && token.type !== 'paren') continue;
    if (token.value === '{') closers.push('}');
    else if (token.value === '[') closers.push(']');
    else closers.splice(closers.lastIndexOf(token.value), 1);
  }
  return [
    ...tokens,
    ...closers.toReversed().map((value): PartialJSONToken => ({
      type: value === '}' ? 'brace' : 'paren',
      value,
    })),
  ];
};

const generateJSONFromTokens = (tokens: PartialJSONToken[]): string => tokens
  .map(token => token.type === 'string' ? `"${token.value}"` : token.value)
  .join('');

export const parsePartialJSONWithRawNumbers = (text: string): unknown => parseJSONWithRawNumbers(
  generateJSONFromTokens(closeOpenJSONContainers(stripIncompleteJSONSuffix(tokenizePartialJSON(text)))),
);

export const jsonInteger = (value: bigint): number | { readonly rawJSON: string } => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : jsonWithRawNumbers.rawJSON(value.toString());
};

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

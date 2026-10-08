import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class JsoncRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsoncRefusalError';
  }
}

function tokenizeJsonc(src) {
  const tokens = [];
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      const start = i;
      while (i < len && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n')) {
        i++;
      }
      tokens.push({ type: 'whitespace', start, end: i, raw: src.slice(start, i) });
      continue;
    }

    if (ch === '/' && src[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < len && src[i] !== '\n' && src[i] !== '\r') {
        i++;
      }
      tokens.push({ type: 'line-comment', start, end: i, raw: src.slice(start, i) });
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      let closed = false;
      while (i < len) {
        if (src[i] === '*' && src[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        throw new JsoncRefusalError(`Unterminated block comment starting at offset ${start}`);
      }
      tokens.push({ type: 'block-comment', start, end: i, raw: src.slice(start, i) });
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++;
      let escaped = false;
      let closed = false;
      while (i < len) {
        const c = src[i];
        if (escaped) {
          escaped = false;
          i++;
        } else if (c === '\\') {
          escaped = true;
          i++;
        } else if (c === '"') {
          i++;
          closed = true;
          break;

        } else {
          i++;
        }
      }
      if (!closed) {
        throw new JsoncRefusalError(`Unterminated string literal at offset ${start}`);
      }
      const raw = src.slice(start, i);
      const value = JSON.parse(raw);
      tokens.push({ type: 'string', start, end: i, raw, value });
      continue;
    }

    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') {
      tokens.push({ type: ch, start: i, end: i + 1, raw: ch });
      i++;
      continue;
    }

    if (src.startsWith('true', i)) {
      tokens.push({ type: 'boolean', start: i, end: i + 4, raw: 'true', value: true });
      i += 4;
      continue;
    }
    if (src.startsWith('false', i)) {
      tokens.push({ type: 'boolean', start: i, end: i + 5, raw: 'false', value: false });
      i += 5;
      continue;
    }
    if (src.startsWith('null', i)) {
      tokens.push({ type: 'null', start: i, end: i + 4, raw: 'null', value: null });
      i += 4;
      continue;
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (src[i] === '-') i++;
      if (i >= len || !(src[i] >= '0' && src[i] <= '9')) {
        throw new JsoncRefusalError(`Invalid number at offset ${start}`);
      }
      if (src[i] === '0') {
        i++;
      } else {
        while (i < len && src[i] >= '0' && src[i] <= '9') i++;
      }
      if (i < len && src[i] === '.') {
        i++;
        if (i >= len || !(src[i] >= '0' && src[i] <= '9')) {
          throw new JsoncRefusalError(`Invalid decimal number at offset ${start}`);
        }
        while (i < len && src[i] >= '0' && src[i] <= '9') i++;
      }
      if (i < len && (src[i] === 'e' || src[i] === 'E')) {
        i++;
        if (i < len && (src[i] === '+' || src[i] === '-')) i++;
        if (i >= len || !(src[i] >= '0' && src[i] <= '9')) {
          throw new JsoncRefusalError(`Invalid exponent number at offset ${start}`);
        }
        while (i < len && src[i] >= '0' && src[i] <= '9') i++;
      }
      const raw = src.slice(start, i);
      const value = Number(raw);
      tokens.push({ type: 'number', start, end: i, raw, value });
      continue;
    }

    throw new JsoncRefusalError(`Unexpected character '${ch}' at offset ${i}`);
  }

  return tokens;
}

function parseJsoncAst(src) {
  let content = src;
  let bomOffset = 0;
  if (src.startsWith('\uFEFF')) {
    content = src.slice(1);
    bomOffset = 1;
  }

  const allTokens = tokenizeJsonc(content);
  if (bomOffset > 0) {
    for (const t of allTokens) {
      t.start += bomOffset;
      t.end += bomOffset;
    }
  }

  const semanticTokens = allTokens.filter(t => t.type !== 'whitespace' && t.type !== 'line-comment' && t.type !== 'block-comment');
  if (semanticTokens.length === 0) {
    return { kind: 'empty' };
  }

  let index = 0;
  function peek() {
    return semanticTokens[index];
  }
  function next() {
    return semanticTokens[index++];
  }

  function parseValue() {
    const token = peek();
    if (!token) throw new JsoncRefusalError('Unexpected end of JSON input');
    if (token.type === '{') return parseObject();
    if (token.type === '[') return parseArray();
    if (token.type === 'string' || token.type === 'number' || token.type === 'boolean' || token.type === 'null') {
      next();
      return { kind: 'primitive', start: token.start, end: token.end, value: token.value };
    }
    throw new JsoncRefusalError(`Unexpected token '${token.raw}' at offset ${token.start}`);
  }

  function parseObject() {
    const openBrace = next();
    const properties = [];
    while (peek() && peek().type !== '}') {
      const keyToken = next();
      if (keyToken.type !== 'string') {
        throw new JsoncRefusalError(`Expected object property string key at offset ${keyToken.start}`);
      }
      const colonToken = next();
      if (colonToken?.type !== ':') {
        throw new JsoncRefusalError(`Expected ':' after property key at offset ${keyToken.end}`);
      }
      const val = parseValue();
      let commaToken = null;
      if (peek()?.type === ',') {
        commaToken = next();
      } else if (peek() && peek().type !== '}') {
        throw new JsoncRefusalError(`Expected ',' or '}' after object property at offset ${val.end}`);
      }
      properties.push({
        keyToken,
        value: val,
        commaToken,
        start: keyToken.start,
        end: commaToken ? commaToken.end : val.end,
      });
    }
    const closeBrace = next();
    if (closeBrace?.type !== '}') {
      throw new JsoncRefusalError(`Unbalanced object: missing '}' for object starting at offset ${openBrace.start}`);
    }
    return {
      kind: 'object',
      openBrace,
      closeBrace,
      properties,
      start: openBrace.start,
      end: closeBrace.end,
    };
  }

  function parseArray() {
    const openBracket = next();
    while (peek() && peek().type !== ']') {
      const el = parseValue();
      if (peek()?.type === ',') {
        next();
      } else if (peek() && peek().type !== ']') {
        throw new JsoncRefusalError(`Expected ',' or ']' after array element at offset ${el.end}`);
      }
    }
    const closeBracket = next();
    if (closeBracket?.type !== ']') {
      throw new JsoncRefusalError(`Unbalanced array: missing ']' for array starting at offset ${openBracket.start}`);
    }
    return {
      kind: 'array',
      start: openBracket.start,
      end: closeBracket.end,
    };
  }

  const root = parseValue();
  if (index < semanticTokens.length) {
    throw new JsoncRefusalError(`Unexpected content after root value at offset ${semanticTokens[index].start}`);
  }

  return { kind: 'root', root };
}

function detectLineEnding(src) {
  return src.includes('\r\n') ? '\r\n' : '\n';
}

function detectIndent(src) {
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([ \t]+)\S/);
    if (match) {
      return match[1];
    }
  }
  return '  ';
}

export function updateDefaultModel(src, modelId, provider) {
  if (typeof provider !== 'string' || !provider) throw new JsoncRefusalError('A provider ID is required');
  const eol = detectLineEnding(src);

  const ast = parseJsoncAst(src);
  if (ast.kind === 'empty') {
    const value = modelId === null ? {} : { defaultProvider: provider, defaultModel: modelId };
    const separator = src === '' || src === '\uFEFF' || src.endsWith('\n') ? '' : eol;
    return src + separator + JSON.stringify(value, null, 2).split('\n').join(eol) + eol;
  }

  if (ast.root.kind !== 'object') {
    throw new JsoncRefusalError('Root value in settings.json must be an object');
  }

  const root = ast.root;
  const providerProps = root.properties.filter(p => p.keyToken.value === 'defaultProvider');
  const modelProps = root.properties.filter(p => p.keyToken.value === 'defaultModel');

  if (providerProps.length > 1) {
    throw new JsoncRefusalError('Duplicate "defaultProvider" key found in settings.json');
  }
  if (modelProps.length > 1) {
    throw new JsoncRefusalError('Duplicate "defaultModel" key found in settings.json');
  }

  // Clearing one connection must preserve a default selected from another provider.
  if (modelId === null) {
    const existingProvider = providerProps[0];
    if (existingProvider?.value.value !== provider) {
      return src;
    }

    const propsToRemove = [existingProvider, modelProps[0]].filter(Boolean);

    let result = src;
    for (const prop of propsToRemove) {
      // Re-parse AST to ensure clean token offsets on consecutive deletes
      const currentAst = parseJsoncAst(result);
      const target = currentAst.root.properties.find(p => p.keyToken.value === prop.keyToken.value);

      result = removeObjectProperty(result, target);
    }
    return result;
  }

  return setSettingsProperty(setSettingsProperty(src, ['defaultProvider'], provider), ['defaultModel'], modelId);
}

export function updatePiSettings(src, { modelId, provider, thinkingLevel, retry }) {
  let result = updateDefaultModel(src, modelId, provider);
  if (thinkingLevel !== null) result = setSettingsProperty(result, ['defaultThinkingLevel'], thinkingLevel);
  if (retry.enabled !== null) result = setSettingsProperty(result, ['retry', 'enabled'], retry.enabled);
  if (retry.maxRetries !== null) result = setSettingsProperty(result, ['retry', 'maxRetries'], retry.maxRetries);
  return result;
}

function setSettingsProperty(src, path, value) {
  const ast = parseJsoncAst(src);
  let current = ast.root;
  for (let index = 0; index < path.length; index++) {
    const key = path[index];
    const properties = current.properties.filter(property => property.keyToken.value === key);
    if (properties.length > 1) throw new JsoncRefusalError(`Duplicate "${key}" key found in settings.json`);
    const property = properties[0];
    if (!property) {
      const nested = path.slice(index + 1).reduceRight((child, parent) => ({ [parent]: child }), value);
      return insertObjectProperty(src, key, JSON.stringify(nested), current, detectIndent(src), detectLineEnding(src));
    }
    if (index === path.length - 1) return src.slice(0, property.value.start) + JSON.stringify(value) + src.slice(property.value.end);
    if (property.value.kind !== 'object') throw new JsoncRefusalError(`"${path.slice(0, index + 1).join('.')}" must be an object in settings.json`);
    current = property.value;
  }
}

function insertObjectProperty(src, key, rawValue, rootNode, indentStep, eol) {
  const rootLineStart = src.lastIndexOf('\n', rootNode.openBrace.start) + 1;
  const rootIndent = src.slice(rootLineStart, rootNode.openBrace.start).match(/^[ \t]*/)[0];
  const closingLineStart = src.lastIndexOf('\n', rootNode.closeBrace.start) + 1;
  const closingLineIsEmpty = /^[ \t]*$/.test(src.slice(closingLineStart, rootNode.closeBrace.start));
  const insertAt = closingLineIsEmpty ? closingLineStart : rootNode.closeBrace.start;
  const entry = `${closingLineIsEmpty ? '' : eol}${rootIndent}${indentStep}${JSON.stringify(key)}: ${rawValue}${eol}${closingLineIsEmpty ? '' : rootIndent}`;
  let result = src.slice(0, insertAt) + entry + src.slice(insertAt);
  const lastProperty = rootNode.properties[rootNode.properties.length - 1];
  if (lastProperty && !lastProperty.commaToken) {
    result = `${result.slice(0, lastProperty.value.end)},${result.slice(lastProperty.value.end)}`;
  }
  return result;
}

function removeObjectProperty(src, prop) {
  const lineStart = src.lastIndexOf('\n', prop.start) + 1;
  let lineEnd = src.indexOf('\n', prop.end);
  if (lineEnd === -1) {
    lineEnd = src.length;
  } else {
    lineEnd += 1;
  }

  const beforeText = src.slice(lineStart, prop.start);
  const afterText = src.slice(prop.commaToken ? prop.commaToken.end : prop.value.end, lineEnd).replace(/\r?\n$/, '');

  if (/^[ \t]*$/.test(beforeText) && /^[ \t]*$/.test(afterText)) {
    return src.slice(0, lineStart) + src.slice(lineEnd);
  }

  const deleteEnd = prop.commaToken ? prop.commaToken.end : prop.value.end;
  return src.slice(0, prop.start) + src.slice(deleteEnd);
}

function runCli() {
  const mode = process.argv[2];
  if (mode !== 'settings') {
    process.stderr.write('Usage: node jsonc-edit.mjs settings\n');
    process.exit(2);
  }

  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`Failed to read stdin: ${err.message}\n`);
    process.exit(2);
  }

  try {
    const defaultModel = envOrEmpty('FLOWAY_DEFAULT_MODEL') || null;
    const thinkingLevel = envOrEmpty('FLOWAY_PI_THINKING_LEVEL') || null;
    // https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/docs/settings.md#model-and-thinking
    if (thinkingLevel !== null && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel)) throw new JsoncRefusalError('Invalid Pi thinking level');
    const retryEnabled = envOrEmpty('FLOWAY_PI_RETRY_ENABLED');
    if (retryEnabled !== '' && retryEnabled !== 'true' && retryEnabled !== 'false') throw new JsoncRefusalError('Invalid Pi retry.enabled');
    const maxRetries = envOrEmpty('FLOWAY_PI_MAX_RETRIES');
    if (maxRetries !== '' && (!/^\d+$/.test(maxRetries) || !Number.isSafeInteger(Number(maxRetries)))) throw new JsoncRefusalError('Invalid Pi retry.maxRetries');
    const output = updatePiSettings(input, {
      modelId: defaultModel,
      provider: process.env.FLOWAY_DEFAULT_PROVIDER,
      thinkingLevel,
      retry: { enabled: retryEnabled === '' ? null : retryEnabled === 'true', maxRetries: maxRetries === '' ? null : Number(maxRetries) },
    });
    process.stdout.write(output);
    process.exit(0);
  } catch (err) {
    const message = err instanceof JsoncRefusalError ? `Refusal: ${err.message}` : `Error: ${err.message}`;
    process.stderr.write(`${message  }\n`);
    process.exit(2);
  }
}

function envOrEmpty(name) {
  return process.env[name] ?? '';
}

// Resolve both paths so URL encoding and executable symlinks do not skip the CLI entrypoint.
if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  runCli();
}

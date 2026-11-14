import { expect, test } from 'vitest';

import { highlight } from '../../../src/components/ui/prism';

test.each(['regex', 'javascript', 'typescript'])('highlights regex syntax inside %s', language => {
  const pattern = String.raw`^(foo|bar)[a-z]\d{2}$`;
  const element = document.createElement('div');
  element.innerHTML = highlight(language === 'regex' ? pattern : `/${pattern}/`, language);

  expect(element.textContent).toBe(language === 'regex' ? pattern : `/${pattern}/`);
  expect(element.querySelector('.token.anchor.function')?.textContent).toBe('^');
  expect(element.querySelector('.token.group.punctuation')?.textContent).toBe('(');
  expect(element.querySelector('.token.alternation.keyword')?.textContent).toBe('|');
  expect(element.querySelector('.token.range')?.textContent).toBe('a-z');
  expect(element.querySelector('.token.char-set.class-name')?.textContent).toBe(String.raw`\d`);
  expect(element.querySelector('.token.quantifier.number')?.textContent).toBe('{2}');
});

test.each([
  ['markup', '<p>Hello</p>', '.token.tag'],
  ['css', 'p { color: red }', '.token.property'],
  ['clike', 'if (value) return 1;', '.token.keyword'],
  ['javascript', 'const value = 1;', '.token.keyword'],
  ['bash', 'echo "$HOME"', '.token.builtin'],
  ['json', '{"value": true}', '.token.property'],
  ['markdown', '# Heading', '.token.title'],
  ['powershell', '$value = $true', '.token.variable'],
  ['toml', 'value = true', '.token.boolean'],
  ['typescript', 'const value: number = 1;', '.token.keyword'],
])('retains the %s grammar', (language, code, selector) => {
  const element = document.createElement('div');
  element.innerHTML = highlight(code, language);
  expect(element.textContent).toBe(code);
  expect(element.querySelector(selector)).not.toBeNull();
});

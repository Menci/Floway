import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_PATH = resolve(ROOT, 'AGENTS.md');
const EXPECTED_TITLE = '# Repository Agent Protocol';
const EXPECTED_SECTIONS = ['## Requirements', '## Index'] as const;
const EXPECTED_TABLE_HEADERS = [
  '| Scope | Requirement | Enforcement |',
  '| Scope | Canonical source |',
] as const;

const fail = (message: string): never => {
  throw new Error(`AGENTS.md protocol violation: ${message}`);
};

const lines = (await readFile(AGENTS_PATH, 'utf8')).trimEnd().split('\n');
if (lines[0] !== EXPECTED_TITLE) fail(`first line must be ${JSON.stringify(EXPECTED_TITLE)}`);

const sectionEntries = lines
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => line.startsWith('## '));

if (sectionEntries.length !== EXPECTED_SECTIONS.length) {
  fail(`expected exactly ${EXPECTED_SECTIONS.length} level-two sections`);
}

for (const [index, expected] of EXPECTED_SECTIONS.entries()) {
  const actual = sectionEntries[index];
  if (actual?.line !== expected) fail(`section ${index + 1} must be ${JSON.stringify(expected)}`);
}

const titleBody = lines.slice(1, sectionEntries[0]?.index);
if (titleBody.some(line => line !== '')) fail('the title may be followed only by the Requirements table');

for (const [index, section] of sectionEntries.entries()) {
  const end = sectionEntries[index + 1]?.index ?? lines.length;
  const body = lines.slice(section.index + 1, end);
  const content = body.filter(line => line !== '');
  if (content.length < 3) fail(`${section.line} must contain a Markdown table`);
  if (content[0] !== EXPECTED_TABLE_HEADERS[index]) {
    fail(`${section.line} must start with ${JSON.stringify(EXPECTED_TABLE_HEADERS[index])}`);
  }
  if (content.some(line => !line.startsWith('|') || !line.endsWith('|'))) {
    fail(`${section.line} may contain only one Markdown table`);
  }
  if (!/^\|(?:-+\|)+$/.test(content[1]?.replaceAll(' ', '') ?? '')) {
    fail(`${section.line} must use a Markdown table separator as its second row`);
  }
  const expectedColumns = index === 0 ? 3 : 2;
  if (content.some(line => line.split('|').length !== expectedColumns + 2)) {
    fail(`${section.line} must keep its ${expectedColumns} prescribed columns`);
  }
}

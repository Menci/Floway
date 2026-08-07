import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import ts from 'typescript';

import { findCssColorLevel4, type ColorLevel4Violation } from './css-color-level-4';

const webRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(webRoot, 'src');
const clientRoot = resolve(webRoot, 'dist/client');
const scriptExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
const documentExtensions = new Set(['.css', '.html']);

interface LocatedViolation extends ColorLevel4Violation {
  file: string;
  line: number;
}

const filesBelow = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? await filesBelow(path) : [path];
  }))).flat();
};

const lineAt = (source: string, index: number): number => source.slice(0, index).split('\n').length;

const locate = (file: string, source: string, offset: number, text: string): LocatedViolation[] =>
  findCssColorLevel4(text).map(violation => ({
    ...violation,
    file: relative(webRoot, file),
    line: lineAt(source, offset + violation.index),
  }));

const sourceViolations = async (file: string): Promise<LocatedViolation[]> => {
  const source = await readFile(file, 'utf8');
  const extension = extname(file);
  if (documentExtensions.has(extension)) return locate(file, source, 0, source);
  if (!scriptExtensions.has(extension)) return [];

  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, extension.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations: LocatedViolation[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
    ) {
      violations.push(...locate(file, source, node.getStart(sourceFile) + 1, node.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

const builtViolations = async (file: string): Promise<LocatedViolation[]> => {
  if (!documentExtensions.has(extname(file))) return [];
  const source = await readFile(file, 'utf8');
  return locate(file, source, 0, source);
};

const violations = [
  ...(await Promise.all((await filesBelow(sourceRoot)).map(sourceViolations))).flat(),
  ...(await Promise.all((await filesBelow(clientRoot)).map(builtViolations))).flat(),
];

if (violations.length > 0) {
  throw new Error(`CSS Color Level 4 reached the browser boundary:\n${violations
    .map(violation => `${violation.file}:${violation.line}: ${violation.syntax}`)
    .join('\n')}`);
}

console.log('Browser styles use only legacy CSS color syntax');

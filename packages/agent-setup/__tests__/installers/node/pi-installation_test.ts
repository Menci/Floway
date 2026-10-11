import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { getLegacyNpmPrefix } from '../../../installers/node/pi-installation.mjs';

const directories: string[] = [];
const workspace = (): string => {
  const directory = mkdtempSync(join(process.cwd(), '.pi-installation-test-'));
  directories.push(directory);
  return directory;
};
const legacyPackage = (root: string): string => {
  const directory = join(root, '@mariozechner', 'pi-coding-agent');
  mkdirSync(join(directory, 'dist'), { recursive: true });
  writeFileSync(join(directory, 'dist', 'cli.js'), 'legacy Pi');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@mariozechner/pi-coding-agent', bin: { pi: 'dist/cli.js' } }));
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('recognizes the exact legacy Pi executable under a Unix global npm prefix', () => {
  const prefix = workspace();
  const directory = legacyPackage(join(prefix, 'lib', 'node_modules'));
  mkdirSync(join(prefix, 'bin'));
  const binary = join(prefix, 'bin', 'pi');
  symlinkSync(join(directory, 'dist', 'cli.js'), binary);
  expect(getLegacyNpmPrefix(binary)).toBe(prefix);
});

test('does not force arbitrary executables, local packages, or another package entrypoint', () => {
  const prefix = workspace();
  const arbitrary = join(prefix, 'pi');
  writeFileSync(arbitrary, 'unmanaged binary');
  expect(getLegacyNpmPrefix(arbitrary)).toBeNull();
  const local = legacyPackage(join(prefix, 'node_modules'));
  const binary = join(prefix, 'local-pi');
  symlinkSync(join(local, 'dist', 'cli.js'), binary);
  expect(getLegacyNpmPrefix(binary)).toBeNull();
  const global = legacyPackage(join(prefix, 'lib', 'node_modules'));
  writeFileSync(join(global, 'dist', 'other.js'), 'another entrypoint');
  const other = join(prefix, 'other-pi');
  symlinkSync(join(global, 'dist', 'other.js'), other);
  expect(getLegacyNpmPrefix(other)).toBeNull();
});

test('recognizes a selected Windows npm prefix only with the exact legacy shim target', () => {
  const prefix = workspace();
  const root = join(prefix, 'node_modules');
  legacyPackage(root);
  const binary = join(prefix, 'pi.cmd');
  writeFileSync(binary, '@echo off\n"%dp0%\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js" %*\n');
  expect(getLegacyNpmPrefix(binary)).toBe(prefix);
  writeFileSync(binary, '@echo off\n"%dp0%\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js.old" %*\n');
  expect(getLegacyNpmPrefix(binary)).toBeNull();
  writeFileSync(binary, '@echo off\necho some other CLI\n');
  expect(getLegacyNpmPrefix(binary)).toBeNull();
});

test('invalid legacy manifests propagate their parsing error', () => {
  const prefix = workspace();
  const directory = legacyPackage(join(prefix, 'lib', 'node_modules'));
  mkdirSync(join(prefix, 'bin'));
  const binary = join(prefix, 'bin', 'pi');
  symlinkSync(join(directory, 'dist', 'cli.js'), binary);
  writeFileSync(join(directory, 'package.json'), '{invalid');
  expect(() => getLegacyNpmPrefix(binary)).toThrow(SyntaxError);
});

test('a selected alias cannot authorize replacing a differently owned global launcher', () => {
  const prefix = workspace();
  const directory = legacyPackage(join(prefix, 'lib', 'node_modules'));
  const alias = join(prefix, 'alias');
  symlinkSync(join(directory, 'dist', 'cli.js'), alias);
  expect(getLegacyNpmPrefix(alias)).toBeNull();
  mkdirSync(join(prefix, 'bin'));
  const launcher = join(prefix, 'bin', 'pi');
  writeFileSync(launcher, 'another package');
  expect(getLegacyNpmPrefix(alias)).toBeNull();
  rmSync(launcher);
  symlinkSync(join(directory, 'dist', 'cli.js'), launcher);
  expect(getLegacyNpmPrefix(alias)).toBe(prefix);
});

test('local Windows npm shims do not identify a global prefix', () => {
  const prefix = workspace();
  legacyPackage(join(prefix, 'node_modules'));
  const bin = join(prefix, 'node_modules', '.bin');
  mkdirSync(bin);
  const shim = join(bin, 'pi.cmd');
  writeFileSync(shim, '"%dp0%\\..\\@mariozechner\\pi-coding-agent\\dist\\cli.js" %*');
  expect(getLegacyNpmPrefix(shim)).toBeNull();
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('ownership probing exposes filesystem permission failures', () => {
  const prefix = workspace();
  const directory = legacyPackage(join(prefix, 'node_modules'));
  const binary = join(prefix, 'pi.cmd');
  writeFileSync(binary, 'legacy shim');
  chmodSync(directory, 0o000);
  try {
    expect(() => getLegacyNpmPrefix(binary)).toThrow(expect.objectContaining({ code: 'EACCES' }));
  } finally {
    chmodSync(directory, 0o700);
  }
});

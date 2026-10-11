import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Unix npm globals store packages under <prefix>/lib/node_modules.
// https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/config.ts#L102-L119
export const getLegacyNpmPrefix = binaryPath => {
  const windowsShim = /\.cmd$/i.test(binaryPath);
  if (!windowsShim && !lstatSync(binaryPath).isSymbolicLink()) return null;
  const binary = realpathSync(binaryPath);
  let packageDir = windowsShim ? join(dirname(binary), 'node_modules', '@mariozechner', 'pi-coding-agent') : dirname(binary);
  if (!windowsShim) {
    while (dirname(packageDir) !== packageDir) {
      if (basename(packageDir) === 'pi-coding-agent' && basename(dirname(packageDir)) === '@mariozechner') break;
      packageDir = dirname(packageDir);
    }
  }
  if (basename(packageDir) !== 'pi-coding-agent' || basename(dirname(packageDir)) !== '@mariozechner') return null;
  const root = dirname(dirname(packageDir));
  if (basename(root) !== 'node_modules' || (!windowsShim && basename(dirname(root)) !== 'lib')) return null;
  if (!lstatSync(join(packageDir, 'package.json'), { throwIfNoEntry: false })) return null;
  const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  // The renamed package may replace only its own global Pi launcher.
  // https://github.com/earendil-works/pi/blob/c00653255da2abc31192b3c31d0e88a768ae4c52/packages/coding-agent/package.json#L1-L20
  if (metadata.name !== '@mariozechner/pi-coding-agent') return null;
  if (typeof metadata.bin?.pi !== 'string') throw new Error('The legacy Pi package has an invalid executable manifest');
  const entrypoint = realpathSync(join(packageDir, metadata.bin.pi));
  if (!windowsShim) {
    const prefix = dirname(dirname(root));
    const launcher = join(prefix, 'bin', 'pi');
    if (binary !== entrypoint || !lstatSync(launcher, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
    return realpathSync(launcher) === entrypoint ? prefix : null;
  }
  const prefix = dirname(root);
  if (resolve(binaryPath).toLowerCase() !== join(prefix, 'pi.cmd').toLowerCase()) return null;
  // https://github.com/npm/cmd-shim/blob/7667c245e7d9259b5f88b77fb71b497ffcc26976/lib/index.js#L62-L87
  const expectedTarget = metadata.bin.pi.replaceAll('/', '\\');
  const shim = readFileSync(binaryPath, 'utf8');
  return shim.includes(`"%dp0%\\node_modules\\@mariozechner\\pi-coding-agent\\${expectedTarget}"`) ? prefix : null;
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    process.stdout.write(JSON.stringify(getLegacyNpmPrefix(process.argv[2])));
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
}

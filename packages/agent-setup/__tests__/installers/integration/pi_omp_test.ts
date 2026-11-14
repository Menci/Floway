import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { SENTINEL_KEY, hostPwsh, installerMarker, makeWorkspace, modelServer, ompConfig, ompConfigPath, ompExtensionPath, ompPluginLockPath, piConfig, piConnectionsPath, piDirFor, piExtensionPath, piSettingsPath, placeFakeOmp, placeFakePi, readOmpConnections, readPiSettings, runPowerShellInstaller, runShellInstaller } from './harness';
import { SETUP_NODE_OMP_EXTENSION, SETUP_NODE_PI_EXTENSION } from '../../../src/script-assets.generated.ts';

for (const agent of ['pi', 'omp'] as const) {
  const config = agent === 'pi' ? piConfig : ompConfig;
  const place = agent === 'pi' ? placeFakePi : placeFakeOmp;
  const extension = agent === 'pi' ? piExtensionPath : ompExtensionPath;
  const oldVersion = agent === 'pi' ? '1.0.4' : '18.8.3';
  for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
    for (const version of agent === 'pi' ? [oldVersion] : ['omp/17.4.1', oldVersion]) {
      for (const location of agent === 'pi' ? ['PATH'] : ['PATH', 'Bun outside PATH']) {
        test(`[${agent}] ${platform}: upgrades ${version} from ${location} before writing configuration`, { timeout: 180_000 }, async () => {
          const ws = makeWorkspace();
          let bin = ws.binDir;
          if (location === 'Bun outside PATH') {
            const packageDir = join(ws.home, '.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist');
            place(packageDir);
            bin = join(ws.home, '.bun/bin');
            mkdirSync(bin, { recursive: true });
            symlinkSync(join(packageDir, 'omp'), join(bin, 'omp'));
          } else {
            place(bin);
          }
          const options = { workspace: ws, baseUrl: modelServer.url, configuration: config(), [agent === 'pi' ? 'fakePiVersion' : 'fakeOmpVersion']: version };
          const result = await install(options);
          expect(result.code, result.combined).toBe(0);
          expect(existsSync(join(ws.root, `updated-${agent}`))).toBeTruthy();
          if (agent === 'omp') {
            expect(readFileSync(join(ws.root, 'updated-omp.resolved'), 'utf8').trim(), 'updater resolves the selected launcher through PATH').toBe(join(bin, 'omp'));
          }
          expect(existsSync(extension(ws))).toBeTruthy();
        });
      }
    }

    if (agent === 'omp') {
      for (const [version, upgrade] of [['18.8.4-canary.1', true], ['18.8.10-canary.1', false], ['18.8.4+build.1', false]] as const) {
        test(`[${agent}] ${platform}: ${version} respects the numeric minimum and prerelease precedence`, { timeout: 180_000 }, async () => {
          const ws = makeWorkspace();
          place(ws.binDir);
          const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config(), fakeOmpVersion: `omp/${version}` });
          expect(result.code, result.combined).toBe(0);
          expect(existsSync(join(ws.root, 'updated-omp')), 'only versions below the required stable release are updated').toBe(upgrade);
          expect(existsSync(extension(ws))).toBeTruthy();
        });
      }
    }

    for (const mode of ['fail', 'noop', 'sleep'] as const) {
      test(`[${agent}] ${platform}: update ${mode} leaves configuration unchanged`, { timeout: 180_000 }, async () => {
        const ws = makeWorkspace();
        place(ws.binDir);
        const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config(), fakeAgentUpdateMode: mode, timeoutSeconds: 1, [agent === 'pi' ? 'fakePiVersion' : 'fakeOmpVersion']: oldVersion });
        expect(result.code, 'a failed update or still-old effective CLI fails setup').not.toBe(0);
        expect(!existsSync(extension(ws))).toBeTruthy();
      });
    }

    test(`[${agent}] ${platform}: malformed versions fail without running an updater`, { timeout: 180_000 }, async () => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config(), [agent === 'pi' ? 'fakePiVersion' : 'fakeOmpVersion']: '19garbage' });
      expect(result.code).not.toBe(0);
      expect(!existsSync(join(ws.root, `updated-${agent}`))).toBeTruthy();
      expect(!existsSync(extension(ws))).toBeTruthy();
    });

    test(`[${agent}] ${platform}: one extension retains and updates independent providers`, { timeout: 180_000 }, async () => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const first = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config({ provider: 'floway-home', model: 'home-model' }) });
      expect(first.code, first.combined).toBe(0);
      const second = await install({ workspace: ws, baseUrl: `${modelServer.url  }/work`, configuration: config({ provider: 'floway-work' }) });
      expect(second.code, second.combined).toBe(0);
      const connectionsPath = agent === 'pi' ? piConnectionsPath(ws) : ompPluginLockPath(ws);
      const readConnections = () => agent === 'pi'
        ? JSON.parse(readFileSync(connectionsPath, 'utf8')).connections as { provider: string; endpoint: string; apiKey: string }[]
        : readOmpConnections(ws);
      expect(readFileSync(extension(ws), 'utf8'), 'both fixed resources contain no key').not.toContain(SENTINEL_KEY);
      expect(statSync(connectionsPath).mode & 0o777, 'connection configuration is private').toBe(0o600);
      if (agent === 'pi') {
        const auth = JSON.parse(readFileSync(join(piDirFor(ws), 'auth.json'), 'utf8'));
        expect(auth['floway-home'].key).toBe(SENTINEL_KEY);
        expect(auth['floway-work'].key).toBe(SENTINEL_KEY);
        expect(readFileSync(extension(ws), 'utf8')).not.toContain(SENTINEL_KEY);
      }
      expect(readFileSync(extension(ws), 'utf8'), 'two providers share the fixed resource').toBe(agent === 'pi' ? SETUP_NODE_PI_EXTENSION : SETUP_NODE_OMP_EXTENSION);
      const entries = readConnections();
      expect(entries.length).toBe(2);
      expect(entries[0]!.provider).toBe('floway-home');
      expect(entries[1]!.provider).toBe('floway-work');
      expect(entries[0]!.endpoint).toBe(modelServer.url);
      expect(entries[1]!.endpoint).toBe(`${modelServer.url  }/work`);
      const settings = agent === 'pi' ? readPiSettings(piSettingsPath(ws)) : readFileSync(ompConfigPath(ws), 'utf8');
      if (typeof settings === 'string') expect(settings, 'adding a provider preserves another provider default').toContain('floway-home/home-model');
      else expect(settings.defaultProvider, 'adding a provider preserves another provider default').toBe('floway-home');
      const update = await install({ workspace: ws, baseUrl: `${modelServer.url  }/updated`, configuration: config({ provider: 'floway-home', model: 'new-home-model' }) });
      expect(update.code, update.combined).toBe(0);
      expect(readFileSync(extension(ws), 'utf8'), 'endpoint updates retain fixed extension bytes').toBe(agent === 'pi' ? SETUP_NODE_PI_EXTENSION : SETUP_NODE_OMP_EXTENSION);
      const updated = readConnections();
      expect(updated.length, 'updating a provider replaces its connection').toBe(2);
      expect(updated.find(entry => entry.provider === 'floway-work')!.endpoint).toBe(`${modelServer.url  }/work`);
      expect(updated.find(entry => entry.provider === 'floway-home')!.endpoint).toBe(`${modelServer.url  }/updated`);
    });
  }
}

for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
  test(`[pi] ${platform}: upgrades a legacy CLI without self-update through the installer`, { timeout: 180_000 }, async () => {
    const ws = makeWorkspace();
    placeFakePi(ws.binDir);
    const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: piConfig(), fakePiVersion: '0.58.0', fakePiSupportsSelf: false });
    expect(result.code, result.combined).toBe(0);
    expect(existsSync(installerMarker(ws))).toBeTruthy();
    expect(existsSync(piExtensionPath(ws))).toBeTruthy();
  });
}

for (const agent of ['pi', 'omp'] as const) {
  const config = agent === 'pi' ? piConfig : ompConfig;
  const place = agent === 'pi' ? placeFakePi : placeFakeOmp;
  for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
    test(`[${agent}] ${platform}: writes explicit global preferences and preserves them when unset`, { timeout: 180_000 }, async () => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const selected = agent === 'pi'
        ? piConfig({ thinkingLevel: 'high', retry: { enabled: false, maxRetries: 0 } })
        : ompConfig({ retry: { enabled: false, maxRetries: 0 } });
      const result = await install({ workspace: ws, baseUrl: modelServer.url, configuration: selected });
      expect(result.code, result.combined).toBe(0);
      const settingsPath = agent === 'pi' ? piSettingsPath(ws) : ompConfigPath(ws);
      const before = readFileSync(settingsPath, 'utf8');
      if (agent === 'pi') {
        const settings = readPiSettings(settingsPath);
        expect(settings.defaultThinkingLevel).toBe('high');
        expect((settings.retry as Record<string, unknown>).enabled).toBe(false);
        expect((settings.retry as Record<string, unknown>).maxRetries).toBe(0);
      } else {
        expect(before).toContain('enabled: false');
        expect(before).toContain('maxRetries: 0');
      }
      const preserved = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config({ provider: 'another-floway' }) });
      expect(preserved.code, preserved.combined).toBe(0);
      expect(readFileSync(settingsPath, 'utf8'), 'unspecified global preferences retain their original bytes').toBe(before);
    });
  }
}

for (const agent of ['pi', 'omp'] as const) {
  const config = agent === 'pi' ? piConfig : ompConfig;
  const place = agent === 'pi' ? placeFakePi : placeFakeOmp;
  const extension = agent === 'pi' ? piExtensionPath : ompExtensionPath;
  const settings = agent === 'pi' ? piSettingsPath : ompConfigPath;
  for (const [platform, install] of [['Bash', runShellInstaller], ...(hostPwsh ? [['PowerShell', runPowerShellInstaller] as const] : [])] as const) {
    test(`[${agent}] ${platform}: cleanup failure preserves both committed files`, { timeout: 180_000 }, async () => {
      const ws = makeWorkspace();
      place(ws.binDir);
      const initial = await install({ workspace: ws, baseUrl: modelServer.url, configuration: config({ model: 'old-model' }) });
      expect(initial.code, initial.combined).toBe(0);
      const updated = await install({ workspace: ws, baseUrl: `${modelServer.url}/updated`, configuration: config({ model: 'new-model' }), fakeBackupCleanupFailure: true });
      expect(updated.code).not.toBe(0);
      expect(updated.combined).toContain('test backup cleanup failure');
      expect(existsSync(join(ws.root, 'cleanup-after-commit'))).toBeTruthy();
      expect(readFileSync(extension(ws), 'utf8'), 'fixed extension remains committed').toBe(agent === 'pi' ? SETUP_NODE_PI_EXTENSION : SETUP_NODE_OMP_EXTENSION);
      const connections = agent === 'pi'
        ? JSON.parse(readFileSync(piConnectionsPath(ws), 'utf8')).connections as { endpoint: string }[]
        : readOmpConnections(ws);
      expect(connections[0]?.endpoint, 'new connection remains committed').toBe(`${modelServer.url}/updated`);
      expect(readFileSync(settings(ws), 'utf8'), 'new preferences remain committed').toContain('new-model');
      expect(updated.combined, 'committed data does not enter rollback').not.toContain('rolling back');
    });
  }
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const root = join(import.meta.dir, '..', '..');

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

test('package install does not mutate user shell or run updater artifacts', () => {
  const packageJson = JSON.parse(readProjectFile('package.json')) as { scripts?: Record<string, string> };
  const tsupConfig = readProjectFile('tsup.config.ts');

  expect(packageJson.scripts?.postinstall).toBeUndefined();
  expect(tsupConfig).not.toContain('scripts/install');
  expect(tsupConfig).not.toContain('scripts/update-plugins');
});

test('wrapper does not spawn global updater or recycle opencode server processes', () => {
  const wrapper = readProjectFile('src/bin/opentmux.ts');

  expect(wrapper).not.toContain('spawnPluginUpdater');
  expect(wrapper).not.toContain('tryReclaimPort');
  expect(wrapper).not.toContain('Rotating port');
  expect(wrapper).not.toContain('safeKill(oldestPid');
});

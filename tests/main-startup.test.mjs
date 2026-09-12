import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.mjs');

test('main starts the registered watcher only after tabs, HTTP, and state are ready', async () => {
  const source = await fs.readFile(mainPath, 'utf8');
  const watcherStart = source.indexOf('await autopilotWatcher.start();');
  const tabsRestored = source.indexOf('await tabs.restorePersistentTabs();');
  const httpStarted = source.indexOf('server = await startHttpApi({');
  const statePublished = source.indexOf('await writeState({ ok: true, port, pid: process.pid');

  assert.ok(watcherStart > tabsRestored);
  assert.ok(watcherStart > httpStarted);
  assert.ok(watcherStart > statePublished);
});

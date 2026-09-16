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

test('main supervises watcher health after readiness and stops it during shutdown', async () => {
  const source = await fs.readFile(mainPath, 'utf8');
  const supervisorStart = source.indexOf('await watcherSupervisor.start();');
  const watcherStart = source.indexOf('const initialWatcherState = await autopilotWatcher.start();');
  const shutdownStop = source.indexOf('watcherSupervisor.stop();');
  assert.ok(supervisorStart > watcherStart);
  assert.ok(shutdownStop > supervisorStart);
  assert.match(source, /agentify:autopilotWatcherChanged/u);
  assert.match(source, /const watcherStatus = await inspectAutopilotWatcher\(\);/u);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '..');

test('preload exposes a bounded watcher state change subscription', async () => {
  const source = await fs.readFile(path.join(root, 'ui', 'preload.cjs'), 'utf8');
  assert.match(source, /onAutopilotWatcherChanged/u);
  assert.match(source, /agentify:autopilotWatcherChanged/u);
  assert.match(source, /sanitizeWatcherState/u);
});

test('control center consumes watcher-only changes and preserves fresh manual inspection', async () => {
  const source = await fs.readFile(path.join(root, 'ui', 'control-center.js'), 'utf8');
  assert.match(source, /onAutopilotWatcherChanged/u);
  assert.match(source, /applyAutopilotWatcherState/u);
  assert.match(source, /watcherHealthTimer = setInterval/u);
  assert.match(source, /callApi\('getState'/u);
  assert.match(source, /btnRefresh.*refresh\(\{ initial: true \}\)/u);
});

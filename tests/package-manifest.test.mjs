import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

test('package manifest is publishable under @agentify/desktop with npx-friendly bins', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

  assert.equal(manifest.name, '@agentify/desktop');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.equal(manifest.bin?.['agentify-desktop'], 'bin/agentify-desktop.mjs');
  assert.equal(manifest.bin?.['agentify-desktop-gui'], 'bin/agentify-desktop.mjs');
  assert.equal(manifest.bin?.['agentify-desktop-mcp'], 'bin/agentify-desktop.mjs');
  assert.ok(manifest.files.includes('bin/'));
  assert.ok(manifest.files.includes('launch-mode.mjs'));
  assert.ok(manifest.files.includes('main.mjs'));
  assert.ok(manifest.files.includes('mcp-server.mjs'));
  assert.ok(manifest.files.includes('ui/'));
  assert.ok(!manifest.files.includes('tests/'));
  assert.ok(manifest.dependencies?.electron);
  assert.equal(manifest.build?.extraMetadata?.dependencies, null);
  assert.equal(manifest.build?.win?.signExecutable, false);
  assert.equal(manifest.build?.win?.signAndEditExecutable, undefined);
});

test('npm pack dry-run includes the documented runtime entrypoints', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const npmArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm pack --dry-run --json']
    : ['pack', '--dry-run', '--json'];
  const { stdout } = await execFileAsync(npmCommand, npmArgs, {
    cwd: root,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  const [pack] = JSON.parse(stdout);
  const packedPaths = new Set(pack.files.map(({ path: filePath }) => filePath));

  assert.ok(packedPaths.has('main.mjs'));
  assert.ok(packedPaths.has('launch-mode.mjs'));
  assert.ok(packedPaths.has('bin/agentify-desktop.mjs'));
});

test('desktop bin dispatches gui and mcp modes', async () => {
  const bin = await fs.readFile(path.join(root, 'bin', 'agentify-desktop.mjs'), 'utf8');

  assert.ok(bin.startsWith('#!/usr/bin/env node'));
  assert.ok(bin.includes("first === 'mcp'"));
  assert.ok(bin.includes("first === 'gui'"));
  assert.ok(bin.includes("'mcp-server.mjs'"));
  assert.ok(bin.includes("'electron'"));
});

test('public README documents npm package and registered MCP tool names', async () => {
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');

  assert.match(readme, /npx @agentify\/desktop/);
  assert.match(readme, /agentify_tabs/);
  assert.match(readme, /agentify_tab_create/);
  assert.match(readme, /agentify_tab_close/);
  assert.doesNotMatch(readme, /agentify_create_tab/);
  assert.doesNotMatch(readme, /agentify-sh/);
});

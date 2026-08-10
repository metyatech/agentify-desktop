import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TabManager } from '../tab-manager.mjs';
import { TabRegistry, tabRegistryPath } from '../tab-registry.mjs';
import { atomicWriteFile } from '../state.mjs';

const vendors = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
];

async function withTempState(fn) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-tab-registry-'));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createBackend() {
  const sessions = [];
  return {
    sessions,
    setQuitting() {},
    async createSession({ url, onClosed, onUrlChanged }) {
      let currentUrl = url;
      let closed = false;
      const session = {
        page: {
          async getUrl() {
            return currentUrl;
          }
        },
        presenter: {},
        isClosed: () => closed,
        close: async () => {
          if (closed) return;
          closed = true;
          onClosed?.();
        },
        emitUrl(nextUrl) {
          currentUrl = nextUrl;
          onUrlChanged?.(nextUrl);
        },
        userClose() {
          if (closed) return;
          closed = true;
          onClosed?.();
        }
      };
      sessions.push(session);
      return session;
    }
  };
}

async function createManager(stateDir, { backend = createBackend(), maxTabs = 12 } = {}) {
  const registry = new TabRegistry({ stateDir, vendors });
  const manager = new TabManager({
    browserBackend: backend,
    registry,
    maxTabs,
    createController: async () => ({})
  });
  return { manager, registry, backend };
}

test('tab persistence: keyed tabs persist while ephemeral and default tabs do not', async () => {
  await withTempState(async (stateDir) => {
    const { manager, registry } = await createManager(stateDir);
    await manager.createTab({ key: 'default', name: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' });
    await manager.createTab({ name: 'temporary', vendorId: 'chatgpt', vendorName: 'ChatGPT' });
    await manager.createTab({
      key: 'autopilot-production',
      name: 'Autopilot Production',
      vendorId: 'chatgpt',
      vendorName: 'ChatGPT',
      url: 'https://chatgpt.com/',
      protectedTab: true
    });

    assert.deepEqual(await registry.read(), [
      {
        key: 'autopilot-production',
        name: 'Autopilot Production',
        vendorId: 'chatgpt',
        vendorName: 'ChatGPT',
        url: 'https://chatgpt.com/',
        protectedTab: true
      }
    ]);
  });
});

test('tab persistence: top-level navigation checkpoints the current conversation URL', async () => {
  await withTempState(async (stateDir) => {
    const { manager, registry, backend } = await createManager(stateDir);
    await manager.createTab({ key: 'conversation', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://chatgpt.com/' });

    backend.sessions[0].emitUrl('https://chatgpt.com/c/12345678?temporary=secret#fragment');
    await manager.checkpointPersistentTabs();

    const entries = await registry.read();
    assert.equal(entries[0].url, 'https://chatgpt.com/c/12345678');
  });
});

test('tab persistence: restart restores metadata with a new runtime id and ensureTab reuses it', async () => {
  await withTempState(async (stateDir) => {
    const first = await createManager(stateDir);
    const oldId = await first.manager.createTab({
      key: 'conversation',
      name: 'Conversation',
      vendorId: 'chatgpt',
      vendorName: 'ChatGPT',
      url: 'https://chatgpt.com/c/abcdef',
      protectedTab: true
    });
    await first.manager.checkpointPersistentTabs();

    const second = await createManager(stateDir);
    await second.manager.createTab({ key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' });
    await second.manager.restorePersistentTabs();
    const restored = second.manager.listTabs().find((tab) => tab.key === 'conversation');

    assert.ok(restored);
    assert.notEqual(restored.id, oldId);
    assert.equal(restored.name, 'Conversation');
    assert.equal(restored.vendorId, 'chatgpt');
    assert.equal(restored.vendorName, 'ChatGPT');
    assert.equal(restored.url, 'https://chatgpt.com/c/abcdef');
    assert.equal(restored.protectedTab, true);
    assert.equal(
      await second.manager.ensureTab({ key: 'conversation', vendorId: 'chatgpt', url: 'https://chatgpt.com/' }),
      restored.id
    );
    assert.equal(second.manager.listTabs().filter((tab) => tab.key === 'conversation').length, 1);
  });
});

test('tab persistence: explicit close removes an entry while application shutdown retains it', async () => {
  await withTempState(async (stateDir) => {
    const explicit = await createManager(stateDir);
    const explicitId = await explicit.manager.createTab({ key: 'explicit', vendorId: 'chatgpt', vendorName: 'ChatGPT' });
    await explicit.manager.closeTab(explicitId);
    assert.deepEqual(await explicit.registry.read(), []);

    const shutdown = await createManager(stateDir);
    await shutdown.manager.createTab({ key: 'retained', vendorId: 'chatgpt', vendorName: 'ChatGPT' });
    await shutdown.manager.checkpointPersistentTabs();
    shutdown.manager.setQuitting(true);
    shutdown.backend.sessions.at(-1).userClose();
    await shutdown.manager.waitForPersistence();

    assert.equal((await shutdown.registry.read())[0].key, 'retained');
  });
});

test('tab persistence: corrupt, duplicate, default-key, and unsafe registries fail closed', async () => {
  await withTempState(async (stateDir) => {
    const filePath = tabRegistryPath(stateDir);
    await fs.writeFile(filePath, '{not-json', 'utf8');
    await assert.rejects(() => new TabRegistry({ stateDir, vendors }).read(), /tab_registry_invalid/);
    assert.equal(await fs.readFile(filePath, 'utf8'), '{not-json');

    const cases = [
      [
        { key: 'same', name: 'One', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://chatgpt.com/', protectedTab: false },
        { key: 'same', name: 'Two', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://chatgpt.com/', protectedTab: false }
      ],
      [{ key: 'default', name: 'Default', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://chatgpt.com/', protectedTab: true }],
      [{ key: 'unsafe', name: 'Unsafe', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://user:pass@chatgpt.com/c/1', protectedTab: false }]
    ];
    for (const tabs of cases) {
      await fs.writeFile(filePath, `${JSON.stringify({ schemaVersion: 1, tabs })}\n`, 'utf8');
      await assert.rejects(() => new TabRegistry({ stateDir, vendors }).read(), /tab_registry_invalid/);
    }
  });
});

test('tab persistence: restore enforces maxTabs before creating sessions', async () => {
  await withTempState(async (stateDir) => {
    const registry = new TabRegistry({ stateDir, vendors });
    await registry.write([
      { key: 'one', name: 'One', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://chatgpt.com/', protectedTab: false },
      { key: 'two', name: 'Two', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://chatgpt.com/', protectedTab: false }
    ]);
    const backend = createBackend();
    const { manager } = await createManager(stateDir, { backend, maxTabs: 2 });
    await manager.createTab({ key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' });

    await assert.rejects(() => manager.restorePersistentTabs(), /max_tabs_reached/);
    assert.equal(backend.sessions.length, 1);
  });
});

test('tab persistence: a temporary restore failure keeps the durable definition', async () => {
  await withTempState(async (stateDir) => {
    const registry = new TabRegistry({ stateDir, vendors });
    const entry = {
      key: 'keep-on-failure',
      name: 'Keep On Failure',
      vendorId: 'chatgpt',
      vendorName: 'ChatGPT',
      url: 'https://chatgpt.com/c/keep',
      protectedTab: false
    };
    await registry.write([entry]);
    const manager = new TabManager({
      browserBackend: {
        async createSession() {
          throw new Error('temporary_navigation_failure');
        }
      },
      registry,
      createController: async () => ({})
    });

    await assert.rejects(() => manager.restorePersistentTabs(), /temporary_navigation_failure/);
    assert.deepEqual(await registry.read(), [entry]);
  });
});

test('tab persistence: failed atomic write preserves the previous good registry', async () => {
  await withTempState(async (stateDir) => {
    const good = new TabRegistry({ stateDir, vendors });
    const original = [
      { key: 'good', name: 'Good', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://chatgpt.com/c/good', protectedTab: false }
    ];
    await good.write(original);
    const before = await fs.readFile(tabRegistryPath(stateDir), 'utf8');
    const failing = new TabRegistry({
      stateDir,
      vendors,
      atomicWrite: async () => {
        throw new Error('disk_full');
      }
    });

    await assert.rejects(
      () => failing.write([{ ...original[0], url: 'https://chatgpt.com/c/replacement' }]),
      /disk_full/
    );
    assert.equal(await fs.readFile(tabRegistryPath(stateDir), 'utf8'), before);
  });
});

test('tab persistence: failed URL checkpoint keeps the last durable URL and remains retryable', async () => {
  await withTempState(async (stateDir) => {
    let writes = 0;
    const registry = new TabRegistry({
      stateDir,
      vendors,
      atomicWrite: async (...args) => {
        writes += 1;
        if (writes === 2) throw new Error('disk_full');
        return await atomicWriteFile(...args);
      }
    });
    const backend = createBackend();
    const manager = new TabManager({
      browserBackend: backend,
      registry,
      createController: async () => ({})
    });
    const tabId = await manager.createTab({
      key: 'retryable',
      vendorId: 'chatgpt',
      vendorName: 'ChatGPT',
      url: 'https://chatgpt.com/c/old'
    });

    await assert.rejects(() => manager.checkpointTabUrl(tabId, 'https://chatgpt.com/c/new'), /disk_full/);
    assert.equal(manager.listTabs()[0].url, 'https://chatgpt.com/c/old');
    assert.equal((await registry.read())[0].url, 'https://chatgpt.com/c/old');

    assert.equal(await manager.checkpointTabUrl(tabId, 'https://chatgpt.com/c/new'), true);
    assert.equal((await registry.read())[0].url, 'https://chatgpt.com/c/new');
  });
});

test('tab persistence: registry writes do not alter token, settings, or profile state', async () => {
  await withTempState(async (stateDir) => {
    const tokenPath = path.join(stateDir, 'token.txt');
    const settingsPath = path.join(stateDir, 'settings.json');
    const profilePath = path.join(stateDir, 'chrome-user-data', 'profile-marker');
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(tokenPath, 'token-value\n');
    await fs.writeFile(settingsPath, '{"browserBackend":"chrome-cdp"}\n');
    await fs.writeFile(profilePath, 'profile-value');

    const registry = new TabRegistry({ stateDir, vendors });
    await registry.write([
      { key: 'safe', name: 'Safe', vendorId: 'chatgpt', vendorName: 'ChatGPT', url: 'https://chatgpt.com/', protectedTab: false }
    ]);

    assert.equal(await fs.readFile(tokenPath, 'utf8'), 'token-value\n');
    assert.equal(await fs.readFile(settingsPath, 'utf8'), '{"browserBackend":"chrome-cdp"}\n');
    assert.equal(await fs.readFile(profilePath, 'utf8'), 'profile-value');
  });
});

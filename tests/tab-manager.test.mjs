import test from 'node:test';
import assert from 'node:assert/strict';

import { TabManager } from '../tab-manager.mjs';

test('tab-manager: ensureTab rejects vendor mismatch using URL fallback when stored vendorId is missing', async () => {
  const sessions = new Map();
  const browserBackend = {
    async createSession({ tabId, url }) {
      const session = {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {
          sessions.delete(tabId);
        }
      };
      sessions.set(tabId, { url, session });
      return session;
    }
  };

  const manager = new TabManager({
    browserBackend,
    createController: async () => ({})
  });

  const tabId = await manager.createTab({ key: 'projA', url: 'https://chatgpt.com/' });
  assert.ok(tabId);

  await assert.rejects(
    async () =>
      await manager.ensureTab({
        key: 'projA',
        vendorId: 'claude',
        vendorName: 'Claude',
        url: 'https://claude.ai/'
      }),
    /key_vendor_mismatch/
  );
});

test('tab-manager: createTab closes session if controller creation fails', async () => {
  let closeCalls = 0;
  const browserBackend = {
    async createSession() {
      return {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {
          closeCalls += 1;
        }
      };
    }
  };

  const manager = new TabManager({
    browserBackend,
    createController: async () => {
      throw new Error('controller_init_failed');
    }
  });

  await assert.rejects(async () => await manager.createTab({ key: 'projB', url: 'https://chatgpt.com/' }), /controller_init_failed/);
  assert.equal(closeCalls, 1);
  assert.deepEqual(manager.listTabs(), []);
});

test('tab-manager: default tab is lazy, isolated from persistent tabs, and concurrent legacy resolution creates once', async () => {
  let sessionCount = 0;
  const browserBackend = {
    async createSession() {
      sessionCount += 1;
      return {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {}
      };
    }
  };
  const manager = new TabManager({ browserBackend, createController: async () => ({}) });

  const productionId = await manager.createTab({
    key: 'autopilot-production',
    url: 'https://chatgpt.com/',
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT'
  });
  assert.equal(sessionCount, 1);
  assert.equal(manager.listTabs().some((tab) => tab.key === 'default'), false);

  const defaultIds = await Promise.all([
    manager.ensureDefaultTab(),
    manager.ensureDefaultTab(),
    manager.ensureDefaultTab()
  ]);
  assert.equal(new Set(defaultIds).size, 1);
  assert.equal(sessionCount, 2);
  assert.notEqual(defaultIds[0], productionId);
  const rows = manager.listTabs();
  assert.equal(rows.filter((tab) => tab.key === 'default').length, 1);
  assert.equal(rows.find((tab) => tab.key === 'default')?.protectedTab, true);
  assert.equal(rows.find((tab) => tab.key === 'autopilot-production')?.protectedTab, false);
});

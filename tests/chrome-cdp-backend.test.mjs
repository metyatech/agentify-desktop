import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ChromeCdpBrowserBackend, ChromeCdpConnection, chromeSpawnOptions } from '../chrome-cdp-backend.mjs';

class MockWebSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.#emit('open', {}));
  }

  addEventListener(type, handler, opts = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: !!opts?.once });
    this.listeners.set(type, list);
  }

  send(_payload) {}

  close() {
    queueMicrotask(() => this.#emit('close', {}));
  }

  #emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const item of list) {
      try {
        item.handler(event);
      } catch {}
    }
    const keep = (this.listeners.get(type) || []).filter((item) => !item.once);
    if (keep.length) this.listeners.set(type, keep);
    else this.listeners.delete(type);
  }
}

class DelayedMockWebSocket {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler, opts = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: !!opts?.once });
    this.listeners.set(type, list);
  }

  send(_payload) {}

  close() {
    queueMicrotask(() => this.#emit('close', {}));
  }

  open() {
    queueMicrotask(() => this.#emit('open', {}));
  }

  #emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const item of list) {
      try {
        item.handler(event);
      } catch {}
    }
    const keep = (this.listeners.get(type) || []).filter((item) => !item.once);
    if (keep.length) this.listeners.set(type, keep);
    else this.listeners.delete(type);
  }
}

test('chrome-cdp-backend: pending commands reject when websocket closes', async () => {
  const ws = new MockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  await conn.connect();
  const pending = conn.send('Runtime.evaluate', { expression: '1+1' });
  ws.close();

  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: pending commands reject at the bounded command deadline', async () => {
  const ws = new MockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws,
    commandTimeoutMs: 20
  });

  await conn.connect();
  const startedAt = Date.now();
  await assert.rejects(
    async () => await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed' }),
    (error) => {
      assert.equal(error.message, 'chrome_cdp_command_timeout');
      assert.deepEqual(error.data, { method: 'Input.dispatchMouseEvent' });
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 500);
  await conn.close();
});

test('chrome-cdp-backend: Chrome spawn does not use shell on any platform', () => {
  const opts = chromeSpawnOptions();
  assert.equal(opts.stdio, 'ignore');
  assert.equal(Object.hasOwn(opts, 'shell'), false);
});

test('chrome-cdp-backend: connect rejects if websocket closes before open', async () => {
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ({
      addEventListener(type, handler) {
        if (type === 'close') queueMicrotask(() => handler({}));
      },
      close() {}
    })
  });

  await assert.rejects(async () => await conn.connect(), /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: async connect error clears stale websocket before retry', async () => {
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) {
        return {
          addEventListener(type, handler) {
            if (type === 'error') queueMicrotask(() => handler(new Error('ws_async_failed')));
          },
          close() {}
        };
      }
      return new MockWebSocket();
    }
  });

  await assert.rejects(async () => await conn.connect(), /ws_async_failed/);
  assert.equal(conn.ws, null);
  await conn.connect();
  assert.equal(calls, 2);
});

test('chrome-cdp-backend: concurrent connect calls share one websocket', async () => {
  let created = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      created += 1;
      return new MockWebSocket();
    }
  });

  await Promise.all([conn.connect(), conn.connect(), conn.connect()]);
  assert.equal(created, 1);
});

test('chrome-cdp-backend: synchronous websocket constructor failure does not poison future retries', async () => {
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) throw new Error('ws_ctor_failed');
      return new MockWebSocket();
    }
  });

  await (async () => {
    try {
      await conn.connect();
      assert.fail('expected first connect to fail');
    } catch (error) {
      assert.match(String(error?.message || error), /ws_ctor_failed/);
    }
  })();
  await conn.connect();
  assert.equal(calls, 2);
});

test('chrome-cdp-backend: close cancels an in-flight connect before open', async () => {
  const ws = new DelayedMockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  const pending = conn.connect();
  await conn.close();
  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: late open after cancel does not resurrect connection state', async () => {
  const ws = new DelayedMockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  const pending = conn.connect();
  await conn.close();
  ws.open();
  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
  assert.equal(conn.connected, false);
  assert.equal(conn.ws, null);
});

test('chrome-cdp-backend: stale socket close does not tear down a newer healthy connection', async () => {
  const first = new DelayedMockWebSocket();
  let second = null;
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) return first;
      second = new MockWebSocket();
      return second;
    }
  });

  const pendingFirst = conn.connect();
  await conn.close();
  await assert.rejects(async () => await pendingFirst, /chrome_cdp_disconnected/);

  await conn.connect();
  assert.equal(conn.connected, true);
  assert.equal(conn.ws, second);

  first.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(conn.connected, true);
  assert.equal(conn.ws, second);
});

test('chrome-cdp-backend: createSession closes target if initialization fails', async () => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Page.enable') throw new Error('page_enable_failed');
      if (method === 'Target.closeTarget') return { success: true };
      return {};
    }
  };

  await assert.rejects(
    async () => await backend.createSession({ url: 'https://chatgpt.com/' }),
    /page_enable_failed/
  );

  assert.equal(calls.some((item) => item.method === 'Target.closeTarget' && item.params?.targetId === 'target-1'), true);
});

test('chrome-cdp-backend: session close is best-effort when closeTarget fails', async () => {
  let closedCalls = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      void params;
      void sessionId;
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Target.closeTarget') throw new Error('chrome_cdp_disconnected');
      return {};
    }
  };

  const session = await backend.createSession({
    url: 'https://chatgpt.com/',
    onClosed: () => {
      closedCalls += 1;
    }
  });

  await session.close();
  assert.equal(session.isClosed(), true);
  assert.equal(closedCalls, 1);
});

test('chrome-cdp-backend: start cleans up spawned chrome process when CDP connect fails', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chrome-start-fail-'));
  let executablePath = process.execPath;
  if (process.platform !== 'win32') {
    executablePath = path.join(tmpDir, 'fake-chrome.sh');
    await fs.writeFile(executablePath, '#!/bin/sh\nsleep 30\n', { encoding: 'utf8', mode: 0o755 });
  }

  const backend = new ChromeCdpBrowserBackend({
    stateDir: tmpDir,
    executablePath,
    debugPort: 45999
  });

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('port_not_in_use');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45999/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {
      queueMicrotask(() => {
        this._error?.(new Error('ws_connect_failed'));
      });
    }
    addEventListener(type, handler) {
      if (type === 'error') this._error = handler;
    }
    close() {}
  };

  try {
    await assert.rejects(async () => await backend.start(), /ws_connect_failed/);
    assert.equal(backend.client, null);
    assert.equal(backend.started, false);
    assert.equal(backend.chromeProcess, null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('chrome-cdp-backend: dispose resets started state and clears stale tab closers', async () => {
  let clientClosed = 0;
  let processKilled = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    close: async () => {
      clientClosed += 1;
    }
  };
  backend.chromeProcess = {
    killed: false,
    kill: () => {
      processKilled += 1;
    }
  };
  backend.tabClosers.set('tab-1', () => {});
  backend.boundTargetDestroyed = () => {};

  await backend.dispose();

  assert.equal(clientClosed, 1);
  assert.equal(processKilled, 1);
  assert.equal(backend.started, false);
  assert.equal(backend.tabClosers.size, 0);
  assert.equal(backend.client, null);
  assert.equal(backend.chromeProcess, null);
  assert.equal(backend.boundTargetDestroyed, null);
});

test('chrome-cdp-backend: start does not reuse a disconnected client as healthy state', async () => {
  let connectCalls = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: false,
    ws: null,
    close: async () => {}
  };
  backend.chromeProcess = {
    killed: false,
    kill: () => {}
  };
  backend.boundTargetDestroyed = () => {};

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('port_not_in_use');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45998/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {}
    addEventListener(type, handler) {
      if (type === 'open') {
        connectCalls += 1;
        queueMicrotask(() => handler({}));
      }
    }
    close() {}
  };

  try {
    await backend.start();
    assert.equal(connectCalls, 1);
    assert.equal(backend.started, true);
    assert.equal(backend.client?.connected, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
    await backend.dispose();
  }
});

async function createSessionWithFileInputs(selectorNodeIds) {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'file-target' };
      if (method === 'Target.attachToTarget') return { sessionId: 'file-session' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 9 };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: selectorNodeIds[params.selector] || [] };
      if (method === 'DOM.setFileInputFiles') return {};
      return {};
    }
  };
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  return { session, calls };
}

async function createSessionWithRuntimeResult(runtimeResult) {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'runtime-target' };
      if (method === 'Target.attachToTarget') return { sessionId: 'runtime-session' };
      if (method === 'Browser.getWindowForTarget') return {};
      if (method === 'Runtime.evaluate') return runtimeResult;
      return {};
    }
  };
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  return { session, calls };
}

test('chrome-cdp-backend: Runtime.evaluate preserves normal values and undefined', async () => {
  const valueSession = await createSessionWithRuntimeResult({ result: { type: 'string', value: 'ok' } });
  assert.equal(await valueSession.session.page.evaluate('1 + 1'), 'ok');

  const undefinedSession = await createSessionWithRuntimeResult({ result: { type: 'undefined' } });
  assert.equal(await undefinedSession.session.page.evaluate('void 0'), undefined);
});

test('chrome-cdp-backend: Runtime.evaluate exposes bounded sanitized exception diagnostics', async () => {
  const marker = 'prompt-secret-marker';
  const longHex = '0123456789abcdef'.repeat(4);
  const { session, calls } = await createSessionWithRuntimeResult({
    result: { type: 'undefined' },
    exceptionDetails: {
      text: `Uncaught TypeError: ${marker} C:\\private\\fixture\\prompt.txt file:///C:/private/fixture?token=secret https://chatgpt.com/c/abc?access_token=secret ${longHex}`,
      lineNumber: 17,
      columnNumber: 9,
      exception: {
        className: 'TypeError',
        description: `TypeError: ${marker} C:\\private\\fixture\\prompt.txt file:///C:/private/fixture?token=secret https://chatgpt.com/c/abc?access_token=secret ${longHex}`,
        objectId: 'session-secret-object-id'
      }
    }
  });

  await assert.rejects(
    async () => await session.page.evaluate('throw new Error("prompt body")'),
    (error) => {
      assert.equal(error.message, 'browser_evaluation_failed');
      assert.deepEqual(error.data.kind, 'runtime_evaluate_exception');
      assert.equal(error.data.exceptionClass, 'TypeError');
      assert.equal(error.data.lineNumber, 17);
      assert.equal(error.data.columnNumber, 9);
      assert.equal(typeof error.data.exceptionMessage, 'string');
      assert.equal(error.data.exceptionMessage.includes(marker), false);
      assert.equal(error.data.exceptionMessage.includes('C:\\private'), false);
      assert.equal(error.data.exceptionMessage.includes('file://'), false);
      assert.equal(error.data.exceptionMessage.includes('access_token'), false);
      assert.equal(error.data.exceptionMessage.includes(longHex), false);
      assert.equal(JSON.stringify(error.data).includes('session-secret-object-id'), false);
      return true;
    }
  );
  assert.equal(calls.some((call) => call.method === 'Input.insertText'), false);
});

test('chrome-cdp-backend: selector-targeted file input uses only the selected node', async () => {
  const { session, calls } = await createSessionWithFileInputs({
    '#upload-files': [101],
    'input[type="file"]': [101, 102, 103]
  });

  const result = await session.page.setFileInputFiles(['C:\\tmp\\attachment.txt'], { selector: '#upload-files' });

  assert.deepEqual(result, { selector: '#upload-files', found: 1, nodeId: 101 });
  assert.deepEqual(
    calls.filter((call) => call.method === 'DOM.querySelectorAll').map((call) => call.params.selector),
    ['#upload-files']
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'DOM.setFileInputFiles').map((call) => call.params.nodeId),
    [101]
  );
});

test('chrome-cdp-backend: selector-targeted input never uses photo or camera nodes', async () => {
  const { session, calls } = await createSessionWithFileInputs({
    '#upload-files': [201],
    '#upload-photos': [202],
    '#upload-camera': [203]
  });

  await session.page.setFileInputFiles(['C:\\tmp\\attachment.txt'], { selector: '#upload-files' });

  assert.deepEqual(
    calls.filter((call) => call.method === 'DOM.setFileInputFiles').map((call) => call.params.nodeId),
    [201]
  );
  assert.equal(calls.some((call) => call.method === 'DOM.querySelectorAll' && call.params.selector !== '#upload-files'), false);
});

test('chrome-cdp-backend: missing selector-targeted input does not fall back to another file input', async () => {
  const { session, calls } = await createSessionWithFileInputs({
    '#upload-files': [],
    'input[type="file"]': [301, 302, 303]
  });

  await assert.rejects(
    session.page.setFileInputFiles(['C:\\tmp\\attachment.txt'], { selector: '#upload-files' }),
    (error) => {
      assert.equal(error.message, 'missing_file_input');
      assert.deepEqual(error.data, { selector: '#upload-files', found: 0 });
      return true;
    }
  );

  assert.equal(calls.some((call) => call.method === 'DOM.setFileInputFiles'), false);
  assert.equal(calls.some((call) => call.method === 'DOM.querySelectorAll' && call.params.selector === 'input[type="file"]'), false);
});

test('chrome-cdp-backend: ambiguous selector-targeted input does not set files', async () => {
  const { session, calls } = await createSessionWithFileInputs({ '#upload-files': [401, 402] });

  await assert.rejects(
    session.page.setFileInputFiles(['C:\\tmp\\attachment.txt'], { selector: '#upload-files' }),
    (error) => {
      assert.equal(error.message, 'ambiguous_file_input');
      assert.deepEqual(error.data, { selector: '#upload-files', found: 2 });
      return true;
    }
  );

  assert.equal(calls.some((call) => call.method === 'DOM.setFileInputFiles'), false);
});

test('chrome-cdp-backend: generic file input selection remains unchanged without a selector', async () => {
  const { session, calls } = await createSessionWithFileInputs({ 'input[type="file"]': [501, 502, 503] });

  const result = await session.page.setFileInputFiles(['C:\\tmp\\attachment.txt']);

  assert.equal(result, undefined);
  assert.deepEqual(
    calls.filter((call) => call.method === 'DOM.setFileInputFiles').map((call) => call.params.nodeId),
    [503]
  );
});

test('chrome-cdp-backend: selector-targeted file input accepts an empty file list to clear it', async () => {
  const { session, calls } = await createSessionWithFileInputs({
    '#upload-files': [601],
    '#upload-photos': [602],
    '#upload-camera': [603]
  });

  const result = await session.page.setFileInputFiles([], { selector: '#upload-files' });

  assert.deepEqual(result, { selector: '#upload-files', found: 1, nodeId: 601 });
  assert.deepEqual(
    calls.filter((call) => call.method === 'DOM.querySelectorAll').map((call) => call.params.selector),
    ['#upload-files']
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'DOM.setFileInputFiles').map((call) => ({ nodeId: call.params.nodeId, files: call.params.files })),
    [{ nodeId: 601, files: [] }]
  );
});

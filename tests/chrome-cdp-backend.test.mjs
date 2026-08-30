import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ChromeCdpBrowserBackend, ChromeCdpConnection, buildChromeLaunchArgs, chromeSpawnOptions } from '../chrome-cdp-backend.mjs';

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

test('chrome-cdp-backend: keeps managed pages active when the browser window is backgrounded', () => {
  const args = buildChromeLaunchArgs({ debugPort: 9222, userDataDir: 'C:\\agentify-test-profile', startUrl: 'about:blank' });
  assert.ok(args.includes('--disable-background-timer-throttling'));
  assert.ok(args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(args.includes('--disable-renderer-backgrounding'));
});

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

test('chrome-cdp-backend: reports only top-level frame and in-page navigation URL changes', async () => {
  const listeners = new Map();
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    on(method, handler) {
      const list = listeners.get(method) || [];
      list.push(handler);
      listeners.set(method, list);
      return () => listeners.set(method, (listeners.get(method) || []).filter((item) => item !== handler));
    },
    send: async (method) => {
      if (method === 'Target.createTarget') return { targetId: 'target-navigation' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-navigation' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      return {};
    }
  };
  const urls = [];
  await backend.createSession({
    url: 'https://chatgpt.com/',
    onUrlChanged: (url) => urls.push(url)
  });
  const emit = (method, params, sessionId = 'session-navigation') => {
    for (const handler of listeners.get(method) || []) handler(params, sessionId);
  };

  emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main-frame', url: 'https://example.com/frame' } });
  emit('Page.frameNavigated', { frame: { id: 'main-frame', url: 'https://chatgpt.com/c/regular' } });
  emit('Page.navigatedWithinDocument', { frameId: 'main-frame', url: 'https://chatgpt.com/c/spa' });
  emit('Page.navigatedWithinDocument', { frameId: 'child', url: 'https://example.com/subframe' });
  emit('Page.navigatedWithinDocument', { frameId: 'main-frame', url: 'https://chatgpt.com/c/wrong-session' }, 'other-session');

  assert.deepEqual(urls, ['https://chatgpt.com/c/regular', 'https://chatgpt.com/c/spa']);
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

test('chrome-cdp-backend: mouseWheel uses CDP native mouseWheel input', async () => {
  const { session, calls } = await createSessionWithFileInputs({});
  await session.page.mouseWheel(320, 480, 0, -720);
  const wheel = calls.findLast((call) => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(wheel?.params, {
    type: 'mouseWheel', x: 320, y: 480, deltaX: 0, deltaY: -720, button: 'none'
  });
  await assert.rejects(session.page.mouseWheel(10_001, 480, 0, -720), /mouse_wheel_input_invalid/u);
  await session.close();
});

test('chrome-cdp-backend: scrollGesture uses synthesizeScrollGesture with touch semantics', async () => {
  const { session, calls } = await createSessionWithFileInputs({});
  await session.page.scrollGesture({
    x: 320,
    y: 480,
    xDistance: 0,
    yDistance: 420,
    speed: 1_000,
    preventFling: true,
    gestureSourceType: 'touch'
  });
  const gesture = calls.findLast((call) => call.method === 'Input.synthesizeScrollGesture');
  assert.deepEqual(gesture?.params, {
    x: 320,
    y: 480,
    xDistance: 0,
    yDistance: 420,
    xOverscroll: 0,
    yOverscroll: 0,
    preventFling: true,
    speed: 1_000,
    gestureSourceType: 'touch',
    repeatCount: 0,
    repeatDelayMs: 0
  });
  await session.page.scrollGesture({ x: 320, y: 480, yDistance: -420, gestureSourceType: 'touch' });
  const down = calls.findLast((call) => call.method === 'Input.synthesizeScrollGesture');
  assert.equal(down?.params.yDistance, -420);
  await session.close();
});

test('chrome-cdp-backend: scrollGesture rejects invalid coordinates, distances, speed, and source', async () => {
  const { session } = await createSessionWithFileInputs({});
  await assert.rejects(session.page.scrollGesture({ x: Number.NaN, y: 480, yDistance: 420 }), /scroll_gesture_input_invalid/u);
  await assert.rejects(session.page.scrollGesture({ x: 10_001, y: 480, yDistance: 420 }), /scroll_gesture_input_invalid/u);
  await assert.rejects(session.page.scrollGesture({ x: 320, y: 480, yDistance: 0 }), /scroll_gesture_input_invalid/u);
  await assert.rejects(session.page.scrollGesture({ x: 320, y: 480, yDistance: 420, speed: 0 }), /scroll_gesture_input_invalid/u);
  await assert.rejects(session.page.scrollGesture({ x: 320, y: 480, yDistance: 420, gestureSourceType: 'pen' }), /scroll_gesture_input_invalid/u);
  await session.close();
});

test('chrome-cdp-backend: scrollGesture preserves protocol errors and does not invoke mouseWheel', async () => {
  const { session, calls } = await createSessionWithFileInputs({});
  const originalSend = session.page.client.send;
  session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Input.synthesizeScrollGesture') {
      const error = new Error('Method not found');
      error.data = { code: -32601, message: 'Method not found' };
      throw error;
    }
    return await originalSend(method, params, sessionId);
  };
  await assert.rejects(session.page.scrollGesture({ x: 320, y: 480, yDistance: 420 }), (error) => {
    assert.equal(error.data.wrapperCode, 'native_scroll_gesture_dispatch_failed');
    assert.equal(error.data.backendCode, -32601);
    assert.equal(error.data.backendMessage, 'Method not found');
    return true;
  });
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseWheel'), false);
  await session.close();
});

test('chrome-cdp-backend: scrollGesture preserves command timeout without falling back', async () => {
  const { session, calls } = await createSessionWithFileInputs({});
  session.page.client.send = async (method) => {
    if (method === 'Input.synthesizeScrollGesture') {
      const error = new Error('chrome_cdp_command_timeout');
      error.data = { method: 'Input.synthesizeScrollGesture' };
      throw error;
    }
    return {};
  };
  await assert.rejects(session.page.scrollGesture({ x: 320, y: 480, yDistance: 420 }), (error) => {
    assert.equal(error.data.backendCode, null);
    assert.equal(error.data.backendMessage, 'chrome_cdp_command_timeout');
    return true;
  });
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseWheel'), false);
  await session.close();
});

test('chrome-cdp-backend: native wheel diagnostics preserve numeric CDP protocol errors separately from wrapper codes', async () => {
  const { session } = await createSessionWithFileInputs({});
  const originalSend = session.page.client.send;
  session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
      const error = new Error('Invalid parameters');
      error.data = { code: -32602, message: 'Invalid parameters' };
      throw error;
    }
    return await originalSend(method, params, sessionId);
  };
  await assert.rejects(session.page.mouseWheel(320, 480, 0, -720), (error) => {
    assert.equal(error.data.wrapperCode, 'native_mouse_wheel_dispatch_failed');
    assert.equal(error.data.backendCode, -32602);
    assert.equal(error.data.backendMessage, 'Invalid parameters');
    assert.equal(error.data.cause.errorCode, -32602);
    assert.equal(error.data.cause.errorMessage, 'Invalid parameters');
    assert.doesNotMatch(error.data.backendMessage, /Runtime\.evaluate/u);
    return true;
  });
  await session.close();
});

test('chrome-cdp-backend: native wheel diagnostics preserve -32000 and generic backend messages', async () => {
  const { session } = await createSessionWithFileInputs({});
  const originalSend = session.page.client.send;
  session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
      const error = new Error('Target closed');
      error.data = { code: -32000, message: 'Target closed' };
      throw error;
    }
    return await originalSend(method, params, sessionId);
  };
  await assert.rejects(session.page.mouseWheel(320, 480, 0, -720), (error) => {
    assert.equal(error.data.backendCode, -32000);
    assert.equal(error.data.backendMessage, 'Target closed');
    return true;
  });
  await session.close();
});

test('chrome-cdp-backend: native wheel diagnostics preserve command timeout and stale-session distinctions', async () => {
  const timeout = await createSessionWithFileInputs({});
  timeout.session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
      const error = new Error('chrome_cdp_command_timeout');
      error.data = { method: 'Input.dispatchMouseEvent' };
      throw error;
    }
    return {};
  };
  await assert.rejects(timeout.session.page.mouseWheel(320, 480, 0, -720), (error) => {
    assert.equal(error.data.backendCode, null);
    assert.equal(error.data.backendMessage, 'chrome_cdp_command_timeout');
    return true;
  });
  await timeout.session.close();

  const stale = await createSessionWithFileInputs({});
  stale.session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
      const error = new Error('Session with given id not found.');
      error.data = { code: -32001, message: 'Session with given id not found.' };
      throw error;
    }
    return {};
  };
  await assert.rejects(stale.session.page.mouseWheel(320, 480, 0, -720), (error) => {
    assert.equal(error.data.backendCode, -32001);
    assert.equal(error.data.backendMessage, 'Session with given id not found.');
    return true;
  });
  await stale.session.close();
});

test('chrome-cdp-backend: native input diagnostics expose bounded page state', async () => {
  const { session } = await createSessionWithFileInputs({});
  assert.deepEqual(await session.page.getNativeInputDiagnostics(), {
    backend: 'chrome-cdp',
    pageClosed: false,
    browserWindowState: null,
    boundsKnown: false,
    adapterMinimized: true,
    documentVisibilityState: null,
    documentHidden: null,
    documentHasFocus: null,
    windowDestroyed: null,
    webContentsDestroyed: null,
    windowVisible: null,
    windowFocused: null,
    windowMinimized: true
  });
  await session.close();
  assert.equal((await session.page.getNativeInputDiagnostics()).pageClosed, true);
});

test('chrome-cdp-backend: native input diagnostics read browser bounds and document visibility without mutation', async () => {
  const { session, calls } = await createSessionWithFileInputs({});
  const originalSend = session.page.client.send;
  calls.length = 0;
  session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Browser.getWindowBounds') {
      calls.push({ method, params, sessionId });
      return { bounds: { windowState: 'normal' } };
    }
    if (method === 'Runtime.evaluate' && params?.expression?.includes('document.visibilityState')) {
      return { result: { value: { visibilityState: 'visible', hidden: false, hasFocus: false } } };
    }
    return await originalSend(method, params, sessionId);
  };
  session.page.minimized = true;

  assert.deepEqual(await session.page.getNativeInputDiagnostics(), {
    backend: 'chrome-cdp',
    pageClosed: false,
    browserWindowState: 'normal',
    boundsKnown: true,
    adapterMinimized: true,
    documentVisibilityState: 'visible',
    documentHidden: false,
    documentHasFocus: false,
    windowDestroyed: null,
    webContentsDestroyed: null,
    windowVisible: null,
    windowFocused: null,
    windowMinimized: false
  });
  assert.equal(calls.some((call) => call.method === 'Browser.getWindowBounds' && call.params?.windowId === 9), true);
  assert.equal(calls.some((call) => call.method === 'Page.bringToFront'), false);
  assert.equal(calls.some((call) => call.method === 'Browser.setWindowBounds'), false);
  assert.equal(calls.some((call) => call.method.startsWith('Input.')), false);
  await session.close();
});

test('chrome-cdp-backend: native input diagnostics preserve minimized and unavailable bounds separately', async () => {
  const { session, calls } = await createSessionWithFileInputs({});
  const originalSend = session.page.client.send;
  calls.length = 0;
  session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Browser.getWindowBounds') throw new Error('bounds_unavailable_with_secret_token');
    if (method === 'Runtime.evaluate' && params?.expression?.includes('document.visibilityState')) {
      return { result: { value: { visibilityState: 'hidden', hidden: true, hasFocus: false } } };
    }
    return await originalSend(method, params, sessionId);
  };

  const result = await session.page.getNativeInputDiagnostics();
  assert.equal(result.browserWindowState, null);
  assert.equal(result.boundsKnown, false);
  assert.equal(result.adapterMinimized, true);
  assert.equal(result.windowMinimized, true);
  assert.equal(result.documentVisibilityState, 'hidden');
  assert.equal(result.documentHidden, true);
  assert.equal(result.documentHasFocus, false);
  assert.equal(JSON.stringify(result).includes('secret_token'), false);
  assert.equal(calls.some((call) => call.method.startsWith('Input.')), false);
  await session.close();
});

test('chrome-cdp-backend: native input diagnostics report an actual minimized browser window', async () => {
  const { session, calls } = await createSessionWithFileInputs({});
  const originalSend = session.page.client.send;
  calls.length = 0;
  session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Browser.getWindowBounds') {
      calls.push({ method, params, sessionId });
      return { bounds: { windowState: 'minimized' } };
    }
    if (method === 'Runtime.evaluate' && params?.expression?.includes('document.visibilityState')) {
      return { result: { value: { visibilityState: 'hidden', hidden: true, hasFocus: false } } };
    }
    return await originalSend(method, params, sessionId);
  };

  const result = await session.page.getNativeInputDiagnostics();
  assert.equal(result.browserWindowState, 'minimized');
  assert.equal(result.boundsKnown, true);
  assert.equal(result.adapterMinimized, true);
  assert.equal(result.windowMinimized, true);
  assert.equal(result.documentVisibilityState, 'hidden');
  assert.equal(result.documentHidden, true);
  assert.equal(result.documentHasFocus, false);
  assert.equal(calls.some((call) => call.method === 'Browser.getWindowBounds' && call.params?.windowId === 9), true);
  assert.equal(calls.some((call) => call.method.startsWith('Input.')), false);
  await session.close();
});

test('chrome-cdp-backend: visibility probe window primitives only change minimized state', async () => {
  const { session, calls } = await createSessionWithFileInputs({});
  const originalSend = session.page.client.send;
  let windowState = 'minimized';
  calls.length = 0;
  session.page.client.send = async (method, params, sessionId) => {
    if (method === 'Browser.setWindowBounds') {
      windowState = params?.bounds?.windowState || null;
      calls.push({ method, params, sessionId });
      return {};
    }
    if (method === 'Browser.getWindowBounds') {
      calls.push({ method, params, sessionId });
      return { bounds: { windowState } };
    }
    return await originalSend(method, params, sessionId);
  };

  await session.page.temporarilyUnminimizeForProbe();
  assert.equal(windowState, 'normal');
  assert.equal(session.page.minimized, false);
  await session.page.restoreMinimizedForProbe();
  assert.equal(windowState, 'minimized');
  assert.equal(session.page.minimized, true);
  assert.deepEqual(calls.filter((call) => call.method === 'Browser.setWindowBounds').map((call) => call.params), [
    { windowId: 9, bounds: { windowState: 'normal' } },
    { windowId: 9, bounds: { windowState: 'minimized' } }
  ]);
  assert.equal(calls.some((call) => call.method === 'Page.bringToFront'), false);
  assert.equal(calls.some((call) => call.method.startsWith('Input.')), false);
  await session.close();
});

function staleSessionError() {
  const error = new Error('Session with given id not found.');
  error.data = { code: -32001, message: error.message };
  return error;
}

async function createSessionWithRecoveryMock({ onEvaluate, userAgent = null, onUrlChanged = null } = {}) {
  const calls = [];
  const listeners = new Map();
  let attachCount = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state', userAgent });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    on(method, handler) {
      const list = listeners.get(method) || [];
      list.push(handler);
      listeners.set(method, list);
      return () => listeners.set(method, (listeners.get(method) || []).filter((item) => item !== handler));
    },
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'recovery-target' };
      if (method === 'Target.attachToTarget') {
        attachCount += 1;
        return { sessionId: attachCount === 1 ? 'session-old' : 'session-new' };
      }
      if (method === 'Browser.getWindowForTarget') return { windowId: 11 };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'Runtime.evaluate') return await onEvaluate?.({ sessionId, calls });
      return {};
    }
  };
  const session = await backend.createSession({ url: 'https://chatgpt.com/', onUrlChanged });
  return {
    backend,
    session,
    calls,
    listeners,
    emit(method, params, eventSessionId = null) {
      for (const handler of listeners.get(method) || []) handler(params, eventSessionId);
    }
  };
}

test('chrome-cdp-backend: normal session command succeeds without reattach', async () => {
  const mock = await createSessionWithRecoveryMock({ onEvaluate: async () => ({ result: { value: 'ok' } }) });

  assert.equal(await mock.session.page.evaluate('1 + 1'), 'ok');
  assert.equal(mock.session.page.sessionId, 'session-old');
  assert.equal(mock.calls.filter((call) => call.method === 'Target.attachToTarget').length, 1);
  assert.deepEqual(mock.calls.filter((call) => call.method === 'Runtime.evaluate').map((call) => call.sessionId), ['session-old']);
});

test('chrome-cdp-backend: stale Runtime.evaluate reattaches, reinitializes, and retries once', async () => {
  let evaluateCalls = 0;
  const mock = await createSessionWithRecoveryMock({
    userAgent: 'AgentifyTest/1.0',
    onEvaluate: async ({ sessionId }) => {
      evaluateCalls += 1;
      if (sessionId === 'session-old' && evaluateCalls === 1) throw staleSessionError();
      return { result: { value: 'recovered' } };
    }
  });

  assert.equal(await mock.session.page.evaluate('1 + 1'), 'recovered');
  assert.equal(mock.session.page.sessionId, 'session-new');
  assert.equal(mock.calls.filter((call) => call.method === 'Target.attachToTarget').length, 2);
  assert.deepEqual(
    mock.calls.filter((call) => call.method === 'Target.attachToTarget').map((call) => ({ targetId: call.params.targetId, flatten: call.params.flatten })),
    [{ targetId: 'recovery-target', flatten: true }, { targetId: 'recovery-target', flatten: true }]
  );
  assert.deepEqual(mock.calls.filter((call) => call.method === 'Runtime.evaluate').map((call) => call.sessionId), ['session-old', 'session-new']);
  assert.deepEqual(mock.calls.filter((call) => call.method === 'Runtime.evaluate').map((call) => call.params.expression), ['1 + 1', '1 + 1']);
  assert.deepEqual(
    mock.calls.filter((call) => ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Page.getFrameTree', 'Page.addScriptToEvaluateOnNewDocument', 'Network.setUserAgentOverride'].includes(call.method)).map((call) => call.sessionId),
    ['session-old', 'session-old', 'session-old', 'session-old', 'session-old', 'session-old', 'session-new', 'session-new', 'session-new', 'session-new', 'session-new', 'session-new']
  );
  assert.equal(evaluateCalls, 2);
});

test('chrome-cdp-backend: concurrent stale commands share one reattach flight', async () => {
  let staleCalls = 0;
  let releaseStale;
  const staleGate = new Promise((resolve) => { releaseStale = resolve; });
  const mock = await createSessionWithRecoveryMock({
    onEvaluate: async ({ sessionId }) => {
      if (sessionId === 'session-old') {
        staleCalls += 1;
        if (staleCalls === 2) releaseStale();
        await staleGate;
        throw staleSessionError();
      }
      return { result: { value: 'ok' } };
    }
  });

  const results = await Promise.all([mock.session.page.evaluate('1'), mock.session.page.evaluate('2')]);
  assert.deepEqual(results, ['ok', 'ok']);
  assert.equal(mock.calls.filter((call) => call.method === 'Target.attachToTarget').length, 2);
  assert.deepEqual(mock.calls.filter((call) => call.method === 'Runtime.evaluate').map((call) => call.sessionId), ['session-old', 'session-old', 'session-new', 'session-new']);
});

test('chrome-cdp-backend: detached event marks the current session and new-session navigation updates URL', async () => {
  const urls = [];
  let evaluateCalls = 0;
  const mock = await createSessionWithRecoveryMock({
    onUrlChanged: (url) => urls.push(url),
    onEvaluate: async ({ sessionId }) => {
      evaluateCalls += 1;
      if (sessionId === 'session-old' && evaluateCalls === 1) throw staleSessionError();
      return { result: { value: 'ok' } };
    }
  });

  mock.emit('Target.detachedFromTarget', { targetId: 'recovery-target', sessionId: 'session-old' });
  assert.equal(await mock.session.page.evaluate('location.href'), 'ok');
  mock.emit('Page.frameNavigated', { frame: { id: 'main-frame', url: 'https://chatgpt.com/c/recovered' } }, 'session-new');
  mock.emit('Page.navigatedWithinDocument', { frameId: 'main-frame', url: 'https://chatgpt.com/c/recovered-2' }, 'session-new');
  mock.emit('Page.frameNavigated', { frame: { id: 'main-frame', url: 'https://chatgpt.com/c/ignored' } }, 'session-old');

  assert.deepEqual(urls, ['https://chatgpt.com/c/recovered', 'https://chatgpt.com/c/recovered-2']);
});

test('chrome-cdp-backend: non-session CDP errors do not reattach', async () => {
  const error = new Error('Invalid request');
  error.data = { code: -32600, message: error.message };
  const mock = await createSessionWithRecoveryMock({ onEvaluate: async () => { throw error; } });

  await assert.rejects(mock.session.page.evaluate('1 + 1'), (actual) => actual === error);
  assert.equal(mock.calls.filter((call) => call.method === 'Target.attachToTarget').length, 1);
});

test('chrome-cdp-backend: target loss during recovery fails without creating another target', async () => {
  let attachCount = 1;
  const mock = await createSessionWithRecoveryMock({
    onEvaluate: async ({ sessionId }) => {
      if (sessionId === 'session-old') throw staleSessionError();
      return { result: { value: 'unreachable' } };
    }
  });
  const originalSend = mock.backend.client.send;
  mock.backend.client.send = async (method, params, sessionId) => {
    if (method === 'Target.attachToTarget') {
      attachCount += 1;
      if (attachCount === 2) {
        const error = new Error('No target with given id');
        error.data = { code: -32000 };
        throw error;
      }
    }
    return await originalSend(method, params, sessionId);
  };

  await assert.rejects(mock.session.page.evaluate('1 + 1'), (error) => {
    assert.equal(error.message, 'chrome_cdp_session_closed');
    assert.equal(error.data.code, -32001);
    assert.equal(error.data.recoveryCode, -32000);
    return true;
  });
  assert.equal(mock.calls.filter((call) => call.method === 'Target.createTarget').length, 1);
});

test('chrome-cdp-backend: a second stale response after retry is not recovered again', async () => {
  const mock = await createSessionWithRecoveryMock({ onEvaluate: async () => { throw staleSessionError(); } });

  await assert.rejects(mock.session.page.evaluate('1 + 1'), (error) => error.data?.code === -32001);
  assert.equal(mock.calls.filter((call) => call.method === 'Target.attachToTarget').length, 2);
  assert.deepEqual(mock.calls.filter((call) => call.method === 'Runtime.evaluate').map((call) => call.sessionId), ['session-old', 'session-new']);
});

test('chrome-cdp-backend: detached preflight and a stale command still perform one recovery per command', async () => {
  const mock = await createSessionWithRecoveryMock({ onEvaluate: async () => { throw staleSessionError(); } });
  mock.emit('Target.detachedFromTarget', { targetId: 'recovery-target', sessionId: 'session-old' });

  await assert.rejects(mock.session.page.evaluate('1 + 1'), (error) => error.data?.code === -32001);
  assert.equal(mock.calls.filter((call) => call.method === 'Target.attachToTarget').length, 2);
  assert.deepEqual(mock.calls.filter((call) => call.method === 'Runtime.evaluate').map((call) => call.sessionId), ['session-new']);
});

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

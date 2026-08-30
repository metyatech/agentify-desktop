import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { mapErrorToHttp, startHttpApi } from '../http-api.mjs';
import { ChatGPTController } from '../chatgpt-controller.mjs';
import { ChromeCdpBrowserBackend } from '../chrome-cdp-backend.mjs';

async function req({ port, token, method, pth, body, headers = {} }) {
  const res = await fetch(`http://127.0.0.1:${port}${pth}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

test('http-api: health is public and returns serverId', async (t) => {
  const tabs = { listTabs: () => [], ensureTab: async () => 't1', createTab: async () => 't1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 't',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const { res, data } = await req({ port, method: 'GET', pth: '/health' });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.serverId, 'sid-test');
});

test('http-api: a no-create query never creates a missing keyed tab', async (t) => {
  let ensureCalls = 0;
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => { ensureCalls += 1; return 'unexpected'; },
    createTab: async () => 'unexpected',
    closeTab: async () => true,
    getControllerById: () => { throw new Error('must_not_resolve_controller'); }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [{ id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' }],
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0 }),
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());

  const { res, data } = await req({
    port: server.address().port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { key: 'autopilot-production', vendorId: 'chatgpt', prompt: 'proposal', createIfMissing: false }
  });
  assert.equal(res.status, 404);
  assert.equal(data.error, 'tab_not_found');
  assert.equal(ensureCalls, 0);
});

test('http-api: rejects unauthorized', async (t) => {
  const tabs = { listTabs: () => [], ensureTab: async () => 't1', createTab: async () => 't1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true, url: 'x' })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const { res, data } = await req({ port, method: 'GET', pth: '/status' });
  assert.equal(res.status, 401);
  assert.equal(data.error, 'unauthorized');
});

test('http-api: status returns getStatus output', async (t) => {
  const tabs = { listTabs: () => [], ensureTab: async () => 't1', createTab: async () => 't1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true, url: 'https://chatgpt.com/', blocked: false })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const { res, data } = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.url, 'https://chatgpt.com/');
});

test('http-api: native input diagnostics are read-only, serialized, and bounded', async (t) => {
  let exclusive = false;
  const controller = {
    runExclusive: async (fn) => {
      assert.equal(exclusive, false);
      exclusive = true;
      try {
        return await fn();
      } finally {
        exclusive = false;
      }
    },
    getNativeInputDiagnostics: async () => {
      assert.equal(exclusive, true);
      return {
        backend: 'chrome-cdp',
        pageClosed: false,
        browserWindowState: 'minimized',
        boundsKnown: true,
        adapterMinimized: true,
        documentVisibilityState: 'hidden',
        documentHidden: true,
        documentHasFocus: false,
        windowMinimized: true,
        windowVisible: null,
        windowFocused: null,
        windowDestroyed: null,
        webContentsDestroyed: null,
        windowId: 42,
        targetId: 'target-secret'
      };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 'tab-production', key: 'autopilot-production', vendorId: 'chatgpt' }],
    getControllerById: (id) => {
      assert.equal(id, 'tab-production');
      return controller;
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 'default',
    vendors: [{ id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' }],
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());

  const { res, data } = await req({
    port: server.address().port,
    token: 'secret',
    method: 'POST',
    pth: '/native-input/diagnostics',
    body: { key: 'autopilot-production' }
  });
  assert.equal(res.status, 200);
  assert.equal(data.backend, 'chrome-cdp');
  assert.equal(data.browserWindowState, 'minimized');
  assert.equal(data.adapterMinimized, true);
  assert.equal(data.documentVisibilityState, 'hidden');
  assert.equal(data.documentHidden, true);
  assert.equal(data.documentHasFocus, false);
  assert.equal(Object.hasOwn(data, 'windowId'), false);
  assert.equal(Object.hasOwn(data, 'targetId'), false);
});

test('http-api: scroll visibility probe is authenticated, tab-scoped, and bounded', async (t) => {
  let exclusive = false;
  const controller = {
    runExclusive: async (fn) => {
      assert.equal(exclusive, false);
      exclusive = true;
      try {
        return await fn();
      } finally {
        exclusive = false;
      }
    },
    probeScrollVisibility: async function () {
      return await this.runExclusive(async () => {
        assert.equal(exclusive, true);
        return {
        backend: 'chrome-cdp',
        preconditionPassed: true,
        before: {
          browserWindowState: 'minimized',
          adapterMinimized: true,
          documentVisibilityState: 'hidden',
          documentHidden: true,
          documentHasFocus: false,
          range: { min: 6, max: 10 },
          scrollTop: 600,
          clientHeight: 400,
          scrollHeight: 1400,
          atBottom: true,
          windowSignature: 'a'.repeat(32),
          secret: 'must-not-escape'
        },
        normalized: {
          browserWindowState: 'normal',
          adapterMinimized: false,
          documentVisibilityState: 'visible',
          documentHidden: false,
          documentHasFocus: false,
          range: { min: 6, max: 10 },
          windowSignature: 'b'.repeat(32)
        },
        normalizationPhysicalScrollChanged: false,
        normalizationConversationWindowChanged: false,
        gestureAttemptLimit: 4,
        gestureAttempts: 1,
        steps: [{
          attempt: 1,
          gestureDistance: 280,
          gestureSpeed: 1000,
          beforeRange: { min: 6, max: 10 },
          afterRange: { min: 5, max: 9 },
          beforeScrollTop: 600,
          afterScrollTop: 320,
          physicalScrollChanged: true,
          conversationWindowChanged: true,
          commandSucceeded: true
        }],
        firstWindowChangeAttempt: 1,
        gestureAttempted: true,
        gestureSourceType: 'touch',
        gestureDirection: 'older/up',
        gestureDistance: 280,
        gestureSpeed: 1000,
        gestureCommandSucceeded: true,
        afterGesture: { range: { min: 5, max: 9 }, windowSignature: 'c'.repeat(32), scrollTop: 320 },
        physicalScrollChanged: true,
        conversationWindowChanged: true,
        restoreAttempts: 1,
        restoreVerified: true,
        restored: {
          browserWindowState: 'minimized',
          adapterMinimized: true,
          documentVisibilityState: 'hidden',
          documentHidden: true,
          documentHasFocus: false
        },
        urlStable: true,
        reason: 'probe-success-window-changed',
        windowId: 42,
        targetId: 'secret'
        };
      });
    }
  };
  const tabs = {
    listTabs: () => [{ id: 'tab-production', key: 'autopilot-production', vendorId: 'chatgpt' }],
    getControllerById: (id) => {
      assert.equal(id, 'tab-production');
      return controller;
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 'default',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());

  const { res, data } = await req({
    port: server.address().port,
    token: 'secret',
    method: 'POST',
    pth: '/native-input/scroll-visibility-probe',
    body: { key: 'autopilot-production' }
  });
  assert.equal(res.status, 200);
  assert.equal(data.backend, 'chrome-cdp');
  assert.equal(data.reason, 'probe-success-window-changed');
  assert.equal(data.gestureSourceType, 'touch');
  assert.equal(data.gestureAttemptLimit, 4);
  assert.equal(data.gestureAttempts, 1);
  assert.equal(data.steps.length, 1);
  assert.equal(data.steps[0].commandSucceeded, true);
  assert.equal(data.firstWindowChangeAttempt, 1);
  assert.equal(data.afterGesture.range.min, 5);
  assert.equal(Object.hasOwn(data, 'windowId'), false);
  assert.equal(JSON.stringify(data).includes('must-not-escape'), false);
});

test('http-api: mouse-wheel visibility probe is authenticated, tab-scoped, and input-limited', async (t) => {
  let calls = 0;
  const controller = {
    probeMouseWheelVisibility: async (...args) => {
      calls += 1;
      assert.equal(args.length, 0);
      return {
        backend: 'chrome-cdp',
        preconditionPassed: true,
        readyForMouseWheel: true,
        interactionPoint: { x: 595, y: 343 },
        moveMouseAttempted: true,
        moveMouseSucceeded: true,
        wheelAttempted: true,
        wheelDeltaX: 0,
        wheelDeltaY: -720,
        wheelCommandSucceeded: false,
        nativeInput: {
          failurePhase: 'mouse-wheel',
          wrapperErrorCode: 'native_mouse_wheel_dispatch_failed',
          backendErrorMessage: 'chrome_cdp_command_timeout'
        },
        restoreAttempts: 1,
        restoreVerified: true,
        urlStable: true,
        reason: 'probe-wheel-failed'
      };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 'tab-production', key: 'autopilot-production', vendorId: 'chatgpt' }],
    getControllerById: (id) => {
      assert.equal(id, 'tab-production');
      return controller;
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 'default',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());

  const { res, data } = await req({
    port: server.address().port,
    token: 'secret',
    method: 'POST',
    pth: '/native-input/mouse-wheel-visibility-probe',
    body: { key: 'autopilot-production', deltaY: 999, count: 20, windowState: 'normal' }
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.equal(data.wheelDeltaX, 0);
  assert.equal(data.wheelDeltaY, -720);
  assert.equal(data.nativeInput.backendErrorMessage, 'chrome_cdp_command_timeout');
  assert.equal(data.reason, 'probe-wheel-failed');
});

test('http-api: authenticated autopilot status endpoint validates and stores only snapshots', async (t) => {
  const stored = [];
  const tabs = { listTabs: () => [], ensureTab: async () => 't1', createTab: async () => 't1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getAutopilotStatus: async () => stored.at(-1) || null,
    onAutopilotStatus: async ({ snapshot }) => {
      if (snapshot?.schemaVersion !== 1 || snapshot?.taskId !== 'task-1') throw new Error('invalid_autopilot_status');
      stored.push(snapshot);
      return snapshot;
    }
  });
  t.after(() => server.close());
  const snapshot = {
    schemaVersion: 1,
    taskId: 'task-1',
    title: 'Safe task',
    repository: null,
    targetBranch: null,
    status: 'running',
    phase: 'executing',
    round: 1,
    maxRounds: 10,
    latestVerdict: null,
    verification: { completed: 0, total: 0, failed: 0 },
    error: null,
    updatedAt: '2026-08-26T00:00:00.000Z'
  };
  const posted = await req({ port: server.address().port, token: 'secret', method: 'POST', pth: '/autopilot/status', body: snapshot });
  assert.equal(posted.res.status, 200);
  assert.equal(posted.data.snapshot.taskId, 'task-1');
  const read = await req({ port: server.address().port, token: 'secret', method: 'GET', pth: '/autopilot/status' });
  assert.equal(read.res.status, 200);
  assert.equal(read.data.snapshot.phase, 'executing');
  const malformed = await req({ port: server.address().port, token: 'secret', method: 'POST', pth: '/autopilot/status', body: { secret: 'no' } });
  assert.equal(malformed.res.status, 400);
  const unauthorized = await req({ port: server.address().port, method: 'POST', pth: '/autopilot/status', body: snapshot });
  assert.equal(unauthorized.res.status, 401);
});

test('http-api: watcher status is authenticated, bounded, and terminal status clear is guarded', async (t) => {
  let watchSnapshot = null;
  let taskSnapshot = { status: 'running' };
  let clearCalls = 0;
  const tabs = { listTabs: () => [], ensureTab: async () => 't1', createTab: async () => 't1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getAutopilotStatus: async () => taskSnapshot,
    onAutopilotStatusClear: async () => { clearCalls += 1; taskSnapshot = null; },
    getAutopilotWatchStatus: async () => watchSnapshot,
    onAutopilotWatchStatus: async ({ snapshot }) => { watchSnapshot = snapshot; return snapshot; },
  });
  t.after(() => server.close());
  const snapshot = {
    schemaVersion: 1,
    tabKey: 'autopilot-production',
    status: 'healthy',
    lastPollAt: '2026-08-27T00:00:00.000Z',
    lastError: null,
    proposal: {
      proposalId: '123e4567-e89b-42d3-a456-426614174000',
      taskId: 'task-1',
      approvalCode: '4216E4AE',
      state: 'observed',
      updatedAt: '2026-08-27T00:00:00.000Z',
    },
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
  const posted = await req({ port: server.address().port, token: 'secret', method: 'POST', pth: '/autopilot/watch-status', body: snapshot });
  assert.equal(posted.res.status, 200);
  const read = await req({ port: server.address().port, token: 'secret', method: 'GET', pth: '/autopilot/watch-status' });
  assert.equal(read.res.status, 200);
  assert.equal(read.data.snapshot.proposal.state, 'observed');
  const malformed = await req({ port: server.address().port, token: 'secret', method: 'POST', pth: '/autopilot/watch-status', body: { ...snapshot, implementation: { prompt: 'must not enter mirror' } } });
  assert.equal(malformed.res.status, 400);
  const runningClear = await req({ port: server.address().port, token: 'secret', method: 'DELETE', pth: '/autopilot/status' });
  assert.equal(runningClear.res.status, 409);
  taskSnapshot = { status: 'blocked' };
  const terminalClear = await req({ port: server.address().port, token: 'secret', method: 'DELETE', pth: '/autopilot/status' });
  assert.equal(terminalClear.res.status, 200);
  assert.equal(clearCalls, 1);
});

test('http-api: status surfaces active query runtime and stop can cancel it', async (t) => {
  let releaseQuery = null;
  let stopCalls = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      await new Promise((_, reject) => {
        releaseQuery = () => {
          const err = new Error('query_aborted');
          err.data = { reason: 'user_stop' };
          reject(err);
        };
      });
    },
    requestStop: async () => {
      stopCalls += 1;
      releaseQuery?.();
      return { ok: true, requested: true, clicked: true };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, url: 'https://chatgpt.com/', blocked: false, promptVisible: true, kind: null, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const qPromise = req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hello from control center' }
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const st1 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st1.res.status, 200);
  assert.equal(st1.data.activeQuery?.tabId, 't0');
  assert.equal(st1.data.activeQuery?.kind, 'query');
  assert.match(st1.data.activeQuery?.promptPreview || '', /hello from control center/);
  assert.equal(st1.data.runtime?.activeQueries?.length, 1);

  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.requested, true);
  assert.equal(stop.data.clicked, true);
  assert.equal(stop.data.activeQuery?.stopRequested, true);

  const qRes = await qPromise;
  assert.equal(qRes.res.status, 409);
  assert.equal(qRes.data.error, 'query_aborted');
  assert.equal(stopCalls, 1);

  const st2 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st2.res.status, 200);
  assert.equal(st2.data.activeQuery, null);
  assert.equal(st2.data.runtime?.activeQueries?.length, 0);
});

test('http-api: status surfaces source, phase, blocked state, and last outcome for runs', async (t) => {
  let releaseQuery = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async ({ onProgress }) => {
      await onProgress?.({ phase: 'typing_prompt' });
      await onProgress?.({ phase: 'awaiting_user', blocked: true, blockedKind: 'login', blockedTitle: 'Needs sign-in' });
      await new Promise((resolve) => {
        releaseQuery = resolve;
      });
      await onProgress?.({ phase: 'waiting_for_response', blocked: false, blockedKind: null, blockedTitle: null });
      return { text: 'final answer', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, url: 'https://chatgpt.com/', blocked: false, promptVisible: true, kind: null, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const qPromise = req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'show runtime', source: 'mcp' }
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const st1 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st1.res.status, 200);
  assert.equal(st1.data.activeQuery?.source, 'mcp');
  assert.equal(st1.data.activeQuery?.phase, 'awaiting_user');
  assert.equal(st1.data.activeQuery?.blocked, true);
  assert.equal(st1.data.activeQuery?.blockedKind, 'login');
  assert.equal(st1.data.activeQuery?.blockedTitle, 'Needs sign-in');

  releaseQuery?.();
  const qRes = await qPromise;
  assert.equal(qRes.res.status, 200);

  const st2 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st2.res.status, 200);
  assert.equal(st2.data.activeQuery, null);
  assert.equal(st2.data.runtime?.lastOutcomes?.[0]?.tabId, 't0');
  assert.equal(st2.data.runtime?.lastOutcomes?.[0]?.status, 'success');
  assert.equal(st2.data.runtime?.lastOutcomes?.[0]?.source, 'mcp');
  assert.equal(st2.data.runtime?.lastOutcomes?.[0]?.label, 'Response received');
});

test('http-api: aborted client request cancels the controller and releases runtime guards', async (t) => {
  let queryStartedResolve;
  const queryStarted = new Promise((resolve) => { queryStartedResolve = resolve; });
  let controllerAbortObserved = false;
  let requestStopCalls = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async ({ signal }) => {
      queryStartedResolve();
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          controllerAbortObserved = true;
          reject(Object.assign(new Error('query_aborted'), { data: { reason: 'client_disconnected' } }));
        }, { once: true });
      });
    },
    requestStop: async () => {
      requestStopCalls += 1;
      return { ok: true, requested: true, clicked: false };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const abortController = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/query`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'disconnect me' }),
    signal: abortController.signal
  });
  await queryStarted;
  abortController.abort();
  await assert.rejects(pending);

  const deadline = Date.now() + 1_000;
  let status = null;
  while (Date.now() < deadline) {
    status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
    if (!status.data.activeQuery && status.data.runtime.inflightQueries === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(controllerAbortObserved, true);
  assert.equal(requestStopCalls, 1);
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
  assert.equal(status.data.runtime.activeQueries.length, 0);
});

test('http-api: same-tab query/send requests are rejected while a run is already active', async (t) => {
  let releaseQuery = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      await new Promise((resolve) => {
        releaseQuery = resolve;
      });
      return { text: 'done', codeBlocks: [], meta: {} };
    },
    send: async () => ({ ok: true })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 5, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, url: 'https://chatgpt.com/', blocked: false, promptVisible: true, kind: null, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const q1 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'first' } });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const q2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'second' } });
  assert.equal(q2.res.status, 409);
  assert.equal(q2.data.error, 'tab_busy');
  assert.equal(q2.data.data?.activeQuery?.promptPreview, 'first');

  const s2 = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'third' } });
  assert.equal(s2.res.status, 409);
  assert.equal(s2.data.error, 'tab_busy');

  const st = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st.res.status, 200);
  assert.equal(st.data.runtime?.activeQueries?.length, 1);

  releaseQuery?.();
  const q1Res = await q1;
  assert.equal(q1Res.res.status, 200);

  const st2 = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(st2.res.status, 200);
  assert.equal(st2.data.runtime?.activeQueries?.length, 0);
});

test('http-api: /send calls the mutex-owning controller directly and completes once within a bound', async (t) => {
  let mutexDepth = 0;
  let sendCalls = 0;
  const controller = {
    runExclusive: async (fn) => {
      if (mutexDepth > 0) throw new Error('nested_mutex');
      mutexDepth += 1;
      try { return await fn(); } finally { mutexDepth -= 1; }
    },
    send: async ({ text }) => controller.runExclusive(async () => {
      sendCalls += 1;
      return { ok: true, text };
    })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const response = await Promise.race([
    req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'one send' } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('send_route_bound_exceeded')), 1_000))
  ]);
  assert.equal(response.res.status, 200);
  assert.equal(response.data.result.text, 'one send');
  assert.equal(sendCalls, 1);
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
  assert.equal(status.data.runtime.activeQueries.length, 0);
});

test('http-api: stopped /send releases every runtime guard and the next send succeeds', async (t) => {
  let firstSend = true;
  let releaseFirst = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    send: async () => {
      if (!firstSend) return { ok: true, attempt: 2 };
      await new Promise((_, reject) => { releaseFirst = () => reject(Object.assign(new Error('query_aborted'), { data: { reason: 'user_stop' } })); });
      return { ok: true, attempt: 1 };
    },
    requestStop: async () => {
      firstSend = false;
      releaseFirst?.();
      return { ok: true, requested: true, clicked: false };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const first = req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'stop this send' } });
  const deadline = Date.now() + 1_000;
  let active = null;
  while (!active && Date.now() < deadline) {
    const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
    active = status.data.activeQuery;
    if (!active) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(active?.kind, 'send');
  const queryWhileSend = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'blocked by send' } });
  assert.equal(queryWhileSend.res.status, 409);
  assert.equal(queryWhileSend.data.error, 'tab_busy');
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  assert.equal(stop.res.status, 200);
  const firstResponse = await first;
  assert.equal(firstResponse.res.status, 409);
  assert.equal(firstResponse.data.error, 'query_aborted');
  const afterStop = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(afterStop.data.activeQuery, null);
  assert.equal(afterStop.data.runtime.inflightQueries, 0);
  assert.equal(afterStop.data.runtime.activeQueries.length, 0);
  const repeatedStop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  assert.equal(repeatedStop.res.status, 200);
  assert.equal(repeatedStop.data.runtime.inflightQueries, 0);
  assert.equal(repeatedStop.data.runtime.activeQueries.length, 0);
  const next = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'next send' } });
  assert.equal(next.res.status, 200);
  assert.equal(next.data.result.attempt, 2);
});

test('http-api: stop during context preparation aborts before controller query and releases runtime state', async (t) => {
  let prepStartedResolve;
  const prepStarted = new Promise((resolve) => { prepStartedResolve = resolve; });
  let prepareCalls = 0;
  let queryCalls = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      queryCalls += 1;
      return { text: 'must not run', codeBlocks: [], meta: {} };
    },
    requestStop: async () => ({ ok: true, requested: true, clicked: false })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    prepareQueryContextFn: async ({ signal }) => {
      prepareCalls += 1;
      if (prepareCalls === 1) {
        prepStartedResolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      }
      return { prompt: 'prepared', attachments: [], context: { roots: [] } };
    },
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const query = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'preparing context' } });
  await prepStarted;
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  const queryResponse = await query;
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.requested, true);
  assert.equal(queryResponse.res.status, 409);
  assert.equal(queryResponse.data.error, 'query_aborted');
  assert.equal(queryCalls, 0);
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
  const next = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'next query' } });
  assert.equal(next.res.status, 200);
  assert.equal(prepareCalls, 2);
});

test('http-api: stop while query waits for controller mutex prevents query start after mutex release', async (t) => {
  let mutexEnteredResolve;
  const mutexEntered = new Promise((resolve) => { mutexEnteredResolve = resolve; });
  let releaseMutex;
  let holdMutex = true;
  let queryCalls = 0;
  const controller = {
    runExclusive: async (fn) => {
      if (holdMutex) {
        mutexEnteredResolve();
        await new Promise((resolve) => { releaseMutex = resolve; });
      }
      return await fn();
    },
    query: async () => {
      queryCalls += 1;
      return { text: 'query ran', codeBlocks: [], meta: {} };
    },
    requestStop: async () => ({ ok: true, requested: false, clicked: false })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const query = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'mutex wait' } });
  await mutexEntered;
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  releaseMutex();
  const queryResponse = await query;
  assert.equal(stop.res.status, 200);
  assert.equal(queryResponse.res.status, 409);
  assert.equal(queryResponse.data.error, 'query_aborted');
  assert.equal(queryCalls, 0);
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
  holdMutex = false;
  const next = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'query after mutex stop' } });
  assert.equal(next.res.status, 200);
  assert.equal(queryCalls, 1);
});

test('http-api: stop while send waits for its mutex prevents send input and permits the next send', async (t) => {
  let sendEnteredResolve;
  const sendEntered = new Promise((resolve) => { sendEnteredResolve = resolve; });
  let releaseSend;
  let firstSend = true;
  let sendCalls = 0;
  const controller = {
    send: async ({ signal }) => {
      if (firstSend) {
        sendEnteredResolve();
        await new Promise((resolve) => { releaseSend = resolve; });
        if (signal.aborted) throw Object.assign(new Error('query_aborted'), { data: { reason: 'user_stop' } });
      }
      sendCalls += 1;
      return { ok: true, attempt: sendCalls };
    },
    requestStop: async () => ({ ok: true, requested: false, clicked: false })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const first = req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'send mutex wait' } });
  await sendEntered;
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  releaseSend();
  const firstResponse = await first;
  assert.equal(stop.res.status, 200);
  assert.equal(firstResponse.res.status, 409);
  assert.equal(firstResponse.data.error, 'query_aborted');
  assert.equal(sendCalls, 0);
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
  firstSend = false;
  const next = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'send after stop' } });
  assert.equal(next.res.status, 200);
  assert.equal(next.data.result.attempt, 1);
});

test('http-api: stop during tab resolution prevents the later controller start', async (t) => {
  let ensureStartedResolve;
  const ensureStarted = new Promise((resolve) => { ensureStartedResolve = resolve; });
  let releaseEnsure;
  let hasTab = false;
  let queryCalls = 0;
  let requestStopCalls = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      queryCalls += 1;
      return { text: 'query ran', codeBlocks: [], meta: {} };
    },
    requestStop: async () => {
      requestStopCalls += 1;
      return { ok: true, requested: false, clicked: false };
    }
  };
  const tabs = {
    listTabs: () => hasTab ? [{ id: 't0', key: 'resolve-me', vendorId: 'chatgpt' }] : [],
    ensureTab: async () => {
      ensureStartedResolve();
      await new Promise((resolve) => { releaseEnsure = resolve; });
      hasTab = true;
      return 't0';
    },
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const query = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'resolve-me', prompt: 'tab resolution wait' } });
  await ensureStarted;
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: { key: 'resolve-me' } });
  releaseEnsure();
  const queryResponse = await query;
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.requested, true);
  assert.equal(queryResponse.res.status, 409);
  assert.equal(queryResponse.data.error, 'query_aborted');
  assert.equal(queryCalls, 0);
  assert.equal(requestStopCalls, 0);
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
  const next = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'resolve-me', prompt: 'after resolution stop' } });
  assert.equal(next.res.status, 200);
  assert.equal(queryCalls, 1);
});

test('http-api: queued operation stop does not mutate a foreign controller run', async (t) => {
  let mutexEnteredResolve;
  const mutexEntered = new Promise((resolve) => { mutexEnteredResolve = resolve; });
  let releaseMutex;
  let holdMutex = true;
  let queryCalls = 0;
  let providerStopCalls = 0;
  const controller = {
    currentRun: { operationId: 'operation-b', requested: false, messageDispatchStarted: true },
    runExclusive: async (fn) => {
      if (holdMutex) {
        mutexEnteredResolve();
        await new Promise((resolve) => { releaseMutex = resolve; });
      }
      return await fn();
    },
    query: async () => {
      queryCalls += 1;
      return { text: 'query ran', codeBlocks: [], meta: {} };
    },
    requestStop: async ({ expectedOperationId }) => {
      if (controller.currentRun?.operationId !== expectedOperationId) return { ok: true, requested: false, clicked: false, reason: 'operation_mismatch' };
      providerStopCalls += 1;
      controller.currentRun.requested = true;
      return { ok: true, requested: true, clicked: true, reason: 'provider_stop_clicked' };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const query = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'queued operation A' } });
  await mutexEntered;
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.providerStop.status, 'operation_mismatch');
  assert.equal(providerStopCalls, 0);
  assert.equal(controller.currentRun.requested, false);
  releaseMutex();
  const queryResponse = await query;
  assert.equal(queryResponse.res.status, 409);
  assert.equal(queryResponse.data.error, 'query_aborted');
  assert.equal(queryCalls, 0);
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
  holdMutex = false;
  controller.currentRun = null;
  const next = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'foreign run remains safe' } });
  assert.equal(next.res.status, 200);
  assert.equal(queryCalls, 1);
});

test('http-api: stopping context preparation does not click a manual generation stop button', async (t) => {
  let prepStartedResolve;
  const prepStarted = new Promise((resolve) => { prepStartedResolve = resolve; });
  let requestStopCalls = 0;
  const controller = {
    currentRun: null,
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'must not run', codeBlocks: [], meta: {} }),
    requestStop: async () => {
      requestStopCalls += 1;
      return { ok: true, requested: false, clicked: false, reason: 'no_matching_run' };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    prepareQueryContextFn: async ({ signal }) => {
      prepStartedResolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { prompt: 'never sent', attachments: [], context: { roots: [] } };
    },
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const query = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'manual generation must continue' } });
  await prepStarted;
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  const queryResponse = await query;
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.providerStop.status, 'no_matching_run');
  assert.equal(requestStopCalls, 1);
  assert.equal(queryResponse.data.error, 'query_aborted');
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
});

test('http-api: activation abort releases active query, scope, inflight, and control state', async (t) => {
  let activationStartedResolve;
  const activationStarted = new Promise((resolve) => { activationStartedResolve = resolve; });
  let queryFinished = false;
  let queryCalls = 0;
  let requestStopCalls = 0;
  const controller = {
    currentRun: null,
    runExclusive: async (fn) => await fn(),
    query: async ({ operationId, signal }) => {
      queryCalls += 1;
      if (queryCalls > 1) return { text: 'next operation', codeBlocks: [], meta: {} };
      controller.currentRun = { operationId, requested: false, messageDispatchStarted: false };
      activationStartedResolve();
      try {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('query_aborted'), { data: { reason: 'user_stop' } })), { once: true });
        });
      } finally {
        controller.currentRun = null;
        queryFinished = true;
      }
    },
    requestStop: async ({ expectedOperationId }) => {
      if (controller.currentRun?.operationId !== expectedOperationId) return { ok: true, requested: false, clicked: false, reason: 'no_matching_run' };
      requestStopCalls += 1;
      controller.currentRun.requested = true;
      return { ok: true, requested: true, clicked: false, reason: 'before_dispatch' };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const query = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'activation-hang', prompt: 'activation waits' } });
  await activationStarted;
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: { key: 'activation-hang' } });
  const queryResponse = await query;
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.requested, true);
  assert.equal(requestStopCalls, 1);
  assert.equal(queryResponse.res.status, 409);
  assert.equal(queryResponse.data.error, 'query_aborted');
  assert.equal(queryFinished, true);
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.activeQueries.length, 0);
  assert.equal(status.data.runtime.inflightQueries, 0);
  const next = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'activation-hang', prompt: 'after activation stop' } });
  assert.equal(next.res.status, 200);
  assert.equal(queryCalls, 2);
});

test('http-api: hanging provider stop is bounded and does not block the next operation', async (t) => {
  let queryStartedResolve;
  const queryStarted = new Promise((resolve) => { queryStartedResolve = resolve; });
  let providerStopCalls = 0;
  let retireProviderStopCalls = 0;
  let retiredOperationId = null;
  let queryCalls = 0;
  let firstOperationId = null;
  const controller = {
    currentRun: null,
    runExclusive: async (fn) => await fn(),
    query: async ({ operationId, signal }) => {
      queryCalls += 1;
      if (queryCalls === 1) firstOperationId = operationId;
      controller.currentRun = { operationId, requested: false, messageDispatchStarted: true };
      queryStartedResolve();
      if (queryCalls > 1) {
        controller.currentRun = null;
        return { text: 'next operation', codeBlocks: [], meta: {} };
      }
      return await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          controller.currentRun = null;
          reject(Object.assign(new Error('query_aborted'), { data: { reason: 'user_stop' } }));
        }, { once: true });
      });
    },
    requestStop: async () => {
      providerStopCalls += 1;
      return await new Promise(() => {});
    },
    retireProviderStop: async ({ expectedOperationId }) => {
      retireProviderStopCalls += 1;
      retiredOperationId = expectedOperationId;
      return { ok: true, retired: true };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const query = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hanging provider stop' } });
  await queryStarted;
  const stopStartedAt = Date.now();
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  const stopElapsedMs = Date.now() - stopStartedAt;
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.providerStop.status, 'timeout');
  assert.equal(stop.data.providerStop.reason, 'provider_stop_timeout');
  assert.ok(stopElapsedMs < 1_300, `stop took ${stopElapsedMs}ms`);
  assert.equal(providerStopCalls, 1);
  assert.equal(retireProviderStopCalls, 1);
  assert.equal(retiredOperationId, firstOperationId);
  const queryResponse = await query;
  assert.equal(queryResponse.res.status, 409);
  assert.equal(queryResponse.data.error, 'query_aborted');
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.activeQuery, null);
  assert.equal(status.data.runtime.inflightQueries, 0);
  const next = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'after hanging stop' } });
  assert.equal(next.res.status, 200);
  assert.equal(queryCalls, 2);
});

test('http-api: dispatched operation stop passes the exact operation ID once', async (t) => {
  let queryStartedResolve;
  const queryStarted = new Promise((resolve) => { queryStartedResolve = resolve; });
  let currentOperationId = null;
  let requestStopCalls = 0;
  let receivedExpectedOperationId = null;
  const controller = {
    currentRun: null,
    runExclusive: async (fn) => await fn(),
    query: async ({ operationId, signal }) => {
      currentOperationId = operationId;
      controller.currentRun = { operationId, requested: false, messageDispatchStarted: true };
      queryStartedResolve();
      return await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('query_aborted'), { data: { reason: 'user_stop' } }));
      }, { once: true }));
    },
    requestStop: async ({ expectedOperationId }) => {
      receivedExpectedOperationId = expectedOperationId;
      if (controller.currentRun?.operationId !== expectedOperationId) return { ok: true, requested: false, clicked: false, reason: 'operation_mismatch' };
      requestStopCalls += 1;
      controller.currentRun.requested = true;
      controller.currentRun = null;
      return { ok: true, requested: true, clicked: true, reason: 'provider_stop_clicked' };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const query = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'exact operation stop' } });
  await queryStarted;
  const stop = await req({ port, token: 'secret', method: 'POST', pth: '/query/stop', body: {} });
  const queryResponse = await query;
  assert.equal(stop.res.status, 200);
  assert.equal(stop.data.providerStop.status, 'completed');
  assert.equal(stop.data.clicked, true);
  assert.equal(requestStopCalls, 1);
  assert.equal(receivedExpectedOperationId, currentOperationId);
  assert.equal(typeof currentOperationId, 'string');
  assert.equal(queryResponse.data.error, 'query_aborted');
});

test('http-api: attachment errors map to bounded HTTP responses and persist safe last outcomes', async (t) => {
  let nextError = 'attachment_upload_timeout';
  const diagnostic = {
    expectedFileNames: ['C:\\private\\task-contract.json'],
    selectedFileNames: ['C:\\private\\task-contract.json'],
    cardDisplayNames: ['task-contract(1).json'],
    fileCount: 1,
    cardCount: 1,
    mappingComplete: false,
    mappingErrors: ['mapping_ambiguous', 'secret-token-should-not-escape'],
    attachmentStates: [{ sourceFileName: 'C:\\private\\task-contract.json', displayName: 'task-contract(1).json', matched: true, matchKind: 'renamed', pending: true, failed: false, content: 'secret', token: 'secret' }],
    missingFileNames: [],
    pendingFileNames: ['C:\\private\\task-contract.json'],
    failedFileNames: [],
    promptTextLength: 32,
    hasSendButton: true,
    sendDisabled: false,
    busy: false,
    elapsedMs: 250,
    timeoutMs: 500,
    cleanup: { status: 'cleared', reason: 'safe cleanup', selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  };
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => { throw Object.assign(new Error(nextError), { data: diagnostic }); }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const timeout = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'timeout fixture' } });
  assert.equal(timeout.res.status, 408);
  assert.equal(timeout.data.error, 'attachment_upload_timeout');
  assert.equal(timeout.data.data.expectedFileNames[0], 'task-contract.json');
  assert.equal(timeout.data.data.attachmentStates[0].sourceFileName, 'task-contract.json');
  assert.equal(JSON.stringify(timeout.data).includes('private'), false);
  assert.equal(JSON.stringify(timeout.data).includes('secret-token'), false);
  const status = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(status.data.runtime.lastOutcomes[0].label, 'Attachment upload timed out');
  assert.equal(status.data.runtime.lastOutcomes[0].attachmentDiagnostics.cleanup.status, 'cleared');

  nextError = 'attachment_upload_failed';
  const failed = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'failure fixture' } });
  assert.equal(failed.res.status, 422);
  assert.equal(failed.data.error, 'attachment_upload_failed');
  const failedStatus = await req({ port, token: 'secret', method: 'GET', pth: '/status' });
  assert.equal(failedStatus.data.runtime.lastOutcomes[0].label, 'Attachment upload failed');
});

test('http-api: attachment state conflict and clear errors keep explicit status mappings', () => {
  const cases = [
    ['chatgpt_file_input_state_conflict', 409],
    ['chatgpt_file_input_clear_failed', 409],
    ['chatgpt_file_input_clear_timeout', 408]
  ];
  for (const [code, expectedStatus] of cases) {
    const mapped = mapErrorToHttp(Object.assign(new Error(code), { data: { expectedFileNames: ['file.json'] } }));
    assert.equal(mapped.code, expectedStatus);
    assert.equal(mapped.body.error, code);
    assert.equal(mapped.body.data.expectedFileNames[0], 'file.json');
  }
});

test('http-api: browser evaluation failures retain safe phase and diagnostics on the real handler', async (t) => {
  const marker = 'prompt-secret-marker';
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      throw Object.assign(new Error('browser_evaluation_failed'), {
        data: {
          kind: 'runtime_evaluate_exception',
          exceptionClass: 'TypeError',
          exceptionMessage: `Cannot read ${marker} C:\\private\\fixture file:///C:/private/fixture?token=secret`,
          lineNumber: 17,
          columnNumber: 9,
          phase: 'typing_prompt',
          cleanup: { status: 'skipped', reason: 'user_turn_baseline_unavailable' }
        }
      });
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async ({ tabId }) => ({ ok: true, tabId, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  const response = await req({ port: server.address().port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'diagnostic fixture' } });

  assert.equal(response.res.status, 500);
  assert.equal(response.data.error, 'internal_error');
  assert.equal(response.data.message, 'browser_evaluation_failed');
  assert.equal(response.data.data.kind, 'runtime_evaluate_exception');
  assert.equal(response.data.data.phase, 'typing_prompt');
  assert.equal(response.data.data.exceptionClass, 'TypeError');
  assert.equal(response.data.data.lineNumber, 17);
  assert.equal(response.data.data.columnNumber, 9);
  assert.deepEqual(response.data.data.cleanup, { status: 'skipped', reason: 'user_turn_baseline_unavailable' });
  assert.equal(JSON.stringify(response.data).includes(marker), false);
  assert.equal(JSON.stringify(response.data).includes('C:\\private'), false);
  assert.equal(JSON.stringify(response.data).includes('file://'), false);
});

test('http-api: status invalid tabId returns 404', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't1',
    createTab: async () => 't1',
    closeTab: async () => true,
    getControllerById: () => {
      throw new Error('tab_not_found');
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async ({ tabId }) => {
      void tabId;
      throw new Error('tab_not_found');
    }
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'GET', pth: '/status?tabId=nope' });
  assert.equal(r.res.status, 404);
  assert.equal(r.data.error, 'tab_not_found');
});

test('http-api: status routes key/model selectors to the requested vendor tab', async (t) => {
  const seenStatus = [];
  const tabs = {
    listTabs: () => [
      { id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' },
      { id: 't1', key: 'compare', vendorId: 'claude', vendorName: 'Claude', url: 'https://claude.ai/' }
    ],
    ensureTab: async () => 't1',
    createTab: async () => 't1',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async ({ tabId }) => {
      seenStatus.push(tabId);
      return { ok: true, tabId, url: 'https://claude.ai/' };
    }
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'GET',
    pth: '/status?key=compare&model=claude'
  });
  assert.equal(r.res.status, 200);
  assert.equal(r.data.tabId, 't1');
  assert.deepEqual(seenStatus, ['t1']);
});

test('http-api: body_too_large returns 413', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ readPageText: async () => '' })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const big = 'x'.repeat(2_200_000);
  const res = await fetch(`http://127.0.0.1:${port}/read-page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ maxChars: 10, pad: big })
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 413);
  assert.equal(data.error, 'body_too_large');
});

test('http-api: invalid JSON returns 400', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ readPageText: async () => '' })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/read-page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: '{"maxChars":10'
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, 400);
  assert.equal(data.error, 'invalid_json');
});

test('http-api: tabs list/create/close', async (t) => {
  const created = [];
  const tabs = {
    listTabs: () => created.map((id) => ({ id })),
    ensureTab: async ({ key }) => {
      const id = `tab-${key}`;
      if (!created.includes(id)) created.push(id);
      return id;
    },
    createTab: async () => {
      const id = `tab-${created.length + 1}`;
      created.push(id);
      return id;
    },
    closeTab: async (id) => {
      const idx = created.indexOf(id);
      if (idx >= 0) created.splice(idx, 1);
      return true;
    },
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const l1 = await req({ port, token: 'secret', method: 'GET', pth: '/tabs' });
  assert.equal(l1.res.status, 200);
  assert.deepEqual(l1.data.tabs, []);

  const c1 = await req({ port, token: 'secret', method: 'POST', pth: '/tabs/create', body: { key: 'projA' } });
  assert.equal(c1.data.tabId, 'tab-projA');

  const l2 = await req({ port, token: 'secret', method: 'GET', pth: '/tabs' });
  assert.equal(l2.data.tabs.length, 1);

  const cl = await req({ port, token: 'secret', method: 'POST', pth: '/tabs/close', body: { tabId: 'tab-projA' } });
  assert.equal(cl.res.status, 200);
});

test('http-api: tabs/create returns 409 when max tabs reached', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => {
      throw new Error('max_tabs_reached');
    },
    createTab: async () => {
      throw new Error('max_tabs_reached');
    },
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/tabs/create', body: { key: 'projA' } });
  assert.equal(r.res.status, 409);
  assert.equal(r.data.error, 'max_tabs_reached');
});

test('http-api: tabs/create routes keyed tabs to the requested vendor', async (t) => {
  let ensuredArgs = null;
  const tabs = {
    listTabs: () => [],
    ensureTab: async (args) => {
      ensuredArgs = args;
      return 'tab-claude-proj';
    },
    createTab: async () => 'tab-x',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/tabs/create',
    body: { key: 'projA', vendorId: 'claude' }
  });
  assert.equal(r.res.status, 200);
  assert.equal(ensuredArgs.key, 'projA');
  assert.equal(ensuredArgs.vendorId, 'claude');
  assert.equal(ensuredArgs.vendorName, 'Claude');
  assert.equal(ensuredArgs.url, 'https://claude.ai/');
});

test('http-api: show creates missing key tab (and hide does not)', async (t) => {
  const created = [];
  const tabs = {
    listTabs: () => created.map((id) => ({ id, key: id.replace(/^tab-/, '') })),
    ensureTab: async ({ key }) => {
      const id = `tab-${key}`;
      if (!created.includes(id)) created.push(id);
      return id;
    },
    createTab: async () => {
      const id = `tab-${created.length + 1}`;
      created.push(id);
      return id;
    },
    closeTab: async () => true,
    getControllerById: () => ({})
  };

  let shown = [];
  let hidden = [];
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    onShow: async ({ tabId }) => shown.push(tabId),
    onHide: async ({ tabId }) => hidden.push(tabId),
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  // show should create
  const s1 = await req({ port, token: 'secret', method: 'POST', pth: '/show', body: { key: 'projA' } });
  assert.equal(s1.res.status, 200);
  assert.equal(created.includes('tab-projA'), true);
  assert.deepEqual(shown.includes('tab-projA'), true);

  // hide should NOT create
  const h1 = await req({ port, token: 'secret', method: 'POST', pth: '/hide', body: { key: 'projB' } });
  assert.equal(h1.res.status, 404);
  assert.equal(h1.data.error, 'tab_not_found');
  assert.equal(created.includes('tab-projB'), false);

  // hide should work for existing
  const h2 = await req({ port, token: 'secret', method: 'POST', pth: '/hide', body: { key: 'projA' } });
  assert.equal(h2.res.status, 200);
  assert.deepEqual(hidden.includes('tab-projA'), true);
});

test('http-api: operations run through controller.runExclusive when available', async (t) => {
  let inExclusive = false;
  const calls = [];
  const controller = {
    runExclusive: async (fn) => {
      assert.equal(inExclusive, false);
      inExclusive = true;
      try {
        return await fn();
      } finally {
        inExclusive = false;
      }
    },
    navigate: async () => {
      assert.equal(inExclusive, true);
      calls.push('navigate');
    },
    ensureReady: async () => {
      assert.equal(inExclusive, true);
      calls.push('ensureReady');
      return { ok: true };
    },
    query: async () => {
      assert.equal(inExclusive, true);
      calls.push('query');
      return { text: 'ok' };
    },
    readPageText: async () => {
      assert.equal(inExclusive, true);
      calls.push('readPageText');
      return 'page';
    },
    downloadLastAssistantImages: async () => {
      assert.equal(inExclusive, true);
      calls.push('downloadLastAssistantImages');
      return [];
    },
    getUrl: async () => 'https://chatgpt.com/'
  };

  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  await req({ port, token: 'secret', method: 'POST', pth: '/navigate', body: { url: 'https://chatgpt.com/' } });
  await req({ port, token: 'secret', method: 'POST', pth: '/ensure-ready', body: { timeoutMs: 1000 } });
  await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi' } });
  await req({ port, token: 'secret', method: 'POST', pth: '/read-page', body: { maxChars: 10 } });
  await req({ port, token: 'secret', method: 'POST', pth: '/download-images', body: { maxImages: 1 } });

  assert.deepEqual(calls, ['navigate', 'ensureReady', 'query', 'readPageText', 'downloadLastAssistantImages']);
});

test('http-api: query packs context paths before forwarding to controller', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-context-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  await fs.writeFile(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

  let seen = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async (args) => {
      seen = args;
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'Summarize this project.', contextPaths: [dir], attachments: [] }
  });

  assert.equal(r.res.status, 200);
  assert.match(String(seen?.prompt || ''), /Packed Context Summary/);
  assert.ok(Array.isArray(seen?.attachments));
  assert.ok(seen.attachments.some((p) => p.endsWith('image.png')));
  assert.equal(r.data.packedContext.filesScanned >= 2, true);
  assert.equal(r.data.packedContextSummary.inlineFileCount >= 1, true);
  assert.equal(r.data.packedContextSummary.autoAttachmentCount >= 1, true);
  assert.equal(r.data.packedContextSummary.contextCharsUsed >= 1, true);
});

test('http-api: query foregrounds a ChatGPT tab before controller execution', async (t) => {
  const events = [];
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      events.push('query');
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    onShow: async ({ tabId }) => events.push(`show:${tabId}`)
  });
  t.after(() => server.close());

  const r = await req({ port: server.address().port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hello' } });

  assert.equal(r.res.status, 200);
  assert.deepEqual(events, ['show:t0', 'query']);
});

test('http-api: query merges saved bundle inputs', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundle-'));
  const bundleText = path.join(dir, 'bundle.txt');
  const extraText = path.join(dir, 'extra.txt');
  const art = path.join(dir, 'sprite.png');
  await fs.writeFile(bundleText, 'bundle content\n', 'utf8');
  await fs.writeFile(extraText, 'extra content\n', 'utf8');
  await fs.writeFile(art, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

  let seen = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async (args) => {
      seen = args;
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const savedBundle = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/save',
    body: {
      name: 'repo-review',
      promptPrefix: 'Use the saved review style.',
      attachments: [art],
      contextPaths: [bundleText]
    }
  });
  assert.equal(savedBundle.res.status, 200);

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: {
      prompt: 'Now answer my question.',
      bundleName: 'repo-review',
      promptPrefix: 'Also be brief.',
      contextPaths: [extraText]
    }
  });

  assert.equal(r.res.status, 200);
  assert.match(String(seen?.prompt || ''), /Use the saved review style\./);
  assert.match(String(seen?.prompt || ''), /Also be brief\./);
  assert.match(String(seen?.prompt || ''), /bundle\.txt/);
  assert.match(String(seen?.prompt || ''), /extra\.txt/);
  assert.ok(seen.attachments.some((p) => p.endsWith('sprite.png')));
  assert.equal(r.data.bundle.name, 'repo-review');
});

test('http-api: query with keyed tab uses default vendor metadata when no model is provided', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-default-vendor-key-'));
  let ensuredArgs = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [],
    ensureTab: async (args) => {
      ensuredArgs = args;
      return 't-chatgpt';
    },
    createTab: async () => 't-chatgpt',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { key: 'projA', prompt: 'hi' }
  });

  assert.equal(r.res.status, 200);
  assert.equal(ensuredArgs.key, 'projA');
  assert.equal(ensuredArgs.vendorId, 'chatgpt');
  assert.equal(ensuredArgs.vendorName, 'ChatGPT');
  assert.equal(ensuredArgs.url, 'https://chatgpt.com/');
});

test('http-api: query with existing keyed vendor tab does not default to ChatGPT', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-existing-vendor-key-'));
  let ensureCalls = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't-perplexity', key: 'perplexity', vendorId: 'perplexity', vendorName: 'Perplexity', url: 'https://www.perplexity.ai/' }],
    ensureTab: async () => {
      ensureCalls += 1;
      return 'unexpected';
    },
    createTab: async () => 'unexpected',
    closeTab: async () => true,
    getControllerById: (id) => {
      assert.equal(id, 't-perplexity');
      return controller;
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const reused = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { key: 'perplexity', prompt: 'hi' }
  });
  assert.equal(reused.res.status, 200);
  assert.equal(reused.data.tabId, 't-perplexity');
  assert.equal(ensureCalls, 0);

  const mismatch = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { key: 'perplexity', vendorId: 'chatgpt', prompt: 'hi' }
  });
  assert.equal(mismatch.res.status, 409);
  assert.equal(mismatch.data.error, 'key_vendor_mismatch');
});

test('http-api: bundle save/list/get/delete work', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundles-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/save',
    body: { name: 'repo-review', promptPrefix: 'Review carefully.' }
  });
  assert.equal(saved.res.status, 200);

  const listed = await req({ port, token: 'secret', method: 'GET', pth: '/bundles/list' });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.bundles.length, 1);

  const got = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/get',
    body: { name: 'repo-review' }
  });
  assert.equal(got.res.status, 200);
  assert.equal(got.data.bundle.name, 'repo-review');

  const deleted = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/delete',
    body: { name: 'repo-review' }
  });
  assert.equal(deleted.res.status, 200);
  assert.equal(deleted.data.deleted, true);
});

test('http-api: bundles/save rejects relative local paths on the direct HTTP surface', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundles-relative-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/save',
    body: { name: 'repo-review', attachments: ['./relative.txt'] }
  });
  assert.equal(saved.res.status, 400);
  assert.equal(saved.data.error, 'relative_path_not_allowed');
  assert.equal(saved.data.data?.field, 'attachments');
});

test('http-api: query returns 404 for missing bundle', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundle-missing-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hello', bundleName: 'missing' }
  });
  assert.equal(resp.res.status, 404);
  assert.equal(resp.data.error, 'bundle_not_found');
});

test('http-api: get bundle returns 404 when missing', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-bundle-get-missing-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/bundles/get',
    body: { name: 'missing' }
  });
  assert.equal(resp.res.status, 404);
  assert.equal(resp.data.error, 'bundle_not_found');
});

test('http-api: query returns 400 for missing context path', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-context-missing-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'Summarize this project.', contextPaths: [path.join(dir, 'nope')] }
  });

  assert.equal(r.res.status, 400);
  assert.equal(r.data.error, 'missing_context_path');
});

test('http-api: query returns 400 for missing explicit attachment path', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-missing-attach-'));
  const missing = path.join(dir, 'missing.png');
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hi', attachments: [missing] }
  });

  assert.equal(r.res.status, 400);
  assert.equal(r.data.error, 'missing_attachment_path');
});

test('http-api: query rejects relative local paths on the direct HTTP surface', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-query-relative-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hi', attachments: ['./relative.txt'] }
  });

  assert.equal(r.res.status, 400);
  assert.equal(r.data.error, 'relative_path_not_allowed');
  assert.equal(r.data.data?.field, 'attachments');
});

test('http-api: invalid query input does not consume rate-limit budget', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-budget-validation-'));
  const missing = path.join(dir, 'missing.txt');
  let queries = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      queries += 1;
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: 1, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false }),
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const bad = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'bad', attachments: [missing] }
  });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.data.error, 'missing_attachment_path');

  const good = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'good', attachments: [] }
  });
  assert.equal(good.res.status, 200);
  assert.equal(queries, 1);
});

test('http-api: artifacts save/list/open-folder work', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-'));
  let opened = null;
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantImages: async ({ outDir }) => {
      const filePath = path.join(outDir, 'sprite.png');
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return [{ path: filePath, mime: 'image/png', source: 'https://x/img.png' }];
    },
    downloadLastAssistantFiles: async ({ outDir }) => {
      const filePath = path.join(outDir, 'spec.txt');
      await fs.writeFile(filePath, 'spec\n', 'utf8');
      return [{ path: filePath, name: 'spec.txt', mime: 'text/plain', source: 'https://x/spec.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onOpenArtifactsFolder: async ({ folderPath }) => {
      opened = folderPath;
      return true;
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'all' }
  });
  assert.equal(saved.res.status, 200);
  assert.equal(saved.data.artifacts.length, 2);

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 2);

  const openedResp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/open-folder',
    body: {}
  });
  assert.equal(openedResp.res.status, 200);
  assert.equal(typeof opened, 'string');
});

test('http-api: artifacts open-folder ignores blank scoped selectors and opens global root', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-open-root-'));
  let opened = null;
  const controller = {
    runExclusive: async (fn) => await fn()
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onOpenArtifactsFolder: async ({ tabId, folderPath }) => {
      opened = { tabId, folderPath };
      return true;
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const openedResp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/open-folder',
    body: { key: '   ', model: '   ' }
  });
  assert.equal(openedResp.res.status, 200);
  assert.equal(openedResp.data.tabId, null);
  assert.equal(opened?.tabId, null);
  assert.equal(opened?.folderPath, path.join(stateDir, 'artifacts'));
});

test('http-api: artifacts save rejects invalid mode', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-mode-'));
  const controller = {
    runExclusive: async (fn) => await fn()
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'bogus' }
  });
  assert.equal(resp.res.status, 400);
  assert.equal(resp.data.error, 'invalid_artifact_mode');
});

test('http-api: artifacts save routes model hint to the requested vendor tab', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-model-'));
  const seenEnsure = [];
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantImages: async ({ outDir }) => {
      const filePath = path.join(outDir, 'sprite.png');
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return [{ path: filePath, mime: 'image/png', source: 'https://x/img.png' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async (args) => {
      seenEnsure.push(args);
      return 't-claude';
    },
    createTab: async () => 't-claude',
    closeTab: async () => true,
    getControllerById: (id) => {
      assert.equal(id, 't-claude');
      return controller;
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { model: 'claude', key: 'compare', mode: 'images' }
  });
  assert.equal(resp.res.status, 200);
  assert.equal(resp.data.tabId, 't-claude');
  assert.equal(seenEnsure.length, 1);
  assert.equal(seenEnsure[0].key, 'compare');
  assert.equal(seenEnsure[0].vendorId, 'claude');
  assert.equal(seenEnsure[0].url, 'https://claude.ai/');
});

test('http-api: artifacts save fails cleanly before partial writes when controller returns bad artifact path', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-bad-path-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantImages: async ({ outDir }) => [
      { path: path.join(outDir, 'sprite.png'), mime: 'image/png', source: 'https://x/img.png' },
      { path: '   ', mime: 'image/png', source: 'https://x/bad.png' }
    ]
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'images' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save fails if controller reports a non-existent artifact file', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-missing-file-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantImages: async ({ outDir }) => [
      { path: path.join(outDir, 'missing.png'), mime: 'image/png', source: 'https://x/missing.png' }
    ]
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'images' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'missing_artifact_file');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save rejects files outside the tab artifacts directory', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-outside-'));
  const outside = path.join(stateDir, 'outside.txt');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async () => [
      { path: outside, name: 'outside.txt', mime: 'text/plain', source: 'https://x/outside.txt' }
    ]
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'artifact_outside_output_dir');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save rejects symlink escape outside the tab artifacts directory', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-symlink-'));
  const outside = path.join(stateDir, 'outside.txt');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async ({ outDir }) => {
      const linkPath = path.join(outDir, 'outside-link.txt');
      await fs.symlink(outside, linkPath);
      return [{ path: linkPath, name: 'outside-link.txt', mime: 'text/plain', source: 'https://x/outside.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'artifact_symlink_not_allowed');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save rejects mixed candidates atomically when one is a symlink', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-atomic-symlink-'));
  const outside = path.join(stateDir, 'outside.txt');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async ({ outDir }) => {
      const goodPath = path.join(outDir, 'good.txt');
      const linkPath = path.join(outDir, 'outside-link.txt');
      await fs.writeFile(goodPath, 'good\n', 'utf8');
      await fs.symlink(outside, linkPath);
      return [
        { path: goodPath, name: 'good.txt', mime: 'text/plain', source: 'https://x/good.txt' },
        { path: linkPath, name: 'outside-link.txt', mime: 'text/plain', source: 'https://x/outside.txt' }
      ];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'artifact_symlink_not_allowed');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts save rejects hard-link escape outside the tab artifacts directory', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-hardlink-'));
  const outside = path.join(stateDir, 'outside.txt');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async ({ outDir }) => {
      const linkPath = path.join(outDir, 'outside-hardlink.txt');
      await fs.link(outside, linkPath);
      return [{ path: linkPath, name: 'outside-hardlink.txt', mime: 'text/plain', source: 'https://x/outside.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });
  assert.equal(saved.res.status, 500);
  assert.equal(saved.data.error, 'artifact_save_failed');
  assert.equal(saved.data.data?.reason, 'artifact_link_count_not_allowed');

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.artifacts.length, 0);
});

test('http-api: artifacts list without tab scope returns global artifacts', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-artifacts-global-'));
  const controller = {
    runExclusive: async (fn) => await fn(),
    downloadLastAssistantFiles: async ({ outDir }) => {
      const filePath = path.join(outDir, 'spec.txt');
      await fs.writeFile(filePath, 'spec\n', 'utf8');
      return [{ path: filePath, name: 'spec.txt', mime: 'text/plain', source: 'https://x/spec.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'repo', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'files' }
  });

  const listed = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/list',
    body: { limit: 10 }
  });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.tabId, null);
  assert.equal(listed.data.artifacts.length, 1);
});

test('http-api: watch-folder list/open/scan work', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-'));
  let opened = null;
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onWatchFoldersList: async () => [{ name: 'inbox', path: path.join(stateDir, 'watch-folders', 'inbox') }],
    onOpenWatchFolder: async ({ folderPath }) => {
      opened = folderPath;
      return true;
    },
    onScanWatchFolder: async () => ({ folderPath: path.join(stateDir, 'watch-folders', 'inbox'), ingested: [{ id: 'a1' }] }),
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const listed = await req({ port, token: 'secret', method: 'GET', pth: '/watch-folders/list' });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.folders.length, 1);

  const openedResp = await req({ port, token: 'secret', method: 'POST', pth: '/watch-folders/open', body: {} });
  assert.equal(openedResp.res.status, 200);
  assert.equal(opened, path.join(stateDir, 'watch-folders', 'inbox'));

  const scanned = await req({ port, token: 'secret', method: 'POST', pth: '/watch-folders/scan', body: {} });
  assert.equal(scanned.res.status, 200);
  assert.equal(scanned.data.ingested.length, 1);
});

test('http-api: watch-folder add/delete work', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-crud-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  let added = null;
  let removed = null;
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onWatchFoldersList: async () => [{ name: 'inbox', path: path.join(stateDir, 'watch-folders', 'inbox') }],
    onAddWatchFolder: async ({ name, folderPath }) => {
      added = { name, path: folderPath };
      return { name: name || 'x', path: folderPath, isDefault: false };
    },
    onRemoveWatchFolder: async ({ name }) => {
      removed = name;
      return true;
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const addResp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/add',
    body: { name: 'sprites', path: '/tmp/sprites' }
  });
  assert.equal(addResp.res.status, 200);
  assert.equal(added.name, 'sprites');

  const delResp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/delete',
    body: { name: 'sprites' }
  });
  assert.equal(delResp.res.status, 200);
  assert.equal(removed, 'sprites');
});

test('http-api: watch-folder add rejects filesystem root', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-root-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onAddWatchFolder: async () => {
      throw new Error('watch_folder_cannot_be_filesystem_root');
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/add',
    body: { name: 'root', path: path.parse(process.cwd()).root }
  });
  assert.equal(resp.res.status, 400);
  assert.equal(resp.data.error, 'watch_folder_cannot_be_filesystem_root');
});

test('http-api: watch-folder add rejects file paths cleanly', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-file-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onAddWatchFolder: async () => {
      throw new Error('watch_folder_not_directory');
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/add',
    body: { name: 'filey', path: '/tmp/not-a-dir.txt' }
  });
  assert.equal(resp.res.status, 400);
  assert.equal(resp.data.error, 'watch_folder_not_directory');
});

test('http-api: watch-folders/add rejects relative paths on the direct HTTP surface', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-relative-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onAddWatchFolder: async () => {
      throw new Error('should_not_be_called');
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/add',
    body: { name: 'sprites', path: './sprites' }
  });
  assert.equal(resp.res.status, 400);
  assert.equal(resp.data.error, 'relative_path_not_allowed');
  assert.equal(resp.data.data?.field, 'path');
});

test('http-api: opening unknown watch folder returns 404', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-watch-missing-'));
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({ runExclusive: async (fn) => await fn() })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    onWatchFoldersList: async () => [{ name: 'inbox', path: path.join(stateDir, 'watch-folders', 'inbox') }],
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const resp = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/watch-folders/open',
    body: { name: 'missing' }
  });
  assert.equal(resp.res.status, 404);
  assert.equal(resp.data.error, 'watch_folder_not_found');
});

test('http-api: query returns vendor-specific context budget', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-budget-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'claude' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'Summarize this project.', contextPaths: [dir] }
  });

  assert.equal(r.res.status, 200);
  assert.equal(r.data.packedContextBudget.maxContextChars, 140000);
});

test('http-api: query returns effective override context budget metadata', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-budget-override-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'claude' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: {
      prompt: 'Summarize this project.',
      contextPaths: [dir],
      maxContextChars: 1234,
      maxContextChunkChars: 222,
      maxContextChunksPerFile: 3,
      maxContextInlineFiles: 4,
      maxContextAttachments: 5
    }
  });

  assert.equal(r.res.status, 200);
  assert.equal(r.data.packedContextBudget.maxContextChars, 1234);
  assert.equal(r.data.packedContextBudget.maxChunkChars, 222);
  assert.equal(r.data.packedContextBudget.maxChunksPerFile, 3);
  assert.equal(r.data.packedContextBudget.maxInlineFiles, 4);
  assert.equal(r.data.packedContextBudget.maxAttachmentFiles, 5);
});

test('http-api: query ignores invalid non-positive context budget overrides', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-budget-invalid-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'claude' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: {
      prompt: 'Summarize this project.',
      contextPaths: [dir],
      maxContextChars: -123,
      maxContextChunkChars: 0,
      maxContextChunksPerFile: -2,
      maxContextInlineFiles: 'nope',
      maxContextAttachments: -5
    }
  });

  assert.equal(r.res.status, 200);
  assert.equal(r.data.packedContextBudget.maxContextChars, 140000);
  assert.equal(r.data.packedContextBudget.maxChunkChars, 7500);
  assert.equal(r.data.packedContextBudget.maxChunksPerFile, 3);
  assert.equal(r.data.packedContextBudget.maxInlineFiles, 20);
  assert.equal(r.data.packedContextBudget.maxAttachmentFiles, 12);
});

test('http-api: non-positive timeoutMs values fall back to safe defaults', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-timeout-clamp-'));
  const seen = { ensureReady: [], query: [], send: [] };
  const controller = {
    runExclusive: async (fn) => await fn(),
    ensureReady: async ({ timeoutMs }) => {
      seen.ensureReady.push(timeoutMs);
      return { ok: true };
    },
    query: async ({ timeoutMs }) => {
      seen.query.push(timeoutMs);
      return { text: 'ok', codeBlocks: [], meta: {} };
    },
    send: async ({ timeoutMs }) => {
      seen.send.push(timeoutMs);
      return { ok: true };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const ready = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/ensure-ready',
    body: { timeoutMs: -1 }
  });
  assert.equal(ready.res.status, 200);

  const queried = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { prompt: 'hi', timeoutMs: 0 }
  });
  assert.equal(queried.res.status, 200);

  const sent = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/send',
    body: { text: 'hi', timeoutMs: -50 }
  });
  assert.equal(sent.res.status, 200);

  assert.deepEqual(seen.ensureReady, [10 * 60_000]);
  assert.deepEqual(seen.query, [10 * 60_000]);
  assert.deepEqual(seen.send, [3 * 60_000]);
});

test('http-api: oversized numeric overrides are clamped to bounded ceilings', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-ceiling-clamp-'));
  await fs.writeFile(path.join(dir, 'repo.txt'), 'hello from repo\n', 'utf8');
  const seen = { query: [], read: [], images: [], files: [] };
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async ({ timeoutMs }) => {
      seen.query.push(timeoutMs);
      return { text: 'ok', codeBlocks: [], meta: {} };
    },
    readPageText: async ({ maxChars }) => {
      seen.read.push(maxChars);
      return 'ok';
    },
    downloadLastAssistantImages: async ({ maxImages, outDir }) => {
      seen.images.push(maxImages);
      const filePath = path.join(outDir, 'sprite.png');
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return [{ path: filePath, mime: 'image/png', source: 'https://x/img.png' }];
    },
    downloadLastAssistantFiles: async ({ maxFiles, outDir }) => {
      seen.files.push(maxFiles);
      const filePath = path.join(outDir, 'spec.txt');
      await fs.writeFile(filePath, 'spec\n', 'utf8');
      return [{ path: filePath, name: 'spec.txt', mime: 'text/plain', source: 'https://x/spec.txt' }];
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'claude' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const queried = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: {
      prompt: 'Summarize this project.',
      contextPaths: [dir],
      timeoutMs: 999_999_999,
      maxContextChars: 9_999_999,
      maxContextFiles: 9_999,
      maxContextFileChars: 9_999_999,
      maxContextChunkChars: 9_999_999,
      maxContextChunksPerFile: 9_999,
      maxContextInlineFiles: 9_999,
      maxContextAttachments: 9_999
    }
  });
  assert.equal(queried.res.status, 200);
  assert.equal(seen.query[0], 30 * 60_000);
  assert.equal(queried.data.packedContextBudget.maxContextChars, 500_000);
  assert.equal(queried.data.packedContextBudget.maxFiles, 500);
  assert.equal(queried.data.packedContextBudget.maxFileChars, 100_000);
  assert.equal(queried.data.packedContextBudget.maxChunkChars, 20_000);
  assert.equal(queried.data.packedContextBudget.maxChunksPerFile, 20);
  assert.equal(queried.data.packedContextBudget.maxInlineFiles, 100);
  assert.equal(queried.data.packedContextBudget.maxAttachmentFiles, 50);

  const read = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/read-page',
    body: { maxChars: 9_999_999 }
  });
  assert.equal(read.res.status, 200);
  assert.equal(seen.read[0], 1_000_000);

  const saved = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/artifacts/save',
    body: { mode: 'all', maxImages: 9_999, maxFiles: 9_999 }
  });
  assert.equal(saved.res.status, 200);
  assert.equal(seen.images[0], 50);
  assert.equal(seen.files[0], 50);
});

test('http-api: query model hint routes to a vendor-scoped tab when default tab is another vendor', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-http-model-route-'));
  const seenEnsure = [];
  const seenQuery = [];
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async (args) => {
      seenQuery.push(args);
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async (args) => {
      seenEnsure.push(args);
      return 't-claude';
    },
    createTab: async () => 't-claude',
    closeTab: async () => true,
    getControllerById: (id) => {
      assert.equal(id, 't-claude');
      return controller;
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [
      { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
      { id: 'claude', name: 'Claude', url: 'https://claude.ai/' }
    ],
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { model: 'claude', prompt: 'hi' }
  });

  assert.equal(r.res.status, 200);
  assert.equal(seenEnsure.length, 1);
  assert.equal(seenEnsure[0].key, 'vendor:claude');
  assert.equal(seenEnsure[0].vendorId, 'claude');
  assert.equal(seenEnsure[0].url, 'https://claude.ai/');
  assert.equal(seenQuery.length, 1);
  assert.equal(r.data.tabId, 't-claude');
});

test('http-api: query rejects unknown vendor hint', async (t) => {
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    vendors: [{ id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' }],
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/query',
    body: { model: 'unknown-vendor', prompt: 'hi' }
  });

  assert.equal(r.res.status, 400);
  assert.equal(r.data.error, 'invalid_vendor');
});

test('http-api: ensure-ready timeout maps to 408 with details', async (t) => {
  const controller = {
    runExclusive: async (fn) => await fn(),
    ensureReady: async () => {
      const err = new Error('timeout_waiting_for_prompt');
      err.data = { kind: 'login' };
      throw err;
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/ensure-ready', body: { timeoutMs: 1000 } });
  assert.equal(r.res.status, 408);
  assert.equal(r.data.error, 'timeout_waiting_for_prompt');
  assert.deepEqual(r.data.data, { kind: 'login' });
});

test('http-api: query returns 429 when maxInflightQueries exceeded', async (t) => {
  let started = 0;
  let release;
  const gate = new Promise((r) => (release = r));

  const controllers = new Map();
  const getController = (id) => {
    if (!controllers.has(id)) {
      controllers.set(id, {
        runExclusive: async (fn) => await fn(),
        query: async () => {
          started += 1;
          await gate;
          return { text: 'ok' };
        }
      });
    }
    return controllers.get(id);
  };

  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }, { id: 't1', key: 'q1' }, { id: 't2', key: 'q2' }],
    ensureTab: async ({ key }) => {
      if (key === 'q1') return 't1';
      if (key === 'q2') return 't2';
      return 't0';
    },
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: (id) => getController(id)
  };

  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getSettings: async () => ({ maxInflightQueries: 1, maxQueriesPerMinute: 999, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const q1 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'q1', prompt: 'hi' } });
  // Give the server a moment to enter the handler and increment inflight.
  for (let i = 0; i < 50 && started === 0; i++) await new Promise((r) => setTimeout(r, 5));

  const q2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'q2', prompt: 'hi2' } });
  assert.equal(q2.res.status, 429);
  assert.equal(q2.data.error, 'rate_limited');
  assert.equal(q2.data.reason, 'max_inflight');

  release();
  const q1r = await q1;
  assert.equal(q1r.res.status, 200);
});

test('http-api: query pacing returns 429 with retryAfterMs when max wait is 0', async (t) => {
  let calls = 0;
  const controller = {
    runExclusive: async (fn) => await fn(),
    query: async () => {
      calls += 1;
      return { text: 'ok' };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getSettings: async () => ({ maxInflightQueries: 10, maxQueriesPerMinute: 999, minTabGapMs: 5_000, minGlobalGapMs: 0, showTabsByDefault: false })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const q1 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi' } });
  assert.equal(q1.res.status, 200);

  const q2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi2' } });
  assert.equal(q2.res.status, 429);
  assert.equal(q2.data.error, 'rate_limited');
  assert.equal(q2.data.reason, 'tab_gap');
  assert.equal(typeof q2.data.retryAfterMs, 'number');
  assert.ok(q2.data.retryAfterMs > 0);

  assert.equal(calls, 1);
});

test('http-api: invalid tabId returns 404', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => {
      throw new Error('tab_not_found');
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/read-page', body: { tabId: 'nope', maxChars: 10 } });
  assert.equal(r.res.status, 404);
  assert.equal(r.data.error, 'tab_not_found');
});

test('http-api: default tab cannot be closed', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/tabs/close', body: { tabId: 't0' } });
  assert.equal(r.res.status, 409);
  assert.equal(r.data.error, 'default_tab_protected');
});

test('http-api: tab_closed returns 409', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => {
      throw new Error('tab_closed');
    }
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/read-page', body: { tabId: 't0', maxChars: 10 } });
  assert.equal(r.res.status, 409);
  assert.equal(r.data.error, 'tab_closed');
});

test('http-api: rotate-token updates auth', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-state-'));
  const tabs = { listTabs: () => [], ensureTab: async () => 't0', createTab: async () => 't0', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'old',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: dir,
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r1 = await req({ port, token: 'old', method: 'POST', pth: '/rotate-token' });
  assert.equal(r1.res.status, 200);

  const r2 = await req({ port, token: 'old', method: 'GET', pth: '/status' });
  assert.equal(r2.res.status, 401);
});

test('http-api: shutdown calls onShutdown', async (t) => {
  let called = 0;
  const tabs = { listTabs: () => [], ensureTab: async () => 't0', createTab: async () => 't0', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    onShutdown: async () => {
      called += 1;
    },
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r = await req({ port, token: 'secret', method: 'POST', pth: '/shutdown', body: { scope: 'app' } });
  assert.equal(r.res.status, 200);
  assert.equal(r.data.ok, true);

  // Give the async handler a moment.
  await new Promise((r2) => setTimeout(r2, 10));
  assert.equal(called, 1);
});

test('http-api: query rate limits (qpm + inflight)', async (t) => {
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default' }, { id: 't1', key: 'q1' }, { id: 't2', key: 'q2' }],
    ensureTab: async ({ key }) => {
      if (key === 'q1') return 't1';
      if (key === 'q2') return 't2';
      return 't0';
    },
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({
      query: async () => ({ text: 'ok', codeBlocks: [], meta: {} })
    })
  };

  let inflightBlock = false;
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getSettings: async () => {
      if (inflightBlock) return { maxInflightQueries: 1, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false };
      return { maxInflightQueries: 2, maxQueriesPerMinute: 1, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false };
    }
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r1 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi', attachments: [] } });
  assert.equal(r1.res.status, 200);

  const r2 = await req({ port, token: 'secret', method: 'POST', pth: '/query', body: { prompt: 'hi2', attachments: [] } });
  assert.equal(r2.res.status, 429);
  assert.equal(r2.data.error, 'rate_limited');
  assert.equal(r2.data.reason, 'qpm');

  // Inflight: simulate by having controller.query hang while maxInflightQueries=1.
  inflightBlock = true;
  let resolveHang;
  const hang = new Promise((r) => (resolveHang = r));
  tabs.getControllerById = () => ({
    query: async () => {
      await hang;
      return { text: 'ok', codeBlocks: [], meta: {} };
    }
  });

  const p1 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'q1', prompt: 'a', attachments: [] } });
  // Let the first request enter inflight.
  await new Promise((r) => setTimeout(r, 20));
  const p2 = req({ port, token: 'secret', method: 'POST', pth: '/query', body: { key: 'q2', prompt: 'b', attachments: [] } });

  const p2Res = await p2;
  assert.equal(p2Res.res.status, 429);
  assert.equal(p2Res.data.reason, 'max_inflight');

  resolveHang();
  const p1Res = await p1;
  assert.equal(p1Res.res.status, 200);
});

test('http-api: send uses governor too', async (t) => {
  const tabs = {
    listTabs: () => [],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => ({
      send: async () => ({ ok: true })
    })
  };

  let qpm = 1;
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true }),
    getSettings: async () => ({ maxInflightQueries: 2, maxQueriesPerMinute: qpm, minTabGapMs: 0, minGlobalGapMs: 0, showTabsByDefault: false })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const r1 = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'hi', stopAfterSend: true } });
  assert.equal(r1.res.status, 200);

  // Immediately sending again should trip qpm=1.
  const r2 = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'hi2' } });
  assert.equal(r2.res.status, 429);
  assert.equal(r2.data.reason, 'qpm');

  // Increase qpm and ensure the bucket adjusts.
  qpm = 100;
  const r3 = await req({ port, token: 'secret', method: 'POST', pth: '/send', body: { text: 'hi3' } });
  assert.equal(r3.res.status, 200);
});

test('http-api: conversation turns requires an existing ChatGPT tab and does not create or query', async (t) => {
  let creates = 0;
  let reads = 0;
  const controller = {
    navigate: async () => { throw new Error('must_not_navigate'); },
    query: async () => { throw new Error('must_not_query'); },
    send: async () => { throw new Error('must_not_send'); },
    readConversationTurns: async (limits) => {
      reads += 1;
      assert.equal(limits.maxTurns, 2);
      return {
        url: 'https://chatgpt.com/c/test',
        turns: [{ id: 'm1', role: 'user', text: 'hello', index: 0 }]
      };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 'chat-1', key: 'review', vendorId: 'chatgpt' }],
    ensureTab: async () => { creates += 1; return 'created'; },
    createTab: async () => { creates += 1; return 'created'; },
    closeTab: async () => true,
    getControllerById: (id) => id === 'chat-1' ? controller : (() => { throw new Error('tab_not_found'); })()
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 'chat-1',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const result = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/conversation/turns',
    body: { key: 'review', maxTurns: 2, maxCharsPerTurn: 100, maxTotalChars: 500 }
  });
  assert.equal(result.res.status, 200);
  assert.deepEqual(result.data, {
    ok: true,
    tabId: 'chat-1',
    vendorId: 'chatgpt',
    url: 'https://chatgpt.com/c/test',
    turns: [{ id: 'm1', role: 'user', text: 'hello', index: 0 }]
  });
  assert.equal(reads, 1);
  assert.equal(creates, 0);

  const byId = await req({
    port,
    token: 'secret',
    method: 'POST',
    pth: '/conversation/turns',
    body: { tabId: 'chat-1', maxTurns: 2 }
  });
  assert.equal(byId.res.status, 200);
  assert.equal(byId.data.tabId, 'chat-1');
  assert.equal(reads, 2);

  const ambiguous = await req({ port, token: 'secret', method: 'POST', pth: '/conversation/turns', body: { key: 'review', tabId: 'chat-1' } });
  assert.equal(ambiguous.res.status, 400);
  assert.equal(ambiguous.data.error, 'ambiguous_conversation_tab');

  const missingSelector = await req({ port, token: 'secret', method: 'POST', pth: '/conversation/turns', body: { maxTurns: 2 } });
  assert.equal(missingSelector.res.status, 400);
  assert.equal(missingSelector.data.error, 'missing_conversation_tab');

  const missing = await req({ port, token: 'secret', method: 'POST', pth: '/conversation/turns', body: { key: 'missing' } });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.data.error, 'tab_not_found');
  assert.equal(creates, 0);

  const unauthorized = await req({ port, method: 'POST', pth: '/conversation/turns', body: { key: 'review' } });
  assert.equal(unauthorized.res.status, 401);
  assert.equal(reads, 2);
});

test('http-api: conversation turns complete mode returns bounded history metadata and rejects invalid history options', async (t) => {
  const calls = [];
  const controller = {
    readConversationTurns: async (options) => {
      calls.push(options);
      return {
        url: 'https://chatgpt.com/c/complete',
        turns: [{ id: 'm1', role: 'user', text: 'hello', index: 0 }],
        history: { mode: 'complete', complete: true, reason: null, startReached: true, snapshotStable: true, iterations: 2, observedTurnCount: 1, returnedTurnCount: 1, scrollRestored: true }
      };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 'chat-1', key: 'review', vendorId: 'chatgpt' }],
    getControllerById: () => controller,
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 'chat-1',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;

  const complete = await req({ port, token: 'secret', method: 'POST', pth: '/conversation/turns', body: { key: 'review', historyMode: 'complete', historyTimeoutMs: 1000, historyMaxIterations: 5 } });
  assert.equal(complete.res.status, 200);
  assert.equal(complete.data.history.complete, true);
  assert.equal(calls[0].historyMode, 'complete');
  assert.equal(calls[0].historyTimeoutMs, 1000);
  assert.equal(calls[0].historyMaxIterations, 5);

  const invalidMode = await req({ port, token: 'secret', method: 'POST', pth: '/conversation/turns', body: { key: 'review', historyMode: 'all' } });
  assert.equal(invalidMode.res.status, 400);
  const invalidIterations = await req({ port, token: 'secret', method: 'POST', pth: '/conversation/turns', body: { key: 'review', historyMaxIterations: 81 } });
  assert.equal(invalidIterations.res.status, 400);
});

test('http-api: conversation turns succeeds when the managed page recovers a stale CDP session', async (t) => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  let attachCount = 0;
  let runtimeEvaluateCount = 0;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'conversation-target' };
      if (method === 'Target.attachToTarget') {
        attachCount += 1;
        return { sessionId: attachCount === 1 ? 'conversation-session-old' : 'conversation-session-new' };
      }
      if (method === 'Browser.getWindowForTarget') return {};
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'conversation-main-frame' } } };
      if (method === 'Runtime.evaluate') {
        runtimeEvaluateCount += 1;
        if (sessionId === 'conversation-session-old') {
          const error = new Error('Session with given id not found.');
          error.data = { code: -32001, message: error.message };
          throw error;
        }
        if (String(params.expression || '').includes('location.href')) return { result: { value: 'https://chatgpt.com/c/preserved' } };
        return {
          result: {
            value: {
              turns: [{ role: 'user', text: 'existing turn', index: 0, messageId: 'message-1' }],
              limitExceeded: false,
              limitKind: null
            }
          }
        };
      }
      return {};
    }
  };
  const session = await backend.createSession({ url: 'https://chatgpt.com/c/preserved' });
  const controller = new ChatGPTController({
    page: session.page,
    selectors: { promptTextarea: '#prompt-textarea', sendButton: '#send', stopButton: '#stop', assistantMessage: '.assistant' },
    stateDir: '/tmp/agentify-test-state'
  });
  const tabs = {
    listTabs: () => [{ id: 'chat-1', key: 'autopilot-production', vendorId: 'chatgpt' }],
    ensureTab: async () => { throw new Error('must_not_create'); },
    createTab: async () => { throw new Error('must_not_create'); },
    closeTab: async () => true,
    getControllerById: (id) => id === 'chat-1' ? controller : (() => { throw new Error('tab_not_found'); })()
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 'chat-1',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(async () => {
    await server.close();
    await session.close();
  });

  const result = await req({
    port: server.address().port,
    token: 'secret',
    method: 'POST',
    pth: '/conversation/turns',
    body: { key: 'autopilot-production', maxTurns: 2 }
  });

  assert.equal(result.res.status, 200);
  assert.deepEqual(result.data, {
    ok: true,
    tabId: 'chat-1',
    vendorId: 'chatgpt',
    url: 'https://chatgpt.com/c/preserved',
    turns: [{ id: 'message-1', role: 'user', text: 'existing turn', index: 0 }]
  });
  assert.equal(session.page.sessionId, 'conversation-session-new');
  assert.equal(runtimeEvaluateCount, 3);
  assert.equal(calls.filter((call) => call.method === 'Target.attachToTarget').length, 2);
  assert.equal(calls.filter((call) => call.method === 'Target.createTarget').length, 1);
});

test('http-api: conversation turns rejects non-ChatGPT tabs and missing controllers', async (t) => {
  const tabs = {
    listTabs: () => [{ id: 'claude-1', key: 'other', vendorId: 'claude' }],
    ensureTab: async () => 'created',
    createTab: async () => 'created',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 'claude-1',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const rejected = await req({ port, token: 'secret', method: 'POST', pth: '/conversation/turns', body: { key: 'other' } });
  assert.equal(rejected.res.status, 409);
  assert.equal(rejected.data.error, 'chatgpt_tab_required');
});

test('http-api: conversation turns rejects duplicate keyed tabs before controller access', async (t) => {
  let reads = 0;
  const tabs = {
    listTabs: () => [
      { id: 'chat-1', key: 'review', vendorId: 'chatgpt' },
      { id: 'chat-2', key: 'review', vendorId: 'chatgpt' }
    ],
    ensureTab: async () => 'created',
    createTab: async () => 'created',
    closeTab: async () => true,
    getControllerById: () => ({ readConversationTurns: async () => { reads += 1; return { url: 'https://chatgpt.com/c/test', turns: [] }; } })
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 'chat-1',
    serverId: 'sid-test',
    stateDir: '/tmp',
    getStatus: async () => ({ ok: true })
  });
  t.after(() => server.close());
  const port = server.address().port;
  const duplicate = await req({ port, token: 'secret', method: 'POST', pth: '/conversation/turns', body: { key: 'review' } });
  assert.equal(duplicate.res.status, 404);
  assert.equal(duplicate.data.error, 'tab_not_found');
  assert.equal(reads, 0);
});

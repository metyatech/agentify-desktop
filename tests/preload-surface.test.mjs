import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAutopilotProposalIpcFailure,
  createAutopilotProposalIpcSuccess,
} from '../autopilot-proposal-ipc.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const NodeModule = require('node:module');

function loadPreloadCjs(invoke) {
  const preloadPath = path.join(__dirname, '..', 'ui', 'preload.cjs');
  let exposed = null;
  const originalLoad = NodeModule._load;
  NodeModule._load = function(request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
        ipcRenderer: { invoke }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    NodeModule._load = originalLoad;
    delete require.cache[preloadPath];
  }
  return exposed;
}

for (const preloadFile of ['preload.cjs', 'preload.mjs']) {
  test(`preload surface: ${preloadFile} does not expose unsupported orchestrator APIs`, async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'ui', preloadFile), 'utf8');
    assert.ok(src.includes('createTab:'), 'expected desktop tab API');
    assert.ok(!src.includes('getOrchestrators:'), 'should not expose orchestrator APIs in preload');
    assert.ok(!src.includes('startOrchestrator:'), 'should not expose orchestrator APIs in preload');
    assert.ok(!src.includes('stopOrchestrator:'), 'should not expose orchestrator APIs in preload');
    assert.ok(!src.includes('stopAllOrchestrators:'), 'should not expose orchestrator APIs in preload');
    assert.ok(!src.includes('setWorkspaceForKey:'), 'should not expose workspace APIs in preload');
    assert.ok(!src.includes('getWorkspaceForKey:'), 'should not expose workspace APIs in preload');
  });
}

test('preload surface: preload.cjs and preload.mjs expose the same desktop API keys', async () => {
  const cjs = await fs.readFile(path.join(__dirname, '..', 'ui', 'preload.cjs'), 'utf8');
  const mjs = await fs.readFile(path.join(__dirname, '..', 'ui', 'preload.mjs'), 'utf8');

  const extractKeys = (src) =>
    Array.from(src.matchAll(/^\s{2}([a-zA-Z0-9_]+):/gm))
      .map((match) => match[1])
      .sort();

  assert.deepEqual(extractKeys(mjs), extractKeys(cjs));
});

test('autopilot proposal IPC envelope unwrap preserves success compatibility and safe failure diagnostics', async () => {
  const proposalResult = { ok: false, status: 'clarification_response_received', clarification: { reason: 'intent_guard_ambiguous' } };
  const timeoutError = Object.assign(new Error('http_504'), {
    data: {
      body: {
        error: 'chrome_cdp_command_timeout',
        data: {
          method: 'Runtime.evaluate',
          phase: 'typing_prompt',
          prompt: 'must not cross IPC',
          params: { expression: 'token=secret' }
        }
      },
      arbitrary: 'cookie=secret'
    }
  });
  const successEnvelope = createAutopilotProposalIpcSuccess(proposalResult);
  const failureEnvelope = createAutopilotProposalIpcFailure(timeoutError);
  let response = successEnvelope;
  const bridge = loadPreloadCjs(async (channel) => {
    assert.equal(channel, 'agentify:requestAutopilotProposal');
    return response;
  });

  assert.deepEqual(await bridge.requestAutopilotProposal(), proposalResult);
  response = failureEnvelope;
  await assert.rejects(
    bridge.requestAutopilotProposal(),
    (error) => {
      assert.equal(error.message, 'chrome_cdp_command_timeout');
      assert.equal(error.code, 'chrome_cdp_command_timeout');
      assert.equal(error.data.diagnostics.method, 'Runtime.evaluate');
      assert.equal(error.data.diagnostics.phase, 'typing_prompt');
      assert.equal(JSON.stringify(error).includes('must not cross IPC'), false);
      assert.equal(JSON.stringify(error).includes('token=secret'), false);
      return true;
    }
  );
});

test('autopilot proposal IPC failure envelope bounds non-CDP errors and excludes arbitrary data', () => {
  const error = Object.assign(new Error('private prompt=should-not-cross'), {
    code: 'arbitrary_private_code',
    data: { prompt: 'private prompt', params: { token: 'secret' }, cookie: 'secret' }
  });
  const envelope = createAutopilotProposalIpcFailure(error);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.message, 'autopilot_proposal_request_failed');
  assert.equal(envelope.error.code, null);
  assert.equal(envelope.error.diagnostics, null);
  assert.equal(JSON.stringify(envelope).includes('private prompt'), false);
  assert.equal(JSON.stringify(envelope).includes('secret'), false);
});

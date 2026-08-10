import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  PROPOSAL_GENERATION_INSTRUCTION_VERSION,
  PROPOSAL_PROTOCOL_VERSION,
  TASK_CONTRACT_SCHEMA_VERSION,
  buildProposalGenerationPrompt,
  createAutopilotProposalService,
  createProposalMetadata
} from '../autopilot-proposal.mjs';

function makeTabs({ rows = [{ id: 'tab-1', key: 'autopilot-production', vendorId: 'chatgpt' }], url = 'https://chatgpt.com/' } = {}) {
  const controllers = new Map(rows.map((row) => [row.id, { getUrl: async () => url }]));
  return {
    listTabs: () => rows,
    getControllerById: (id) => {
      const controller = controllers.get(id);
      if (!controller) throw new Error('tab_not_found');
      return controller;
    }
  };
}

function makeService(options = {}) {
  const calls = [];
  let release;
  const requestQuery = options.requestQuery || (async (body) => {
    calls.push(body);
    if (release) await release;
    return { result: { text: 'proposal response' } };
  });
  const service = createAutopilotProposalService({
    tabs: options.tabs || makeTabs(),
    getRuntimeState: options.getRuntimeState || (() => ({ inflightQueries: 0, activeQueries: [] })),
    requestQuery,
    now: () => new Date('2026-08-10T00:00:00.000Z'),
    randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
    randomBytes: () => Buffer.from([0xab, 0x12, 0xcd, 0x34])
  });
  return { service, calls, setRelease: (fn) => { release = fn; } };
}

test('control center workflow is production-only and metadata is local', async () => {
  const { service, calls } = makeService();
  const result = await service.request();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'autopilot-production');
  assert.equal(calls[0].createIfMissing, false);
  assert.equal(result.metadata.schemaVersion, 1);
  assert.match(result.metadata.proposalId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.match(result.metadata.approvalCode, /^[A-F0-9]{8}$/u);
  assert.equal(result.metadata.tabKey, 'autopilot-production');
  assert.equal(result.status, 'proposal_response_received');
});

for (const [name, tabs, runtime] of [
  ['missing production tab', makeTabs({ rows: [] }), undefined],
  ['duplicate production tabs', makeTabs({ rows: [{ id: 'a', key: 'autopilot-production', vendorId: 'chatgpt' }, { id: 'b', key: 'autopilot-production', vendorId: 'chatgpt' }] }), undefined],
  ['non-ChatGPT production tab', makeTabs({ rows: [{ id: 'a', key: 'autopilot-production', vendorId: 'claude' }] }), undefined],
  ['active query', makeTabs(), { inflightQueries: 0, activeQueries: [{ tabId: 'tab-1' }] }],
  ['inflight query', makeTabs(), { inflightQueries: 1, activeQueries: [] }]
]) {
  test(`proposal request does not send when ${name}`, async () => {
    let calls = 0;
    const service = createAutopilotProposalService({
      tabs,
      getRuntimeState: () => runtime || ({ inflightQueries: 0, activeQueries: [] }),
      requestQuery: async () => { calls += 1; }
    });
    await assert.rejects(service.request());
    assert.equal(calls, 0);
  });
}

test('double click while request is pending sends one query and disables the second request', async () => {
  let resolve;
  const { service, calls } = makeService({ requestQuery: async (body) => {
    calls.push(body);
    await new Promise((r) => { resolve = r; });
    return { result: { text: 'proposal' } };
  }});
  const first = service.request();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(service.request(), /autopilot_proposal_request_inflight/u);
  assert.equal(calls.length, 1);
  resolve();
  await first;
});

test('request error clears inflight state so the button is reusable', async () => {
  let calls = 0;
  const service = createAutopilotProposalService({
    tabs: makeTabs(),
    requestQuery: async () => {
      calls += 1;
      if (calls === 1) throw new Error('query_error');
      return { result: { text: 'proposal' } };
    }
  });
  await assert.rejects(service.request(), /query_error/u);
  await service.request();
  assert.equal(calls, 2);
});

test('proposal prompt pins current schema, metadata, and clarification safety', async () => {
  const metadata = createProposalMetadata({
    now: new Date('2026-08-10T00:00:00.000Z'),
    randomUUID: crypto.randomUUID,
    randomBytes: () => Buffer.from([0xab, 0x12, 0xcd, 0x34])
  });
  const prompt = buildProposalGenerationPrompt({ metadata });
  assert.match(prompt, new RegExp(PROPOSAL_GENERATION_INSTRUCTION_VERSION, 'u'));
  assert.match(prompt, new RegExp(PROPOSAL_PROTOCOL_VERSION, 'u'));
  assert.match(prompt, new RegExp(`Task contract schemaVersion: ${TASK_CONTRACT_SCHEMA_VERSION}`, 'u'));
  assert.match(prompt, /repository\.slug/u);
  assert.match(prompt, /repository\.targetBranch/u);
  assert.match(prompt, /implementation\.maxPatchAttempts/u);
  assert.match(prompt, /verification/u);
  assert.match(prompt, /review/u);
  assert.match(prompt, /delivery/u);
  assert.match(prompt, /constraints/u);
  assert.match(prompt, /do not guess/u);
  assert.match(prompt, /fake or default repository/u);
  assert.match(prompt, /Copy every value exactly/u);
  assert.match(prompt, /AUTOPILOT_PROPOSAL_BEGIN_V1/u);
  assert.match(prompt, /開始して XXXXXXXX/u);
});

test('control center exposes the production action', async () => {
  const html = await fs.readFile(path.join(import.meta.dirname, '..', 'ui', 'control-center.html'), 'utf8');
  assert.match(html, /この内容を実行/u);
  assert.match(html, /autopilot-production/u);
  assert.match(html, /まだ変更は開始しません/u);
});

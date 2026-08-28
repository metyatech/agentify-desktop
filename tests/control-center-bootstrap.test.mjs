import assert from 'node:assert/strict';
import test from 'node:test';

import { showBootstrapFailure, startControlCenter } from '../ui/control-center-bootstrap.js';

function makeDocument(elements) {
  return { getElementById: (id) => elements[id] || null };
}

function makeElement(textContent = '') {
  const classes = new Set();
  return {
    textContent,
    classList: {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
    },
  };
}

test('bootstrap continues into normal Control Center startup after a successful dynamic import', async () => {
  let imported = null;
  const result = await startControlCenter(async (specifier) => {
    imported = specifier;
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(imported, './control-center.js');
});

test('bootstrap makes a module import rejection visible with a fixed code', async () => {
  const status = makeElement('Activity: Starting Agentify Desktop…');
  const message = makeElement('Loading…');
  const previousDocument = globalThis.document;
  globalThis.document = makeDocument({ statusLine: status, messageLine: message });
  try {
    const result = await startControlCenter(async () => {
      throw new Error('C:\\secret\\private-file.mjs https://chatgpt.com/c/private token-like-value');
    });
    assert.deepEqual(result, { ok: false, code: 'MODULE_LOAD_FAILED' });
    assert.equal(status.textContent, 'Control Center failed to initialize: MODULE_LOAD_FAILED');
    assert.equal(message.textContent, '起動に失敗しました。Agentify Desktopを再起動してください。');
    assert.equal(status.classList.contains('isError'), true);
    assert.equal(message.classList.contains('isError'), true);
    assert.doesNotMatch(status.textContent, /private-file|chatgpt|token-like/u);
    assert.doesNotMatch(message.textContent, /private-file|chatgpt|token-like/u);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('bootstrap tolerates missing status and message elements', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = makeDocument({});
  try {
    await assert.doesNotReject(() => startControlCenter(async () => { throw new Error('private detail'); }));
    assert.doesNotThrow(() => showBootstrapFailure());
  } finally {
    globalThis.document = previousDocument;
  }
});

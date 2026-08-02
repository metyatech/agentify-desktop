import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatGPTController } from '../chatgpt-controller.mjs';

const selectors = {
  promptTextarea: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  stopButton: 'button[data-testid="stop-button"]',
  assistantMessage: '[data-message-author-role="assistant"]'
};

function readyState() {
  return {
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    readyState: 'complete',
    blocked: false,
    promptVisible: true,
    kind: null,
    indicators: {
      hasTurnstile: false,
      hasArkose: false,
      hasVerifyButton: false,
      looks403: false,
      loginLike: false,
      rawPromptVisible: true,
      sendVisible: true
    }
  };
}

function basicEvaluation(js) {
  if (js.includes('const hasTurnstile')) return readyState();
  if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
  return undefined;
}

function createPage({ events, onEvaluate }) {
  return {
    async navigate() {},
    async evaluate(js) {
      const basic = basicEvaluation(js);
      if (basic !== undefined) return basic;
      return await onEvaluate(js);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey(key) {
      events.push(`key:${key}`);
    },
    async insertText(text) {
      events.push(`text:${text}`);
    },
    async moveMouse() {},
    async mouseDown(x) {
      events.push(x >= 80 ? 'normal-send-click' : 'prompt-click');
    },
    async mouseUp() {},
    async setFileInputFiles(files) {
      events.push(`files-set:${files.length}`);
    }
  };
}

function createController(page) {
  return new ChatGPTController({ page, selectors });
}

function isClickSendEvaluation(js) {
  return js.includes('const chatgptSendSel') || js.includes('already_generating');
}

test('chatgpt-controller: send falls back to requestSubmit on the active composer before Enter', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('form.requestSubmit')) {
        events.push('requestSubmit');
        return true;
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, fallbackEnter: true, requestSubmit: true, host: 'chatgpt.com', isChatGPT: true };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('requestSubmit'), true);
  assert.equal(events.includes('key:Enter'), false);
});

test('chatgpt-controller: inserts a multiline prompt once without sending Enter', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('form.requestSubmit')) {
        events.push('requestSubmit');
        return true;
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, fallbackEnter: true, requestSubmit: true, host: 'chatgpt.com', isChatGPT: true };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await createController(page).send({ text: 'line1\nline2\nline3', timeoutMs: 5_000 });

  assert.deepEqual(events.filter((event) => event.startsWith('text:')), ['text:line1\nline2\nline3']);
  assert.equal(events.includes('key:Enter'), false);
});

test('chatgpt-controller: query returns the final ChatGPT assistant message, not composer UI text', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        return {
          isChatGPT: true,
          stop: false,
          sendEnabled: true,
          txt: 'POC-1',
          count: 1,
          usedFallback: false,
          hasError: false,
          hasContinue: false,
          hasRegenerate: false
        };
      }
      if (js.includes('const assistantSel')) {
        return {
          isChatGPT: true,
          stop: false,
          sendEnabled: true,
          txt: '非常に高い',
          count: 0,
          usedFallback: true,
          hasError: false,
          hasContinue: false,
          hasRegenerate: false
        };
      }
      if (isClickSendEvaluation(js)) {
        return {
          ok: true,
          isChatGPT: true,
          fallbackEnter: false,
          host: 'chatgpt.com',
          rect: { x: 90, y: 10, w: 20, h: 20 }
        };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'return POC-1', timeoutMs: 5_000 });

  assert.equal(result.text, 'POC-1');
  assert.equal(result.text.includes('非常に高い'), false);
});

test('chatgpt-controller: waits for attachment readiness after typing and before clicking the normal send button', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  const attachment = path.join(tempDir, 'attachment.txt');
  await fs.writeFile(attachment, 'test attachment');

  try {
    const events = [];
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const codeBlocks')) return { codeBlocks: [] };
        if (js.includes('const assistantCandidates')) {
          return {
            isChatGPT: true,
            stop: false,
            sendEnabled: true,
            txt: 'uploaded',
            count: 1,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false
          };
        }
        if (js.includes('const attachCandidates')) {
          events.push('attachment-menu-open');
          return { isChatGPT: true, opened: true };
        }
        if (js.includes('const fileMenuItems')) {
          events.push('attachment-file-option');
          return { isChatGPT: true, selected: true };
        }
        if (js.includes('const attachmentReady')) {
          events.push('attachment-ready');
          return {
            isChatGPT: true,
            ready: true,
            promptTextLength: 14,
            hasSendButton: true,
            sendVisible: true,
            sendDisabled: false,
            busy: false
          };
        }
        if (isClickSendEvaluation(js)) {
          return {
            ok: true,
            isChatGPT: true,
            fallbackEnter: false,
            host: 'chatgpt.com',
            rect: { x: 90, y: 10, w: 20, h: 20 }
          };
        }
        if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      }
    });

    await createController(page).query({ prompt: 'body before upload', attachments: [attachment], timeoutMs: 5_000 });

    const index = (event) => events.indexOf(event);
    assert.ok(index('text:body before upload') < index('attachment-menu-open'));
    assert.ok(index('attachment-menu-open') < index('attachment-file-option'));
    assert.ok(index('attachment-file-option') < index('files-set:1'));
    assert.ok(index('files-set:1') < index('attachment-ready'));
    assert.ok(index('attachment-ready') < index('normal-send-click'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('chatgpt-controller: refuses a disabled normal send button without clicking microphone or response controls', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (isClickSendEvaluation(js)) {
        return { ok: false, error: 'send_button_disabled', isChatGPT: true, host: 'chatgpt.com' };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).send({ text: 'do not click other controls', timeoutMs: 5_000 }),
    /send_button_disabled/
  );

  assert.equal(events.filter((event) => event === 'normal-send-click').length, 0);
  assert.equal(events.includes('key:Enter'), false);
});

test('chatgpt-controller: aborts before sending when attachment upload readiness times out', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  const attachment = path.join(tempDir, 'attachment.txt');
  await fs.writeFile(attachment, 'test attachment');

  try {
    const events = [];
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const attachCandidates')) {
          events.push('attachment-menu-open');
          return { isChatGPT: true, opened: true };
        }
        if (js.includes('const fileMenuItems')) {
          events.push('attachment-file-option');
          return { isChatGPT: true, selected: true };
        }
        if (js.includes('const attachmentReady')) {
          events.push('attachment-not-ready');
          return {
            isChatGPT: true,
            ready: false,
            promptTextLength: 12,
            hasSendButton: true,
            sendVisible: true,
            sendDisabled: true,
            busy: true
          };
        }
        if (isClickSendEvaluation(js)) throw new Error('send_must_not_be_checked');
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      }
    });

    await assert.rejects(
      createController(page).query({ prompt: 'wait for file', attachments: [attachment], timeoutMs: 20 }),
      (error) => {
        assert.equal(error.message, 'attachment_upload_timeout');
        assert.equal(error.data?.busy, true);
        return true;
      }
    );

    assert.equal(events.includes('normal-send-click'), false);
    assert.equal(events.includes('requestSubmit'), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

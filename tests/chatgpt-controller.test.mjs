import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ChatGPTController,
  hasSameChatGPTAttachmentFileNameMultiset,
  isChatGPTAttachmentCardDisplayName
} from '../chatgpt-controller.mjs';

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

function createPage({ events, onEvaluate, onSetFileInputFiles = null }) {
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
    async setFileInputFiles(files, options = {}) {
      events.push(`files-set:${files.length}`);
      if (options?.selector) events.push(`files-selector:${options.selector}`);
      await onSetFileInputFiles?.(files, options);
    }
  };
}

function createController(page) {
  return new ChatGPTController({ page, selectors });
}

function isClickSendEvaluation(js) {
  return js.includes('const sendBaseline');
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
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        return {
          isChatGPT: true,
          stop: false,
          sendPresent: true,
          sendEnabled: true,
          promptTextLength: 0,
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
    let attachmentReadyPolls = 0;
    let fileMenuSelected = false;
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const assistantBaseline')) return assistantBaseline();
        if (js.includes('const codeBlocks')) return { codeBlocks: [] };
        if (js.includes('const assistantCandidates')) {
          return {
            isChatGPT: true,
            stop: false,
            sendPresent: true,
            sendEnabled: true,
            promptTextLength: 0,
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
        if (js.includes('const visibleMenuRoots')) {
          if (!fileMenuSelected) {
            fileMenuSelected = true;
            events.push('attachment-file-option');
            return { inputAvailable: false, selected: true };
          }
          return { inputAvailable: true, selected: false };
        }
        if (js.includes('const expectedFileNames')) {
          attachmentReadyPolls += 1;
          events.push('attachment-ready');
          return attachmentCardSnapshot([{ fileName: 'attachment.txt', found: true, pending: false, failed: false }], { promptTextLength: 14 });
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
    let fileMenuSelected = false;
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const attachCandidates')) {
          events.push('attachment-menu-open');
          return { isChatGPT: true, opened: true };
        }
        if (js.includes('const fileMenuItems')) {
          if (!fileMenuSelected) {
            fileMenuSelected = true;
            events.push('attachment-file-option');
            return { isChatGPT: true, inputAvailable: false, selected: true };
          }
          return { isChatGPT: true, inputAvailable: true, selected: false };
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

function assistantBaseline({ count = 0, lastAssistantId = '', lastAssistantText = '' } = {}) {
  return { isChatGPT: true, assistantCount: count, lastAssistantId, lastAssistantText };
}

function assistantSnapshot({
  stop = false,
  sendPresent = true,
  sendEnabled = true,
  promptTextLength = 0,
  txt = '',
  count = 0,
  lastAssistantId = '',
  hasContinue = false
} = {}) {
  return {
    isChatGPT: true,
    stop,
    sendPresent,
    sendEnabled,
    promptTextLength,
    txt,
    count,
    lastAssistantId,
    usedFallback: false,
    hasError: false,
    hasContinue,
    hasRegenerate: false
  };
}

test('chatgpt-controller: waits for a new assistant turn instead of returning the previous answer', async () => {
  const events = [];
  let baselineCaptured = false;
  let responsePolls = 0;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) {
        baselineCaptured = true;
        return assistantBaseline({ count: 1, lastAssistantId: 'old-turn', lastAssistantText: 'OLD-ANSWER' });
      }
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        assert.equal(baselineCaptured, true);
        responsePolls += 1;
        return responsePolls < 5
          ? assistantSnapshot({ count: 1, lastAssistantId: 'old-turn', txt: 'OLD-ANSWER' })
          : assistantSnapshot({ count: 1, lastAssistantId: 'new-turn', txt: 'NEW-ANSWER' });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'return only the new answer', timeoutMs: 8_000 });

  assert.equal(result.text, 'NEW-ANSWER');
  assert.ok(responsePolls >= 5);
});

test('chatgpt-controller: treats a visible normal stop button without a send button as generating', async () => {
  const events = [];
  let baselineCaptured = false;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) {
        baselineCaptured = true;
        return assistantBaseline({ count: 1, lastAssistantId: 'old-turn', lastAssistantText: 'OLD-ANSWER' });
      }
      if (js.includes('const assistantCandidates')) {
        assert.equal(baselineCaptured, true);
        return assistantSnapshot({
          stop: true,
          sendEnabled: false,
          count: 1,
          lastAssistantId: 'old-turn',
          txt: 'OLD-ANSWER'
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).query({ prompt: 'wait for the current generation', timeoutMs: 25 }),
    (error) => {
      assert.equal(error.message, 'timeout_waiting_for_response');
      assert.equal(error.data?.last, 'OLD-ANSWER');
      return true;
    }
  );
});

test('chatgpt-controller: waits for all attachment names in two consecutive composer polls', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  const attachment = path.join(tempDir, 'expected.txt');
  await fs.writeFile(attachment, 'test attachment');

  try {
    const events = [];
    let attachmentPolls = 0;
    let fileMenuSelected = false;
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const assistantBaseline')) return assistantBaseline();
        if (js.includes('const codeBlocks')) return { codeBlocks: [] };
        if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'new-turn', txt: 'uploaded' });
        if (js.includes('const attachCandidates')) {
          if (!js.includes(`activeComposer.querySelectorAll('button, [role="button"]')`)) {
            throw new Error('composer-external attachment button selected');
          }
          events.push('attachment-menu-open');
          return { isChatGPT: true, opened: true };
        }
        if (js.includes('const visibleMenuRoots')) {
          events.push('file-input-ready');
          return { inputAvailable: true, selected: false };
        }
        if (js.includes('const expectedFileNames')) {
          attachmentPolls += 1;
          events.push(`attachment-check:${attachmentPolls}`);
          return attachmentCardSnapshot([{
            fileName: 'expected.txt',
            found: attachmentPolls > 1,
            pending: false,
            failed: false
          }], {
            promptTextLength: 14,
            conditionsReady: attachmentPolls > 1,
            mappingComplete: attachmentPolls > 1
          });
        }
        if (isClickSendEvaluation(js)) {
          return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
        }
        if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      }
    });

    await createController(page).query({ prompt: 'upload expected file', attachments: [attachment], timeoutMs: 5_000 });

    assert.equal(attachmentPolls, 3);
    assert.ok(events.indexOf('attachment-check:3') < events.indexOf('normal-send-click'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('chatgpt-controller: rejects an attachment set when even one expected filename never appears', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  const firstAttachment = path.join(tempDir, 'first.txt');
  const secondAttachment = path.join(tempDir, 'second.txt');
  await fs.writeFile(firstAttachment, 'first');
  await fs.writeFile(secondAttachment, 'second');

  try {
    const events = [];
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const attachCandidates')) return { isChatGPT: true, opened: true };
        if (js.includes('const visibleMenuRoots')) return { inputAvailable: true, selected: false };
        if (js.includes('const expectedFileNames')) {
          return attachmentCardSnapshot([
            { fileName: 'first.txt', found: true, pending: false, failed: false },
            { fileName: 'second.txt', found: false, pending: false, failed: false }
          ], {
            promptTextLength: 12,
            conditionsReady: false,
            mappingComplete: false,
            mappingErrors: ['file_card_count_mismatch']
          });
        }
        if (isClickSendEvaluation(js)) throw new Error('send_must_not_be_checked');
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      }
    });

    await assert.rejects(
      createController(page).query({ prompt: 'wait for both', attachments: [firstAttachment, secondAttachment], timeoutMs: 20 }),
      (error) => {
        assert.equal(error.message, 'attachment_upload_timeout');
        assert.deepEqual(error.data?.expectedFileNames, ['first.txt', 'second.txt']);
        assert.deepEqual(error.data?.observedFileNames, ['first.txt']);
        assert.equal(error.data?.promptTextLength, 12);
        assert.equal(error.data?.hasSendButton, true);
        assert.equal(error.data?.sendDisabled, false);
        assert.equal(error.data?.busy, false);
        return true;
      }
    );

    assert.equal(events.includes('normal-send-click'), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('chatgpt-controller: limits attachment selection to the active composer and visible file menu', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  const attachment = path.join(tempDir, 'menu.txt');
  await fs.writeFile(attachment, 'menu');

  try {
    const events = [];
    let attachmentPolls = 0;
    let fileMenuSelected = false;
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const assistantBaseline')) return assistantBaseline();
        if (js.includes('const codeBlocks')) return { codeBlocks: [] };
        if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'new-turn', txt: 'menu uploaded' });
        if (js.includes('const attachCandidates')) {
          if (!js.includes(`activeComposer.querySelectorAll('button, [role="button"]')`)) {
            throw new Error('composer-external attachment button selected');
          }
          events.push('active-composer-attachment');
          return { isChatGPT: true, opened: true };
        }
        if (js.includes('const visibleMenuRoots')) {
          assert.equal(js.includes('visibleMenuRoots.flatMap'), true, 'must search only visible menu roots');
          if (!fileMenuSelected) {
            fileMenuSelected = true;
            events.push('visible-menu-file-option');
            return { inputAvailable: false, selected: true };
          }
          return { inputAvailable: true, selected: false };
        }
        if (js.includes('const expectedFileNames')) {
          attachmentPolls += 1;
          return attachmentCardSnapshot([{ fileName: 'menu.txt', found: true, pending: false, failed: false }]);
        }
        if (isClickSendEvaluation(js)) {
          return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
        }
        if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      }
    });

    await createController(page).query({ prompt: 'use active composer', attachments: [attachment], timeoutMs: 5_000 });

    assert.equal(attachmentPolls, 2);
    assert.deepEqual(
      events.filter((event) => event === 'active-composer-attachment' || event === 'visible-menu-file-option'),
      ['active-composer-attachment', 'visible-menu-file-option']
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function sendBaseline({ userCount = 0, lastUserId = '', lastUserText = '', activePromptText = 'send prompt' } = {}) {
  return {
    userCount,
    lastUserId,
    lastUserText,
    activePromptText,
    activePromptTextLength: activePromptText.length
  };
}

function chatgptSendSignal({
  userCount = 0,
  lastUserId = '',
  lastUserText = '',
  activePromptText = 'send prompt',
  normalStopVisible = false
} = {}) {
  return {
    isChatGPT: true,
    userCount,
    lastUserId,
    lastUserText,
    activePromptText,
    activePromptTextLength: activePromptText.length,
    normalStopVisible
  };
}

test('chatgpt-controller: recognizes a new user turn when controls do not change after a normal send click', async () => {
  const events = [];
  let sendPolls = 0;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) {
        return {
          ok: true,
          isChatGPT: true,
          fallbackEnter: false,
          host: 'chatgpt.com',
          rect: { x: 90, y: 10, w: 20, h: 20 },
          sendBaseline: sendBaseline({ activePromptText: 'count-based send' })
        };
      }
      if (js.includes('const chatgptUserTurns')) {
        sendPolls += 1;
        return chatgptSendSignal({
          userCount: 1,
          lastUserId: 'new-user-turn',
          lastUserText: 'count-based send',
          activePromptText: 'count-based send'
        });
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: 'count-based send', timeoutMs: 100 });

  assert.deepEqual(result, { ok: true });
  assert.equal(sendPolls, 1);
  assert.equal(events.includes('normal-send-click'), true);
});

test('chatgpt-controller: recognizes a virtualized user turn when only its identifier changes', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) {
        return {
          ok: true,
          isChatGPT: true,
          fallbackEnter: false,
          host: 'chatgpt.com',
          rect: { x: 90, y: 10, w: 20, h: 20 },
          sendBaseline: sendBaseline({ userCount: 1, lastUserId: 'old-user-turn', lastUserText: 'OLD' })
        };
      }
      if (js.includes('const chatgptUserTurns')) {
        return chatgptSendSignal({ userCount: 1, lastUserId: 'virtualized-user-turn', lastUserText: 'new prompt' });
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: 'new prompt', timeoutMs: 100 });

  assert.deepEqual(result, { ok: true });
});

test('chatgpt-controller: recognizes a multiline user turn by text when identifiers are unavailable', async () => {
  const events = [];
  const prompt = 'line1\nline2\nline3';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) {
        return {
          ok: true,
          isChatGPT: true,
          fallbackEnter: false,
          host: 'chatgpt.com',
          rect: { x: 90, y: 10, w: 20, h: 20 },
          sendBaseline: sendBaseline({ userCount: 1, lastUserText: 'OLD-USER-TURN', activePromptText: prompt })
        };
      }
      if (js.includes('const chatgptUserTurns')) {
        return chatgptSendSignal({ userCount: 1, lastUserText: 'line1 line2 line3', activePromptText: prompt });
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: prompt, timeoutMs: 100 });

  assert.deepEqual(result, { ok: true });
});

test('chatgpt-controller: rejects an unchanged ChatGPT send state without a normal stop button', async () => {
  const events = [];
  const baseline = sendBaseline({ userCount: 1, lastUserId: 'old-user-turn', lastUserText: 'OLD', activePromptText: 'unchanged prompt' });
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) {
        return {
          ok: true,
          isChatGPT: true,
          fallbackEnter: false,
          host: 'chatgpt.com',
          rect: { x: 90, y: 10, w: 20, h: 20 },
          sendBaseline: baseline
        };
      }
      if (js.includes('const chatgptUserTurns')) {
        return chatgptSendSignal({
          userCount: baseline.userCount,
          lastUserId: baseline.lastUserId,
          lastUserText: baseline.lastUserText,
          activePromptText: baseline.activePromptText
        });
      }
      if (js.includes('const clickFallbackBaselineText')) {
        return { attempted: false, lastFallbackResult: 'unchanged_prompt' };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).send({ text: 'unchanged prompt', timeoutMs: 20 }),
    /send_not_triggered/
  );

  assert.equal(events.includes('normal-send-click'), true);
});

test('chatgpt-controller: checks send completion only within the active composer', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) {
        return {
          ok: true,
          isChatGPT: true,
          fallbackEnter: false,
          host: 'chatgpt.com',
          rect: { x: 90, y: 10, w: 20, h: 20 },
          sendBaseline: sendBaseline({ activePromptText: 'composer-only' })
        };
      }
      if (js.includes('const chatgptUserTurns')) {
        if (!js.includes('chatgptComposer.querySelectorAll(chatgptSendSel)')) {
          throw new Error('composer-external send button consulted');
        }
        if (!js.includes('chatgptComposer.querySelectorAll(chatgptStopSel)')) {
          throw new Error('composer-external stop button consulted');
        }
        return chatgptSendSignal({ userCount: 1, lastUserId: 'composer-user-turn', lastUserText: 'composer-only', activePromptText: 'composer-only' });
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: 'composer-only', timeoutMs: 100 });

  assert.deepEqual(result, { ok: true });
});

function normalChatGPTSendResult(baseline) {
  return {
    ok: true,
    isChatGPT: true,
    fallbackEnter: false,
    host: 'chatgpt.com',
    rect: { x: 90, y: 10, w: 20, h: 20 },
    sendBaseline: baseline
  };
}

test('chatgpt-controller: query uses the exact DOM send button when the coordinate click produces no signal', async () => {
  const events = [];
  let domClickAttempted = false;
  const prompt = 'submit through exact DOM button';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        return assistantSnapshot({ txt: 'DOM-SUBMISSION-ANSWER', count: 1, lastAssistantId: 'new-assistant' });
      }
      if (js.includes('const sendBaseline')) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
      if (js.includes('const chatgptUserTurns')) {
        return chatgptSendSignal({
          userCount: domClickAttempted ? 1 : 0,
          lastUserId: domClickAttempted ? 'dom-submitted-user' : '',
          lastUserText: domClickAttempted ? prompt : '',
          activePromptText: prompt
        });
      }
      if (js.includes('const clickFallbackBaselineText')) {
        assert.equal(js.includes('normalSend.click()'), true);
        assert.equal(js.includes('chatgptComposer.querySelectorAll(chatgptSendSel)'), true);
        events.push('dom-send-click');
        domClickAttempted = true;
        return { attempted: true, lastFallbackResult: 'dom_click' };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt, timeoutMs: 2_000 });

  assert.equal(result.text, 'DOM-SUBMISSION-ANSWER');
  assert.deepEqual(events.filter((event) => event === 'normal-send-click' || event === 'dom-send-click'), ['normal-send-click', 'dom-send-click']);
  assert.equal(events.includes('requestSubmit'), false);
});

test('chatgpt-controller: does not use DOM fallback after a successful coordinate click', async () => {
  const events = [];
  const prompt = 'coordinate click works';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
      if (js.includes('const chatgptUserTurns')) {
        return chatgptSendSignal({ userCount: 1, lastUserId: 'coordinate-user', lastUserText: prompt, activePromptText: prompt });
      }
      if (js.includes('const clickFallbackBaselineText') || js.includes('const submitFallbackBaselineText')) {
        throw new Error('fallback_must_not_run_after_coordinate_success');
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: prompt, timeoutMs: 100 });

  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('normal-send-click'), true);
  assert.equal(events.includes('dom-send-click'), false);
  assert.equal(events.includes('requestSubmit'), false);
});

test('chatgpt-controller: uses the active composer requestSubmit after the DOM send click has no signal', async () => {
  const events = [];
  let requestSubmitAttempted = false;
  const prompt = 'submit through active composer form';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
      if (js.includes('const chatgptUserTurns')) {
        return chatgptSendSignal({
          userCount: 0,
          activePromptText: requestSubmitAttempted ? '' : prompt
        });
      }
      if (js.includes('const clickFallbackBaselineText')) {
        events.push('dom-send-click');
        return { attempted: true, lastFallbackResult: 'dom_click' };
      }
      if (js.includes('const submitFallbackBaselineText')) {
        assert.equal(js.includes('form.requestSubmit(normalSend)'), true);
        assert.equal(js.includes('form.requestSubmit()'), true);
        assert.equal(js.includes('chatgptComposer.querySelectorAll(chatgptSendSel)'), true);
        events.push('requestSubmit');
        requestSubmitAttempted = true;
        return { attempted: true, lastFallbackResult: 'request_submit_with_button' };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: prompt, timeoutMs: 20 });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events.filter((event) => event === 'normal-send-click' || event === 'dom-send-click' || event === 'requestSubmit'), [
    'normal-send-click',
    'dom-send-click',
    'requestSubmit'
  ]);
  assert.equal(events.includes('key:Enter'), false);
});

test('chatgpt-controller: skips DOM submission fallbacks when the prompt changed after coordinate click', async () => {
  const events = [];
  const prompt = 'original prompt';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
      if (js.includes('const chatgptUserTurns')) return chatgptSendSignal({ activePromptText: prompt });
      if (js.includes('const clickFallbackBaselineText')) {
        events.push('fallback-checked');
        return { attempted: false, lastFallbackResult: 'prompt_changed' };
      }
      if (js.includes('const submitFallbackBaselineText')) throw new Error('request_submit_must_not_run_after_prompt_change');
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).send({ text: prompt, timeoutMs: 20 }),
    (error) => {
      assert.equal(error.message, 'send_not_triggered');
      assert.equal(error.data?.coordinateClickAttempted, true);
      assert.equal(error.data?.domClickAttempted, false);
      assert.equal(error.data?.requestSubmitAttempted, false);
      assert.equal(error.data?.lastFallbackResult, 'prompt_changed');
      return true;
    }
  );

  assert.deepEqual(events.filter((event) => event === 'dom-send-click' || event === 'requestSubmit'), []);
});

test('chatgpt-controller: skips DOM submission fallbacks for disabled or stopped composers', async () => {
  for (const state of ['disabled', 'aria_disabled', 'stop_visible']) {
    const events = [];
    const prompt = `skip fallback ${state}`;
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const sendBaseline')) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
        if (js.includes('const chatgptUserTurns')) return chatgptSendSignal({ activePromptText: prompt });
        if (js.includes('const clickFallbackBaselineText')) {
          assert.equal(js.includes('disabled(normalSend)'), true);
          assert.equal(js.includes('normalStop'), true);
          return { attempted: false, lastFallbackResult: state };
        }
        if (js.includes('const submitFallbackBaselineText')) throw new Error(`request_submit_must_not_run:${state}`);
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      }
    });

    await assert.rejects(createController(page).send({ text: prompt, timeoutMs: 20 }), /send_not_triggered/);
    assert.equal(events.includes('dom-send-click'), false);
    assert.equal(events.includes('requestSubmit'), false);
  }
});

test('chatgpt-controller: limits DOM submission fallback to the active composer exact send button', async () => {
  const events = [];
  const prompt = 'active composer exact send only';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
      if (js.includes('const chatgptUserTurns')) return chatgptSendSignal({ activePromptText: prompt });
      if (js.includes('const clickFallbackBaselineText')) {
        assert.equal(js.includes('chatgptComposer.querySelectorAll(chatgptSendSel)'), true);
        assert.equal(js.includes('document.querySelectorAll(chatgptSendSel)'), false);
        assert.equal(js.includes("querySelectorAll('button, [role=\\\"button\\\"]')"), false);
        return { attempted: false, lastFallbackResult: 'no_active_composer_send' };
      }
      if (js.includes('const submitFallbackBaselineText')) throw new Error('request_submit_must_not_run_without_exact_active_button');
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(createController(page).send({ text: prompt, timeoutMs: 20 }), /send_not_triggered/);
  assert.equal(events.includes('dom-send-click'), false);
  assert.equal(events.includes('requestSubmit'), false);
});

test('chatgpt-controller: reports every exact submission fallback when no send signal arrives', async () => {
  const events = [];
  const prompt = 'no send signal';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const sendBaseline')) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
      if (js.includes('const chatgptUserTurns')) return chatgptSendSignal({ activePromptText: prompt });
      if (js.includes('const clickFallbackBaselineText')) {
        events.push('dom-send-click');
        return { attempted: true, lastFallbackResult: 'dom_click' };
      }
      if (js.includes('const submitFallbackBaselineText')) {
        events.push('requestSubmit');
        return { attempted: true, lastFallbackResult: 'request_submit_with_button' };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).send({ text: prompt, timeoutMs: 20 }),
    (error) => {
      assert.equal(error.message, 'send_not_triggered');
      assert.deepEqual(error.data, {
        host: 'chatgpt.com',
        coordinateClickAttempted: true,
        domClickAttempted: true,
        requestSubmitAttempted: true,
        lastFallbackResult: 'request_submit_with_button'
      });
      return true;
    }
  );

  assert.deepEqual(events.filter((event) => event === 'normal-send-click' || event === 'dom-send-click' || event === 'requestSubmit'), [
    'normal-send-click',
    'dom-send-click',
    'requestSubmit'
  ]);
});

test('chatgpt-controller: completes a new response when the empty ChatGPT composer has no send button', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        return assistantSnapshot({
          sendPresent: false,
          sendEnabled: false,
          promptTextLength: 0,
          txt: 'AUTOPILOT-MULTILINE-7F19',
          count: 1,
          lastAssistantId: 'autopilot-answer'
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'AUTOPILOT-MULTILINE-7F19', timeoutMs: 3_000 });

  assert.equal(result.text, 'AUTOPILOT-MULTILINE-7F19');
});

test('chatgpt-controller: completes a new response when the empty ChatGPT composer has an enabled send button', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        return assistantSnapshot({
          sendPresent: true,
          sendEnabled: true,
          promptTextLength: 0,
          txt: 'ENABLED-SEND-ANSWER',
          count: 1,
          lastAssistantId: 'enabled-send-answer'
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'return enabled send answer', timeoutMs: 3_000 });

  assert.equal(result.text, 'ENABLED-SEND-ANSWER');
});

test('chatgpt-controller: waits for stop to disappear before completing a new assistant response', async () => {
  const events = [];
  let responsePolls = 0;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        responsePolls += 1;
        return assistantSnapshot({
          stop: responsePolls <= 2,
          sendPresent: false,
          sendEnabled: false,
          promptTextLength: 0,
          txt: 'STOP-THEN-IDLE-ANSWER',
          count: 1,
          lastAssistantId: 'stop-then-idle'
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'wait for stop', timeoutMs: 4_000 });

  assert.equal(result.text, 'STOP-THEN-IDLE-ANSWER');
  assert.ok(responsePolls >= 4);
});

test('chatgpt-controller: waits while an unsent prompt remains in the ChatGPT composer', async () => {
  const events = [];
  let responsePolls = 0;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        responsePolls += 1;
        return assistantSnapshot({
          sendPresent: false,
          sendEnabled: false,
          promptTextLength: responsePolls <= 6 ? 17 : 0,
          txt: 'UNSENT-PROMPT-GUARDED',
          count: 1,
          lastAssistantId: 'unsent-prompt-guarded'
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'wait for unsent prompt to clear', timeoutMs: 4_000 });

  assert.equal(result.text, 'UNSENT-PROMPT-GUARDED');
  assert.ok(responsePolls >= 7);
});

test('chatgpt-controller: waits while a visible ChatGPT send button remains disabled', async () => {
  const events = [];
  let responsePolls = 0;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        responsePolls += 1;
        return assistantSnapshot({
          sendPresent: true,
          sendEnabled: responsePolls > 6,
          promptTextLength: 0,
          txt: 'DISABLED-SEND-GUARDED',
          count: 1,
          lastAssistantId: 'disabled-send-guarded'
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'wait for disabled send', timeoutMs: 4_000 });

  assert.equal(result.text, 'DISABLED-SEND-GUARDED');
  assert.ok(responsePolls >= 7);
});

test('chatgpt-controller: does not return a previous answer when a no-send-button composer has no new assistant turn', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) {
        return assistantBaseline({ count: 1, lastAssistantId: 'old-answer', lastAssistantText: 'OLD-ANSWER' });
      }
      if (js.includes('const assistantCandidates')) {
        return assistantSnapshot({
          sendPresent: false,
          sendEnabled: false,
          promptTextLength: 0,
          txt: 'OLD-ANSWER',
          count: 1,
          lastAssistantId: 'old-answer'
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).query({ prompt: 'do not return old answer', timeoutMs: 50 }),
    (error) => {
      assert.equal(error.message, 'timeout_waiting_for_response');
      assert.equal(error.data?.last, 'OLD-ANSWER');
      assert.equal(error.data?.newChatGPTAssistant, false);
      assert.equal(error.data?.composerIdle, true);
      return true;
    }
  );
});

test('chatgpt-controller: includes ChatGPT composer diagnostics in response timeouts', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const assistantCandidates')) {
        return assistantSnapshot({
          sendPresent: true,
          sendEnabled: false,
          stop: false,
          promptTextLength: 8,
          txt: 'PARTIAL-ANSWER',
          count: 1,
          lastAssistantId: 'partial-answer'
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).query({ prompt: 'collect timeout diagnostics', timeoutMs: 50 }),
    (error) => {
      assert.equal(error.message, 'timeout_waiting_for_response');
      assert.deepEqual(error.data, {
        last: 'PARTIAL-ANSWER',
        lastAssistantCount: 1,
        lastAssistantId: 'partial-answer',
        sendPresent: true,
        sendEnabled: false,
        stop: false,
        promptTextLength: 8,
        newChatGPTAssistant: true,
        composerIdle: false
      });
      return true;
    }
  );
});

test('chatgpt-controller: recognizes the Japanese ChatGPT send and stop aria labels', async () => {
  const source = await fs.readFile(new URL('../chatgpt-controller.mjs', import.meta.url), 'utf8');

  assert.equal(source.includes('button[aria-label="プロンプトを送信する"]'), true);
  assert.equal(source.includes('button[aria-label="生成を停止する"]'), true);
  assert.equal(source.includes('button[aria-label="生成を停止"]'), true);
  assert.equal(source.includes('button[aria-label="停止"]'), true);
});

async function withTempAttachments(names, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  const files = [];
  try {
    for (const name of names) {
      const file = path.join(tempDir, name);
      await fs.writeFile(file, name);
      files.push(file);
    }
    return await fn(files);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function attachmentCardSnapshot(fileStates, { observedFileNames, promptTextLength = 12, hasSendButton = true, sendDisabled = false, busy = false, conditionsReady = true, mappingComplete = true, mappingErrors = [] } = {}) {
  return {
    isChatGPT: true,
    fileStates,
    observedFileNames: observedFileNames || fileStates.filter((state) => state.found).map((state) => state.fileName),
    observedDisplayNames: fileStates.filter((state) => state.found && state.displayNameValid !== false).map((state) => state.displayName || state.fileName),
    selectedFileNames: fileStates.map((state) => state.fileName),
    cardDisplayNames: fileStates.filter((state) => state.found).map((state) => state.displayName || state.fileName),
    fileCount: fileStates.length,
    cardCount: fileStates.filter((state) => state.found).length,
    countsMatch: fileStates.length === fileStates.filter((state) => state.found).length,
    mappingComplete,
    mappingErrors,
    missingFileNames: fileStates.filter((state) => !state.found).map((state) => state.fileName),
    pendingFileNames: fileStates.filter((state) => state.pending).map((state) => state.fileName),
    failedFileNames: fileStates.filter((state) => state.failed).map((state) => state.fileName),
    promptTextLength,
    hasSendButton,
    sendDisabled,
    busy,
    conditionsReady
  };
}

function createDirectUploadPage({ events, fileStateForPoll, onNormalSend = null }) {
  let attachmentPolls = 0;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'uploaded-turn', txt: 'uploaded' });
      if (js.includes('const chatgptUploadInputs')) {
        assert.equal(js.includes("activeComposer.querySelectorAll('input#upload-files[type=\"file\"]')"), true);
        assert.equal(js.includes("document.querySelectorAll('#upload-files')"), true);
        assert.equal(js.includes("uploadInput.id !== 'upload-photos'"), true);
        assert.equal(js.includes("uploadInput.id !== 'upload-camera'"), true);
        return { isChatGPT: true, inputReady: true };
      }
      if (js.includes('const attachCandidates')) throw new Error('attachment_menu_must_not_open');
      if (js.includes('const expectedFileNames')) {
        attachmentPolls += 1;
        return fileStateForPoll(attachmentPolls);
      }
      if (isClickSendEvaluation(js)) {
        onNormalSend?.(attachmentPolls);
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  return { page, attachmentPolls: () => attachmentPolls };
}

test('chatgpt-controller: targets only the active composer upload-files input without opening the attachment menu', async () => {
  await withTempAttachments(['normal.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createDirectUploadPage({
      events,
      fileStateForPoll: () => attachmentCardSnapshot([{ fileName: 'normal.txt', found: true, pending: false, failed: false }])
    });

    await createController(page).query({ prompt: 'attach only the ordinary file', attachments: [attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), ['files-set:1', 'files-selector:#upload-files']);
    assert.equal(events.includes('attachment-menu-open'), false);
  });
});

test('chatgpt-controller: waits for visible cursor-wait and circular attachment progress before two ready polls', async () => {
  await withTempAttachments(['progress.txt'], async ([attachment]) => {
    for (const pendingKind of ['cursor-wait', 'circle[stroke-dasharray]']) {
      const events = [];
      let sentAt = 0;
      const { page, attachmentPolls } = createDirectUploadPage({
        events,
        fileStateForPoll: (poll) => attachmentCardSnapshot([{
          fileName: 'progress.txt',
          found: true,
          pending: poll === 1,
          failed: false,
          pendingKind
        }]),
        onNormalSend: (poll) => { sentAt = poll; }
      });

      await createController(page).query({ prompt: `wait for ${pendingKind}`, attachments: [attachment], timeoutMs: 5_000 });

      assert.equal(attachmentPolls(), 3);
      assert.equal(sentAt, 3);
    }
  });
});

test('chatgpt-controller: stops immediately on a visible attachment upload failure without sending', async () => {
  await withTempAttachments(['failed.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createDirectUploadPage({
      events,
      fileStateForPoll: () => attachmentCardSnapshot([{ fileName: 'failed.txt', found: true, pending: false, failed: true }])
    });

    await assert.rejects(
      createController(page).query({ prompt: 'do not send failures', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => {
        assert.equal(error.message, 'attachment_upload_failed');
        assert.deepEqual(error.data?.failedFileNames, ['failed.txt']);
        return true;
      }
    );
    assert.equal(events.includes('normal-send-click'), false);
  });
});

test('chatgpt-controller: does not treat composer text as an attachment card and waits for every file', async () => {
  await withTempAttachments(['first.txt', 'second.txt'], async ([first, second]) => {
    const events = [];
    const { page } = createDirectUploadPage({
      events,
      fileStateForPoll: () => attachmentCardSnapshot([
        { fileName: 'first.txt', found: true, pending: false, failed: false },
        { fileName: 'second.txt', found: false, pending: true, failed: false }
      ], {
        observedFileNames: ['first.txt', 'second.txt'],
        conditionsReady: true
      })
    });

    await assert.rejects(
      createController(page).query({ prompt: 'all cards must be present', attachments: [first, second], timeoutMs: 20 }),
      (error) => {
        assert.equal(error.message, 'attachment_upload_timeout');
        assert.deepEqual(error.data?.missingFileNames, ['second.txt']);
        assert.deepEqual(error.data?.pendingFileNames, ['second.txt']);
        return true;
      }
    );
    assert.equal(events.includes('normal-send-click'), false);
  });
});

test('chatgpt-controller: includes attachment card readiness diagnostics on timeout', async () => {
  await withTempAttachments(['diagnostic.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createDirectUploadPage({
      events,
      fileStateForPoll: () => attachmentCardSnapshot([
        { fileName: 'diagnostic.txt', found: true, pending: true, failed: false }
      ], { promptTextLength: 9, hasSendButton: true, sendDisabled: true, busy: true, conditionsReady: false })
    });

    await assert.rejects(
      createController(page).query({ prompt: 'wait for diagnosis', attachments: [attachment], timeoutMs: 20 }),
      (error) => {
        assert.equal(error.message, 'attachment_upload_timeout');
        assert.deepEqual(error.data?.expectedFileNames, ['diagnostic.txt']);
        assert.deepEqual(error.data?.observedFileNames, ['diagnostic.txt']);
        assert.deepEqual(error.data?.missingFileNames, []);
        assert.deepEqual(error.data?.pendingFileNames, ['diagnostic.txt']);
        assert.deepEqual(error.data?.failedFileNames, []);
        assert.equal(error.data?.promptTextLength, 9);
        assert.equal(error.data?.hasSendButton, true);
        assert.equal(error.data?.sendDisabled, true);
        assert.equal(error.data?.busy, true);
        return true;
      }
    );
    assert.equal(events.includes('normal-send-click'), false);
  });
});

function chatgptUploadInputState({
  selectedFileNames = [],
  cardDisplayNames = [],
  selectionMatchesExpected = false,
  mappingComplete = false,
  mappingErrors = []
} = {}) {
  return {
    isChatGPT: true,
    inputReady: true,
    selectedFileNames,
    selectedFiles: selectedFileNames.map((name, index) => ({ name, size: 0, type: 'text/plain', lastModified: 0, index })),
    cardDisplayNames,
    selectionMatchesExpected,
    fileCount: selectedFileNames.length,
    cardCount: cardDisplayNames.length,
    countsMatch: selectedFileNames.length === cardDisplayNames.length,
    mappingComplete,
    mappingErrors,
    composerInputCount: 1,
    pageUploadInputCount: 1
  };
}

function createUploadInputStatePage({ events, initialState, clearAfterPoll = 0, fileStateForPoll = null, clearEvaluationResult = null }) {
  let attachmentPolls = 0;
  let clearPolls = 0;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'reselected-turn', txt: 'uploaded' });
      if (js.includes('const chatgptUploadInputs')) {
        assert.doesNotThrow(() => new Function(js));
        return initialState;
      }
      if (js.includes('const nativeValueSetter')) {
        assert.doesNotThrow(() => new Function(js));
        assert.equal(js.includes("nativeValueSetter.call(uploadInput, '')"), true);
        assert.equal(js.includes("new Event('input', { bubbles: true, composed: true })"), true);
        assert.equal(js.includes("new Event('change', { bubbles: true, composed: true })"), true);
        if (clearEvaluationResult) return await clearEvaluationResult(js);
        events.push('native-clear');
        events.push('native-input');
        events.push('native-change');
        return { ok: true };
      }
      if (js.includes('const clearInput')) {
        clearPolls += 1;
        const cleared = clearAfterPoll > 0 && clearPolls >= clearAfterPoll;
        return {
          isChatGPT: true,
          cleared,
          selectedFileNames: cleared ? [] : initialState.selectedFileNames,
          composerInputCount: 1,
          pageUploadInputCount: 1,
          cardDisplayNames: initialState.cardDisplayNames || [],
          filesLength: cleared ? 0 : initialState.selectedFileNames.length,
          inputValueLength: cleared ? 0 : 32,
          cardCount: 0
        };
      }
      if (js.includes('const expectedFileNames')) {
        attachmentPolls += 1;
        return fileStateForPoll?.(attachmentPolls) || attachmentCardSnapshot([{ fileName: 'repeat.txt', found: true, pending: false, failed: false }]);
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  return { page, attachmentPolls: () => attachmentPolls, clearPolls: () => clearPolls };
}

test('chatgpt-controller: initial attachment sets the ordinary file once without clearing', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({ selectedFileNames: [] })
    });

    await createController(page).query({ prompt: 'attach initially', attachments: [attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), ['files-set:1', 'files-selector:#upload-files']);
  });
});

test('chatgpt-controller: clears a stale same-file selection before reselecting it', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      }),
      clearAfterPoll: 1
    });

    await createController(page).query({ prompt: 'reselect the same file', attachments: [attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), ['files-set:1', 'files-selector:#upload-files']);
    assert.deepEqual(events.filter((event) => event.startsWith('native-')), ['native-clear', 'native-input', 'native-change']);
  });
});

test('chatgpt-controller: waits for the active file input to clear before reselecting', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page, clearPolls } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      }),
      clearAfterPoll: 2
    });

    await createController(page).query({ prompt: 'wait for clear', attachments: [attachment], timeoutMs: 5_000 });

    assert.equal(clearPolls(), 2);
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), ['files-set:1', 'files-selector:#upload-files']);
    assert.equal(events.indexOf('native-clear') < events.indexOf('files-set:1'), true);
  });
});

test('chatgpt-controller: reports a file-input clear timeout without reselecting', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      })
    });

    await assert.rejects(
      createController(page).query({ prompt: 'clear must finish', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => {
        assert.equal(error.message, 'chatgpt_file_input_clear_timeout');
        assert.deepEqual(error.data?.expectedFileNames, ['repeat.txt']);
        assert.deepEqual(error.data?.selectedFileNames, ['repeat.txt']);
        assert.deepEqual(error.data?.cardDisplayNames, []);
        assert.equal(error.data?.composerInputCount, 1);
        assert.equal(error.data?.pageUploadInputCount, 1);
        assert.equal(error.data?.filesLength, 1);
        assert.equal(error.data?.inputValueLength, 32);
        assert.equal(error.data?.cardCount, 0);
        return true;
      }
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(events.includes('native-clear'), true);
  });
});

test('chatgpt-controller: reuses complete active composer cards without clearing or setting files', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page, attachmentPolls } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        cardDisplayNames: ['repeat.txt'],
        selectionMatchesExpected: true,
        mappingComplete: true
      })
    });

    await createController(page).query({ prompt: 'reuse active attachment', attachments: [attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(attachmentPolls(), 2);
  });
});

test('chatgpt-controller: rejects a partial active composer attachment state without clearing it', async () => {
  await withTempAttachments(['first.txt', 'second.txt'], async ([first, second]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['first.txt', 'second.txt'],
        cardDisplayNames: ['first.txt'],
        selectionMatchesExpected: true,
        mappingErrors: ['file_card_count_mismatch']
      })
    });

    await assert.rejects(
      createController(page).query({ prompt: 'do not disturb partial cards', attachments: [first, second], timeoutMs: 5_000 }),
      (error) => {
        assert.equal(error.message, 'chatgpt_file_input_state_conflict');
        assert.deepEqual(error.data?.expectedFileNames, ['first.txt', 'second.txt']);
        assert.deepEqual(error.data?.selectedFileNames, ['first.txt', 'second.txt']);
        assert.deepEqual(error.data?.cardDisplayNames, ['first.txt']);
        return true;
      }
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
  });
});

test('chatgpt-controller: ignores a historical same-name card when deciding to clear stale selection', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      }),
      clearAfterPoll: 1
    });

    await createController(page).query({ prompt: 'historical card is irrelevant', attachments: [attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), ['files-set:1', 'files-selector:#upload-files']);
    assert.equal(events.includes('native-clear'), true);
  });
});

test('chatgpt-controller: replaces a different selected file without clearing first', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({ selectedFileNames: ['other.txt'] })
    });

    await createController(page).query({ prompt: 'replace another file', attachments: [attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), ['files-set:1', 'files-selector:#upload-files']);
  });
});

test('chatgpt-controller: treats basename case differences as a stale same-file selection', async () => {
  await withTempAttachments(['Repeat.TXT'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      }),
      clearAfterPoll: 1
    });

    await createController(page).query({ prompt: 'case-insensitive repeat', attachments: [attachment], timeoutMs: 5_000 });

    assert.equal(events.filter((event) => event === 'files-set:0').length, 0);
    assert.equal(events.filter((event) => event === 'native-clear').length, 1);
  });
});

test('chatgpt-controller: treats reordered duplicate basenames as a stale same-file selection', async () => {
  await withTempAttachments(['first.txt', 'second.txt', 'first.txt'], async ([first, second, duplicate]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['SECOND.TXT', 'FIRST.TXT', 'first.txt'],
        selectionMatchesExpected: true
      }),
      clearAfterPoll: 1,
      fileStateForPoll: () => attachmentCardSnapshot([
        { fileName: 'first.txt', found: true, pending: false, failed: false },
        { fileName: 'second.txt', found: true, pending: false, failed: false },
        { fileName: 'first.txt', found: true, pending: false, failed: false }
      ])
    });

    await createController(page).query({ prompt: 'reordered repeated files', attachments: [first, second, duplicate], timeoutMs: 5_000 });

    assert.equal(events.filter((event) => event === 'files-set:0').length, 0);
    assert.equal(events.filter((event) => event === 'native-clear').length, 1);
    assert.equal(events.filter((event) => event === 'files-set:3').length, 1);
  });
});

test('chatgpt-controller: accepts only exact or ChatGPT duplicate-suffixed attachment card display names', () => {
  const accepted = [
    ['foo.txt', 'foo.txt'],
    ['foo.txt', 'foo(2).txt'],
    ['foo.txt', 'foo(15).txt'],
    ['foo(2).txt', 'foo(2).txt'],
    ['foo(2).txt', 'foo(2)(2).txt'],
    ['archive.tar.gz', 'archive.tar(2).gz'],
    ['README', 'README(2)'],
    ['.env', '.env(2)']
  ];
  const rejected = [
    ['foo.txt', 'foo (2).txt'],
    ['foo.txt', 'foo-2.txt'],
    ['foo.txt', 'foo(1).txt'],
    ['foo.txt', 'bar(2).txt'],
    ['foo.txt', 'foo(2).md']
  ];

  for (const [fileName, displayName] of accepted) {
    assert.equal(isChatGPTAttachmentCardDisplayName(fileName, displayName), true, `${fileName} -> ${displayName}`);
  }
  for (const [fileName, displayName] of rejected) {
    assert.equal(isChatGPTAttachmentCardDisplayName(fileName, displayName), false, `${fileName} -> ${displayName}`);
  }
});

test('chatgpt-controller: reuses a completed renamed ChatGPT card mapped from the active FileList', async () => {
  await withTempAttachments(['foo.txt'], async ([attachment]) => {
    const events = [];
    const { page, attachmentPolls } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['foo.txt'],
        cardDisplayNames: ['foo(2).txt'],
        selectionMatchesExpected: true,
        mappingComplete: true
      }),
      fileStateForPoll: () => attachmentCardSnapshot([{
        fileName: 'foo.txt',
        displayName: 'foo(2).txt',
        found: true,
        displayNameValid: true,
        pending: false,
        failed: false
      }])
    });

    await createController(page).query({ prompt: 'reuse renamed attachment', attachments: [attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(events.includes('native-clear'), false);
    assert.equal(attachmentPolls(), 2);
  });
});

test('chatgpt-controller: reuses duplicate FileList entries only when every ordered card maps', async () => {
  await withTempAttachments(['foo.txt'], async ([attachment]) => {
    const events = [];
    const { page, attachmentPolls } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['foo.txt', 'foo.txt'],
        cardDisplayNames: ['foo.txt', 'foo(2).txt'],
        selectionMatchesExpected: true,
        mappingComplete: true
      }),
      fileStateForPoll: () => attachmentCardSnapshot([
        { fileName: 'foo.txt', displayName: 'foo.txt', found: true, displayNameValid: true, pending: false, failed: false },
        { fileName: 'foo.txt', displayName: 'foo(2).txt', found: true, displayNameValid: true, pending: false, failed: false }
      ])
    });

    await createController(page).query({ prompt: 'reuse duplicate attachments', attachments: [attachment, attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(attachmentPolls(), 2);
  });
});

test('chatgpt-controller: refuses an invalid renamed active card without sending or clearing it', async () => {
  await withTempAttachments(['foo.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['foo.txt'],
        cardDisplayNames: ['foo (2).txt'],
        selectionMatchesExpected: true,
        mappingErrors: ['display_name_mismatch:0']
      })
    });

    await assert.rejects(
      createController(page).query({ prompt: 'do not infer renamed cards', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => {
        assert.equal(error.message, 'chatgpt_file_input_state_conflict');
        assert.deepEqual(error.data?.cardDisplayNames, ['foo (2).txt']);
        return true;
      }
    );
    assert.equal(events.includes('native-clear'), false);
    assert.equal(events.some((event) => event.startsWith('files-set:')), false);
  });
});

test('chatgpt-controller: rejects reversed or count-mismatched active card mappings without clearing', async () => {
  await withTempAttachments(['first.txt', 'second.txt'], async ([first, second]) => {
    for (const cardDisplayNames of [['second.txt', 'first.txt'], ['first.txt']]) {
      const events = [];
      const { page } = createUploadInputStatePage({
        events,
        initialState: chatgptUploadInputState({
          selectedFileNames: ['first.txt', 'second.txt'],
          cardDisplayNames,
          selectionMatchesExpected: true,
          mappingErrors: cardDisplayNames.length === 2 ? ['display_name_mismatch:0'] : ['file_card_count_mismatch']
        })
      });

      await assert.rejects(
        createController(page).query({ prompt: 'preserve unresolved attachments', attachments: [first, second], timeoutMs: 5_000 }),
        (error) => {
          assert.equal(error.message, 'chatgpt_file_input_state_conflict');
          assert.deepEqual(error.data?.cardDisplayNames, cardDisplayNames);
          return true;
        }
      );
      assert.equal(events.includes('native-clear'), false);
      assert.equal(events.some((event) => event.startsWith('files-set:')), false);
    }
  });
});

test('chatgpt-controller: uses native value-setter clearing only for stale selections and never calls the empty CDP FileList API', async () => {
  const source = await fs.readFile(new URL('../chatgpt-controller.mjs', import.meta.url), 'utf8');

  assert.equal(source.includes('setFileInputFiles([], { selector: \'#upload-files\' })'), false);
  assert.equal(source.includes("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set"), true);
  assert.equal(source.includes("nativeValueSetter.call(uploadInput, '')"), true);
  assert.equal(source.includes("new Event('input', { bubbles: true, composed: true })"), true);
  assert.equal(source.includes("new Event('change', { bubbles: true, composed: true })"), true);
});

test('chatgpt-controller: does not clear when the FileList changes after stale-selection detection', async () => {
  await withTempAttachments(['expected.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['expected.txt'],
        selectionMatchesExpected: true
      }),
      clearEvaluationResult: async (js) => {
        assert.equal(js.includes('const expectedFileNames = ["expected.txt"];'), true);
        assert.equal(js.includes('file_selection_changed'), true);
        return {
          ok: false,
          reason: 'file_selection_changed',
          expectedFileNames: ['expected.txt'],
          selectedFileNames: ['different.txt'],
          cardDisplayNames: [],
          composerInputCount: 1,
          pageUploadInputCount: 1
        };
      }
    });

    await assert.rejects(
      createController(page).query({ prompt: 'do not clear another file', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => {
        assert.equal(error.message, 'chatgpt_file_input_clear_failed');
        assert.equal(error.data?.reason, 'file_selection_changed');
        assert.deepEqual(error.data?.expectedFileNames, ['expected.txt']);
        assert.deepEqual(error.data?.selectedFileNames, ['different.txt']);
        assert.deepEqual(error.data?.cardDisplayNames, []);
        assert.equal(error.data?.composerInputCount, 1);
        assert.equal(error.data?.pageUploadInputCount, 1);
        return true;
      }
    );
    assert.equal(events.includes('native-clear'), false);
    assert.equal(events.includes('native-input'), false);
    assert.equal(events.includes('native-change'), false);
    assert.equal(events.some((event) => event.startsWith('files-set:')), false);
  });
});

test('chatgpt-controller: revalidates FileList names as a case-insensitive duplicate-preserving multiset', async () => {
  assert.equal(
    hasSameChatGPTAttachmentFileNameMultiset(
      ['foo.txt', 'foo.txt', 'bar.txt'],
      ['BAR.TXT', 'foo.txt', 'FOO.TXT']
    ),
    true
  );
  assert.equal(
    hasSameChatGPTAttachmentFileNameMultiset(
      ['foo.txt', 'foo.txt', 'bar.txt'],
      ['foo.txt', 'bar.txt']
    ),
    false
  );
});

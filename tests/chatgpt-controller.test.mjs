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
    let attachmentReadyPolls = 0;
    const page = createPage({
      events,
      onEvaluate: async (js) => {
        if (js.includes('const assistantBaseline')) return assistantBaseline();
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
        if (js.includes('const visibleMenuRoots')) {
          events.push('attachment-file-option');
          return { inputAvailable: false, selected: true };
        }
        if (js.includes('const expectedFileNames')) {
          attachmentReadyPolls += 1;
          events.push('attachment-ready');
          return {
            isChatGPT: true,
            promptTextLength: 14,
            hasSendButton: true,
            sendDisabled: false,
            busy: false,
            conditionsReady: true,
            observedFileNames: ['attachment.txt']
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

function assistantBaseline({ count = 0, lastAssistantId = '', lastAssistantText = '' } = {}) {
  return { isChatGPT: true, assistantCount: count, lastAssistantId, lastAssistantText };
}

function assistantSnapshot({
  stop = false,
  sendEnabled = true,
  txt = '',
  count = 0,
  lastAssistantId = '',
  hasContinue = false
} = {}) {
  return {
    isChatGPT: true,
    stop,
    sendEnabled,
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
          return {
            isChatGPT: true,
            promptTextLength: 14,
            hasSendButton: true,
            sendDisabled: false,
            busy: false,
            conditionsReady: true,
            observedFileNames: attachmentPolls === 1 ? [] : ['expected.txt']
          };
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
          return {
            isChatGPT: true,
            promptTextLength: 12,
            hasSendButton: true,
            sendDisabled: false,
            busy: false,
            observedFileNames: ['first.txt']
          };
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
          events.push('visible-menu-file-option');
          return { inputAvailable: false, selected: true };
        }
        if (js.includes('const expectedFileNames')) {
          attachmentPolls += 1;
          return {
            isChatGPT: true,
            promptTextLength: 12,
            hasSendButton: true,
            sendDisabled: false,
            busy: false,
            conditionsReady: true,
            observedFileNames: ['menu.txt']
          };
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

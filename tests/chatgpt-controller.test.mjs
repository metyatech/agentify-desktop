import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  ChatGPTController,
  DEFAULT_CONVERSATION_HISTORY_ITERATIONS,
  DEFAULT_CONVERSATION_HISTORY_TIMEOUT_MS,
  MAX_CONVERSATION_HISTORY_TIMEOUT_MS,
  conversationSemanticAnchorSignature,
  conversationSemanticTailSignature,
  buildChatGPTDomModelScript,
  buildConversationTraversalReadScript,
  buildConversationWindowReadScript,
  conversationDirectionalProgress,
  diagnoseVirtualizedOriginIdentityMismatch,
  conversationStartBoundaryProof,
  verifyCompleteHistoryFixedPoint,
  mergeConversationSnapshots,
  hasSameChatGPTAttachmentFileNameMultiset,
  isChatGPTAttachmentCardDisplayName,
  isChatGPTCurrentDraftAttachmentCard,
  mapChatGPTAttachmentCardNames
} from '../chatgpt-controller.mjs';
import { createDraftLease, describeAttachmentFiles, DraftOwnershipStore, textDigest } from '../chatgpt-draft-ownership.mjs';
import { classifyProposalResponse, parseValidateProposalResponse } from '../autopilot-proposal.mjs';
import { validateAndSanitizeBackendHistoryDiagnostics } from '../http-api.mjs';

const selectors = {
  promptTextarea: '#prompt-textarea',
  sendButton: 'button[data-testid="send-button"]',
  stopButton: 'button[data-testid="stop-button"]',
  assistantMessage: '[data-message-author-role="assistant"]'
};

const conversationProposalMetadata = Object.freeze({
  schemaVersion: 1,
  proposalId: '123e4567-e89b-42d3-a456-426614174000',
  createdAt: '2026-08-10T00:00:00.000Z',
  expiresAt: '2026-08-10T23:59:59.999Z',
  tabKey: 'autopilot-production',
  approvalCode: 'AB12CD34'
});

const conversationProposalPrompt = String.raw`Windows path: D:\ghws\RuntimeUnicodeTextSample
Embedded quote: Commit with message "Replace Fab media with real Unreal screenshots"
Newline instruction:
Keep this line and the next line distinct.`;

function conversationProposalText() {
  return [
    'AUTOPILOT_PROPOSAL_BEGIN_V1',
    JSON.stringify({
      ...conversationProposalMetadata,
      contract: {
        schemaVersion: 1,
        id: 'conversation-transport-test',
        title: 'Conversation transport test',
        repository: null,
        agentify: { tabKey: conversationProposalMetadata.tabKey },
        implementation: { prompt: conversationProposalPrompt },
        verification: [],
        review: { maxRounds: 10, timeoutMs: 300000 },
        delivery: { push: false },
        constraints: []
      }
    }, null, 2),
    'AUTOPILOT_PROPOSAL_END_V1'
  ].join('\n');
}

function normalizeUserTurnTextForTest(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function userTurnDigestForTest(value) {
  return crypto.createHash('sha256').update(normalizeUserTurnTextForTest(value), 'utf8').digest('hex');
}

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
  if (js.includes('agentifyPromptTypeVerification')) return { ok: true, promptTextLength: 0 };
  if (js.includes('agentifyPromptTypeClear')) return { ok: true, promptTextLength: 0 };
  if (js.includes('const hasTurnstile')) return readyState();
  if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
  return undefined;
}

function createPage({ events, onEvaluate, attachmentDraftState = null, onBasicEvaluate = null, promptEvaluationOverride = null, onInsertText = null, onSetFileInputFiles = null, onStopTokenEvaluate = null, onMoveMouse = null, onMouseDown = null, onMouseUp = null, onSendKey = null, onMouseWheel = null, onScrollGesture = null, nativeInputDiagnostics = null, includeUserTurnBaseline = false, userTurnBaseline = null }) {
  const defaultStopTokenEvaluation = (js) => {
    if (js.includes('agentifyStopTokenStateRead')) return { ok: true, generation: 0, sequence: 0, retiredSequence: 0, dispatchState: null };
    const generation = Number(/const (?:generation|expectedGeneration) = ([0-9]+)/u.exec(js)?.[1] || 0);
    const sequence = Number(/const (?:sequence|expectedSequence) = ([0-9]+)/u.exec(js)?.[1] || 0);
    if (js.includes('agentifyStopTokenActivation')) {
      const token = JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null');
      return { ok: true, applied: true, generation, sequence, token };
    }
    if (js.includes('agentifyStopTokenDispatchCheck')) return { ok: true, active: true, generation, sequence, retiredSequence: 0, dispatchState: 'pending' };
    if (js.includes('agentifyStopTokenDispatchClaim')) return { ok: true, claimed: true, state: 'claimed' };
    if (js.includes('agentifyStopTokenDispatchStart')) {
      const startGeneration = Number(/dispatch: \{ generation: ([0-9]+)/u.exec(js)?.[1] || 0);
      const startSequence = Number(/sequence: ([0-9]+)/u.exec(js)?.[1] || 0);
      return { ok: true, started: true, state: 'dispatching', generation: startGeneration, sequence: startSequence };
    }
    if (js.includes('agentifyStopTokenDispatchRollback')) return { ok: true, rolledBack: true, state: 'cancelled' };
    if (js.includes('agentifyStopTokenDispatchComplete')) return { ok: true, state: 'dispatched' };
    if (js.includes('agentifyStopTokenDispatchRead')) return { ok: true, state: 'dispatching' };
    return { ok: true };
  };
  return {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('agentifyStopTokenStop') && !js.includes('agentifyStopTokenStopCancellation')) {
        const customStop = await onStopTokenEvaluate?.(js);
        if (customStop !== undefined) return customStop;
        const fallbackStop = await onEvaluate(js);
        if (fallbackStop === true) return { ok: true, state: 'dispatched', clicked: true, reason: 'provider_stop_clicked' };
        if (fallbackStop === false) return { ok: true, state: 'cancelled', cancelled: true, clicked: false };
        return fallbackStop;
      }
      if (js.includes('agentifyStopTokenLifecycle') || js.includes('agentifyStopTokenStateRead') || js.includes('agentifyStopTokenDispatchCheck') || js.includes('agentifyStopTokenDispatchClaim') || js.includes('agentifyStopTokenDispatchStart') || js.includes('agentifyStopTokenDispatchRollback') || js.includes('agentifyStopTokenDispatchComplete') || js.includes('agentifyStopTokenDispatchRead') || js.includes('agentifyStopTokenStopCancellation')) {
        return await onStopTokenEvaluate?.(js) ?? defaultStopTokenEvaluation(js);
      }
      if (js.includes('agentifyAttachmentDraftPreflight')) return typeof attachmentDraftState === 'function' ? await attachmentDraftState() : attachmentDraftState || { isChatGPT: true, hasAttachmentState: false };
      const basicOverride = await onBasicEvaluate?.(js);
      if (basicOverride !== undefined) return basicOverride;
      if (js.includes('missing_prompt_textarea') && promptEvaluationOverride) return await promptEvaluationOverride(js);
      if (js.includes('agentifyUserTurnBaseline')) {
        return typeof userTurnBaseline === 'function'
          ? await userTurnBaseline()
          : userTurnBaseline || { count: 0, lastId: '', lastTextDigest: userTurnDigestForTest('') };
      }
      const basic = basicEvaluation(js);
      if (basic !== undefined) {
        if (includeUserTurnBaseline && js.includes('missing_prompt_textarea')) {
          return {
            ...basic,
            userTurnBaseline: userTurnBaseline || { count: 0, lastId: '', lastTextDigest: userTurnDigestForTest('') }
          };
        }
        return basic;
      }
      return await onEvaluate(js);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey(key, options = {}) {
      events.push(`key:${key}`);
      await onSendKey?.(key, options);
    },
    async insertText(text) {
      events.push(`text:${text}`);
      await onInsertText?.(text);
    },
    async moveMouse(x, y) {
      events.push(`move-mouse:${x}:${y}`);
      await onMoveMouse?.(x, y);
    },
    async mouseWheel(x, y, deltaX = 0, deltaY = 0) {
      events.push(`mouse-wheel:${x}:${y}:${deltaX}:${deltaY}`);
      await onMouseWheel?.(x, y, deltaX, deltaY);
    },
    async scrollGesture(options = {}) {
      events.push(`scroll-gesture:${JSON.stringify(options)}`);
      await onScrollGesture?.(options);
    },
    async getNativeInputDiagnostics() {
      return nativeInputDiagnostics || {
        backend: 'test',
        windowVisible: null,
        windowFocused: null,
        windowMinimized: null,
        windowDestroyed: false,
        webContentsDestroyed: false,
        pageClosed: false
      };
    },
    async mouseDown(x) {
      events.push(x >= 80 ? 'normal-send-click' : 'prompt-click');
      await onMouseDown?.(x);
    },
    async mouseUp(x) {
      await onMouseUp?.(x);
    },
    async setFileInputFiles(files, options = {}) {
      events.push(`files-set:${files.length}`);
      if (options?.selector) events.push(`files-selector:${options.selector}`);
      await onSetFileInputFiles?.(files, options);
    }
  };
}

function createController(page, options = {}) {
  return new ChatGPTController({ page, selectors, ...options });
}

function createBackendDiagnosticPage({
  pathname = '/c/backend-diagnostic-test',
  body = null,
  sessionBody = { accessToken: 'session-access-token-sentinel' },
  status = 200,
  sessionStatus = 200,
  contentType = 'application/json',
  sessionContentType = 'application/json',
  responseText = body === null ? '{}' : JSON.stringify(body),
  sessionResponseText = sessionBody === null ? '{}' : JSON.stringify(sessionBody),
  contentLength = null,
  sessionContentLength = null,
  fetchError = null,
  sessionFetchError = null,
  fetchDelayMs = 0,
  sessionFetchDelayMs = 0,
  mountedDomTurnCount = 0,
  streamChunks = null,
  sessionStreamChunks = null,
  stallAfterReadIndex = null,
  sessionStallAfterReadIndex = null,
  omitReader = false,
  sessionOmitReader = false,
  backendResponses = null,
  digestOverrides = {},
  domRecords = []
} = {}) {
  const calls = [];
  const allCalls = [];
  const state = { readCount: 0, sessionReadCount: 0, backendRequestCount: 0, cancelCount: 0, sessionCancelCount: 0, responseTextCalled: false, sessionResponseTextCalled: false };
  const chunks = (streamChunks || [responseText]).map((chunk) => chunk instanceof Uint8Array
    ? chunk
    : new TextEncoder().encode(String(chunk)));
  const sessionChunks = (sessionStreamChunks || [sessionResponseText]).map((chunk) => chunk instanceof Uint8Array
    ? chunk
    : new TextEncoder().encode(String(chunk)));
  const domNodes = domRecords.map((record, index) => {
    const turnId = String(record.turnId || `dom-turn-${index}`).trim();
    const role = record.role === 'assistant' ? 'assistant' : 'user';
    const text = String(record.text || '');
    const contentTurn = {
      parentElement: null,
      getAttribute(name) { return name === 'data-content-search-turn-key' ? turnId : null; }
    };
    const wrapper = {
      parentElement: null,
      getAttribute(name) { return name === 'data-turn-key' ? `wrapper-${turnId}` : null; },
      contains(node) { return node === domNode; }
    };
    const domNode = {
      parentElement: contentTurn,
      innerText: text,
      textContent: text,
      cloneNode() { return { innerText: text, textContent: text, matches: () => false, querySelectorAll: () => [] }; },
      getAttribute(name) {
        if (name === 'data-content-search-unit-key') return `${turnId}:${index}:${role}`;
        return null;
      },
      closest(selector) {
        if (selector === '[data-content-search-turn-key]') return contentTurn;
        if (selector === '[data-turn-key]') return wrapper;
        return null;
      }
    };
    contentTurn.parentElement = wrapper;
    wrapper.parentElement = null;
    return domNode;
  });
  const page = {
    async evaluate(js) {
      const context = {
        AbortController,
        TextDecoder,
        TextEncoder,
        clearTimeout,
        crypto: {
          subtle: {
            async digest(algorithm, value) {
              const text = new TextDecoder().decode(value);
              const digest = digestOverrides[text];
              if (typeof digest !== 'string') return await crypto.webcrypto.subtle.digest(algorithm, value);
              return Uint8Array.from(digest.match(/.{2}/gu), (byte) => Number.parseInt(byte, 16)).buffer;
            }
          }
        },
        document: { querySelectorAll: (selector) => selector === '[data-content-search-unit-key]' ? domNodes : Array.from({ length: mountedDomTurnCount }, () => ({})) },
        fetch: async (url, options) => {
          const isSession = String(url) === '/api/auth/session';
          const call = { url, options };
          allCalls.push(call);
          if (!isSession) calls.push(call);
          const backendResponse = !isSession && Array.isArray(backendResponses) ? backendResponses[state.backendRequestCount] || null : null;
          if (!isSession) state.backendRequestCount += 1;
          const responseStatus = isSession ? sessionStatus : backendResponse?.status ?? status;
          const responseContentType = isSession ? sessionContentType : backendResponse?.contentType ?? contentType;
          const responseTextValue = isSession ? sessionResponseText : backendResponse?.responseText ?? responseText;
          const responseContentLength = isSession ? sessionContentLength : backendResponse?.contentLength ?? contentLength;
          const responseChunks = isSession
            ? sessionChunks
            : (backendResponse
              ? (backendResponse.streamChunks || [responseTextValue])
              : chunks).map((chunk) => chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
          const responseFetchError = isSession ? sessionFetchError : backendResponse?.fetchError ?? fetchError;
          const responseFetchDelayMs = isSession ? sessionFetchDelayMs : backendResponse?.fetchDelayMs ?? fetchDelayMs;
          const responseStallAfterReadIndex = isSession ? sessionStallAfterReadIndex : backendResponse?.stallAfterReadIndex ?? stallAfterReadIndex;
          const responseOmitReader = isSession ? sessionOmitReader : backendResponse?.omitReader ?? omitReader;
          if (responseFetchError) throw responseFetchError;
          if (responseFetchDelayMs > 0) {
            await new Promise((resolve, reject) => {
              const handle = setTimeout(resolve, responseFetchDelayMs);
              options.signal.addEventListener('abort', () => {
                clearTimeout(handle);
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              }, { once: true });
            });
          }
          return {
            ok: responseStatus >= 200 && responseStatus < 300,
            status: responseStatus,
            headers: { get: (name) => name.toLowerCase() === 'content-type' ? responseContentType : name.toLowerCase() === 'content-length' ? responseContentLength : null },
            body: responseOmitReader ? {} : {
                getReader() {
                let chunkIndex = 0;
                return {
                  async read() {
                    if (isSession) state.sessionReadCount += 1;
                    else state.readCount += 1;
                    if (responseStallAfterReadIndex !== null && chunkIndex >= responseStallAfterReadIndex) {
                      await new Promise((resolve, reject) => {
                        const onAbort = () => {
                          const error = new Error('aborted');
                          error.name = 'AbortError';
                          reject(error);
                        };
                        if (options.signal.aborted) onAbort();
                        else options.signal.addEventListener('abort', onAbort, { once: true });
                      });
                    }
                    if (chunkIndex >= responseChunks.length) return { done: true, value: undefined };
                    return { done: false, value: responseChunks[chunkIndex++] };
                  },
                  async cancel() { if (isSession) state.sessionCancelCount += 1; else state.cancelCount += 1; }
                };
              }
            },
            async text() { if (isSession) state.sessionResponseTextCalled = true; else state.responseTextCalled = true; return responseTextValue; }
          };
        },
        location: { origin: 'https://chatgpt.com', pathname },
        setTimeout,
        clearTimeout
      };
      return await vm.runInNewContext(js, context);
    },
    async getUrl() { return `https://chatgpt.com${pathname}`; }
  };
  return { page, calls, allCalls, state };
}

function backendMappingFixture({ currentNode = 'assistant-2', branching = false, brokenParent = false, cycle = false } = {}) {
  const root = { id: 'root-sentinel', parent: null, children: ['user-1'] };
  const user = { id: 'user-1', parent: 'root-sentinel', children: ['assistant-2'], message: { author: { role: 'user' }, content: { parts: ['synthetic user'] } } };
  const assistant = { id: 'assistant-2', parent: brokenParent ? 'missing-parent-sentinel' : 'user-1', children: [], message: { author: { role: 'assistant' }, content: { parts: ['synthetic assistant'] } } };
  if (cycle) {
    root.parent = 'assistant-2';
    assistant.children = ['root-sentinel'];
  }
  const mapping = { 'root-sentinel': root, 'user-1': user, 'assistant-2': assistant };
  if (branching) {
    mapping['user-branch'] = { id: 'user-branch', parent: 'root-sentinel', children: ['assistant-branch'], message: { author: { role: 'user' }, content: { parts: ['branch user'] } } };
    mapping['assistant-branch'] = { id: 'assistant-branch', parent: 'user-branch', children: [], message: { author: { role: 'assistant' }, content: { parts: ['branch assistant'] } } };
    root.children.push('user-branch');
  }
  return { mapping, current_node: currentNode, conversation_id: 'backend-diagnostic-test' };
}

function createStartMarkerDiagnosticPage({ snapshot, initialAtTop = true, wheelSnapshots = [], layoutSnapshots = [] } = {}) {
  const events = [];
  let phase = 'before';
  let wheelIndex = 0;
  let windowState = 'minimized';
  let adapterMinimized = true;
  let visibilityState = 'hidden';
  let hidden = true;
  let hasFocus = false;
  let layoutReadIndex = 0;
  const base = structuredClone(snapshot);
  const currentSnapshot = () => {
    if (phase === 'normalized') {
      const layout = layoutSnapshots.length
        ? layoutSnapshots[Math.min(layoutReadIndex++, layoutSnapshots.length - 1)]
        : base;
      return structuredClone(layout);
    }
    if (phase === 'wheel') return structuredClone(wheelSnapshots[Math.min(wheelIndex - 1, wheelSnapshots.length - 1)] || base);
    if (phase === 'restored') return structuredClone(base);
    return structuredClone(base);
  };
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const targetDistance =')) {
        events.push('conversation-scroll-restore');
        phase = 'restored';
        return { ok: true };
      }
      if (js.includes('const markerSelector =')) return currentSnapshot();
      throw new Error(`unexpected_start_marker_eval:${js.slice(0, 80)}`);
    },
    onMouseWheel: async (_x, _y, _dx, dy) => {
      assert.equal(dy, -720);
      wheelIndex += 1;
      phase = 'wheel';
    }
  });
  page.getUrl = async () => base.url;
  page.getNativeInputDiagnostics = async () => ({
    backend: 'chrome-cdp', pageClosed: false, browserWindowState: windowState,
    adapterMinimized, documentVisibilityState: visibilityState,
    documentHidden: hidden, documentHasFocus: hasFocus
  });
  page.temporarilyUnminimizeForProbe = async () => {
    events.push('window-state:normal');
    windowState = 'normal'; adapterMinimized = false; visibilityState = 'visible'; hidden = false; hasFocus = true; phase = 'normalized';
  };
  page.restoreMinimizedForProbe = async () => {
    events.push('window-state:minimized');
    windowState = 'minimized'; adapterMinimized = true; visibilityState = 'hidden'; hidden = true; hasFocus = false;
  };
  if (!initialAtTop) base.scroller.atTop = false;
  return { page, events, getWheelCount: () => wheelIndex };
}

function startMarkerSnapshot({ range = { min: 1, max: 3 }, atTop = true, atBottom = false, scrollTop = 0, scrollHeight = 1_000, clientHeight = 400, verticalScrollMode = 'normal', markerPositions = [1, 2, 3], turnZero = null, firstMessagePosition = 1, firstMessageRole = 'user', windowSignature = 'aaa11111', structuralSignature = 'bbb22222' } = {}) {
  const positions = markerPositions.map((position) => ({ parsedPosition: position, insideSelectedScroller: true }));
  const zero = turnZero || { elementCount: 0, insideScrollerCount: 0, visibleElementCount: 0, containsUserMessage: false, containsAssistantMessage: false, rawMarkers: [] };
  return {
    url: 'https://chatgpt.com/c/start-marker-test', limitExceeded: false, limitKind: null, loading: false,
    range, windowSignature, structuralSignature,
    scroller: { candidateCount: 1, selectedMessageDescendantCount: 3, scrollTop, scrollHeight, clientHeight, verticalScrollMode, atTop, atBottom, point: { x: 500, y: 300 } },
    markerPositions: { minimum: Math.min(...markerPositions), maximum: Math.max(...markerPositions), uniquePositions: markerPositions, hasPosition0: markerPositions.includes(0), hasPosition1: markerPositions.includes(1) },
    turnZero: zero,
    positionOne: { elementCount: markerPositions.includes(1) ? 1 : 0, containsUserMessage: firstMessagePosition === 1, containsAssistantMessage: firstMessagePosition === 1 && firstMessageRole === 'assistant', rawMarkers: [] },
    firstMessagePosition, firstMessageRole,
    positionSource: { depth: 1, attributeName: 'id', rawValue: `conversation-turn-${firstMessagePosition}`, parsedPosition: firstMessagePosition },
    firstMessages: [{ domIndex: 0, role: firstMessageRole, parsedPosition: firstMessagePosition, messageIdPresent: true, turnIdPresent: false, textLength: 5, textDigest: 'abcd1234', textPrefix: 'first' }],
    firstMessageAncestors: [{ depth: 0, tagName: 'DIV', id: `conversation-turn-${firstMessagePosition}`, dataTestId: null, dataConversationTurn: null, dataTurn: null, dataMessageIdPresent: false, dataTurnIdPresent: false, hidden: false, ariaHidden: false, display: 'block', visibility: 'visible' }],
    previousSiblings: [], scrollerMarkerOrder: positions.map((item) => ({ ...item, id: `conversation-turn-${item.parsedPosition}`, dataTestId: null, roleCounts: { user: 1, assistant: 0 }, hidden: false })),
    messagePositionOrder: [{ role: firstMessageRole, position: firstMessagePosition }],
    turnZeroElementExists: zero.elementCount > 0,
    turnZeroContainsConversationMessage: zero.containsUserMessage || zero.containsAssistantMessage
  };
}

function createPromptExpressionContext(userTurns = [], initialPromptText = '') {
  const focused = { value: false };
  const prompt = {
    tagName: 'DIV',
    id: 'prompt-textarea',
    innerText: initialPromptText,
    textContent: initialPromptText,
    isContentEditable: true,
    disabled: false,
    readOnly: false,
    getAttribute(name) {
      return name === 'id' ? this.id : name === 'contenteditable' ? 'true' : name === 'role' ? 'textbox' : null;
    },
    matches(selector) {
      return selector === '[contenteditable="true"]' || selector === '[role="textbox"]' || selector === '[contenteditable="true"], [role="textbox"]';
    },
    getBoundingClientRect() {
      return { x: 12, y: 640, width: 480, height: 42 };
    },
    focus() {
      focused.value = true;
    }
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '#prompt-textarea' || selector.includes('[contenteditable="true"]') || selector.includes('[role="textbox"]')) return [prompt];
      if (selector.includes('[data-message-author-role="user"]') || selector.includes('article[data-turn="user"]')) return userTurns;
      return [];
    }
  };
  const context = {
    document,
    window: { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) },
    TextEncoder,
    Uint8Array,
    crypto: crypto.webcrypto,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  return { context, focused, prompt };
}

function createChallengeExpressionContext({ bodyText, challengeText = bodyText, composerText = '', promptVisible = true, sendVisible = true, verifyButton = false, turnstile = false, arkose = false }) {
  const prompt = {
    tagName: 'DIV',
    id: 'prompt-textarea',
    innerText: composerText,
    textContent: composerText,
    isContentEditable: true,
    disabled: false,
    readOnly: false,
    getAttribute(name) {
      if (name === 'id') return this.id;
      if (name === 'contenteditable') return 'true';
      if (name === 'role') return 'textbox';
      if (name === 'aria-label') return 'Message';
      return null;
    },
    matches(selector) {
      return selector === '[contenteditable="true"]' || selector === '[role="textbox"]' || selector.includes('[contenteditable="true"]') || selector.includes('[role="textbox"]');
    },
    getBoundingClientRect() {
      return { x: 12, y: 640, width: 480, height: 42 };
    }
  };
  const send = {
    textContent: 'Send',
    getBoundingClientRect() {
      return { x: 500, y: 640, width: 42, height: 42 };
    },
    getAttribute(name) {
      if (name === 'data-testid') return 'send-button';
      if (name === 'aria-label') return 'Send';
      return null;
    },
    matches() {
      return false;
    }
  };
  const verify = {
    textContent: 'Verify you are human',
    getBoundingClientRect() {
      return { x: 100, y: 100, width: 160, height: 40 };
    }
  };
  const frame = (src) => ({ getAttribute: (name) => name === 'src' ? src : null });
  const clonedBody = {
    innerText: challengeText,
    textContent: challengeText,
    querySelectorAll() {
      return [];
    }
  };
  const body = {
    innerText: bodyText,
    cloneNode() {
      return clonedBody;
    }
  };
  const document = {
    body,
    readyState: 'complete',
    title: 'ChatGPT',
    querySelectorAll(selector) {
      if (selector === '#prompt-textarea' || selector.includes('main textarea') || selector.includes('[contenteditable="true"]') || selector.includes('[role="textbox"]')) return promptVisible ? [prompt] : [];
      if (selector === 'button[data-testid="send-button"]') return sendVisible ? [send] : [];
      if (selector === 'button, a') return verifyButton ? [verify] : [];
      if (selector === 'iframe') return turnstile ? [frame('https://challenges.cloudflare.com/turnstile/api.js')] : arkose ? [frame('https://client-api.arkoselabs.com/fc/api')] : [];
      return [];
    },
    querySelector(selector) {
      if (turnstile && selector.includes('turnstile')) return frame('https://challenges.cloudflare.com/turnstile/api.js');
      if (arkose && selector.includes('arkose')) return frame('https://client-api.arkoselabs.com/fc/api');
      return null;
    }
  };
  const context = {
    document,
    location: { href: 'https://chatgpt.com/' },
    window: { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) },
    TextEncoder,
    Uint8Array,
    crypto: crypto.webcrypto
  };
  context.globalThis = context;
  return { context };
}

async function captureActualChallengeEvaluation(options) {
  const events = [];
  const { context } = createChallengeExpressionContext(options);
  let expression = '';
  const page = createPage({
    events,
    onBasicEvaluate: async (js) => {
      if (!js.includes('const hasTurnstile')) return undefined;
      expression = js;
      return await vm.runInNewContext(js, context);
    },
    onEvaluate: async (js) => {
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  const result = await createController(page).detectChallenge();
  return { events, expression, result };
}

test('chatgpt-controller: challenge detection ignores composer verify text on a normal page', async () => {
  const captured = await captureActualChallengeEvaluation({
    bodyText: 'ChatGPT Read all files and verify every marker',
    challengeText: 'ChatGPT',
    composerText: 'Read all files and verify every marker'
  });

  assert.equal(captured.result.promptVisible, true);
  assert.equal(captured.result.blocked, false);
  assert.equal(captured.result.indicators.looks403, false);
  assert.equal(captured.result.indicators.hasVerifyButton, false);
  assert.match(captured.expression, /verify you are human\|human verification\|i am human/u);
});

test('chatgpt-controller: challenge detection blocks a concrete 403 page', async () => {
  const captured = await captureActualChallengeEvaluation({
    bodyText: '403 Forbidden',
    promptVisible: false,
    sendVisible: false
  });

  assert.equal(captured.result.promptVisible, false);
  assert.equal(captured.result.indicators.looks403, true);
  assert.equal(captured.result.blocked, true);
  assert.equal(captured.result.kind, 'blocked');
});

test('chatgpt-controller: challenge detection preserves concrete human verification blocking', async () => {
  const captured = await captureActualChallengeEvaluation({
    bodyText: 'Verify you are human',
    promptVisible: false,
    sendVisible: false,
    verifyButton: true
  });

  assert.equal(captured.result.blocked, true);
  assert.equal(captured.result.indicators.hasVerifyButton, true);
  assert.equal(captured.result.kind, 'captcha');
});

test('chatgpt-controller: conversation words do not block a usable composer', async () => {
  const captured = await captureActualChallengeEvaluation({
    bodyText: 'Previous user said verify this and assistant mentioned 403 in the explanation. ChatGPT Read all files and verify every marker',
    challengeText: 'Previous user said verify this and assistant mentioned 403 in the explanation. ChatGPT',
    composerText: 'Read all files and verify every marker'
  });

  assert.equal(captured.result.promptVisible, true);
  assert.equal(captured.result.indicators.looks403, false);
  assert.equal(captured.result.blocked, false);
});

function createUserTurnFixture({ id = '', messageId = '', text = '' } = {}) {
  return {
    id,
    innerText: text,
    getAttribute(name) {
      if (name === 'data-message-id') return messageId;
      if (name === 'id') return id;
      return null;
    }
  };
}

function createConversationTurnFixture({ role, innerText, textContent = innerText, messageId = '' }) {
  const createClone = () => ({
    innerText,
    textContent,
    matches: () => false,
    querySelectorAll: () => []
  });
  return {
    parentElement: null,
    cloneNode: createClone,
    getAttribute(name) {
      if (name === 'data-message-author-role') return role;
      if (name === 'data-message-id') return messageId;
      return null;
    },
    closest(selector) {
      if (selector === '[data-message-id]' && messageId) return this;
      return null;
    }
  };
}

function createConversationExpressionContext(nodes) {
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="user"], [data-message-author-role="assistant"]') return nodes;
      return [];
    }
  };
  const context = { document };
  context.globalThis = context;
  return context;
}

async function captureActualConversationExtraction(nodes) {
  const events = [];
  const context = createConversationExpressionContext(nodes);
  let expression = '';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (!js.includes('const selectedTurns = turns.slice')) throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      expression = js;
      return await vm.runInNewContext(js, context);
    }
  });
  const result = await createController(page).readConversationTurns({ maxTurns: 2, maxCharsPerTurn: 100_000, maxTotalChars: 200_000 });
  return { expression, result };
}

function createCompleteHistoryDom({ initialScrollTop = 480, positionHints = true, changeUrlOnScroll = false } = {}) {
  const body = {
    tagName: 'BODY',
    parentElement: null,
    id: '',
    className: '',
    contains(node) { return node === this || node?.parentElement === this || node?.parentElement?.parentElement === this; },
    matches: () => false,
    getAttribute: () => null
  };
  const sidebar = {
    tagName: 'NAV',
    parentElement: body,
    id: 'sidebar',
    className: 'navigation-pane',
    contains: () => false,
    matches: (selector) => selector.includes('nav') || selector.includes('navigation'),
    getAttribute: () => null,
    scrollHeight: 20_000,
    clientHeight: 400,
    scrollTop: 0
  };
  const scroller = {
    tagName: 'DIV',
    parentElement: body,
    id: 'conversation-scroll',
    className: 'conversation-scroll-region',
    scrollHeight: 1_400,
    clientHeight: 400,
    scrollTop: initialScrollTop,
    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    matches: () => false,
    getAttribute: () => null,
    dispatchEvent: () => true,
    scrollTo(options) { this.scrollTop = options.top; },
    scrollBy(options) { this.scrollTop += options.top; }
  };
  let currentNodes = [];
  let url = 'https://chatgpt.com/c/test';
  const windowFor = (scrollTop) => {
    if (scrollTop >= 900) return [20, 21, 22, 23, 24];
    if (scrollTop >= 650) return [15, 16, 17, 18, 19, 20, 21];
    if (scrollTop >= 400) return [10, 11, 12, 13, 14, 15, 16];
    if (scrollTop >= 200) return [5, 6, 7, 8, 9, 10, 11];
    return [0, 1, 2, 3, 4, 5, 6];
  };
  const setNodes = (scrollTop) => {
    currentNodes = windowFor(scrollTop).map((position) => {
      const role = position % 2 ? 'assistant' : 'user';
      const node = {
        tagName: 'ARTICLE',
        parentElement: scroller,
        id: positionHints ? `conversation-turn-${position}` : '',
        className: '',
        innerText: `turn-${position}`,
        textContent: `turn-${position}`,
        matches: () => false,
        querySelectorAll: () => [],
        cloneNode() {
          return { innerText: this.innerText, textContent: this.textContent, matches: () => false, querySelectorAll: () => [] };
        },
        getAttribute(name) {
          if (name === 'data-message-author-role') return role;
          if (name === 'data-message-id') return `message-${position}`;
          if (name === 'data-testid') return positionHints ? `conversation-turn-${position}` : null;
          return null;
        },
        closest(selector) { return selector === '[data-message-id]' ? this : null; },
        contains(child) { return child === this; }
      };
      if (!positionHints) node.getAttribute = (name) => name === 'data-message-author-role' ? role : name === 'data-message-id' ? `message-${position}` : null;
      return node;
    });
    if (changeUrlOnScroll && scrollTop < initialScrollTop) url = 'https://chatgpt.com/c/changed';
  };
  Object.defineProperty(scroller, 'scrollTop', {
    get() { return this._scrollTop; },
    set(value) { this._scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, Number(value) || 0)); setNodes(this._scrollTop); }
  });
  scroller.scrollTop = initialScrollTop;
  setNodes(initialScrollTop);
  const document = {
    scrollingElement: body,
    body,
    documentElement: body,
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="user"], [data-message-author-role="assistant"]') return currentNodes;
      if (selector === '*') return [scroller, sidebar, body, ...currentNodes];
      return [];
    }
  };
  const context = {
    document,
    location: { get href() { return url; } },
    getComputedStyle(node) {
      if (node === scroller) return { overflowY: 'auto' };
      if (node === sidebar) return { overflowY: 'auto' };
      return { overflowY: 'visible' };
    },
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    Event: class Event {},
    WheelEvent: class WheelEvent {},
    Date,
    JSON
  };
  context.globalThis = context;
  return { context, scroller, getNodes: () => currentNodes, getUrl: () => url };
}

function evaluateConversationWindowReadWithDom({
  documentScrollHeight = 2_000,
  documentClientHeight = 400,
  documentOverflowY = 'visible',
  innerScroller = null,
  loadingNodes = []
} = {}) {
  const body = {
    tagName: 'BODY',
    parentElement: null,
    id: '',
    className: '',
    scrollHeight: documentScrollHeight,
    clientHeight: documentClientHeight,
    scrollTop: 0,
    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    matches: () => false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1_000, bottom: 800, width: 1_000, height: 800 })
  };
  const scroller = innerScroller
    ? {
        tagName: 'DIV',
        parentElement: body,
        id: 'conversation-scroll',
        className: 'conversation-scroll-region',
        scrollHeight: innerScroller.scrollHeight ?? 1_400,
        clientHeight: innerScroller.clientHeight ?? 400,
        scrollTop: innerScroller.scrollTop ?? 480,
        contains(node) {
          let current = node;
          while (current) {
            if (current === this) return true;
            current = current.parentElement;
          }
          return false;
        },
        matches: () => false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1_000, bottom: 800, width: 1_000, height: 800 })
      }
    : null;
  const parent = scroller || body;
  const messages = [0, 1].map((position) => ({
    tagName: 'ARTICLE',
    parentElement: parent,
    id: `conversation-turn-${position}`,
    className: '',
    innerText: `turn-${position}`,
    textContent: `turn-${position}`,
    matches: () => false,
    querySelectorAll: () => [],
    cloneNode() {
      return {
        innerText: this.innerText,
        textContent: this.textContent,
        matches: () => false,
        querySelectorAll: () => [],
        remove() {}
      };
    },
    getAttribute(name) {
      if (name === 'data-message-author-role') return position % 2 ? 'assistant' : 'user';
      if (name === 'data-message-id') return `message-${position}`;
      if (name === 'data-testid') return `conversation-turn-${position}`;
      return null;
    },
    closest: () => null,
    contains(child) { return child === this; },
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 200, bottom: 40, width: 190, height: 30 })
  }));
  const document = {
    scrollingElement: body,
    documentElement: body,
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="user"], [data-message-author-role="assistant"]') return messages;
      if (selector === '[id*="conversation-turn-" i], [data-testid*="conversation-turn-" i], [data-conversation-turn], [data-turn]') return messages;
      if (selector === '[aria-busy="true"], [role="progressbar"], [data-testid*="loading" i]') return loadingNodes;
      return [];
    }
  };
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/native-wheel-test' },
    innerWidth: 1_000,
    innerHeight: 800,
    getComputedStyle(node) {
      if (node === body) return { overflowY: documentOverflowY };
      if (node === scroller) return { overflowY: innerScroller?.overflowY || 'auto' };
      return { overflowY: 'visible', display: 'block', visibility: 'visible', opacity: '1' };
    }
  };
  context.globalThis = context;
  return vm.runInNewContext(buildConversationWindowReadScript({ maxTurns: 10, maxCharsPerTurn: 1_000, maxTotalChars: 5_000 }), context);
}

function evaluateCurrentDomModel({ offsetPx = 4_800, malformed = false, legacy = false, innerScroller = true, missingContentTurn = false, mismatchedContentTurn = false, missingVirtualizerWrapper = false } = {}) {
  const body = {
    tagName: 'BODY', parentElement: null, id: '', className: '', scrollHeight: 2_000, clientHeight: 800, scrollTop: 0,
    matches: () => false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1_000, bottom: 800, width: 1_000, height: 800 })
  };
  const scroller = {
    tagName: 'DIV', parentElement: body, id: innerScroller ? 'conversation-scroll' : '', className: 'thread-scroll-container overflow-y-auto',
    scrollHeight: 1_600, clientHeight: 800, scrollTop: 0,
    matches: () => false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1_000, bottom: 800, width: 1_000, height: 800 })
  };
  const selection = { tagName: 'DIV', parentElement: innerScroller ? scroller : body, style: {}, matches: () => false, getAttribute: () => null };
  const host = { tagName: 'DIV', parentElement: selection, style: { marginTop: `${offsetPx}px` }, matches: () => false, getAttribute: () => null };
  const wrappers = [];
  const units = [];
  const contains = (root, child) => {
    let current = child;
    while (current) {
      if (current === root) return true;
      current = current.parentElement;
    }
    return false;
  };
  body.contains = (child) => child === body || contains(body, child);
  scroller.contains = (child) => child === scroller || contains(scroller, child);
  const makeUnit = (contentTurnKey, unitIndex, role) => {
    const unitKey = `${contentTurnKey}:${unitIndex}:${role}`;
    const action = { remove() {} };
    let contentTurn = null;
    let virtualizerWrapper = null;
    const unit = {
      tagName: 'DIV', parentElement: null, innerText: role === 'assistant' ? 'assistant answer Copy' : 'user prompt', textContent: role === 'assistant' ? 'assistant answer Copy' : 'user prompt',
      getAttribute(name) { return name === 'data-content-search-unit-key' ? unitKey : null; },
      closest(selector) {
        if (selector === '[data-content-search-turn-key]') return contentTurn;
        if (selector === '[data-turn-key]') return virtualizerWrapper;
        return null;
      },
      contains(child) { return child === this || contains(this, child); },
      cloneNode() {
        return { innerText: role === 'assistant' ? 'assistant answer' : 'user prompt', textContent: role === 'assistant' ? 'assistant answer' : 'user prompt', matches: () => false, querySelectorAll: () => [action] };
      }
    };
    unit.setParents = (content, wrapper) => {
      contentTurn = content;
      virtualizerWrapper = wrapper;
    };
    return unit;
  };
  for (const [contentTurnKey, virtualizerTurnKey, entries] of [
    ['turn-a', 'virtual-wrapper-a', [['0', 'user'], ['2', 'assistant']]],
    ['turn-b', 'virtual-wrapper-b', [['0', 'user']]]
  ]) {
    const wrapper = {
      tagName: 'DIV', parentElement: host, style: {}, id: '', className: '',
      getAttribute(name) { return name === 'data-turn-key' ? virtualizerTurnKey : null; },
      closest(selector) { return selector === '[data-turn-key]' ? this : null; },
      contains(child) { return child === this || contains(this, child); },
      matches: () => false
    };
    const contentTurn = {
      tagName: 'DIV', parentElement: wrapper, style: {},
      getAttribute(name) {
        if (name !== 'data-content-search-turn-key') return null;
        return mismatchedContentTurn ? `different-${contentTurnKey}` : contentTurnKey;
      },
      closest(selector) { return selector === '[data-content-search-turn-key]' ? this : selector === '[data-turn-key]' ? wrapper : null; },
      contains(child) { return child === this || contains(this, child); },
      matches: () => false
    };
    wrappers.push(wrapper);
    for (const [unitIndex, role] of entries) {
      const unit = makeUnit(contentTurnKey, unitIndex, role);
      unit.parentElement = missingContentTurn ? wrapper : contentTurn;
      unit.setParents(missingContentTurn ? null : contentTurn, missingVirtualizerWrapper ? null : wrapper);
      units.push(unit);
    }
  }
  if (malformed) {
    const bad = makeUnit('different-turn', 0, 'assistant');
    bad.parentElement = wrappers[0];
    bad.setParents(null, wrappers[0]);
    bad.getAttribute = (name) => name === 'data-content-search-unit-key' ? 'turn-a:not-a-role' : null;
    units.push(bad);
  }
  if (legacy) {
    wrappers[0].getAttribute = (name) => name === 'data-turn-key' ? 'virtual-wrapper-a' : name === 'data-message-author-role' ? 'user' : null;
  }
  const document = {
    scrollingElement: body,
    documentElement: body,
    querySelectorAll(selector) {
      if (selector === '[data-content-search-unit-key]') return units;
      if (selector === '[data-turn-key]') return wrappers;
      if (selector.includes('[data-message-author-role="user"]')) return legacy ? [wrappers[0]] : [];
      if (selector.includes('[data-message-author-role="assistant"]') || selector.includes('article[data-turn')) return [];
      return [];
    }
  };
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/current-dom-test' },
    innerWidth: 1_000,
    innerHeight: 800,
    getComputedStyle(node) { return { overflowY: node === (innerScroller ? scroller : body) ? (innerScroller ? 'auto' : 'visible') : 'visible' }; }
  };
  context.globalThis = context;
  return { context, result: vm.runInNewContext(`${buildChatGPTDomModelScript()}.read()`, context) };
}

function evaluatePersistentTurnShells({
  shellTestIds = Array.from({ length: 45 }, (_, index) => `conversation-turn-${index}`),
  mountedIndices = Array.from({ length: 18 }, (_, index) => index + 27),
  shellOrder = null,
  shellRoles = new Map(),
  shellHeights = new Map(),
  unitOutsideShell = false,
  sentinel = 'provider-sentinel-should-not-leak'
} = {}) {
  const body = { tagName: 'BODY', parentElement: null, scrollHeight: 3_000, clientHeight: 800, scrollTop: 0, matches: () => false, getAttribute: () => null };
  const main = { tagName: 'MAIN', parentElement: body, matches: () => false, getAttribute: () => null };
  const scroller = { tagName: 'DIV', parentElement: main, scrollHeight: 4_000, clientHeight: 800, scrollTop: 0, matches: () => false, getAttribute: () => null };
  const host = { tagName: 'DIV', parentElement: scroller, style: { marginTop: '0px' }, matches: () => false, getAttribute: () => null };
  const contains = (root, child) => {
    let current = child;
    while (current) {
      if (current === root) return true;
      current = current.parentElement;
    }
    return false;
  };
  body.contains = (child) => child === body || contains(body, child);
  main.contains = (child) => child === main || contains(main, child);
  scroller.contains = (child) => child === scroller || contains(scroller, child);
  host.contains = (child) => child === host || contains(host, child);
  const shells = [];
  const wrappers = [];
  const units = [];
  const shellByIndex = new Map();
  const roleNode = (role) => ({ getAttribute: (name) => name === 'data-message-author-role' ? role : null });
  const makeShell = (testId, position) => {
    const role = shellRoles.has(position) ? shellRoles.get(position) : position % 2 === 0 ? 'user' : 'assistant';
    const shell = {
      tagName: position % 2 === 0 ? 'SECTION' : 'ARTICLE',
      parentElement: host,
      style: {},
      matches: () => false,
      getAttribute(name) {
        if (name === 'data-testid') return testId;
        if (name === 'data-turn') return role;
        return null;
      },
      querySelectorAll: () => [],
      contains(child) { return child === this || contains(this, child); },
      getBoundingClientRect: () => ({ height: shellHeights.get(testId) ?? 120 })
    };
    const wrapper = {
      tagName: 'DIV', parentElement: shell, style: {}, matches: () => false,
      getAttribute(name) { return name === 'data-turn-key' ? `virtual-${sentinel}-${position}` : null; },
      contains(child) { return child === this || contains(this, child); }
    };
    shellByIndex.set(position, shell);
    shells.push(shell);
    wrappers.push(wrapper);
    return { shell, wrapper, role };
  };
  for (const [position, testId] of (shellOrder || shellTestIds.map((value, index) => ({ value, index }))).entries()) {
    const spec = typeof testId === 'object' ? testId : { value: testId, index: position };
    makeShell(spec.value, spec.index);
  }
  const makeUnit = (position, index) => {
    const role = position % 2 === 0 ? 'user' : 'assistant';
    const contentTurn = { parentElement: shellByIndex.get(position), getAttribute: (name) => name === 'data-content-search-turn-key' ? `${sentinel}-turn-${position}` : null, closest: (selector) => selector === '[data-content-search-turn-key]' ? contentTurn : selector === '[data-turn-key]' ? wrappers[position] : null, contains: (child) => child === contentTurn || contains(contentTurn, child), matches: () => false };
    const wrapper = wrappers[position] || wrappers[0];
    const unit = {
      tagName: 'DIV', parentElement: null, innerText: `turn ${position}`, textContent: `turn ${position}`,
      getAttribute(name) { return name === 'data-content-search-unit-key' ? `${sentinel}-turn-${position}:${index}:${role}` : null; },
      closest(selector) { return selector === '[data-content-search-turn-key]' ? contentTurn : selector === '[data-turn-key]' ? wrapper : null; },
      contains(child) { return child === this || contains(this, child); },
      cloneNode() { return { innerText: `turn ${position}`, textContent: `turn ${position}`, matches: () => false, querySelectorAll: () => [] }; }
    };
    unit.parentElement = unitOutsideShell && index === 0 ? host : contentTurn;
    units.push(unit);
  };
  mountedIndices.forEach((position, index) => makeUnit(position, index));
  const document = {
    scrollingElement: body,
    documentElement: body,
    querySelector(selector) { return selector === 'main' ? main : null; },
    querySelectorAll(selector) {
      if (selector === '[data-content-search-unit-key]') return units;
      if (selector === '[data-turn-key]') return wrappers;
      if (selector === '[data-message-author-role="user"], [data-message-author-role="assistant"], article[data-turn="user"], article[data-turn="assistant"]') return [];
      return [];
    }
  };
  main.querySelectorAll = (selector) => selector === 'section[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn-"]' ? shells : [];
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/persistent-shell-test' },
    innerWidth: 1_000,
    innerHeight: 800,
    getComputedStyle(node) { return { overflowY: node === scroller ? 'auto' : 'visible' }; }
  };
  context.globalThis = context;
  return {
    context,
    result: vm.runInNewContext(`${buildChatGPTDomModelScript()}.read()`, context),
    readWindow: () => vm.runInNewContext(buildConversationWindowReadScript({ maxTurns: 100, maxCharsPerTurn: 1_000, maxTotalChars: 20_000 }), context)
  };
}

function createNativeWheelHistoryPage({ initialWindow = 2, windowCount = 5, windowSize = null, windowRanges = null, positionHints = true, positionOffset = 0, turnText = null, turnLiveText = null, turnIdentityPlan = null, changeUrlOnWheel = false, changeUrlOnReadAt = null, nativeWheel = true, windowChanges = true, scrollGesture = false, scrollGestureSource = null, backend = 'test', initialBrowserWindowState = null, initialVisibilityState = null, initialDocumentHidden = null, initialDocumentHasFocus = null, initialPageClosed = false, windowRestoreSucceeds = true, nativeDiagnosticsPlan = null, mouseWheelPlan = null, olderMaterializationPlan = null, directTopPlan = null, normalizeReady = true, limitExceededAtRead = null, limitKind = 'total', restorePlan = null, layoutSnapshots = null, onTraversalRead = null, currentDom = false, persistentTurnShells = null, virtualizerTopOffsetPx = null, virtualizerTopOffsetPlan = null, reverseScroll = false } = {}) {
  const events = [];
  let windows = Array.isArray(windowRanges)
    ? windowRanges
    : Number.isInteger(windowSize) && windowSize > 0
    ? Array.from({ length: windowCount }, (_, index) => Array.from({ length: windowSize }, (_, offset) => index * windowSize + offset))
    : windowCount > 5
    ? Array.from({ length: windowCount }, (_, index) => Array.from({ length: 7 }, (_, offset) => index * 5 + offset))
    : [
      [0, 1, 2, 3, 4, 5, 6],
      [5, 6, 7, 8, 9, 10, 11],
      [10, 11, 12, 13, 14, 15, 16],
      [15, 16, 17, 18, 19, 20, 21],
      [20, 21, 22, 23, 24]
    ];
  const defaultScrollHeight = windowCount > 5 ? windowCount * 250 + 400 : 1_400;
  let windowIndex = initialWindow;
  const originalWindowIndex = initialWindow;
  let url = 'https://chatgpt.com/c/native-wheel-test';
  let wheelCount = 0;
  let readCount = 0;
  let restoreCount = 0;
  let directTopCount = 0;
  let scrollTopOverride = null;
  let scrollHeightOverride = null;
  let loadingOverride = null;
  let virtualizerTopOffsetOverride = Number.isFinite(Number(virtualizerTopOffsetPx)) ? Number(virtualizerTopOffsetPx) : null;
  const initialState = initialBrowserWindowState || (backend === 'chrome-cdp' ? 'minimized' : null);
  let browserWindowState = initialState;
  let adapterMinimized = backend === 'chrome-cdp' ? initialState === 'minimized' : null;
  let visibilityState = backend === 'chrome-cdp' ? (initialVisibilityState || (initialState === 'minimized' ? 'hidden' : 'visible')) : null;
  let hidden = backend === 'chrome-cdp' ? (initialDocumentHidden ?? visibilityState === 'hidden') : null;
  let hasFocus = backend === 'chrome-cdp' ? (initialDocumentHasFocus ?? initialState !== 'minimized') : null;
  let nativeDiagnosticsCount = 0;
  const snapshot = () => {
    const rawPositions = windows[windowIndex];
    const positions = rawPositions.map((position) => position + positionOffset);
    const persistentShellDiagnostics = typeof persistentTurnShells === 'function'
      ? persistentTurnShells({ readCount, windowIndex })
      : persistentTurnShells;
    const defaultScrollTop = reverseScroll
      ? -(windows.length - 1 - windowIndex) * 250
      : windowIndex * 250;
    const rawScrollTop = Number.isFinite(scrollTopOverride) ? scrollTopOverride : defaultScrollTop;
    const scrollHeight = Number.isFinite(scrollHeightOverride) ? scrollHeightOverride : defaultScrollHeight;
    const maxScrollDistance = Math.max(0, scrollHeight - 400);
    const distanceFromBottom = reverseScroll ? Math.max(0, -rawScrollTop) : Math.max(0, maxScrollDistance - rawScrollTop);
    const distanceFromTop = reverseScroll ? Math.max(0, maxScrollDistance + rawScrollTop) : Math.max(0, rawScrollTop);
    return {
      url,
      turns: positions.map((position) => {
        const plannedIdentity = typeof turnIdentityPlan === 'function' ? turnIdentityPlan({ position, windowIndex, readCount }) : null;
        return {
          role: rawPositions[positions.indexOf(position)] % 2 ? 'assistant' : 'user',
          text: typeof turnText === 'function' ? turnText({ position, windowIndex, readCount }) : `turn-${position}`,
          messageId: plannedIdentity && Object.hasOwn(plannedIdentity, 'messageId') ? plannedIdentity.messageId : `message-${position}`,
          turnId: plannedIdentity && Object.hasOwn(plannedIdentity, 'turnId') ? plannedIdentity.turnId : null,
          positionHint: positionHints ? position : null,
          ...(typeof turnLiveText === 'function' ? { domMode: 'content-search-unit', liveInnerText: turnLiveText({ position, windowIndex, readCount }) } : {})
        };
      }),
      limitExceeded: false,
      limitKind: null,
      loading: loadingOverride === null ? false : loadingOverride,
      range: positionHints ? { min: positions[0], max: positions.at(-1) } : { min: null, max: null },
      startBoundary: {
        firstMessagePosition: positionHints ? positions[0] : null,
        firstMessageRole: positionHints ? (rawPositions[0] % 2 ? 'assistant' : 'user') : null,
        positionZeroMessageNodeCount: positionHints && positions.includes(0) ? 1 : 0,
        positionZeroMarkerInsideScrollerCount: positionHints && positions.includes(0) ? 1 : 0,
        positionOneMessageNodeCount: positionHints && positions.includes(1) ? 1 : 0,
        ...(currentDom ? {
          virtualizedOrigin: {
            domMode: 'content-search-unit',
            scrollerCandidateCount: 1,
            turnHostCount: 1,
            topOffsetPx: virtualizerTopOffsetOverride,
            validMessageCount: positions.length,
            malformedMessageCount: 0,
            persistentTurnShells: persistentShellDiagnostics,
            firstMessageRole: rawPositions[0] % 2 ? 'assistant' : 'user',
            loading: loadingOverride === true
          }
        } : {})
      },
      scroller: {
        candidateCount: 1,
        selectedMessageDescendantCount: positions.length,
        selected: { tagName: 'DIV', id: 'conversation-scroll', className: 'conversation-scroll-region', role: '', overflowY: 'auto' },
        selectedPath: 'body>main>div#conversation-scroll',
        candidates: [],
        scrollTop: rawScrollTop,
        scrollHeight,
        clientHeight: 400,
        maxScrollDistance,
        verticalScrollMode: reverseScroll ? 'reverse' : 'normal',
        distanceFromTop,
        distanceFromBottom,
        atTop: reverseScroll ? distanceFromTop <= 2 : rawScrollTop <= 1,
        atBottom: reverseScroll ? distanceFromBottom <= 2 : windowIndex === windows.length - 1,
        point: { x: 500, y: 400 },
        ...(currentDom ? {
          messageDomMode: 'content-search-unit',
          virtualizerTopOffsetPx: virtualizerTopOffsetOverride,
          virtualizerHostCount: 1,
          validCurrentMessageUnitCount: positions.length,
          malformedCurrentMessageUnitCount: 0,
          persistentTurnShells: persistentShellDiagnostics
        } : {})
      }
    };
  };
  const applyOlderMaterialization = async (attempt) => {
    if (typeof olderMaterializationPlan !== 'function') return false;
    const materialized = await olderMaterializationPlan({ attempt, windowIndex, windows: windows.map((window) => window.slice()) });
    if (!materialized || typeof materialized !== 'object') return false;
    if (Array.isArray(materialized.prependRange)) {
      windows = [materialized.prependRange.slice(), ...windows];
      windowIndex = 0;
    } else if (Number.isInteger(materialized.windowIndex)) {
      windowIndex = Math.max(0, Math.min(windows.length - 1, materialized.windowIndex));
    }
    if (Number.isFinite(Number(materialized.virtualizerTopOffsetPx))) virtualizerTopOffsetOverride = Number(materialized.virtualizerTopOffsetPx);
    if (typeof materialized.loading === 'boolean') loadingOverride = materialized.loading;
    if (materialized.changeUrl === true) url = 'https://chatgpt.com/c/changed-during-origin-probe';
    scrollTopOverride = Number.isFinite(Number(materialized.scrollTop)) ? Number(materialized.scrollTop) : null;
    return true;
  };
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const operation = "top";')) {
        events.push('conversation-scroll-top');
        directTopCount += 1;
        const planned = typeof directTopPlan === 'function'
          ? await directTopPlan({ attempt: directTopCount, windowIndex, scrollTop: scrollTopOverride })
          : Array.isArray(directTopPlan) ? directTopPlan[directTopCount - 1] : null;
        if (planned && typeof planned === 'object') {
          if (Number.isInteger(planned.windowIndex)) windowIndex = Math.max(0, Math.min(windows.length - 1, planned.windowIndex));
          if (Number.isFinite(Number(planned.scrollTop))) scrollTopOverride = Number(planned.scrollTop);
          if (typeof planned.loading === 'boolean') loadingOverride = planned.loading;
          if (Number.isFinite(Number(planned.virtualizerTopOffsetPx))) virtualizerTopOffsetOverride = Number(planned.virtualizerTopOffsetPx);
        }
        const topScroll = reverseScroll ? -Math.max(0, (Number.isFinite(scrollHeightOverride) ? scrollHeightOverride : defaultScrollHeight) - 400) : 0;
        scrollTopOverride = topScroll;
        if (reverseScroll && (!planned || !Number.isInteger(planned.windowIndex))) windowIndex = 0;
        return { ok: true, scrollTop: topScroll, verticalScrollMode: reverseScroll ? 'reverse' : 'normal' };
      }
      if (js.includes('const targetDistance =')) {
        events.push('conversation-scroll-restore');
        const directTail = js.includes('const operation = "tail";');
        if (!directTail) restoreCount += 1;
        const distance = Number(/const targetDistance = ([0-9]+)/u.exec(js)?.[1] || 0);
        const planned = directTail
          ? null
          : typeof restorePlan === 'function'
            ? await restorePlan({ attempt: restoreCount, distance })
            : Array.isArray(restorePlan) ? restorePlan[restoreCount - 1] : null;
        loadingOverride = typeof planned?.loading === 'boolean' ? planned.loading : false;
        if (planned && typeof planned === 'object' && Number.isFinite(Number(planned.scrollHeight))) scrollHeightOverride = Number(planned.scrollHeight);
        if (planned && typeof planned === 'object' && Number.isFinite(Number(planned.virtualizerTopOffsetPx))) virtualizerTopOffsetOverride = Number(planned.virtualizerTopOffsetPx);
        if (planned && typeof planned === 'object' && Number.isInteger(planned.windowIndex)) windowIndex = Math.max(0, Math.min(windows.length - 1, planned.windowIndex));
        else windowIndex = distance === 0 ? windows.length - 1 : originalWindowIndex;
        const maxScrollDistance = Math.max(0, (Number.isFinite(scrollHeightOverride) ? scrollHeightOverride : defaultScrollHeight) - 400);
        scrollTopOverride = planned && typeof planned === 'object' && Number.isFinite(Number(planned.scrollTop))
          ? Number(planned.scrollTop)
          : reverseScroll ? -Math.min(maxScrollDistance, distance) : maxScrollDistance - Math.min(maxScrollDistance, distance);
        return { ok: true, scrollTop: scrollTopOverride, verticalScrollMode: reverseScroll ? 'reverse' : 'normal' };
      }
      if (!js.includes('const maxTurns =')) throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      const traversalRead = js.includes('const traversalRead = true;');
      if (!traversalRead) readCount += 1;
      if (Number.isInteger(changeUrlOnReadAt) && readCount === changeUrlOnReadAt) url = 'https://chatgpt.com/c/changed';
      if (currentDom && typeof virtualizerTopOffsetPlan === 'function') {
        const planned = await virtualizerTopOffsetPlan({ readCount, traversalRead, windowIndex, currentOffset: virtualizerTopOffsetOverride });
        if (planned !== null && planned !== undefined && Number.isFinite(Number(planned))) virtualizerTopOffsetOverride = Number(planned);
        if (planned && typeof planned === 'object') {
          if (Array.isArray(planned.prependRange)) {
            windows = [planned.prependRange.slice(), ...windows];
            windowIndex = 0;
          } else if (Number.isInteger(planned.windowIndex)) {
            windowIndex = Math.max(0, Math.min(windows.length - 1, planned.windowIndex));
          }
          if (Number.isFinite(Number(planned.virtualizerTopOffsetPx))) virtualizerTopOffsetOverride = Number(planned.virtualizerTopOffsetPx);
          if (Number.isFinite(Number(planned.scrollTop))) scrollTopOverride = Number(planned.scrollTop);
          if (planned.resetScrollHeight === true) scrollHeightOverride = null;
          else if (Number.isFinite(Number(planned.scrollHeight))) scrollHeightOverride = Number(planned.scrollHeight);
        }
      }
      const state = snapshot();
      if (traversalRead && typeof onTraversalRead === 'function') await onTraversalRead({ readCount, windowIndex, state: structuredClone(state) });
      const layoutOverride = !traversalRead && Array.isArray(layoutSnapshots) && layoutSnapshots[readCount - 1] && typeof layoutSnapshots[readCount - 1] === 'object'
        ? layoutSnapshots[readCount - 1]
        : null;
      if (layoutOverride) {
        const { scroller: layoutScroller, ...layoutFields } = layoutOverride;
        Object.assign(state, layoutFields);
        if (layoutScroller && typeof layoutScroller === 'object') {
          Object.assign(state.scroller, layoutScroller);
          if (Number.isFinite(Number(layoutScroller.scrollTop))) scrollTopOverride = Number(layoutScroller.scrollTop);
          const layoutScrollTop = Number(state.scroller.scrollTop);
          const layoutScrollHeight = Number(state.scroller.scrollHeight);
          const layoutClientHeight = Number(state.scroller.clientHeight);
          const layoutMaxDistance = Math.max(0, layoutScrollHeight - layoutClientHeight);
          state.scroller.maxScrollDistance = layoutMaxDistance;
          state.scroller.verticalScrollMode = reverseScroll ? 'reverse' : 'normal';
          state.scroller.distanceFromBottom = reverseScroll ? Math.max(0, -layoutScrollTop) : Math.max(0, layoutMaxDistance - layoutScrollTop);
          state.scroller.distanceFromTop = reverseScroll ? Math.max(0, layoutMaxDistance + layoutScrollTop) : Math.max(0, layoutScrollTop);
          if (layoutScroller.atTop === undefined) state.scroller.atTop = reverseScroll ? state.scroller.distanceFromTop <= 2 : layoutScrollTop <= 1;
          if (layoutScroller.atBottom === undefined) state.scroller.atBottom = reverseScroll ? state.scroller.distanceFromBottom <= 2 : windowIndex === windows.length - 1;
        }
      }
      if (readCount === limitExceededAtRead) return { ...state, limitExceeded: true, limitKind };
      return state;
    },
    onMouseWheel: async (_x, _y, _deltaX, deltaY) => {
      wheelCount += 1;
      if (changeUrlOnWheel && wheelCount === 1) url = 'https://chatgpt.com/c/changed';
      if (!windowChanges) return;
      const planned = typeof mouseWheelPlan === 'function'
        ? await mouseWheelPlan({ attempt: wheelCount, deltaY, range: windows[windowIndex].slice(0), scrollTop: windowIndex * 250, windowIndex })
        : Array.isArray(mouseWheelPlan) ? mouseWheelPlan[wheelCount - 1] : null;
      if (deltaY < 0 && await applyOlderMaterialization(wheelCount)) return;
      if (planned && typeof planned === 'object') {
        if (Number.isInteger(planned.windowIndex)) windowIndex = Math.max(0, Math.min(windows.length - 1, planned.windowIndex));
        if (planned.range) {
          const next = planned.range;
          const matching = windows.findIndex((window) => window[0] === next.min && window.at(-1) === next.max);
          if (matching >= 0) windowIndex = matching;
        }
        scrollTopOverride = Number.isFinite(Number(planned.scrollTop)) ? Number(planned.scrollTop) : null;
        if (Number.isFinite(Number(planned.virtualizerTopOffsetPx))) virtualizerTopOffsetOverride = Number(planned.virtualizerTopOffsetPx);
        return;
      }
      scrollTopOverride = null;
      if (deltaY > 0) windowIndex = Math.min(windows.length - 1, windowIndex + 1);
      if (deltaY < 0) windowIndex = Math.max(0, windowIndex - 1);
    },
    onScrollGesture: async ({ yDistance, gestureSourceType }) => {
      wheelCount += 1;
      if (changeUrlOnWheel && wheelCount === 1) url = 'https://chatgpt.com/c/changed';
      if (scrollGestureSource && gestureSourceType !== scrollGestureSource) return;
      if (!windowChanges) return;
      if (yDistance > 0 && await applyOlderMaterialization(wheelCount)) return;
      if (yDistance < 0) windowIndex = Math.min(windows.length - 1, windowIndex + 1);
      if (yDistance > 0) windowIndex = Math.max(0, windowIndex - 1);
    }
  });
  page.getUrl = async () => url;
  if (backend === 'chrome-cdp') {
    page.getNativeInputDiagnostics = async () => {
      nativeDiagnosticsCount += 1;
      const base = {
        backend,
        pageClosed: initialPageClosed,
        browserWindowState,
        adapterMinimized,
        documentVisibilityState: visibilityState,
        documentHidden: hidden,
        documentHasFocus: hasFocus
      };
      const planned = typeof nativeDiagnosticsPlan === 'function'
        ? await nativeDiagnosticsPlan({ count: nativeDiagnosticsCount, state: { ...base } })
        : null;
      return planned && typeof planned === 'object' ? { ...base, ...planned } : base;
    };
    page.temporarilyUnminimizeForProbe = async () => {
      events.push('window-state:normal');
      browserWindowState = 'normal';
      adapterMinimized = false;
      visibilityState = normalizeReady ? 'visible' : 'hidden';
      hidden = !normalizeReady;
      hasFocus = normalizeReady;
    };
    page.restoreMinimizedForProbe = async () => {
      events.push('window-state:minimized');
      if (!windowRestoreSucceeds) return;
      browserWindowState = 'minimized';
      adapterMinimized = true;
      visibilityState = 'hidden';
      hidden = true;
      hasFocus = false;
    };
  }
  if (!nativeWheel) page.mouseWheel = undefined;
  if (!scrollGesture) page.scrollGesture = undefined;
  return { page, events, snapshot, getWindowIndex: () => windowIndex, getWheelCount: () => wheelCount, getRestoreCount: () => restoreCount, getDirectTopCount: () => directTopCount, originalWindowIndex };
}

function currentDomUnitIdentity({ position }) {
  const role = position % 2 ? 'assistant' : 'user';
  const turnId = `origin-turn-${position}`;
  return { turnId, messageId: `${turnId}:0:${role}` };
}

function completeTraversalFixture(count, { textChangeAt = null, reverse = false, reason = null, snapshots = null } = {}) {
  const turns = Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: textChangeAt === index ? `turn-${index}-changed` : `turn-${index}`,
    messageId: `message-${index}`,
    positionHint: index
  }));
  if (reverse) turns.reverse();
  return {
    snapshots: snapshots || [{ turns }],
    startReached: true,
    startPositionProof: true,
    tailProven: true,
    snapshotStable: true,
    scrollRestored: true,
    reason,
    diagnostics: {}
  };
}

function completeDiagnosticTraversalFixture({ count = 4, positionOffset = 0, textChangeAt = null, reverse = false, identityMode = 'message' } = {}) {
  const turns = Array.from({ length: count }, (_, index) => {
    const turn = {
      role: index % 2 ? 'assistant' : 'user',
      text: textChangeAt === index ? `private-turn-${index}-changed` : `private-turn-${index}`,
      positionHint: index + positionOffset
    };
    if (identityMode === 'message') turn.messageId = `private-message-${index}`;
    else if (identityMode === 'turn') turn.turnId = `private-turn-id-${index}`;
    return turn;
  });
  if (reverse) turns.reverse();
  return {
    snapshots: [{ turns }],
    startReached: true,
    startPositionProof: true,
    tailProven: true,
    snapshotStable: true,
    scrollRestored: true,
    reason: null,
    diagnostics: {}
  };
}

function createScrollVisibilityProbePage({
  visibilityAfterNormalize = 'visible',
  windowChanges = true,
  gestureError = null,
  readAfterGestureError = false,
  restoreFailures = 0,
  changeUrlOnGesture = false,
  changeUrlAtGesture = null,
  initialScrollTop = 600,
  normalizedScrollTop = 600,
  normalizedRange = { min: 6, max: 10 },
  gesturePlan = null,
  hideAfterGesture = null,
  normalizedHasFocus = false,
  moveMouseError = null,
  mouseWheelError = null,
  mouseWheelEffect = null,
  changeUrlAfterMouseWheel = false,
  changeUrlAtMouseWheel = null,
  hideAfterMouseWheel = null,
  loseFocusAfterMouseWheel = null
} = {}) {
  const events = [];
  let browserWindowState = 'minimized';
  let adapterMinimized = true;
  let visibilityState = 'hidden';
  let hidden = true;
  let hasFocus = false;
  let range = { min: 6, max: 10 };
  let scrollTop = initialScrollTop;
  let url = 'https://chatgpt.com/c/scroll-visibility-probe';
  let gestureCount = 0;
  let mouseWheelCount = 0;
  let restoreAttempts = 0;
  const snapshot = () => ({
    url,
    turns: Array.from({ length: range.max - range.min + 1 }, (_, index) => {
      const position = range.min + index;
      return { role: position % 2 ? 'assistant' : 'user', text: `turn-${position}`, messageId: `message-${position}`, turnId: null, positionHint: position };
    }),
    limitExceeded: false,
    limitKind: null,
    loading: false,
    scroller: {
      candidateCount: 1,
      selectedMessageDescendantCount: range.max - range.min + 1,
      selected: { tagName: 'DIV', id: 'conversation-scroll', className: 'conversation-scroll-region', role: '', overflowY: 'auto' },
      selectedPath: 'body>main>div#conversation-scroll',
      candidates: [],
      scrollTop,
      scrollHeight: 1_400,
      clientHeight: 400,
      atTop: scrollTop <= 1,
      atBottom: scrollTop >= 1_000,
      point: { x: 500, y: 400 }
    }
  });
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (!js.includes('const maxTurns =')) throw new Error(`unexpected_probe_eval:${js.slice(0, 80)}`);
      if ((gestureCount > 0 || mouseWheelCount > 0) && readAfterGestureError) throw new Error('post_gesture_read_failed');
      return snapshot();
    },
    onScrollGesture: async ({ yDistance }) => {
      gestureCount += 1;
      if (gestureError) throw gestureError;
      if (changeUrlOnGesture || changeUrlAtGesture === gestureCount) url = 'https://chatgpt.com/c/changed';
      const planned = typeof gesturePlan === 'function'
        ? await gesturePlan({ attempt: gestureCount, yDistance, range: { ...range }, scrollTop })
        : Array.isArray(gesturePlan) ? gesturePlan[gestureCount - 1] : null;
      if (planned && typeof planned === 'object') {
        if (planned.range) range = { min: planned.range.min, max: planned.range.max };
        if (planned.scrollTop !== undefined) scrollTop = planned.scrollTop;
      } else if (windowChanges && yDistance > 0) {
        range = { min: 5, max: 9 };
      }
      if (hideAfterGesture === gestureCount) {
        visibilityState = 'hidden';
        hidden = true;
      }
    },
    onMoveMouse: async () => {
      if (moveMouseError) throw moveMouseError;
    },
    onMouseWheel: async (_x, _y, _deltaX, _deltaY) => {
      mouseWheelCount += 1;
      const plannedError = typeof mouseWheelError === 'function'
        ? await mouseWheelError({ attempt: mouseWheelCount })
        : mouseWheelError;
      if (plannedError) throw plannedError;
      if (changeUrlAfterMouseWheel || changeUrlAtMouseWheel === mouseWheelCount) url = 'https://chatgpt.com/c/changed';
      const planned = typeof mouseWheelEffect === 'function'
        ? await mouseWheelEffect({ attempt: mouseWheelCount, range: { ...range }, scrollTop: scrollTop })
        : mouseWheelEffect;
      if (planned && typeof planned === 'object') {
        if (planned.range) range = { min: planned.range.min, max: planned.range.max };
        if (planned.scrollTop !== undefined) scrollTop = planned.scrollTop;
      }
      if (hideAfterMouseWheel === mouseWheelCount) {
        visibilityState = 'hidden';
        hidden = true;
      }
      if (loseFocusAfterMouseWheel === mouseWheelCount) hasFocus = false;
    },
    nativeInputDiagnostics: () => ({})
  });
  page.getUrl = async () => url;
  page.getNativeInputDiagnostics = async () => ({
    backend: 'chrome-cdp',
    pageClosed: false,
    browserWindowState,
    adapterMinimized,
    documentVisibilityState: visibilityState,
    documentHidden: hidden,
    documentHasFocus: hasFocus
  });
  page.temporarilyUnminimizeForProbe = async () => {
    browserWindowState = 'normal';
    adapterMinimized = false;
    scrollTop = normalizedScrollTop;
    range = { ...normalizedRange };
    hasFocus = normalizedHasFocus;
    if (visibilityAfterNormalize === 'visible') {
      visibilityState = 'visible';
      hidden = false;
    }
  };
  page.restoreMinimizedForProbe = async () => {
    restoreAttempts += 1;
    if (restoreAttempts <= restoreFailures) throw new Error('restore_failed');
    browserWindowState = 'minimized';
    adapterMinimized = true;
    visibilityState = 'hidden';
    hidden = true;
    hasFocus = false;
  };
  return {
    page,
    events,
    getRestoreAttempts: () => restoreAttempts,
    getGestureCount: () => gestureCount,
    getMouseWheelCount: () => mouseWheelCount
  };
}

async function captureActualTypePromptEvaluation(userTurns) {
  const events = [];
  const progress = [];
  const { context, focused, prompt: promptNode } = createPromptExpressionContext(userTurns);
  let expression = '';
  let evaluationResult;
  let evaluationError = null;
  const page = createPage({
    events,
    promptEvaluationOverride: async (js) => {
      if (!js.includes('const lastUserTextDigest')) return basicEvaluation(js);
      expression = js;
      try {
        const evaluated = await vm.runInNewContext(js, context);
        evaluationResult = structuredClone(evaluated);
        return evaluated;
      } catch (error) {
        evaluationError = error;
        throw error;
      }
    },
    onBasicEvaluate: async (js) => {
      if (js.includes('agentifyPromptTypeVerification')) {
        return await vm.runInNewContext(js, context);
      }
      return undefined;
    },
    onInsertText: async (text) => {
      promptNode.innerText = text;
      promptNode.textContent = text;
    },
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) throw new Error('test_stop_after_type_prompt');
      if (js.includes('agentifyAttachmentCleanup')) return { ok: false, reason: 'test_stop_after_type_prompt' };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).query({ prompt: 'actual expression prompt', onProgress: (item) => progress.push(item) }),
    (error) => error.message === 'test_stop_after_type_prompt'
  );
  return { context, events, progress, expression, evaluationResult, evaluationError, focused };
}

test('chatgpt-controller: executes the actual typePrompt browser expression for a user-turn baseline', async () => {
  const lastText = '  Existing   user turn\ntext  ';
  const result = await captureActualTypePromptEvaluation([
    createUserTurnFixture({ id: 'user-turn-1', messageId: 'message-1', text: lastText })
  ]);

  assert.equal(result.evaluationError, null);
  assert.equal(result.expression.includes('lastTextDigest: lastUserTextDigest'), true);
  assert.equal(result.expression.includes('lastText: lastUserText'), true);
  assert.equal(result.evaluationResult.ok, true);
  assert.equal(result.evaluationResult.userTurnBaseline.count, 1);
  assert.equal(result.evaluationResult.userTurnBaseline.lastId, 'message-1');
  assert.equal(result.evaluationResult.userTurnBaseline.lastText, lastText);
  assert.equal(result.evaluationResult.userTurnBaseline.lastTextDigest, userTurnDigestForTest(lastText));
  assert.match(result.evaluationResult.userTurnBaseline.lastTextDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.focused.value, true);
});

test('chatgpt-controller: executes the actual typePrompt browser expression with zero user turns', async () => {
  const result = await captureActualTypePromptEvaluation([]);

  assert.equal(result.evaluationError, null);
  assert.equal(result.evaluationResult.ok, true);
  assert.equal(result.evaluationResult.userTurnBaseline.count, 0);
  assert.equal(result.evaluationResult.userTurnBaseline.lastId, '');
  assert.equal(result.evaluationResult.userTurnBaseline.lastText, '');
  assert.equal(result.evaluationResult.userTurnBaseline.lastTextDigest, userTurnDigestForTest(''));
  assert.match(result.evaluationResult.userTurnBaseline.lastTextDigest, /^[0-9a-f]{64}$/u);
});

test('chatgpt-controller: continues to insertText after the actual typePrompt baseline evaluation', async () => {
  const result = await captureActualTypePromptEvaluation([
    createUserTurnFixture({ id: 'user-turn-2', text: 'Existing user turn' })
  ]);

  assert.equal(result.progress.some((item) => item?.phase === 'typing_prompt'), true);
  assert.deepEqual(result.events.filter((event) => event.startsWith('text:')), ['text:actual expression prompt']);
});

test('chatgpt-controller: re-clears a restored composer draft when select-all input does not replace it', async () => {
  const events = [];
  const prompt = 'replacement prompt after restored draft';
  const state = { text: 'restored Agentify draft', clearCount: 0 };
  const { context, prompt: promptNode } = createPromptExpressionContext([], state.text);
  const insertions = [];
  const page = createPage({
    events,
    onBasicEvaluate: async (js) => {
      if (js.includes('agentifyPromptTypeClear')) {
        state.text = '';
        state.clearCount += 1;
        promptNode.innerText = '';
        promptNode.textContent = '';
        return { ok: true, promptTextLength: 0 };
      }
      if (js.includes('agentifyPromptTypeVerification')) {
        const normalized = String(state.text).replace(/\s+/g, ' ').trim();
        return { ok: normalized === prompt, promptTextLength: normalized.length };
      }
      return undefined;
    },
    promptEvaluationOverride: async (js) => {
      if (!js.includes('const lastUserTextDigest')) return basicEvaluation(js);
      return await vm.runInNewContext(js, context);
    },
    onInsertText: async (text) => {
      insertions.push(text);
      state.text += text;
      promptNode.innerText = state.text;
      promptNode.textContent = state.text;
    },
    onSendKey: async () => {},
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) throw new Error('test_stop_after_type_prompt');
      if (js.includes('agentifyAttachmentCleanup')) return { ok: false, reason: 'test_stop_after_type_prompt' };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).query({ prompt }),
    (error) => error.message === 'test_stop_after_type_prompt'
  );

  assert.equal(state.clearCount, 1);
  assert.deepEqual(insertions, [prompt, prompt]);
  assert.equal(state.text, prompt);
});

function createProviderStopDomPage({ state, isStopVisible, onStopTokenEvaluateExtra = null }) {
  let clickCount = 0;
  let lastStopScript = '';
  const stopButton = {
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 20, height: 20 }),
    click: () => { clickCount += 1; }
  };
  const context = {
    document: {
      querySelectorAll: () => isStopVisible() ? [stopButton] : []
    },
    window: {
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' })
    },
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  context.__agentifyProviderStopState = structuredClone(state);
  const page = createPage({
    events: [],
    onStopTokenEvaluate: async (js) => {
      const extra = await onStopTokenEvaluateExtra?.(js, context);
      if (extra !== undefined) return extra;
      if (js.includes('agentifyStopTokenStateRead')) {
        const current = context.__agentifyProviderStopState;
        return {
          ok: true,
          generation: current.generation,
          sequence: current.sequence,
          retiredSequence: current.retiredSequence,
          dispatchState: current.dispatch?.state || null
        };
      }
      if (js.includes('agentifyStopTokenStop') && !js.includes('agentifyStopTokenStopCancellation')) {
        lastStopScript = js;
        return await vm.runInNewContext(js, context);
      }
      if (js.includes('agentifyStopTokenStopCancellation')) return await vm.runInNewContext(js, context);
      if (js.includes('agentifyStopTokenRelease')) return await vm.runInNewContext(js, context);
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  return {
    page,
    context,
    clickCount: () => clickCount,
    stopScript: () => lastStopScript,
    state: () => context.__agentifyProviderStopState
  };
}

async function waitForCondition(check, { timeoutMs = 1_500, pollMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  assert.equal(check(), true, 'condition did not become true before timeout');
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

test('chatgpt-controller: reads only structured ChatGPT turns through the mutex', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      assert.match(js, /data-message-author-role="user"/u);
      assert.match(js, /data-message-author-role="assistant"/u);
      assert.match(js, /data-testid\*="copy"/u);
      assert.doesNotMatch(js, /\.navigate\(|\.query\(|\.send\(/u);
      return {
        turns: [
          { role: 'user', text: '開始', index: 0, messageId: 'message-user' },
          { role: 'assistant', text: 'AUTOPILOT_PROPOSAL_BEGIN_V1\n{"ok":true}\nAUTOPILOT_PROPOSAL_END_V1', index: 1, messageId: null }
        ],
        limitExceeded: false,
        limitKind: null
      };
    }
  });
  const controller = createController(page);
  const result = await controller.readConversationTurns({ maxTurns: 2, maxCharsPerTurn: 1000, maxTotalChars: 2000 });
  assert.equal(result.url, 'https://chatgpt.com/');
  assert.equal(result.turns[0].id, 'message-user');
  assert.match(result.turns[1].id, /^turn-[0-9a-f]{24}$/u);
  assert.deepEqual(result.turns.map((turn) => turn.role), ['user', 'assistant']);
});

test('chatgpt-controller: complete history merges overlapping virtualized windows without losing turns', async () => {
  const merged = mergeConversationSnapshots([
    [
      { role: 'user', text: 'turn-0', messageId: 'm0' },
      { role: 'assistant', text: 'turn-1', messageId: 'm1' },
      { role: 'user', text: 'turn-2', messageId: 'm2' }
    ],
    [
      { role: 'user', text: 'turn-2', messageId: 'm2' },
      { role: 'assistant', text: 'turn-3', messageId: 'm3' },
      { role: 'user', text: 'turn-4', messageId: 'm4' }
    ]
  ]);
  assert.equal(merged.ambiguous, false);
  assert.equal(merged.continuous, true);
  assert.deepEqual(merged.turns.map((turn) => turn.text), ['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4']);
});

test('chatgpt-controller: complete history does not deduplicate identical text without a stable identity', async () => {
  const merged = mergeConversationSnapshots([[
    { role: 'user', text: 'repeat', fingerprint: 'repeat-a' },
    { role: 'assistant', text: 'answer-a', fingerprint: 'answer-a' },
    { role: 'user', text: 'repeat', fingerprint: 'repeat-b' },
    { role: 'assistant', text: 'answer-b', fingerprint: 'answer-b' }
  ]]);
  assert.equal(merged.ambiguous, false);
  assert.equal(merged.turns.length, 4);
  assert.deepEqual(merged.turns.map((turn) => turn.text), ['repeat', 'answer-a', 'repeat', 'answer-b']);
});

test('chatgpt-controller: complete history refuses an ambiguous duplicate observation', async () => {
  const merged = mergeConversationSnapshots([[
    { role: 'user', text: 'same', messageId: 'm1' },
    { role: 'user', text: 'same', messageId: 'm1' }
  ]]);
  assert.equal(merged.ambiguous, true);
});

test('chatgpt-controller: complete history orchestrates native wheel input and accumulates virtualized windows', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2 });
  const page = harness.page;
  const result = await createController(page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.deepEqual(result.turns.map((turn) => turn.index), Array.from({ length: 25 }, (_, index) => index));
  assert.equal(result.history.complete, true);
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.nativeWheelSupported, true);
  assert.equal(result.history.diagnostics.nativeScrollControlProven, true);
  assert.ok(harness.getWheelCount() > 0);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
});

test('chatgpt-controller: bounded raw windows preserve proven newest-to-oldest traversal order', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2 });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.mode, 'bounded-raw-windows');
  assert.equal(result.history.windowOrder, 'newest-to-oldest');
  assert.equal(result.history.reason, null);
  assert.equal(result.history.tailProven, true);
  assert.equal(result.history.startReached, true);
  assert.equal(result.history.startPositionProof, true);
  assert.equal(result.history.scrollRestored, true);
  assert.equal(result.history.windowRestored, true);
  assert.equal(result.history.windowCount, result.windows.length);
  assert.deepEqual(result.windows[0].turns.map((turn) => turn.positionHint), [20, 21, 22, 23, 24]);
  assert.deepEqual(result.windows.at(-1).turns.map((turn) => turn.positionHint), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.windows[0].turns.slice(0, 2).map((turn) => turn.positionHint), result.windows[1].turns.slice(-2).map((turn) => turn.positionHint));
  assert.equal(Object.hasOwn(result, 'fullHistoryComplete'), false);
  assert.equal(Object.hasOwn(result.history, 'fullHistoryComplete'), false);
  assert.equal(result.windows[0].turns[0].identityProvenance, 'provider-message-id');
});

test('chatgpt-controller: bounded raw windows expose hashed live text without returning it', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    turnLiveText: ({ position }) => position === 12 ? 'turn-12' : `turn-${position} presentation`
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  const turns = result.windows.flatMap((window) => window.turns);
  const same = turns.find((candidate) => candidate.messageId === 'message-12');
  const different = turns.find((candidate) => candidate.messageId === 'message-13');
  assert.ok(same);
  assert.ok(different);
  assert.equal(same.text, 'turn-12');
  assert.deepEqual(same.textObservation, {
    liveInnerTextLength: 'turn-12'.length,
    liveInnerTextSha256: crypto.createHash('sha256').update('turn-12', 'utf8').digest('hex'),
    canonicalMatchesLiveInnerText: true
  });
  assert.equal(different.text, 'turn-13');
  assert.deepEqual(different.textObservation, {
    liveInnerTextLength: 'turn-13 presentation'.length,
    liveInnerTextSha256: crypto.createHash('sha256').update('turn-13 presentation', 'utf8').digest('hex'),
    canonicalMatchesLiveInnerText: false
  });
  assert.equal(Object.hasOwn(different, 'liveInnerText'), false);
  assert.equal(JSON.stringify(different).includes('turn-13 presentation'), false);
});

test('chatgpt-controller: bounded raw windows retain conflicting durable observations without merging them', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2], [2, 3, 4], [4, 5, 6]],
    turnText: ({ position, windowIndex }) => position === 2 ? `turn-2-variant-${windowIndex}` : `turn-${position}`
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 10,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.reason, null);
  const variants = result.windows.flatMap((window) => window.turns)
    .filter((turn) => turn.messageId === 'message-2')
    .map((turn) => turn.text);
  assert.deepEqual(new Set(variants), new Set(['turn-2-variant-0', 'turn-2-variant-1']));
  assert.equal(result.history.diagnostics.mergeAmbiguous, undefined);
});

test('chatgpt-controller: bounded raw windows retain acquired windows at the iteration boundary', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 4 });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 20_000,
    historyMaxIterations: 1
  });
  assert.equal(result.history.reason, 'history-iteration-limit');
  assert.equal(result.history.stopReason, 'history-iteration-limit');
  assert.equal(result.history.tailProven, true);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.scrollRestored, true);
  assert.ok(result.windows.length > 0);
  assert.equal(Object.hasOwn(result.history, 'fullHistoryComplete'), false);
});

test('chatgpt-controller: bounded raw windows fail closed on conversation changes', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, changeUrlOnWheel: true });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.reason, 'conversation-changed');
  assert.equal(result.history.urlStable, false);
  assert.deepEqual(result.windows, []);
});

test('chatgpt-controller: bounded raw windows fail closed when the tail cannot be proven', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, nativeWheel: false });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 5000,
    historyMaxIterations: 4
  });
  assert.equal(result.history.reason, 'history-native-scroll-unproven');
  assert.equal(result.history.tailProven, false);
  assert.deepEqual(result.windows, []);
});

test('chatgpt-controller: bounded raw windows fail closed when scroll restoration fails', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 4, restorePlan: () => ({ scrollTop: 0 }) });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.reason, 'scroll-restore-failed');
  assert.equal(result.history.scrollRestored, false);
  assert.deepEqual(result.windows, []);
});

test('chatgpt-controller: bounded raw windows fail closed when browser window restore fails', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    backend: 'chrome-cdp',
    initialBrowserWindowState: 'minimized',
    windowRestoreSucceeds: false
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.windowRestored, false);
  assert.equal(result.history.diagnostics.windowLifecycle.restoreVerified, false);
  assert.equal(result.history.reason, 'history-window-restore-failed');
  assert.deepEqual(result.windows, []);
});

test('chatgpt-controller: bounded stop plus browser window restore failure never returns raw windows', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 4,
    backend: 'chrome-cdp',
    initialBrowserWindowState: 'minimized',
    windowRestoreSucceeds: false
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyTimeoutMs: 20_000,
    historyMaxIterations: 1
  });
  assert.equal(result.history.reason, 'history-iteration-limit');
  assert.equal(result.history.stopReason, 'history-iteration-limit');
  assert.equal(result.history.windowRestored, false);
  assert.equal(result.history.diagnostics.windowLifecycle.restoreVerified, false);
  assert.deepEqual(result.windows, []);
});

test('chatgpt-controller: complete history requires a full-history fixed point', () => {
  const identical = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(28),
    completeTraversalFixture(28)
  ], { maxTurns: 50 });
  assert.equal(identical.complete, true);
  assert.equal(identical.result.diagnostics.completeVerification.passCount, 2);

  const verification = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(10),
    completeTraversalFixture(28),
    completeTraversalFixture(28)
  ], { maxTurns: 50 });
  assert.equal(verification.complete, true);
  assert.equal(verification.reason, null);
  assert.equal(verification.result.mergedTurns.length, 28);
  assert.equal(verification.result.diagnostics.completeVerification.passCount, 3);
  assert.equal(verification.result.diagnostics.completeVerification.mismatchCount, 1);
  assert.equal(verification.result.diagnostics.completeVerification.stabilized, true);
  assert.notEqual(
    verification.result.diagnostics.completeVerification.signatures[0],
    verification.result.diagnostics.completeVerification.signatures[1]
  );

  const productionRegression = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(10),
    completeTraversalFixture(20),
    completeTraversalFixture(25),
    completeTraversalFixture(28),
    completeTraversalFixture(28)
  ], { maxTurns: 50 });
  assert.equal(productionRegression.complete, true);
  assert.equal(productionRegression.result.diagnostics.completeVerification.passCount, 5);
  assert.equal(productionRegression.result.diagnostics.completeVerification.mismatchCount, 3);
  assert.equal(productionRegression.result.mergedTurns.length, 28);

  const sevenPassStable = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(10),
    completeTraversalFixture(11),
    completeTraversalFixture(12),
    completeTraversalFixture(13),
    completeTraversalFixture(14),
    completeTraversalFixture(15),
    completeTraversalFixture(15)
  ], { maxTurns: 50 });
  assert.equal(sevenPassStable.complete, true);
  assert.equal(sevenPassStable.result.diagnostics.completeVerification.passCount, 7);
  assert.equal(sevenPassStable.result.diagnostics.completeVerification.mismatchCount, 5);
});

test('chatgpt-controller: long fixed-point passes share the explicit operation deadline', async () => {
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  const createDelayedHarness = () => createNativeWheelHistoryPage({
    initialWindow: 2,
    onTraversalRead: ({ windowIndex }) => {
      if (windowIndex === 0) clock += 70_000;
    },
  });
  try {
    const oldBudget = await createController(createDelayedHarness().page).readConversationTurns({
      maxTurns: 50,
      maxCharsPerTurn: 1000,
      maxTotalChars: 5000,
      historyMode: 'complete',
      historyTimeoutMs: 60_000,
      historyMaxIterations: 240,
    });
    assert.equal(oldBudget.history.complete, false);
    assert.equal(oldBudget.history.diagnostics.completeVerification.passCount, 1);
    assert.equal(oldBudget.history.diagnostics.completeVerification.budgetExhausted, true);

    const extendedBudget = await createController(createDelayedHarness().page).readConversationTurns({
      maxTurns: 50,
      maxCharsPerTurn: 1000,
      maxTotalChars: 5000,
      historyMode: 'complete',
      historyTimeoutMs: 180_000,
      historyMaxIterations: 240,
    });
    assert.equal(extendedBudget.history.complete, true);
    assert.equal(extendedBudget.history.diagnostics.completeVerification.passCount, 2);
    assert.equal(extendedBudget.history.diagnostics.completeVerification.requiredConsecutiveStablePasses, 2);
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: fixed-point diagnostics retain only recent signatures while counting every pass', () => {
  const traversals = Array.from({ length: 10 }, (_, index) => completeTraversalFixture(index + 10));
  const verification = verifyCompleteHistoryFixedPoint(traversals, { maxTurns: 50 });
  assert.equal(verification.complete, false);
  assert.equal(verification.reason, 'history-fixed-point-unproven');
  assert.equal(verification.result.diagnostics.completeVerification.passCount, 10);
  assert.equal(verification.result.diagnostics.completeVerification.mismatchCount, 9);
  assert.equal(verification.result.diagnostics.completeVerification.signatures.length, 8);
  assert.equal(verification.result.diagnostics.completeVerification.passSummaries.length, 8);
  assert.equal(verification.result.diagnostics.completeVerification.passDiffs.length, 8);
});

test('chatgpt-controller: complete-history pass diagnostics classify component changes without raw data', () => {
  const identical = verifyCompleteHistoryFixedPoint([
    completeDiagnosticTraversalFixture({}),
    completeDiagnosticTraversalFixture({})
  ], { maxTurns: 50 });
  const identicalDiagnostics = identical.result.diagnostics.completeVerification;
  assert.equal(identical.complete, true);
  assert.equal(identicalDiagnostics.passSummaries.length, 2);
  assert.equal(identicalDiagnostics.passDiffs[0].sameIdTextSignature, true);
  assert.equal(identicalDiagnostics.passDiffs[0].sameIdPositionSignature, true);
  assert.equal(identicalDiagnostics.passDiffs[0].sameIdentityOrder, true);
  assert.equal(identicalDiagnostics.passDiffs[0].positionOnlyDifferenceCount, 0);
  assert.equal(identicalDiagnostics.passDiffs[0].textOnlyDifferenceCount, 0);

  const positionOnly = verifyCompleteHistoryFixedPoint([
    completeDiagnosticTraversalFixture({}),
    completeDiagnosticTraversalFixture({ positionOffset: 10 })
  ], { maxTurns: 50 });
  const positionDiff = positionOnly.result.diagnostics.completeVerification.passDiffs[0];
  const positionFrom = positionOnly.result.diagnostics.completeVerification.passSummaries[0];
  const positionTo = positionOnly.result.diagnostics.completeVerification.passSummaries[1];
  assert.notEqual(positionFrom.fullSignature, positionTo.fullSignature);
  assert.equal(positionDiff.sameIdTextSignature, true);
  assert.equal(positionDiff.sameIdPositionSignature, false);
  assert.equal(positionDiff.sameTextSequenceSignature, true);
  assert.equal(positionDiff.positionOnlyDifferenceCount, 4);
  assert.equal(positionDiff.textOnlyDifferenceCount, 0);

  const textOnly = verifyCompleteHistoryFixedPoint([
    completeDiagnosticTraversalFixture({}),
    completeDiagnosticTraversalFixture({ textChangeAt: 2 }),
    completeDiagnosticTraversalFixture({ textChangeAt: 2 })
  ], { maxTurns: 50 });
  const textDiff = textOnly.result.diagnostics.completeVerification.passDiffs[0];
  assert.equal(textDiff.sameIdPositionSignature, true);
  assert.equal(textDiff.sameIdTextSignature, false);
  assert.equal(textDiff.samePositionSequenceSignature, true);
  assert.equal(textDiff.textOnlyDifferenceCount, 1);

  const identityOrder = verifyCompleteHistoryFixedPoint([
    completeDiagnosticTraversalFixture({}),
    completeDiagnosticTraversalFixture({ reverse: true }),
    completeDiagnosticTraversalFixture({ reverse: true })
  ], { maxTurns: 50 });
  const identityDiff = identityOrder.result.diagnostics.completeVerification.passDiffs[0];
  assert.equal(identityDiff.sameIdentitySet, true);
  assert.equal(identityDiff.sameIdentityOrder, false);
  assert.equal(identityDiff.sameIdTextSignature, false);

  const addedRemoved = verifyCompleteHistoryFixedPoint([
    completeDiagnosticTraversalFixture({ count: 3 }),
    completeDiagnosticTraversalFixture({ count: 4 }),
    completeDiagnosticTraversalFixture({ count: 4 })
  ], { maxTurns: 50 });
  const addedDiff = addedRemoved.result.diagnostics.completeVerification.passDiffs[0];
  assert.equal(addedDiff.addedIdentityCount, 1);
  assert.equal(addedDiff.removedIdentityCount, 0);

  const fallback = verifyCompleteHistoryFixedPoint([
    completeDiagnosticTraversalFixture({ identityMode: 'fallback' }),
    completeDiagnosticTraversalFixture({ identityMode: 'fallback' })
  ], { maxTurns: 50 });
  const fallbackDiagnostics = fallback.result.diagnostics.completeVerification;
  assert.equal(fallbackDiagnostics.passSummaries[0].messageIdCount, 0);
  assert.equal(fallbackDiagnostics.passSummaries[0].turnIdOnlyCount, 0);
  assert.equal(fallbackDiagnostics.passSummaries[0].fallbackIdentityCount, 4);
  const serializedDiagnostics = JSON.stringify(fallbackDiagnostics);
  assert.equal(serializedDiagnostics.includes('private-turn-'), false);
  assert.equal(serializedDiagnostics.includes('private-message-'), false);
  assert.equal(serializedDiagnostics.includes('private-turn-id-'), false);
});

test('chatgpt-controller: complete-history preserves valid diagnostics before an invalid pass', () => {
  const validA = completeDiagnosticTraversalFixture({});
  const validB = completeDiagnosticTraversalFixture({ positionOffset: 10, textChangeAt: 2 });
  const invalidTimeout = completeDiagnosticTraversalFixture({});
  invalidTimeout.reason = 'timeout';
  const timeoutResult = verifyCompleteHistoryFixedPoint([validA, validB, invalidTimeout], { maxTurns: 50 });
  const timeoutDiagnostics = timeoutResult.result.diagnostics.completeVerification;
  assert.equal(timeoutResult.complete, false);
  assert.equal(timeoutResult.reason, 'timeout');
  assert.equal(timeoutDiagnostics.passCount, 3);
  assert.equal(timeoutDiagnostics.passSummaries.length, 2);
  assert.equal(timeoutDiagnostics.passDiffs.length, 1);
  assert.equal(timeoutDiagnostics.passDiffs[0].positionOnlyDifferenceCount, 3);
  assert.equal(timeoutDiagnostics.passDiffs[0].positionAndTextDifferenceCount, 1);
  assert.equal(JSON.stringify(timeoutDiagnostics).includes('private-turn-'), false);
  assert.equal(JSON.stringify(timeoutDiagnostics).includes('private-message-'), false);

  const ambiguous = completeDiagnosticTraversalFixture({});
  ambiguous.snapshots = [[
    { role: 'user', text: 'private-ambiguous', messageId: 'private-duplicate' },
    { role: 'user', text: 'private-ambiguous', messageId: 'private-duplicate' }
  ]];
  const ambiguousResult = verifyCompleteHistoryFixedPoint([validA, validB, ambiguous], { maxTurns: 50 });
  const ambiguousDiagnostics = ambiguousResult.result.diagnostics.completeVerification;
  assert.equal(ambiguousResult.complete, false);
  assert.equal(ambiguousResult.reason, 'merge-ambiguous');
  assert.equal(ambiguousDiagnostics.passCount, 3);
  assert.equal(ambiguousDiagnostics.passSummaries.length, 2);
  assert.equal(ambiguousDiagnostics.passDiffs.length, 1);

  const gap = completeDiagnosticTraversalFixture({});
  gap.snapshots = [
    validA.snapshots[0],
    [{ role: 'user', text: 'private-gap', messageId: 'private-gap' }]
  ];
  const gapResult = verifyCompleteHistoryFixedPoint([validA, gap], { maxTurns: 50 });
  const gapDiagnostics = gapResult.result.diagnostics.completeVerification;
  assert.equal(gapResult.complete, false);
  assert.equal(gapResult.reason, 'history-gap');
  assert.equal(gapDiagnostics.passCount, 2);
  assert.equal(gapDiagnostics.passSummaries.length, 1);
  assert.equal(gapDiagnostics.passDiffs.length, 0);

  const invalidFirst = verifyCompleteHistoryFixedPoint([invalidTimeout], { maxTurns: 50 });
  const invalidFirstDiagnostics = invalidFirst.result.diagnostics.completeVerification;
  assert.equal(invalidFirst.complete, false);
  assert.equal(invalidFirst.reason, 'timeout');
  assert.equal(invalidFirstDiagnostics.passCount, 1);
  assert.equal(invalidFirstDiagnostics.passSummaries.length, 0);
  assert.equal(invalidFirstDiagnostics.passDiffs.length, 0);
});

test('chatgpt-controller: complete history does not stabilize changing full-history signatures', () => {
  const textChanged = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(28),
    completeTraversalFixture(28, { textChangeAt: 10 }),
    completeTraversalFixture(28)
  ], { maxTurns: 50 });
  assert.equal(textChanged.complete, false);
  assert.equal(textChanged.reason, 'history-fixed-point-unproven');

  const orderChanged = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(28),
    completeTraversalFixture(28, { reverse: true }),
    completeTraversalFixture(28)
  ], { maxTurns: 50 });
  assert.equal(orderChanged.complete, false);
  assert.equal(orderChanged.reason, 'history-fixed-point-unproven');
});

test('chatgpt-controller: complete history preserves traversal safety failures during verification', () => {
  const ambiguous = completeTraversalFixture(28, {
    snapshots: [[
      { role: 'user', text: 'same', messageId: 'duplicate' },
      { role: 'user', text: 'same', messageId: 'duplicate' }
    ]]
  });
  const ambiguousResult = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(28),
    ambiguous
  ], { maxTurns: 50 });
  assert.equal(ambiguousResult.complete, false);
  assert.equal(ambiguousResult.reason, 'merge-ambiguous');

  const gapResult = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(28),
    completeTraversalFixture(1, {
      snapshots: [
        completeTraversalFixture(28).snapshots[0],
        [{ role: 'user', text: 'unrelated', messageId: 'unrelated' }]
      ]
    })
  ], { maxTurns: 50 });
  assert.equal(gapResult.complete, false);
  assert.equal(gapResult.reason, 'history-gap');
});

test('chatgpt-controller: complete history fails closed when fixed-point budget is exhausted', () => {
  const verification = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(10),
    completeTraversalFixture(28)
  ], { maxTurns: 50 });
  assert.equal(verification.complete, false);
  assert.equal(verification.reason, 'history-fixed-point-unproven');
  assert.equal(verification.result.diagnostics.completeVerification.stabilized, false);

  const moving = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(10),
    completeTraversalFixture(28),
    completeTraversalFixture(35)
  ], { maxTurns: 50 });
  assert.equal(moving.complete, false);
  assert.equal(moving.reason, 'history-fixed-point-unproven');

  const startFailure = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(28),
    { ...completeTraversalFixture(28), startReached: false, startPositionProof: false }
  ], { maxTurns: 50 });
  assert.equal(startFailure.reason, 'history-start-unproven');

  const tailFailure = verifyCompleteHistoryFixedPoint([
    completeTraversalFixture(28),
    { ...completeTraversalFixture(28), tailProven: false }
  ], { maxTurns: 50 });
  assert.equal(tailFailure.reason, 'history-tail-unproven');
});

test('chatgpt-controller: Chrome complete history uses mouseWheel and never uses scrollGesture', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, backend: 'chrome-cdp', scrollGesture: true, scrollGestureSource: 'touch' });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.diagnostics.scrollInputMethod, 'chrome-cdp-mouse-wheel');
  assert.equal(result.history.diagnostics.gestureAttemptsDown, 0);
  assert.equal(result.history.diagnostics.gestureAttemptsUp, 0);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(result.history.diagnostics.tailEntry.mode, 'direct-bottom');
  assert.equal(result.history.diagnostics.windowLifecycle.normalizationApplied, true);
  assert.equal(result.history.diagnostics.windowLifecycle.normalizedWindowState, 'normal');
  assert.equal(result.history.diagnostics.windowLifecycle.normalizedVisibilityState, 'visible');
  assert.equal(result.history.diagnostics.windowLifecycle.normalizedHasFocus, true);
  assert.equal(result.history.diagnostics.windowLifecycle.restoreVerified, true);
  assert.equal(result.history.diagnostics.windowLifecycle.restoredWindowState, 'minimized');
  assert.ok(harness.events.some((event) => event.startsWith('mouse-wheel:')));
  assert.equal(harness.events.some((event) => event.startsWith('scroll-gesture:')), false);
  assert.equal(harness.events[0], 'window-state:normal');
  assert.ok(harness.events.indexOf('conversation-scroll-restore') < harness.events.lastIndexOf('window-state:minimized'));
  assert.equal(harness.events.at(-1), 'window-state:minimized');
  assert.equal(harness.getWheelCount() > 0, true);
});

test('chatgpt-controller: an already-bottom Chrome baseline uses read-only direct tail proof', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 4, backend: 'chrome-cdp', scrollGesture: true, scrollGestureSource: 'touch' });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.diagnostics.tailEntry.mode, 'direct-bottom');
  assert.equal(result.history.diagnostics.tailEntry.directVerified, true);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(result.history.diagnostics.gestureAttemptsDown, 0);
});

test('chatgpt-controller: reverse vertical scroller treats raw zero as tail and negative scroll as older history', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 4,
    backend: 'chrome-cdp',
    positionHints: false,
    currentDom: true,
    reverseScroll: true,
    virtualizerTopOffsetPx: 6_400,
    virtualizerTopOffsetPlan: ({ windowIndex }) => windowIndex * 1_600
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, true, JSON.stringify(result.history));
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.layoutSettle.final.verticalScrollMode, 'reverse');
  assert.equal(result.history.diagnostics.tailEntry.mode, 'direct-bottom');
  assert.equal(result.history.diagnostics.tailEntry.alreadyAtBottom, true);
  assert.equal(result.history.diagnostics.tailEntry.directVerified, true);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.ok(result.history.diagnostics.wheelUpAttempts > 0);
  assert.equal(result.history.diagnostics.startProofMode, 'virtualized-origin');
  assert.equal(result.history.diagnostics.progress.tailProven, true);
  assert.equal(result.history.diagnostics.progress.startProven, true);
  assert.equal(result.history.diagnostics.conversationRestore.verified, true);
  assert.equal(result.history.diagnostics.conversationRestore.initialDistanceFromBottom, 0);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
});

test('chatgpt-controller: top proof bounds physical-only jitter without treating it as older progress', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 4,
    mouseWheelPlan: ({ attempt, deltaY }) => {
      const passAttempt = ((attempt - 1) % 80) + 1;
      if (deltaY > 0) return { windowIndex: 4, scrollTop: null };
      if (passAttempt === 80) return { windowIndex: 0, scrollTop: 0 };
      if (passAttempt === 79) return { windowIndex: 1, scrollTop: 250 };
      if (passAttempt === 78) return { windowIndex: 2, scrollTop: 500 };
      return { windowIndex: 3, scrollTop: Math.max(10, 800 - passAttempt * 10) };
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 30_000,
    historyMaxIterations: 80
  });
  const diagnostics = result.history.diagnostics;
  assert.ok(harness.getWheelCount() < 160);
  assert.equal(typeof diagnostics.iterationLimitReached, 'boolean');
  assert.equal(typeof diagnostics.iterationLimitReachedAtTop, 'boolean');
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.complete, false);
  assert.notEqual(result.history.reason, 'timeout');
  assert.ok(harness.events.some((event) => event.startsWith('mouse-wheel:')));
});

test('chatgpt-controller: Chrome complete history does not fall back to scrollGesture when mouseWheel fails', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, backend: 'chrome-cdp', scrollGesture: true, scrollGestureSource: 'touch' });
  harness.page.mouseWheel = async () => {
    const error = new Error('chrome_cdp_command_timeout');
    error.data = { backendMessage: 'chrome_cdp_command_timeout' };
    throw error;
  };
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 5000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-native-wheel-failed');
  assert.equal(result.history.diagnostics.nativeInput.failurePhase, 'mouse-wheel');
  assert.equal(result.history.diagnostics.nativeInput.backendErrorMessage, 'chrome_cdp_command_timeout');
  assert.equal(harness.events.some((event) => event.startsWith('scroll-gesture:')), false);
});

test('chatgpt-controller: Chrome proof keeps the same direction across physical-only progress', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 4,
    backend: 'chrome-cdp',
    scrollGesture: true,
    mouseWheelPlan: ({ attempt }) => ((attempt - 1) % 2) + 1 === 1
      ? { scrollTop: 900 }
      : ((attempt - 1) % 2) + 1 === 2
        ? { windowIndex: 3, scrollTop: 650 }
        : null
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  const wheels = harness.events.filter((event) => event.startsWith('mouse-wheel:'));
  assert.equal(result.history.diagnostics.nativeScrollControlProven, true);
  assert.equal(result.history.diagnostics.firstNativeUp.physicalChanged, true);
  assert.equal(typeof result.history.diagnostics.firstNativeUp.changed, 'boolean');
  assert.equal(result.history.diagnostics.firstNativeUp.range.min, 20);
  assert.equal(result.history.diagnostics.wheelUpAttempts >= 2, true);
  assert.ok(result.history.diagnostics.reads.lightweightReadCount > 0);
  assert.ok(result.history.diagnostics.reads.fullReadCount > 0);
  assert.equal(wheels[0].endsWith(':0:-720'), true);
  assert.equal(wheels[1].endsWith(':0:-720'), true);
});

test('chatgpt-controller: Chrome complete history accepts visible unfocused windows and dispatches targeted wheels', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, backend: 'chrome-cdp', initialBrowserWindowState: 'normal', initialDocumentHasFocus: false });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.diagnostics.windowLifecycle.normalizationApplied, false);
  assert.equal(result.history.diagnostics.windowLifecycle.restoreAttempts, 0);
  assert.equal(harness.events.some((event) => event.startsWith('window-state:')), false);
  assert.equal(result.history.diagnostics.windowLifecycle.originalHasFocus, false);
  assert.equal(harness.events.some((event) => event.startsWith('mouse-wheel:')), true);
});

test('chatgpt-controller: complete history remains fail-closed for hidden, closed, and runtime-hidden Chrome pages', async () => {
  const hidden = createNativeWheelHistoryPage({
    backend: 'chrome-cdp',
    initialBrowserWindowState: 'normal',
    initialDocumentHasFocus: false,
    initialVisibilityState: 'hidden',
    initialDocumentHidden: true
  });
  const hiddenResult = await createController(hidden.page).readConversationTurns({ historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(hiddenResult.history.complete, false);
  assert.equal(hiddenResult.history.reason, 'history-native-window-not-ready');
  assert.equal(hidden.getWheelCount(), 0);

  const closed = createNativeWheelHistoryPage({ backend: 'chrome-cdp', initialBrowserWindowState: 'normal', initialPageClosed: true });
  const closedResult = await createController(closed.page).readConversationTurns({ historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(closedResult.history.complete, false);
  assert.equal(closedResult.history.reason, 'history-native-window-not-ready');
  assert.equal(closed.getWheelCount(), 0);

  const runtimeHidden = createNativeWheelHistoryPage({
    backend: 'chrome-cdp',
    initialBrowserWindowState: 'normal',
    initialDocumentHasFocus: false,
    nativeDiagnosticsPlan: ({ count }) => count >= 2 ? { documentVisibilityState: 'hidden', documentHidden: true } : null
  });
  const runtimeResult = await createController(runtimeHidden.page).readConversationTurns({ historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(runtimeResult.history.complete, false);
  assert.equal(runtimeResult.history.reason, 'history-native-window-not-ready');
  assert.equal(runtimeHidden.getWheelCount(), 0);
});

test('chatgpt-controller: complete history keeps a 60 second default and allows a bounded explicit budget', () => {
  assert.equal(DEFAULT_CONVERSATION_HISTORY_TIMEOUT_MS, 60_000);
  assert.equal(MAX_CONVERSATION_HISTORY_TIMEOUT_MS, 180_000);
  assert.equal(DEFAULT_CONVERSATION_HISTORY_ITERATIONS, 240);
});

test('chatgpt-controller: complete history remains fail-closed when the expanded iteration budget cannot prove the start', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 249, windowCount: 250 });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 60_000,
    historyMaxIterations: 240
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-iteration-limit');
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.diagnostics.iterationLimitReached, true);
  assert.equal(result.history.diagnostics.iterationLimitReachedAtTop, false);
  assert.equal(result.history.diagnostics.historyIterationLimit, 240);
});

test('chatgpt-controller: semantic tail signature ignores remounted identities and position hints', () => {
  const baseline = conversationSemanticTailSignature([
    { role: 'assistant', messageId: 'old-a', turnId: 'old-t-a', positionHint: 58, text: ' first answer \n' },
    { role: 'user', messageId: 'old-u', turnId: 'old-t-u', positionHint: 59, text: 'follow-up' },
    { role: 'assistant', messageId: 'old-a2', turnId: 'old-t-a2', positionHint: 60, text: 'final response' },
    { role: 'user', messageId: 'old-u2', turnId: 'old-t-u2', positionHint: 64, text: 'one more question' },
    { role: 'assistant', messageId: 'old-a3', turnId: 'old-t-a3', positionHint: 70, text: 'one more answer' }
  ]);
  const remounted = conversationSemanticTailSignature([
    { role: 'assistant', messageId: 'new-a', turnId: 'new-t-a', positionHint: 101, text: 'first answer' },
    { role: 'user', messageId: 'new-u', turnId: 'new-t-u', positionHint: 105, text: 'follow-up' },
    { role: 'assistant', messageId: 'new-a2', turnId: 'new-t-a2', positionHint: 109, text: 'final response' },
    { role: 'user', messageId: 'new-u2', turnId: 'new-t-u2', positionHint: 114, text: 'one more question' },
    { role: 'assistant', messageId: 'new-a3', turnId: 'new-t-a3', positionHint: 120, text: 'one more answer' }
  ]);
  assert.equal(remounted, baseline);
  assert.equal(conversationSemanticTailSignature([
    { role: 'assistant', positionHint: 1, text: 'first answer' },
    { role: 'user', positionHint: 2, text: 'follow-up' },
    { role: 'assistant', positionHint: 3, text: 'final response' },
    { role: 'user', positionHint: 4, text: 'one more question' },
    { role: 'assistant', positionHint: 5, text: 'one more answer' }
  ]), baseline);
  assert.notEqual(conversationSemanticTailSignature([
    { role: 'assistant', positionHint: 58, text: 'first answer' },
    { role: 'user', positionHint: 59, text: 'follow-up' },
    { role: 'user', positionHint: 60, text: 'final response' },
    { role: 'user', positionHint: 64, text: 'one more question' },
    { role: 'assistant', positionHint: 70, text: 'one more answer' }
  ]), baseline);
  assert.notEqual(conversationSemanticTailSignature([
    { role: 'assistant', positionHint: 58, text: 'changed answer' },
    { role: 'user', positionHint: 59, text: 'follow-up' },
    { role: 'assistant', positionHint: 60, text: 'final response' },
    { role: 'user', positionHint: 64, text: 'one more question' },
    { role: 'assistant', positionHint: 70, text: 'one more answer' }
  ]), baseline);
  assert.notEqual(conversationSemanticTailSignature([
    { role: 'assistant', positionHint: 58, text: 'first answer' },
    { role: 'user', positionHint: 59, text: 'follow-up' },
    { role: 'assistant', positionHint: 60, text: 'final response' },
    { role: 'user', positionHint: 64, text: 'one more question' }
  ]), baseline);
  assert.notEqual(conversationSemanticTailSignature([
    { role: 'assistant', positionHint: 58, text: 'first answer' },
    { role: 'user', positionHint: 59, text: 'follow-up' },
    { role: 'user', positionHint: 60, text: 'final response' },
    { role: 'assistant', positionHint: 64, text: 'one more question' },
    { role: 'assistant', positionHint: 70, text: 'one more answer' }
  ]), baseline);
});

test('chatgpt-controller: anchored restore identity is semantic and ignores remounted DOM identities', () => {
  const baseline = conversationSemanticAnchorSignature([
    { role: 'user', messageId: 'old-1', turnId: 'old-t1', positionHint: 10, text: 'first' },
    { role: 'assistant', messageId: 'old-2', turnId: 'old-t2', positionHint: 11, text: 'answer' },
    { role: 'user', messageId: 'old-3', turnId: 'old-t3', positionHint: 12, text: 'follow-up' },
    { role: 'assistant', messageId: 'old-4', turnId: 'old-t4', positionHint: 13, text: 'closing' }
  ]);
  const remounted = conversationSemanticAnchorSignature([
    { role: 'user', messageId: 'new-1', turnId: 'new-t1', positionHint: 101, text: 'first' },
    { role: 'assistant', messageId: 'new-2', turnId: 'new-t2', positionHint: 103, text: 'answer' },
    { role: 'user', messageId: 'new-3', turnId: 'new-t3', positionHint: 109, text: 'follow-up' },
    { role: 'assistant', messageId: 'new-4', turnId: 'new-t4', positionHint: 114, text: 'closing' }
  ]);
  assert.equal(remounted, baseline);
  assert.notEqual(conversationSemanticAnchorSignature([
    { role: 'user', text: 'first' },
    { role: 'assistant', text: 'answer' },
    { role: 'assistant', text: 'follow-up' },
    { role: 'assistant', text: 'closing' }
  ]), baseline);
});

test('chatgpt-controller: history budget starts after the normalized baseline', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, backend: 'chrome-cdp' });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 5000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.diagnostics.historyStartedAfterNormalizedBaseline, true);
  assert.equal(result.history.diagnostics.historyBudgetMs, 5000);
  assert.equal(result.history.diagnostics.historyIterationLimit, 30);
});

test('chatgpt-controller: complete history uses the settled normalized baseline after a transient layout', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    backend: 'chrome-cdp',
    layoutSnapshots: [
      { range: { min: 6, max: 10 }, scroller: { scrollTop: 0, scrollHeight: 7_212, clientHeight: 763, atTop: true, atBottom: false } },
      { range: { min: 6, max: 10 }, scroller: { scrollTop: 6_449, scrollHeight: 7_212, clientHeight: 763, atTop: false, atBottom: true } },
      { range: { min: 6, max: 10 }, scroller: { scrollTop: 6_449, scrollHeight: 7_212, clientHeight: 763, atTop: false, atBottom: true } },
      { range: { min: 6, max: 10 }, scroller: { scrollTop: 6_449, scrollHeight: 7_212, clientHeight: 763, atTop: false, atBottom: true } }
    ]
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  const diagnostics = result.history.diagnostics;
  assert.equal(result.history.complete, true);
  assert.equal(diagnostics.layoutSettle.verified, true);
  assert.ok([0, 1_000, 6_449].includes(diagnostics.layoutSettle.first.scrollTop));
  assert.ok([1_000, 6_449].includes(diagnostics.layoutSettle.final.scrollTop));
  assert.equal(diagnostics.historyStartedAfterNormalizedBaseline, true);
  assert.equal(diagnostics.wheelUpAttempts > 0, true);
  assert.equal(harness.getWheelCount() > 0, true);
  assert.equal(diagnostics.conversationRestore.mode, 'bottom');
  assert.equal(diagnostics.conversationRestore.bottomMatched, true);
  assert.equal(diagnostics.conversationRestore.signatureMatched, null);
});

test('chatgpt-controller: conversation restore converges after a transient signature mismatch', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    backend: 'chrome-cdp',
    restorePlan: ({ attempt }) => attempt === 1 ? { windowIndex: 3 } : null
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.scrollRestored, true);
  assert.equal(result.history.diagnostics.conversationRestore.mode, 'anchored-window');
  assert.ok(result.history.diagnostics.conversationRestore.attempts >= 2);
  assert.equal(result.history.diagnostics.conversationRestore.verified, true);
  assert.equal(result.history.diagnostics.conversationRestore.initialDistanceFromBottom, 500);
  assert.equal(result.history.diagnostics.conversationRestore.finalDistanceFromBottom, 500);
  assert.equal(result.history.diagnostics.conversationRestore.distanceMatched, true);
  assert.equal(result.history.diagnostics.conversationRestore.signatureMatched, null);
  assert.equal(result.history.diagnostics.conversationRestore.lastFailureReason, null);
  assert.ok(harness.getRestoreCount() >= 3);
});

test('chatgpt-controller: conversation restore recalculates against changed scroll geometry', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    backend: 'chrome-cdp',
    restorePlan: ({ attempt }) => attempt === 1 ? { windowIndex: 3, scrollHeight: 1600 } : null
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.scrollRestored, true);
  assert.ok(result.history.diagnostics.conversationRestore.attempts >= 2);
  assert.equal(result.history.diagnostics.conversationRestore.distanceMatched, true);
  assert.equal(result.history.diagnostics.conversationRestore.signatureMatched, null);
  assert.equal(result.history.diagnostics.conversationRestore.finalDistanceFromBottom, 500);
});

test('chatgpt-controller: anchored restore waits for loading to finish', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    backend: 'chrome-cdp',
    restorePlan: ({ attempt }) => ((attempt - 1) % 3) + 1 === 1
      ? { windowIndex: 4, loading: false }
      : ((attempt - 1) % 3) + 1 === 2
        ? { windowIndex: 2, loading: true }
        : { windowIndex: 2, loading: false }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  const restore = result.history.diagnostics.conversationRestore;
  assert.equal(result.history.complete, true);
  assert.equal(restore.attempts, 3);
  assert.equal(restore.verified, true);
  assert.equal(restore.anchorLoadingMatched, true);
});

test('chatgpt-controller: anchored restore fails closed while loading never finishes', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    backend: 'chrome-cdp',
    restorePlan: ({ attempt }) => attempt === 1
      ? { windowIndex: 4, loading: false }
      : { windowIndex: 2, loading: true }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 5000,
    historyMaxIterations: 30
  });
  const restore = result.history.diagnostics.conversationRestore;
  assert.equal(result.history.complete, false);
  assert.equal(result.history.scrollRestored, false);
  assert.equal(restore.verified, false);
  assert.equal(restore.attempts, 4);
  assert.equal(restore.anchorLoadingMatched, false);
  assert.equal(restore.lastFailureReason, 'anchor-loading');
});

test('chatgpt-controller: permanent conversation restore mismatch is bounded and fails closed', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    backend: 'chrome-cdp',
    restorePlan: () => ({ windowIndex: 3 })
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 5000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'scroll-restore-failed');
  assert.equal(result.history.scrollRestored, false);
  assert.equal(result.history.diagnostics.conversationRestore.attempts, 4);
  assert.equal(result.history.diagnostics.conversationRestore.verified, false);
  assert.equal(result.history.diagnostics.conversationRestore.lastFailureReason, 'bottom-mismatch');
});

test('chatgpt-controller: primary history timeout is not hidden by restore failure', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    backend: 'chrome-cdp',
    initialBrowserWindowState: 'normal',
    restorePlan: () => ({ windowIndex: 3 })
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 1,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'timeout');
  assert.equal(result.history.scrollRestored, false);
  assert.equal(result.history.diagnostics.conversationRestore.attempts, 4);
  assert.equal(result.history.diagnostics.conversationRestore.lastFailureReason, 'bottom-mismatch');
});

test('chatgpt-controller: Chrome complete history fails closed before wheel when normalized state is not ready', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, backend: 'chrome-cdp', normalizeReady: false });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 5000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-native-window-not-ready');
  assert.equal(harness.events.some((event) => event.startsWith('mouse-wheel:')), false);
  assert.equal(harness.events.at(-1), 'window-state:minimized');
});

test('chatgpt-controller: complete history rejects a limit-exceeded post-wheel snapshot', async () => {
  const harness = createNativeWheelHistoryPage({
    backend: 'chrome-cdp',
    // Three reads establish the stable normalized baseline; three direct-tail reads follow;
    // the next full read is the post-wheel snapshot.
    limitExceededAtRead: 7,
    limitKind: 'per-turn'
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 5000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'conversation_turn_too_large');
  assert.equal(harness.getWheelCount(), 1);
  assert.equal(result.history.diagnostics.windowLifecycle.restoreVerified, true);
});

test('chatgpt-controller: successful scrollGesture without a DOM transition remains incomplete', async () => {
  const harness = createNativeWheelHistoryPage({ scrollGesture: true, scrollGestureSource: 'touch', windowChanges: false });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000,
    historyMode: 'complete',
    historyTimeoutMs: 5000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-start-unproven');
  assert.equal(result.history.diagnostics.nativeScrollControlProven, false);
});

test('chatgpt-controller: visibility probe normalizes once, performs one older touch gesture, and restores minimized state', async () => {
  const harness = createScrollVisibilityProbePage();
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.preconditionPassed, true);
  assert.equal(result.before.browserWindowState, 'minimized');
  assert.equal(result.before.adapterMinimized, true);
  assert.equal(result.before.documentVisibilityState, 'hidden');
  assert.equal(result.normalized.browserWindowState, 'normal');
  assert.equal(result.normalized.documentVisibilityState, 'visible');
  assert.equal(result.normalizationPhysicalScrollChanged, false);
  assert.equal(result.normalizationConversationWindowChanged, false);
  assert.equal(result.gestureAttempts, 1);
  assert.equal(result.gestureAttempted, true);
  assert.equal(result.gestureSourceType, 'touch');
  assert.equal(result.gestureDirection, 'older/up');
  assert.equal(result.gestureDistance, 280);
  assert.equal(result.gestureSpeed, 1_000);
  assert.equal(result.gestureCommandSucceeded, true);
  assert.deepEqual(result.afterGesture.range, { min: 5, max: 9 });
  assert.equal(result.conversationWindowChanged, true);
  assert.equal(result.restoreAttempts, 1);
  assert.equal(result.restoreVerified, true);
  assert.equal(result.restored.browserWindowState, 'minimized');
  assert.equal(result.restored.documentVisibilityState, 'hidden');
  assert.equal(result.reason, 'probe-success-window-changed');
  assert.equal(harness.events.filter((event) => event.startsWith('scroll-gesture:')).length, 1);
  assert.equal(harness.events.filter((event) => event.startsWith('mouse-wheel:')).length, 0);
});

test('chatgpt-controller: visibility probe does not gesture when normalized document stays hidden', async () => {
  const harness = createScrollVisibilityProbePage({ visibilityAfterNormalize: 'hidden' });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.gestureAttempted, false);
  assert.equal(result.reason, 'probe-normalized-but-hidden');
  assert.equal(result.restoreVerified, true);
  assert.equal(harness.events.filter((event) => event.startsWith('scroll-gesture:')).length, 0);
});

test('chatgpt-controller: visibility probe reports one-gesture no progress and restores', async () => {
  const harness = createScrollVisibilityProbePage({ windowChanges: false });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.gestureAttempted, true);
  assert.equal(result.gestureCommandSucceeded, true);
  assert.equal(result.conversationWindowChanged, false);
  assert.equal(result.gestureAttempts, 4);
  assert.equal(result.steps.length, 4);
  assert.equal(result.physicalScrollChanged, false);
  assert.equal(result.reason, 'probe-window-no-progress');
  assert.equal(result.restoreVerified, true);
  assert.equal(harness.events.filter((event) => event.startsWith('scroll-gesture:')).length, 4);
});

test('chatgpt-controller: visibility probe attributes normalization-only scroll changes separately', async () => {
  const harness = createScrollVisibilityProbePage({ initialScrollTop: 100, normalizedScrollTop: 200, windowChanges: false });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.normalizationPhysicalScrollChanged, true);
  assert.equal(result.steps.every((step) => step.physicalScrollChanged === false), true);
  assert.equal(result.physicalScrollChanged, false);
  assert.equal(result.conversationWindowChanged, false);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: visibility probe attributes normalization-only window changes separately', async () => {
  const harness = createScrollVisibilityProbePage({ normalizedRange: { min: 5, max: 9 }, windowChanges: false });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.normalizationConversationWindowChanged, true);
  assert.equal(result.steps.every((step) => step.conversationWindowChanged === false), true);
  assert.equal(result.conversationWindowChanged, false);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: visibility probe stops after the first eventual window transition', async () => {
  const harness = createScrollVisibilityProbePage({
    windowChanges: false,
    gesturePlan: [
      { scrollTop: 610 },
      { scrollTop: 620 },
      { range: { min: 5, max: 9 }, scrollTop: 630 },
      { range: { min: 4, max: 8 }, scrollTop: 640 }
    ]
  });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.gestureAttempts, 3);
  assert.equal(result.steps.length, 3);
  assert.equal(result.firstWindowChangeAttempt, 3);
  assert.equal(result.conversationWindowChanged, true);
  assert.equal(result.physicalScrollChanged, true);
  assert.equal(result.reason, 'probe-success-window-changed');
  assert.equal(harness.getGestureCount(), 3);
});

test('chatgpt-controller: visibility probe records four physical-only steps without treating them as a window transition', async () => {
  const harness = createScrollVisibilityProbePage({
    windowChanges: false,
    gesturePlan: [
      { scrollTop: 610 },
      { scrollTop: 620 },
      { scrollTop: 630 },
      { scrollTop: 640 }
    ]
  });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.gestureAttempts, 4);
  assert.equal(result.steps.length, 4);
  assert.equal(result.steps.every((step) => step.physicalScrollChanged), true);
  assert.equal(result.physicalScrollChanged, true);
  assert.equal(result.conversationWindowChanged, false);
  assert.equal(result.reason, 'probe-window-no-progress');
});

test('chatgpt-controller: visibility probe stops at the second gesture when the URL changes', async () => {
  const harness = createScrollVisibilityProbePage({ windowChanges: false, changeUrlAtGesture: 2 });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.gestureAttempts, 2);
  assert.equal(harness.getGestureCount(), 2);
  assert.equal(result.reason, 'probe-conversation-changed');
  assert.equal(result.urlStable, false);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: visibility probe does not send the next gesture after visibility is lost', async () => {
  const harness = createScrollVisibilityProbePage({ windowChanges: false, hideAfterGesture: 1 });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.gestureAttempts, 1);
  assert.equal(harness.getGestureCount(), 1);
  assert.equal(result.reason, 'probe-precondition-failed');
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: visibility probe restores after gesture and post-read failures', async () => {
  const gestureFailure = createScrollVisibilityProbePage({ gestureError: new Error('gesture_failed') });
  const failedGesture = await createController(gestureFailure.page).probeScrollVisibility();
  assert.equal(failedGesture.reason, 'probe-gesture-failed');
  assert.equal(failedGesture.gestureAttempted, true);
  assert.equal(failedGesture.restoreVerified, true);

  const postReadFailure = createScrollVisibilityProbePage({ readAfterGestureError: true });
  const failedRead = await createController(postReadFailure.page).probeScrollVisibility();
  assert.equal(failedRead.reason, 'probe-gesture-failed');
  assert.equal(failedRead.gestureCommandSucceeded, true);
  assert.equal(failedRead.restoreVerified, true);
});

test('chatgpt-controller: visibility probe stops on URL change and never sends a second gesture', async () => {
  const harness = createScrollVisibilityProbePage({ changeUrlOnGesture: true });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.reason, 'probe-conversation-changed');
  assert.equal(result.gestureAttempted, true);
  assert.equal(result.restoreVerified, true);
  assert.equal(result.urlStable, false);
  assert.equal(harness.events.filter((event) => event.startsWith('scroll-gesture:')).length, 1);
});

test('chatgpt-controller: visibility probe permits one restore retry only', async () => {
  const retry = createScrollVisibilityProbePage({ restoreFailures: 1 });
  const result = await createController(retry.page).probeScrollVisibility();
  assert.equal(result.restoreAttempts, 2);
  assert.equal(result.restoreVerified, true);

  const permanent = createScrollVisibilityProbePage({ restoreFailures: 5 });
  const failed = await createController(permanent.page).probeScrollVisibility();
  assert.equal(failed.restoreAttempts, 2);
  assert.equal(failed.restoreVerified, false);
  assert.equal(failed.reason, 'probe-restore-failed');
});

test('chatgpt-controller: visibility probe rejects non-minimized preconditions without mutation', async () => {
  const harness = createScrollVisibilityProbePage();
  harness.page.getNativeInputDiagnostics = async () => ({
    backend: 'chrome-cdp',
    pageClosed: false,
    browserWindowState: 'normal',
    adapterMinimized: false,
    documentVisibilityState: 'visible',
    documentHidden: false,
    documentHasFocus: false
  });
  const result = await createController(harness.page).probeScrollVisibility();
  assert.equal(result.preconditionPassed, false);
  assert.equal(result.reason, 'probe-precondition-failed');
  assert.equal(result.gestureAttempted, false);
  assert.equal(harness.getRestoreAttempts(), 0);
  assert.equal(harness.events.filter((event) => event.startsWith('scroll-gesture:')).length, 0);
});

test('chatgpt-controller: mouse-wheel probe uses normalized focused state and reports bounded physical-only progress', async () => {
  const harness = createScrollVisibilityProbePage({
    normalizedHasFocus: true,
    normalizedScrollTop: 6_449,
    mouseWheelEffect: { scrollTop: 5_729 }
  });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.preconditionPassed, true);
  assert.equal(result.readyForMouseWheel, true);
  assert.equal(result.normalizationPhysicalScrollChanged, true);
  assert.equal(result.moveMouseAttempted, true);
  assert.equal(result.moveMouseSucceeded, true);
  assert.equal(result.wheelAttempted, true);
  assert.equal(result.wheelDeltaX, 0);
  assert.equal(result.wheelDeltaY, -720);
  assert.equal(result.wheelCommandSucceeded, true);
  assert.equal(result.afterWheel.scrollTop, 5_729);
  assert.equal(result.physicalScrollChanged, true);
  assert.equal(result.conversationWindowChanged, false);
  assert.equal(result.reason, 'probe-wheel-no-window-change');
  assert.equal(result.wheelAttemptLimit, 8);
  assert.equal(result.wheelAttempts, 8);
  assert.equal(result.steps.length, 8);
  assert.equal(harness.getMouseWheelCount(), 8);
  assert.equal(harness.events.filter((event) => event.startsWith('scroll-gesture:')).length, 0);
  assert.equal(harness.events.filter((event) => event.startsWith('mouse-wheel:')).length, 8);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe reports a conversation window transition', async () => {
  const harness = createScrollVisibilityProbePage({ normalizedHasFocus: true, mouseWheelEffect: { range: { min: 5, max: 9 }, scrollTop: 5_729 } });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.conversationWindowChanged, true);
  assert.equal(result.reason, 'probe-wheel-window-changed');
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe stops after the third wheel window transition', async () => {
  const harness = createScrollVisibilityProbePage({
    normalizedHasFocus: true,
    normalizedScrollTop: 6_449,
    mouseWheelEffect: ({ attempt }) => ({
      scrollTop: 6_449 - attempt * 720,
      range: attempt === 3 ? { min: 5, max: 9 } : { min: 6, max: 10 }
    })
  });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttempts, 3);
  assert.equal(result.steps.length, 3);
  assert.equal(result.firstWindowChangeAttempt, 3);
  assert.equal(result.conversationWindowChanged, true);
  assert.equal(result.anyPhysicalScrollChanged, true);
  assert.equal(result.reason, 'probe-wheel-window-changed');
  assert.equal(harness.getMouseWheelCount(), 3);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe stops after eight physical-only wheels', async () => {
  const harness = createScrollVisibilityProbePage({
    normalizedHasFocus: true,
    normalizedScrollTop: 6_449,
    mouseWheelEffect: ({ attempt }) => ({ scrollTop: 6_449 - attempt * 720 })
  });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttemptLimit, 8);
  assert.equal(result.wheelAttempts, 8);
  assert.equal(result.steps.length, 8);
  assert.equal(result.anyPhysicalScrollChanged, true);
  assert.equal(result.conversationWindowChanged, false);
  assert.equal(result.physicalTopReached, false);
  assert.equal(result.reason, 'probe-wheel-no-window-change');
  assert.equal(result.totalPhysicalDelta, 5_760);
  assert.equal(harness.getMouseWheelCount(), 8);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe stops at physical top before another wheel', async () => {
  const harness = createScrollVisibilityProbePage({
    normalizedHasFocus: true,
    normalizedScrollTop: 1_000,
    mouseWheelEffect: ({ attempt }) => ({ scrollTop: attempt === 1 ? 280 : 0 })
  });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttempts, 2);
  assert.equal(result.physicalTopReached, true);
  assert.equal(result.conversationWindowChanged, false);
  assert.equal(result.reason, 'probe-wheel-top-without-window-change');
  assert.equal(harness.getMouseWheelCount(), 2);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe keeps normalization movement separate from wheel movement', async () => {
  const harness = createScrollVisibilityProbePage({
    initialScrollTop: 0,
    normalizedScrollTop: 6_449,
    normalizedHasFocus: true,
    mouseWheelEffect: ({ attempt }) => ({ scrollTop: 6_449 - attempt * 720 })
  });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.normalizationPhysicalScrollChanged, true);
  assert.equal(result.steps[0].physicalScrollChanged, true);
  assert.equal(result.physicalScrollChanged, true);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe stops when URL changes after the second wheel', async () => {
  const harness = createScrollVisibilityProbePage({
    normalizedHasFocus: true,
    mouseWheelEffect: ({ attempt }) => ({ scrollTop: 6_449 - attempt * 720 }),
    changeUrlAtMouseWheel: 2
  });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttempts, 2);
  assert.equal(result.reason, 'probe-conversation-changed');
  assert.equal(harness.getMouseWheelCount(), 2);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe stops before the next wheel when focus is lost', async () => {
  const harness = createScrollVisibilityProbePage({
    normalizedHasFocus: true,
    mouseWheelEffect: ({ attempt }) => ({ scrollTop: 6_449 - attempt * 720 }),
    loseFocusAfterMouseWheel: 1
  });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttempts, 1);
  assert.equal(result.reason, 'probe-precondition-failed');
  assert.equal(harness.getMouseWheelCount(), 1);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe stops at the failing wheel attempt', async () => {
  const error = new Error('chrome_cdp_command_timeout');
  error.data = { wrapperCode: 'native_mouse_wheel_dispatch_failed', backendMessage: 'chrome_cdp_command_timeout' };
  const harness = createScrollVisibilityProbePage({
    normalizedHasFocus: true,
    mouseWheelEffect: ({ attempt }) => ({ scrollTop: 6_449 - attempt * 720 }),
    mouseWheelError: ({ attempt }) => attempt === 3 ? error : null
  });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttempts, 3);
  assert.equal(result.failureAttempt, 3);
  assert.equal(result.nativeInput.failurePhase, 'mouse-wheel');
  assert.equal(result.reason, 'probe-wheel-failed');
  assert.equal(harness.getMouseWheelCount(), 3);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe does not confuse normalization-only movement with wheel movement', async () => {
  const harness = createScrollVisibilityProbePage({ initialScrollTop: 0, normalizedScrollTop: 6_449, normalizedHasFocus: true });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.normalizationPhysicalScrollChanged, true);
  assert.equal(result.physicalScrollChanged, false);
  assert.equal(result.conversationWindowChanged, false);
  assert.equal(result.reason, 'probe-wheel-no-window-change');
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe requires document focus without requesting it', async () => {
  const harness = createScrollVisibilityProbePage({ normalizedHasFocus: false });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.readyForMouseWheel, false);
  assert.equal(result.wheelAttempted, false);
  assert.equal(result.reason, 'probe-normalized-but-unfocused');
  assert.equal(result.restoreVerified, true);
  assert.equal(harness.getMouseWheelCount(), 0);
});

test('chatgpt-controller: mouse-wheel probe stops on move failure and restores', async () => {
  const harness = createScrollVisibilityProbePage({ normalizedHasFocus: true, moveMouseError: new Error('move_failed') });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.moveMouseAttempted, true);
  assert.equal(result.moveMouseSucceeded, false);
  assert.equal(result.wheelAttempted, false);
  assert.equal(result.nativeInput.failurePhase, 'move-mouse');
  assert.equal(result.reason, 'probe-wheel-failed');
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe preserves timeout diagnostics and never retries', async () => {
  const error = new Error('chrome_cdp_command_timeout');
  error.data = { wrapperCode: 'native_mouse_wheel_dispatch_failed', backendMessage: 'chrome_cdp_command_timeout' };
  const harness = createScrollVisibilityProbePage({ normalizedHasFocus: true, mouseWheelError: error });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttempted, true);
  assert.equal(result.wheelCommandSucceeded, false);
  assert.equal(result.nativeInput.failurePhase, 'mouse-wheel');
  assert.equal(result.nativeInput.wrapperErrorCode, 'native_mouse_wheel_dispatch_failed');
  assert.equal(result.nativeInput.backendErrorMessage, 'chrome_cdp_command_timeout');
  assert.equal(harness.getMouseWheelCount(), 1);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe restores after post-wheel read failure', async () => {
  const harness = createScrollVisibilityProbePage({ normalizedHasFocus: true, readAfterGestureError: true });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttempted, true);
  assert.equal(result.wheelCommandSucceeded, true);
  assert.equal(result.nativeInput.failurePhase, 'post-wheel-read');
  assert.equal(result.reason, 'probe-wheel-failed');
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: mouse-wheel probe performs at most eight wheels and no touch fallback', async () => {
  const harness = createScrollVisibilityProbePage({ normalizedHasFocus: true });
  const result = await createController(harness.page).probeMouseWheelVisibility();
  assert.equal(result.wheelAttempted, true);
  assert.equal(result.wheelAttempts, 8);
  assert.equal(harness.getMouseWheelCount(), 8);
  assert.equal(harness.getGestureCount(), 0);
  assert.equal(harness.events.filter((event) => event.startsWith('scroll-gesture:')).length, 0);
  assert.equal(result.restoreVerified, true);
});

test('chatgpt-controller: complete history remains incomplete when the top proof is not established', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 10, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 1, historyMaxIterations: 1 });
  assert.equal(result.history.complete, false);
  assert.ok(['timeout', 'history-tail-unproven', 'history-native-scroll-failed'].includes(result.history.reason));
  assert.equal(result.history.diagnostics.completeVerification.attempted, true);
  assert.ok(result.history.diagnostics.completeVerification.passCount <= 1);
});

test('chatgpt-controller: complete history fails closed when native wheel is unsupported', async () => {
  const harness = createNativeWheelHistoryPage({ nativeWheel: false });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-native-scroll-unproven');
  assert.equal(harness.getWheelCount(), 0);
});

test('chatgpt-controller: complete history rejects native wheel dispatch without a conversation window transition', async () => {
  const harness = createNativeWheelHistoryPage({ windowChanges: false });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-start-unproven');
  assert.ok(harness.getWheelCount() >= 2);
  assert.equal(result.history.diagnostics.nativeScrollControlProven, false);
});

test('chatgpt-controller: native wheel diagnostics identify moveMouse failures without dispatching the wheel', async () => {
  const harness = createNativeWheelHistoryPage();
  const moveError = Object.assign(new Error('C:\\Users\\secret\\native input token 123456789012345678901234567890'), {
    name: 'MoveFailureError',
    code: 'MOVE_PRIVATE_CODE'
  });
  harness.page.moveMouse = async () => { throw moveError; };
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.reason, 'history-native-wheel-failed');
  assert.equal(result.history.diagnostics.nativeInput.failurePhase, 'move-mouse');
  assert.equal(result.history.diagnostics.nativeInput.errorName, 'MoveFailureError');
  assert.equal(result.history.diagnostics.nativeInput.errorCode, 'MOVE_PRIVATE_CODE');
  assert.doesNotMatch(result.history.diagnostics.nativeInput.errorMessage, /C:\\Users\\secret/u);
  assert.ok(result.history.diagnostics.nativeInput.errorMessage.length <= 256);
  assert.equal(harness.getWheelCount(), 0);
});

test('chatgpt-controller: native wheel diagnostics identify mouseWheel failures and retain runtime state', async () => {
  const harness = createNativeWheelHistoryPage();
  harness.page.mouseWheel = async () => {
    const error = new Error('Invalid parameters https://example.invalid/private/secret');
    error.name = 'WheelDispatchError';
    error.code = 'native_mouse_wheel_dispatch_failed';
    error.data = {
      code: 'native_mouse_wheel_dispatch_failed',
      wrapperCode: 'native_mouse_wheel_dispatch_failed',
      backendCode: -32602,
      backendMessage: 'Invalid parameters'
    };
    throw error;
  };
  harness.page.getNativeInputDiagnostics = async () => ({
    backend: 'electron',
    windowVisible: false,
    windowFocused: false,
    windowMinimized: false,
    windowDestroyed: false,
    webContentsDestroyed: true
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  const nativeInput = result.history.diagnostics.nativeInput;
  assert.equal(result.history.reason, 'history-native-wheel-failed');
  assert.equal(nativeInput.failurePhase, 'mouse-wheel');
  assert.equal(nativeInput.backend, 'electron');
  assert.equal(nativeInput.errorName, 'WheelDispatchError');
  assert.equal(nativeInput.errorCode, 'native_mouse_wheel_dispatch_failed');
  assert.equal(nativeInput.wrapperErrorName, 'WheelDispatchError');
  assert.equal(nativeInput.wrapperErrorCode, 'native_mouse_wheel_dispatch_failed');
  assert.equal(nativeInput.backendErrorCode, -32602);
  assert.match(nativeInput.backendErrorMessage, /Invalid parameters/u);
  assert.doesNotMatch(nativeInput.backendErrorMessage, /https:\/\//u);
  assert.equal(nativeInput.windowVisible, false);
  assert.equal(nativeInput.windowFocused, false);
  assert.equal(nativeInput.windowMinimized, false);
  assert.equal(nativeInput.windowDestroyed, false);
  assert.equal(nativeInput.webContentsDestroyed, true);
});

test('chatgpt-controller: trusted Chrome backend timeout diagnostic survives controller transport', async () => {
  const harness = createNativeWheelHistoryPage();
  harness.page.mouseWheel = async () => {
    const error = new Error('transport wrapper message');
    error.name = 'NativeInputError';
    error.code = 'native_mouse_wheel_dispatch_failed';
    error.data = {
      wrapperCode: 'native_mouse_wheel_dispatch_failed',
      backendCode: null,
      backendMessage: 'chrome_cdp_command_timeout'
    };
    throw error;
  };
  const result = await createController(harness.page).readConversationTurns({ historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  const nativeInput = result.history.diagnostics.nativeInput;
  assert.equal(result.history.reason, 'history-native-wheel-failed');
  assert.equal(nativeInput.failurePhase, 'mouse-wheel');
  assert.equal(nativeInput.wrapperErrorCode, 'native_mouse_wheel_dispatch_failed');
  assert.equal(nativeInput.backendErrorCode, null);
  assert.equal(nativeInput.backendErrorMessage, 'chrome_cdp_command_timeout');
  assert.equal(nativeInput.errorMessage, 'chrome_cdp_command_timeout');
});

test('chatgpt-controller: trusted Chrome backend session-closed diagnostic survives controller transport', async () => {
  const harness = createNativeWheelHistoryPage();
  harness.page.mouseWheel = async () => {
    const error = new Error('transport wrapper message');
    error.name = 'NativeInputError';
    error.code = 'native_mouse_wheel_dispatch_failed';
    error.data = {
      wrapperCode: 'native_mouse_wheel_dispatch_failed',
      backendCode: 'chrome_cdp_session_closed',
      backendMessage: 'chrome_cdp_session_closed'
    };
    throw error;
  };
  const result = await createController(harness.page).readConversationTurns({ historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  const nativeInput = result.history.diagnostics.nativeInput;
  assert.equal(nativeInput.backendErrorCode, 'chrome_cdp_session_closed');
  assert.equal(nativeInput.backendErrorMessage, 'chrome_cdp_session_closed');
  assert.equal(nativeInput.errorMessage, 'chrome_cdp_session_closed');
});

test('chatgpt-controller: trusted Chrome backend numeric protocol diagnostics remain separate from wrapper diagnostics', async () => {
  const harness = createNativeWheelHistoryPage();
  harness.page.mouseWheel = async () => {
    const error = new Error('wrapper message');
    error.name = 'NativeInputError';
    error.code = 'native_mouse_wheel_dispatch_failed';
    error.data = {
      wrapperCode: 'native_mouse_wheel_dispatch_failed',
      backendCode: -32602,
      backendMessage: 'Invalid parameters'
    };
    throw error;
  };
  const result = await createController(harness.page).readConversationTurns({ historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  const nativeInput = result.history.diagnostics.nativeInput;
  assert.equal(nativeInput.wrapperErrorCode, 'native_mouse_wheel_dispatch_failed');
  assert.equal(nativeInput.backendErrorCode, -32602);
  assert.equal(nativeInput.backendErrorMessage, 'Invalid parameters');
});

test('chatgpt-controller: untrusted native fallback diagnostics remain redacted and bounded', async () => {
  const harness = createNativeWheelHistoryPage();
  harness.page.mouseWheel = async () => {
    const error = new Error(`raw aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa https://example.invalid/private C:\\secret\\path`);
    error.name = 'NativeInputError';
    error.code = 'native_mouse_wheel_dispatch_failed';
    error.data = { wrapperCode: 'native_mouse_wheel_dispatch_failed' };
    throw error;
  };
  const result = await createController(harness.page).readConversationTurns({ historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  const nativeInput = result.history.diagnostics.nativeInput;
  assert.ok(nativeInput.backendErrorMessage.length <= 256);
  assert.doesNotMatch(nativeInput.backendErrorMessage, /https:\/\/example\.invalid/u);
  assert.doesNotMatch(nativeInput.backendErrorMessage, /C:\\secret\\path/u);
  assert.doesNotMatch(nativeInput.backendErrorMessage, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/u);
});

test('chatgpt-controller: trusted backend diagnostics only normalize controls and enforce the bound', async () => {
  const harness = createNativeWheelHistoryPage();
  harness.page.mouseWheel = async () => {
    const error = new Error('wrapper message');
    error.name = 'NativeInputError';
    error.code = 'native_mouse_wheel_dispatch_failed';
    error.data = {
      wrapperCode: 'native_mouse_wheel_dispatch_failed',
      backendMessage: `Invalid\nparameters ${'x'.repeat(300)}`
    };
    throw error;
  };
  const result = await createController(harness.page).readConversationTurns({ historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  const message = result.history.diagnostics.nativeInput.backendErrorMessage;
  assert.ok(message.length <= 256);
  assert.equal(message.startsWith('Invalid parameters'), true);
  assert.doesNotMatch(message, /\n/u);
});

test('chatgpt-controller: post-wheel snapshot failures have their own diagnostic phase', async () => {
  const harness = createNativeWheelHistoryPage();
  const originalEvaluate = harness.page.evaluate.bind(harness.page);
  let windowReads = 0;
  harness.page.evaluate = async (js) => {
    if (js.includes('const maxTurns =')) {
      windowReads += 1;
      // Three reads establish the stable normalized baseline; three direct-tail reads follow;
      // the next full read follows the native wheel.
      if (windowReads === 7) throw Object.assign(new Error('post wheel read failed'), { code: 'POST_READ_FAILED' });
    }
    return await originalEvaluate(js);
  };
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.reason, 'history-native-wheel-failed');
  assert.equal(result.history.diagnostics.nativeInput.failurePhase, 'post-wheel-read');
  assert.equal(result.history.diagnostics.nativeInput.errorCode, 'POST_READ_FAILED');
});

test('chatgpt-controller: successful and no-progress wheel diagnostics do not report a dispatch failure', async () => {
  const success = createNativeWheelHistoryPage();
  const complete = await createController(success.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(complete.history.diagnostics.nativeInput.failurePhase, null);
  assert.equal(complete.history.diagnostics.nativeInput.backend, 'test');

  const noProgress = createNativeWheelHistoryPage({ windowChanges: false });
  const stalled = await createController(noProgress.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(stalled.history.reason, 'history-start-unproven');
  assert.equal(stalled.history.diagnostics.nativeInput.failurePhase, null);
  assert.equal(stalled.history.diagnostics.nativeInput.errorMessage, null);
});

test('chatgpt-controller: stable IDs classify older, newer, same, and remount transitions without position hints', () => {
  const message = (id, role = 'user') => ({ messageId: id, role, text: id, positionHint: null });
  assert.equal(conversationDirectionalProgress([message('m5'), message('m6')], [message('m3'), message('m4'), message('m5')]), 'older');
  assert.equal(conversationDirectionalProgress([message('m3'), message('m4')], [message('m4'), message('m5'), message('m6')]), 'newer');
  assert.equal(conversationDirectionalProgress([message('m5'), message('m6')], [message('m5'), message('m6')]), 'same');
  assert.equal(conversationDirectionalProgress([message('m5', 'user')], [message('m5', 'assistant')]), 'ambiguous');
  assert.equal(conversationDirectionalProgress([message('m5'), message('m6')], [message('m7'), message('m8')]), 'ambiguous');
  assert.equal(conversationDirectionalProgress(
    [message('m4'), message('m5'), message('m6'), message('m7')],
    [message('m2'), message('m5'), message('m6')]
  ), 'ambiguous');
  assert.equal(conversationDirectionalProgress(
    [message('m4'), message('m5'), message('m6'), message('m7')],
    [message('m4'), message('m6'), message('m7')]
  ), 'ambiguous');
  assert.equal(conversationDirectionalProgress(
    [message('m5'), message('m6'), message('m7'), message('m8')],
    [message('m5'), message('m6')]
  ), 'ambiguous');
  assert.equal(conversationDirectionalProgress([
    { messageId: 'm5', role: 'user', text: 'm5', positionHint: null, virtualizerTurnKey: 'virtual-A' },
    { messageId: 'm6', role: 'assistant', text: 'm6', positionHint: null, virtualizerTurnKey: 'virtual-A' }
  ], [
    { messageId: 'm5', role: 'user', text: 'm5', positionHint: null, virtualizerTurnKey: 'virtual-B' },
    { messageId: 'm6', role: 'assistant', text: 'm6', positionHint: null, virtualizerTurnKey: 'virtual-B' }
  ]), 'same');
});

test('chatgpt-controller: virtualized-origin identity diagnostics identify current unit index churn', () => {
  const before = [
    { turnId: 'provider-turn-A', role: 'user', messageId: 'provider-turn-A:0:user' },
    { turnId: 'provider-turn-A', role: 'assistant', messageId: 'provider-turn-A:2:assistant' }
  ];
  const after = [
    { turnId: 'provider-turn-A', role: 'user', messageId: 'provider-turn-A:1:user' },
    { turnId: 'provider-turn-A', role: 'assistant', messageId: 'provider-turn-A:3:assistant' }
  ];
  const diagnostic = diagnoseVirtualizedOriginIdentityMismatch(before, after);
  assert.equal(diagnostic.beforeCount, 2);
  assert.equal(diagnostic.afterCount, 2);
  assert.equal(diagnostic.messageIdSequenceSame, false);
  assert.equal(diagnostic.turnRoleSequenceSame, true);
  assert.equal(diagnostic.turnRoleDirection, 'same');
  assert.equal(diagnostic.beforeTurnRoleUnique, true);
  assert.equal(diagnostic.afterTurnRoleUnique, true);
  assert.equal(diagnostic.alignedSameTurnRoleCount, 2);
  assert.equal(diagnostic.alignedSameTurnRoleDifferentMessageIdCount, 2);
  assert.equal(diagnostic.unitIndexOnlyMismatchCount, 2);
  assert.equal(diagnostic.beforeCurrentUnitKeyShapeValid, true);
  assert.equal(diagnostic.afterCurrentUnitKeyShapeValid, true);
  assert.equal(diagnostic.afterIsExactOrderedIdentitySubsetOfBefore, false);
  assert.equal(diagnostic.lengthChanged, false);
});

test('chatgpt-controller: virtualized-origin identity diagnostics prove only exact ordered subsets', () => {
  const turn = (position) => {
    const role = position % 2 ? 'assistant' : 'user';
    const turnId = `unit-turn-${position}`;
    return { turnId, role, messageId: `${turnId}:0:${role}` };
  };
  const before = Array.from({ length: 13 }, (_, position) => turn(position));
  const nonContiguousSubset = [0, 2, 3, 5, 6, 8, 9, 11, 12].map((position) => turn(position));
  const subsetDiagnostic = diagnoseVirtualizedOriginIdentityMismatch(before, nonContiguousSubset);
  assert.equal(subsetDiagnostic.turnRoleDirection, 'ambiguous');
  assert.equal(subsetDiagnostic.afterIsExactOrderedIdentitySubsetOfBefore, true);
  assert.equal(subsetDiagnostic.exactIdentitySubsetCount, 9);

  const reordered = [0, 3, 2, 5, 6, 8, 9, 11, 12].map((position) => turn(position));
  assert.equal(diagnoseVirtualizedOriginIdentityMismatch(before, reordered).afterIsExactOrderedIdentitySubsetOfBefore, false);

  const unknown = nonContiguousSubset.slice();
  unknown[4] = turn(99);
  assert.equal(diagnoseVirtualizedOriginIdentityMismatch(before, unknown).afterIsExactOrderedIdentitySubsetOfBefore, false);

  const changedMessageId = nonContiguousSubset.map((item, index) => index === 4
    ? { ...item, messageId: `${item.turnId}:1:${item.role}` }
    : item);
  assert.equal(diagnoseVirtualizedOriginIdentityMismatch(before, changedMessageId).afterIsExactOrderedIdentitySubsetOfBefore, false);

  const unitChurn = nonContiguousSubset.map((item, index) => index === 4
    ? { ...item, messageId: `${item.turnId}:1:${item.role}` }
    : item);
  assert.equal(diagnoseVirtualizedOriginIdentityMismatch(before, unitChurn).unitIndexOnlyMismatchCount, 1);
});

test('chatgpt-controller: virtualized-origin identity diagnostics classify turn-role direction independently', () => {
  const makeTurns = (ids, prefix) => ids.map((id, index) => ({
    turnId: id,
    role: (id.charCodeAt(id.length - 1) - 'A'.charCodeAt(0)) % 2 === 0 ? 'user' : 'assistant',
    messageId: `${prefix}-${index}`
  }));
  const before = makeTurns(['turn-B', 'turn-C', 'turn-D'], 'before-provider');
  const older = makeTurns(['turn-A', 'turn-B', 'turn-C', 'turn-D'], 'after-provider');
  const newer = makeTurns(['turn-B', 'turn-C', 'turn-D', 'turn-E'], 'newer-provider');
  assert.equal(conversationDirectionalProgress(before, older), 'ambiguous');
  const olderDiagnostic = diagnoseVirtualizedOriginIdentityMismatch(before, older);
  assert.equal(olderDiagnostic.turnRoleDirection, 'older');
  assert.equal(olderDiagnostic.turnRoleSequenceSame, false);
  assert.equal(olderDiagnostic.messageIdSequenceSame, false);
  assert.equal(olderDiagnostic.alignedSameTurnRoleCount, 3);
  assert.equal(olderDiagnostic.alignedSameTurnRoleDifferentMessageIdCount, 3);
  assert.equal(olderDiagnostic.lengthChanged, true);
  const newerDiagnostic = diagnoseVirtualizedOriginIdentityMismatch(before, newer);
  assert.equal(newerDiagnostic.turnRoleDirection, 'newer');
  assert.equal(diagnoseVirtualizedOriginIdentityMismatch(before, makeTurns(['turn-X', 'turn-Y'], 'unrelated')).turnRoleDirection, 'ambiguous');
});

test('chatgpt-controller: virtualized-origin identity diagnostics reject duplicate, reordered, and malformed identities', () => {
  const turn = (turnId, role, messageId = `${turnId}:0:${role}`) => ({ turnId, role, messageId });
  const before = [turn('turn-A', 'user'), turn('turn-B', 'assistant'), turn('turn-C', 'user')];
  const reordered = [turn('turn-A', 'user'), turn('turn-C', 'user'), turn('turn-B', 'assistant')];
  assert.equal(diagnoseVirtualizedOriginIdentityMismatch(before, reordered).turnRoleDirection, 'ambiguous');

  const duplicate = diagnoseVirtualizedOriginIdentityMismatch(
    [turn('turn-A', 'user'), turn('turn-A', 'user', 'turn-A:1:user')],
    [turn('turn-A', 'user')]
  );
  assert.equal(duplicate.beforeTurnRoleUnique, false);
  assert.equal(duplicate.beforeDuplicateTurnRoleCount, 1);
  assert.equal(duplicate.turnRoleDirection, 'ambiguous');
  assert.equal(duplicate.afterIsExactOrderedIdentitySubsetOfBefore, false);

  const malformed = diagnoseVirtualizedOriginIdentityMismatch(
    [turn('turn-A', 'user', 'sentinel-malformed-provider-unit-key')],
    [turn('turn-A', 'user', 'turn-A:0:assistant')]
  );
  assert.equal(malformed.beforeCurrentUnitKeyShapeValid, false);
  assert.equal(malformed.afterCurrentUnitKeyShapeValid, false);
  assert.equal(malformed.afterIsExactOrderedIdentitySubsetOfBefore, false);
});

test('chatgpt-controller: structural origin diagnostics never expose provider identities or hashes', () => {
  const sentinel = 'PRIVATE_PROVIDER_ID_SENTINEL_62a47';
  const diagnostic = diagnoseVirtualizedOriginIdentityMismatch(
    [{ turnId: sentinel, role: 'user', messageId: `${sentinel}:0:user` }],
    [{ turnId: sentinel, role: 'user', messageId: `${sentinel}:1:user` }]
  );
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, new RegExp(sentinel, 'u'));
  assert.doesNotMatch(serialized, /[a-f0-9]{64}/iu);
});

test('chatgpt-controller: discontinuous current-DOM overlap is not semantic older progress', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[2, 5, 6], [2, 5, 6], [4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 1_600,
    directTopPlan: () => ({})
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 10_000, historyMaxIterations: 240 });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-virtualizer-stalled');
  assert.equal(result.history.diagnostics.semanticOlderProgressCount, 0);
  assert.ok(result.history.diagnostics.olderNoProgressCount > 0);
  assert.equal(result.history.diagnostics.progress.olderWindowObserved, false);
  assert.equal(result.history.diagnostics.topMaterialization.stalled, true);
  assert.ok(harness.getWheelCount() < 20);
});

test('chatgpt-controller: physical jitter does not reset semantic older no-progress and fails as a bounded virtualizer stall', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    positionHints: false,
    backend: 'chrome-cdp',
    currentDom: true,
    virtualizerTopOffsetPx: 1_600,
    windowChanges: true,
    mouseWheelPlan: ({ attempt }) => ({ scrollTop: attempt % 2 ? 1 : 0 }),
    directTopPlan: () => ({})
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 10_000, historyMaxIterations: 240 });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-virtualizer-stalled');
  assert.ok(result.history.diagnostics.physicalScrollChangeCount > 0);
  assert.equal(result.history.diagnostics.semanticOlderProgressCount, 0);
  assert.ok(result.history.diagnostics.olderNoProgressCount > 0);
  assert.equal(result.history.diagnostics.topMaterialization.stalled, true);
  assert.equal(result.history.diagnostics.directTop.attempted, true);
  assert.ok(harness.getWheelCount() < 20);
});

test('chatgpt-controller: reverse current-DOM scrolling keeps monotonic physical older progress until virtualized windows materialize', async () => {
  let scrollPlanStep = 0;
  let finalOriginReached = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 3,
    windowRanges: [
      [0, 1, 2, 3, 4, 5],
      [4, 5, 6, 7, 8, 9],
      [8, 9, 10, 11, 12, 13],
      [12, 13, 14, 15, 16, 17]
    ],
    positionHints: false,
    backend: 'chrome-cdp',
    currentDom: true,
    reverseScroll: true,
    virtualizerTopOffsetPx: 18_000,
    restorePlan: () => {
      scrollPlanStep = 0;
      finalOriginReached = false;
      return { virtualizerTopOffsetPx: 18_000 };
    },
    directTopPlan: () => ({ windowIndex: 0, virtualizerTopOffsetPx: 0 }),
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (deltaY > 0) return { windowIndex: 3, scrollTop: 0, virtualizerTopOffsetPx: 18_000 };
      if (finalOriginReached && windowIndex === 0) return { windowIndex: 0, scrollTop: -1_000, virtualizerTopOffsetPx: 0 };
      const step = ++scrollPlanStep;
      if (step === 1) return { windowIndex: 3, scrollTop: -200, virtualizerTopOffsetPx: 18_000 };
      if (step === 2) return { windowIndex: 3, scrollTop: -400, virtualizerTopOffsetPx: 18_000 };
      if (step === 3) return { windowIndex: 2, scrollTop: -600, virtualizerTopOffsetPx: 12_000 };
      if (step === 4) return { windowIndex: 1, scrollTop: -800, virtualizerTopOffsetPx: 6_000 };
      finalOriginReached = true;
      return { windowIndex: 0, scrollTop: -1_000, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 60 });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.firstNativeUp.changed, false);
  assert.equal(result.history.diagnostics.firstNativeUp.physicalChanged, true);
  assert.equal(result.history.diagnostics.nativeScrollControlProven, true);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(result.history.diagnostics.directTop.fallbackTriggered, false);
  assert.equal(result.history.diagnostics.mergeContinuous, true);
  assert.equal(result.turns.length, 18);
});

test('chatgpt-controller: current DOM stable IDs and decreasing virtualizer offsets prove older traversal without position hints', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2, 3], [2, 3, 4, 5], [4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPlan: ({ windowIndex }) => windowIndex * 1_600
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.reason, null);
  assert.ok(result.history.diagnostics.semanticOlderProgressCount >= 2);
  assert.ok(result.history.diagnostics.virtualizerOffsetProgressCount >= 2);
  assert.equal(result.history.diagnostics.initialVirtualizerTopOffsetPx, 3_200);
  assert.equal(result.history.diagnostics.lowestVirtualizerTopOffsetPx, 0);
  assert.equal(result.history.diagnostics.finalVirtualizerTopOffsetPx, 3_200);
  assert.equal(result.history.diagnostics.progress.olderWindowObserved, true);
  assert.equal(result.history.diagnostics.startProofMode, 'virtualized-origin');
});

test('chatgpt-controller: false zero-offset origin probes and adds materialized older history', async () => {
  let materialized = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 9, 10, 11], [8, 9, 10, 11, 12, 13, 14, 15]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    olderMaterializationPlan: ({ attempt, windowIndex }) => {
      if (windowIndex === 0 && attempt >= 5 && !materialized) {
        materialized = true;
        return { prependRange: [-4, -3, -2, -1, 0, 1, 2, 3], virtualizerTopOffsetPx: 0 };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 10_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 40
  });
  assert.equal(result.history.startReached, true);
  assert.equal(result.history.reason, null);
  assert.equal(materialized, true);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, true);
  assert.ok(result.history.diagnostics.virtualizedOriginProbe.boundaryCount >= 2, JSON.stringify(result.history.diagnostics.virtualizedOriginProbe));
  assert.ok(result.history.diagnostics.virtualizedOriginProbe.progressCount >= 1);
  assert.ok(result.history.diagnostics.virtualizedOriginProbe.materializationProgressCount >= 1);
  const observedIds = new Set(result.windows.flatMap((window) => window.turns.map((turn) => turn.messageId)));
  for (let position = -4; position <= 15; position += 1) assert.ok(observedIds.has(`message-${position}`));
});

test('chatgpt-controller: origin probe returns immediately when its wheel materializes older history in a transient scroll state', async () => {
  let materialized = false;
  let postMaterializationReads = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 9, 10, 11], [8, 9, 10, 11, 12, 13, 14, 15]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    olderMaterializationPlan: ({ attempt, windowIndex }) => {
      if (windowIndex === 0 && attempt >= 5 && !materialized) {
        materialized = true;
        return { prependRange: [-4, -3, -2, -1, 0, 1, 2, 3], virtualizerTopOffsetPx: 120, scrollTop: 8 };
      }
      return null;
    },
    virtualizerTopOffsetPlan: ({ traversalRead, windowIndex }) => {
      if (!materialized || !traversalRead || windowIndex !== 0) return null;
      postMaterializationReads += 1;
      return postMaterializationReads === 1
        ? { virtualizerTopOffsetPx: 120, scrollTop: 8 }
        : { virtualizerTopOffsetPx: 0, scrollTop: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 10_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 40
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(materialized, true);
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.ok(probe.progressCount >= 1);
  assert.equal(probe.lastFailureReason, null);
  assert.equal(probe.transientAtTopFalseCount, 0);
  assert.equal(probe.transientPositiveTopOffsetCount, 0);
  const observedIds = new Set(result.windows.flatMap((window) => window.turns.map((turn) => turn.messageId)));
  for (let position = -4; position <= 15; position += 1) assert.ok(observedIds.has(`message-${position}`));
});

test('chatgpt-controller: origin probe returns immediately when polling observes delayed older materialization', async () => {
  let armed = false;
  let pollReadsAfterWheel = 0;
  let materialized = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 9, 10, 11], [8, 9, 10, 11, 12, 13, 14, 15]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    mouseWheelPlan: ({ attempt, deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0 && attempt >= 5 && !armed) armed = true;
      return null;
    },
    virtualizerTopOffsetPlan: ({ windowIndex }) => {
      if (!armed || windowIndex !== 0) return null;
      if (materialized) return { virtualizerTopOffsetPx: 0, scrollTop: 0 };
      pollReadsAfterWheel += 1;
      if (pollReadsAfterWheel < 2) return null;
      materialized = true;
      return { prependRange: [-4, -3, -2, -1, 0, 1, 2, 3], virtualizerTopOffsetPx: 120, scrollTop: 8 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 10_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 40
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(materialized, true);
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.ok(probe.progressCount >= 1);
  assert.equal(probe.lastFailureReason, null);
  const observedIds = new Set(result.windows.flatMap((window) => window.turns.map((turn) => turn.messageId)));
  for (let position = -4; position <= 15; position += 1) assert.ok(observedIds.has(`message-${position}`));
});

test('chatgpt-controller: multi-stage zero-offset boundaries keep traversing until final stable origin', async () => {
  const olderRanges = [
    [-4, -3, -2, -1, 0, 1, 2, 3],
    [-8, -7, -6, -5, -4, -3, -2, -1]
  ];
  let materializationIndex = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 9, 10, 11], [8, 9, 10, 11, 12, 13, 14, 15]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    olderMaterializationPlan: ({ windowIndex }) => {
      if (windowIndex !== 0 || materializationIndex >= olderRanges.length) return null;
      return { prependRange: olderRanges[materializationIndex++], virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 10_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 50
  });
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.boundaryCount, 3);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, true);
  assert.ok(result.windows.length >= 5);
  assert.ok(result.windows.every((window, index) => window.windowIndex === index));
  const observedIds = new Set(result.windows.flatMap((window) => window.turns.map((turn) => turn.messageId)));
  assert.deepEqual(Array.from({ length: 24 }, (_, index) => `message-${index - 8}`).filter((id) => observedIds.has(id)), Array.from({ length: 24 }, (_, index) => `message-${index - 8}`));
  assert.deepEqual(result.windows.at(-1).turns.map((turn) => turn.messageId), Array.from({ length: 8 }, (_, index) => `message-${index - 8}`));
});

test('chatgpt-controller: prior older progress does not prove a later apparent zero origin', async () => {
  let materialized = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 9, 10, 11], [8, 9, 10, 11, 12, 13, 14, 15]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    olderMaterializationPlan: ({ windowIndex }) => {
      if (windowIndex === 0 && !materialized) {
        materialized = true;
        return { prependRange: [-4, -3, -2, -1, 0, 1, 2, 3], virtualizerTopOffsetPx: 0 };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 10_000, historyMaxIterations: 4
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-iteration-limit');
  assert.ok(result.history.diagnostics.olderProgressCount > 0);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, false);
});

test('chatgpt-controller: true short current-DOM history passes bounded active origin probes', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  assert.equal(result.history.complete, true, JSON.stringify(result.history));
  assert.equal(result.turns.length, 8);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, true);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.stablePasses, 3);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.attempts, 3);
  assert.equal(result.history.diagnostics.startProofMode, 'virtualized-origin');
});

test('chatgpt-controller: virtualized-origin stable passes ignore provider text variants', async () => {
  let probePass = 0;
  const variants = ['presentation-a', 'presentation-b', 'presentation-a'];
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnText: ({ position }) => position === 0 ? `turn-zero-${variants[Math.max(0, probePass - 1) % variants.length]}` : `turn-${position}`,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) {
        probePass += 1;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, true);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.stablePasses, 3);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.boundaryCount, 1);
});

test('chatgpt-controller: virtualized-origin probes keep A/B/A text variants on one logical boundary', async () => {
  let probePass = 0;
  const variants = ['historical-shape', 'dom-decoration', 'historical-shape'];
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnText: ({ position }) => position === 0 ? `turn-zero-${variants[Math.max(0, probePass - 1) % variants.length]}` : `turn-${position}`,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) {
        probePass += 1;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, true);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.stablePasses, 3);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.boundaryCount, 1);
});

test('chatgpt-controller: virtualized-origin probe waits through transient atTop false state', async () => {
  let transientArmed = false;
  let transientPolls = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    mouseWheelPlan: ({ attempt, deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) {
        if (attempt >= 3 && !transientArmed) transientArmed = true;
        return { scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!transientArmed || traversalRead) return null;
      transientPolls += 1;
      return { scrollTop: transientPolls <= 2 ? 8 : 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.ok(probe.transientAtTopFalseCount >= 2);
  assert.ok(probe.transientResetCount >= 2);
});

test('chatgpt-controller: virtualized-origin probe waits through transient positive top offset', async () => {
  let transientArmed = false;
  let transientPolls = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    mouseWheelPlan: ({ attempt, deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) {
        if (attempt >= 3 && !transientArmed) transientArmed = true;
        return { scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!transientArmed || traversalRead) return null;
      transientPolls += 1;
      return { scrollTop: 0, virtualizerTopOffsetPx: transientPolls <= 2 ? 120 : 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.ok(probe.transientPositiveTopOffsetCount >= 2);
  assert.ok(probe.transientResetCount >= 2);
});

test('chatgpt-controller: virtualized-origin probe resets through combined transient scroll states', async () => {
  let transientArmed = false;
  let transientPolls = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    mouseWheelPlan: ({ attempt, deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) {
        if (attempt >= 3 && !transientArmed) transientArmed = true;
        return { scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!transientArmed || traversalRead) return null;
      transientPolls += 1;
      if (transientPolls === 1) return { scrollTop: 8, virtualizerTopOffsetPx: 120 };
      if (transientPolls === 2) return { scrollTop: 0, virtualizerTopOffsetPx: 120 };
      return { scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.ok(probe.transientAtTopFalseCount >= 1);
  assert.ok(probe.transientPositiveTopOffsetCount >= 2);
  assert.ok(probe.transientResetCount >= 2);
});

test('chatgpt-controller: virtualized-origin probe fails closed on identity change during a transient', async () => {
  let transientArmed = false;
  let identityChanged = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: ({ position }) => position === 0 && identityChanged
      ? { messageId: 'replacement-message-zero', turnId: null }
      : null,
    mouseWheelPlan: ({ attempt, deltaY, windowIndex }) => {
      if (attempt >= 3 && deltaY < 0 && windowIndex === 0) {
        transientArmed = true;
        return { scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!transientArmed || traversalRead) return null;
      identityChanged = true;
      return { scrollTop: 8, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(probe.verified, false);
  assert.equal(probe.stablePasses, 0);
  assert.equal(probe.lastFailureStage, 'poll-identity-changed');
  assert.equal(probe.lastFailureReason, 'identity-sequence-changed');
  assert.equal(probe.identityMismatch.stage, 'poll');
  assert.equal(probe.identityMismatch.beforeCount, 8);
  assert.equal(probe.identityMismatch.afterCount, 8);
  assert.equal(probe.identityMismatch.turnRoleDirection, 'ambiguous');
  assert.doesNotMatch(JSON.stringify(probe.identityMismatch), /replacement-message-zero/u);
});

test('chatgpt-controller: virtualized-origin probe fails boundedly if a transient candidate never returns', async () => {
  let transientArmed = false;
  let pollCount = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    mouseWheelPlan: ({ attempt, deltaY, windowIndex }) => {
      if (attempt >= 3 && deltaY < 0 && windowIndex === 0) {
        transientArmed = true;
        return { scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!transientArmed || traversalRead) return null;
      pollCount += 1;
      return { scrollTop: 8, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 10_000, historyMaxIterations: 30
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.complete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(probe.verified, false);
  assert.ok(pollCount > 0);
  assert.ok(probe.transientAtTopFalseCount > 0);
  assert.equal(probe.lastFailureStage, 'poll-stability-timeout');
  assert.equal(probe.lastFailureReason, 'candidate-not-restored');
});

test('chatgpt-controller: virtualized-origin identity kind changes reset boundary stability', async () => {
  let switchIdentityKind = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: ({ position }) => position === 0 && switchIdentityKind
      ? { messageId: null, turnId: 'message-0' }
      : null,
    mouseWheelPlan: ({ attempt, deltaY, windowIndex }) => {
      if (attempt >= 2 && deltaY < 0 && windowIndex === 0) {
        switchIdentityKind = true;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, false);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.stablePasses, 0);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.boundaryCount, 1);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.lastFailureStage, 'wheel-identity-changed');
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.lastFailureReason, 'identity-sequence-changed');
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.identityMismatch.stage, 'wheel');
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.identityMismatch.turnRoleDirection, 'ambiguous');
});

test('chatgpt-controller: same-direction unit-index churn remains fail-closed instead of newer recoil', async () => {
  let churnUnitIndex = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: ({ position }) => {
      const identity = currentDomUnitIdentity({ position });
      if (position === 0 && churnUnitIndex) identity.messageId = 'origin-turn-0:1:user';
      return identity;
    },
    mouseWheelPlan: ({ attempt, deltaY, windowIndex }) => {
      if (attempt >= 2 && deltaY < 0 && windowIndex === 0) {
        churnUnitIndex = true;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    restorePlan: () => {
      churnUnitIndex = false;
      return { windowIndex: 0 };
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(probe.verified, false);
  assert.equal(probe.lastFailureStage, 'wheel-identity-changed');
  assert.equal(probe.lastFailureReason, 'identity-sequence-changed');
  assert.equal(probe.identityMismatch.turnRoleDirection, 'same');
  assert.equal(probe.identityMismatch.unitIndexOnlyMismatchCount, 1);
  assert.equal(probe.identityRecoilCount, 0);
  assert.equal(probe.stablePasses, 0);
});

test('chatgpt-controller: bounded newer recoil restores the exact origin baseline without false older progress', async () => {
  const candidate = Array.from({ length: 12 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const newerAgain = Array.from({ length: 10 }, (_, index) => index + 6);
  const newest = Array.from({ length: 10 }, (_, index) => index + 8);
  let probeArmed = false;
  let pollCount = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 3,
    windowRanges: [candidate, newer, newerAgain, newest],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (!probeArmed && deltaY < 0 && windowIndex === 0) {
        probeArmed = true;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    restorePlan: () => {
      probeArmed = false;
      return { windowIndex: 3 };
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!probeArmed || traversalRead) return null;
      pollCount += 1;
      if (pollCount === 1) return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      if (pollCount === 2) return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 50
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(result.history.reason, null);
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.ok(probe.identityRecoilCount > 0);
  assert.ok(probe.identityRecoilPollCount > 0);
  assert.ok(probe.identityRecoilRestoreCount > 0);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
  assert.equal(probe.lastFailureStage, null);
  assert.equal(probe.lastFailureReason, null);
});

test('chatgpt-controller: a second bounded older retry restores a persistent newer recoil before origin proof', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const newerAgain = Array.from({ length: 10 }, (_, index) => index + 6);
  let probeArmed = false;
  let recoilInjected = false;
  let correctiveRestored = false;
  let correctiveWheelCalls = 0;
  let olderRetryWheelCalls = 0;
  let newerCorrectiveWheelCalls = 0;
  let transientObservationActive = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 3,
    windowRanges: [candidate, newer, newerAgain, Array.from({ length: 10 }, (_, index) => index + 8)],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: ({ position }) => {
      const role = position % 2 ? 'assistant' : 'user';
      const turnId = `provider-secret-turn-${position}`;
      return { turnId, messageId: `${turnId}:0:${role}` };
    },
    turnText: ({ position, windowIndex }) => transientObservationActive && windowIndex > 0
      ? `transient-recoil-only-${position}`
      : `turn-${position}`,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) probeArmed = true;
      if (probeArmed && recoilInjected && [1, 2].includes(windowIndex) && deltaY < 0) {
        olderRetryWheelCalls += 1;
        correctiveWheelCalls += 1;
        if (correctiveWheelCalls === 1) return { windowIndex: 2 };
        if (correctiveWheelCalls === 2 && !correctiveRestored) {
          correctiveRestored = true;
          transientObservationActive = false;
          return { windowIndex: 0 };
        }
      }
      if (probeArmed && recoilInjected && [1, 2].includes(windowIndex) && deltaY > 0) newerCorrectiveWheelCalls += 1;
      return null;
    },
    restorePlan: () => ({ windowIndex: 3 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead || !probeArmed || recoilInjected || readCount < 18) return null;
      recoilInjected = true;
      transientObservationActive = true;
      return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 60
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.equal(probe.identityCorrectiveRestoreAttemptCount, 2);
  assert.equal(probe.identityCorrectiveRestoreSuccessCount, 1);
  assert.equal(probe.identityCorrectiveRestoreWheelCount, 2);
  assert.equal(correctiveWheelCalls, 2);
  assert.equal(olderRetryWheelCalls, 2);
  assert.equal(newerCorrectiveWheelCalls, 0);
  assert.equal(probe.identityCorrectiveRestoreRetryCount, 2);
  assert.equal(probe.identityCorrectiveRestoreEpisodeCount, 1);
  assert.equal(probe.identityCorrectiveRestoreMaxRetries, 3);
  assert.ok(probe.identityRecoilCount > 0);
  assert.ok(probe.identityRecoilRestoreCount > 0);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
  assert.equal(result.windows.flatMap((window) => window.turns).some((turn) => turn.text.includes('transient-recoil-only')), false);
  assert.equal(probe.lastFailureReason, null);
  assert.equal(JSON.stringify(probe).includes('provider-secret'), false);
});

test('chatgpt-controller: corrective retry fails closed immediately when the global iteration budget is reached', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const newerAgain = Array.from({ length: 10 }, (_, index) => index + 6);
  let probeArmed = false;
  let recoilInjected = false;
  let correctiveWheelCalls = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [candidate, newer, newerAgain],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) probeArmed = true;
      if (probeArmed && recoilInjected && deltaY < 0 && windowIndex === 1) {
        correctiveWheelCalls += 1;
        return { windowIndex: 2, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    restorePlan: () => ({ windowIndex: 2 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead || !probeArmed || recoilInjected || readCount < 18) return null;
      recoilInjected = true;
      return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 5
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-iteration-limit');
  assert.equal(probe.verified, false);
  assert.equal(probe.lastFailureStage, 'probe-budget-exhausted');
  assert.equal(probe.lastFailureReason, 'iteration-limit');
  assert.equal(correctiveWheelCalls, 1);
  assert.equal(probe.identityCorrectiveRestoreAttemptCount, 1);
  assert.equal(probe.identityCorrectiveRestoreWheelCount, 1);
  assert.equal(probe.stablePasses, 1);
});

test('chatgpt-controller: the third bounded older retry can restore the original candidate without a fourth wheel', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const newerA = Array.from({ length: 10 }, (_, index) => index + 4);
  const newerB = Array.from({ length: 10 }, (_, index) => index + 5);
  const newerC = Array.from({ length: 10 }, (_, index) => index + 6);
  let probeArmed = false;
  let recoilInjected = false;
  let retryCount = 0;
  let olderRetryDeltaCount = 0;
  let newerRetryDeltaCount = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 3,
    windowRanges: [candidate, newerA, newerB, newerC],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (!probeArmed && deltaY < 0 && windowIndex === 0) probeArmed = true;
      if (probeArmed && recoilInjected && [1, 2, 3].includes(windowIndex) && deltaY < 0) {
        retryCount += 1;
        olderRetryDeltaCount += 1;
        if (retryCount === 1) return { windowIndex: 2 };
        if (retryCount === 2) return { windowIndex: 3 };
        if (retryCount === 3) return { windowIndex: 0 };
      }
      if (probeArmed && recoilInjected && [1, 2, 3].includes(windowIndex) && deltaY > 0) newerRetryDeltaCount += 1;
      return null;
    },
    restorePlan: () => ({ windowIndex: 3 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead || !probeArmed || recoilInjected || readCount < 18) return null;
      recoilInjected = true;
      return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 60
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.equal(retryCount, 3);
  assert.equal(olderRetryDeltaCount, 3);
  assert.equal(newerRetryDeltaCount, 0);
  assert.equal(probe.identityCorrectiveRestoreAttemptCount, 3);
  assert.equal(probe.identityCorrectiveRestoreRetryCount, 3);
  assert.equal(probe.identityCorrectiveRestoreWheelCount, 3);
  assert.equal(probe.identityCorrectiveRestoreSuccessCount, 1);
  assert.equal(probe.identityCorrectiveRestoreBudgetExhaustedCount, 0);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
});

test('chatgpt-controller: retry two detects actual older progress against the original candidate', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const older = Array.from({ length: 12 }, (_, index) => index - 4);
  let probeArmed = false;
  let recoilInjected = false;
  let correctiveWheelCalls = 0;
  let correctiveOlderWheelCount = 0;
  let correctiveNewerWheelCount = 0;
  let pollCount = 0;
  let actualOlderReturned = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [candidate, newer, older],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (actualOlderReturned) return null;
      if (!probeArmed && deltaY < 0 && windowIndex === 0) {
        probeArmed = true;
        return null;
      }
      if (probeArmed && recoilInjected && deltaY < 0 && correctiveWheelCalls < 2 && windowIndex === 1) {
        correctiveWheelCalls += 1;
        correctiveOlderWheelCount += 1;
        if (correctiveWheelCalls === 2) actualOlderReturned = true;
        return { windowIndex: correctiveWheelCalls === 1 ? 1 : 2, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (probeArmed && recoilInjected && deltaY > 0 && windowIndex === 1) correctiveNewerWheelCount += 1;
      return null;
    },
    restorePlan: () => ({ windowIndex: 2 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead || !probeArmed || recoilInjected || readCount < 18) return null;
      pollCount += 1;
      if (pollCount !== 1) return null;
      recoilInjected = true;
      return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 6
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.ok(probe.identityRecoilCount > 0);
  assert.equal(correctiveWheelCalls, 2);
  assert.equal(correctiveOlderWheelCount, 2);
  assert.equal(correctiveNewerWheelCount, 0);
  assert.equal(probe.identityCorrectiveRestoreAttemptCount, 2);
  assert.equal(probe.identityCorrectiveRestoreWheelCount, 2);
  assert.equal(probe.identityCorrectiveRestoreOlderProgressCount, 1);
  assert.equal(probe.progressCount, 1);
  assert.equal(probe.materializationProgressCount, 1);
  assert.equal(probe.identityCorrectiveRestoreUnresolvedCount, 0);
  assert.equal(result.turns.some((turn) => turn.messageId === 'origin-turn--4:0:user'), true);
});

test('chatgpt-controller: corrective recoil that returns a contraction waits for the original candidate without another wheel', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const newerAgain = Array.from({ length: 10 }, (_, index) => index + 6);
  const subset = [0, 2, 3, 5, 6, 8, 9, 11, 12];
  let probeArmed = false;
  let recoilInjected = false;
  let correctiveWheelCalls = 0;
  let correctiveReadPending = false;
  let contractionRestorePending = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 3,
    windowRanges: [candidate, newer, newerAgain, subset],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) probeArmed = true;
      if (deltaY < 0 && probeArmed && recoilInjected && windowIndex === 1) {
        correctiveWheelCalls += 1;
        return { windowIndex: 2 };
      }
      if (deltaY < 0 && probeArmed && recoilInjected && windowIndex === 2) {
        correctiveWheelCalls += 1;
        correctiveReadPending = true;
        contractionRestorePending = true;
        return { windowIndex: 3 };
      }
      return null;
    },
    restorePlan: () => ({ windowIndex: 3 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead || !probeArmed) return null;
      if (correctiveReadPending) {
        correctiveReadPending = false;
        return null;
      }
      if (contractionRestorePending) {
        contractionRestorePending = false;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (recoilInjected || readCount < 18) return null;
      recoilInjected = true;
      return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 60
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.equal(correctiveWheelCalls, 2);
  assert.equal(probe.identityCorrectiveRestoreAttemptCount, 2);
  assert.equal(probe.identityCorrectiveRestoreSuccessCount, 0);
  assert.ok(probe.identityContractionCount > 0);
  assert.ok(probe.identityContractionRestoreCount > 0);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
});

test('chatgpt-controller: corrective recoil with unrelated identity fails closed immediately', async () => {
  const candidate = Array.from({ length: 12 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const newerAgain = Array.from({ length: 10 }, (_, index) => index + 6);
  const unrelated = Array.from({ length: 10 }, (_, index) => index + 50);
  let probeArmed = false;
  let recoilInjected = false;
  let correctiveWheelCalls = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 3,
    windowRanges: [candidate, newer, newerAgain, unrelated],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (deltaY < 0 && windowIndex === 0) probeArmed = true;
      if (deltaY < 0 && probeArmed && recoilInjected && windowIndex === 1) {
        correctiveWheelCalls += 1;
        return { windowIndex: 2 };
      }
      if (deltaY < 0 && probeArmed && recoilInjected && windowIndex === 2) {
        correctiveWheelCalls += 1;
        return { windowIndex: 3 };
      }
      return null;
    },
    restorePlan: () => ({ windowIndex: 3 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead || !probeArmed || recoilInjected || readCount < 18) return null;
      recoilInjected = true;
      return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 60
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(probe.lastFailureStage, 'corrective-identity-invalid');
  assert.equal(probe.lastFailureReason, 'identity-sequence-changed');
  assert.equal(correctiveWheelCalls, 2);
  assert.equal(probe.identityCorrectiveRestoreAttemptCount, 2);
  assert.equal(probe.identityCorrectiveRestoreUnresolvedCount, 1);
});

test('chatgpt-controller: bounded exact identity contraction restores the 13-unit origin baseline without false progress', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const subset = [0, 2, 3, 5, 6, 8, 9, 11, 12];
  let contractionInjected = false;
  let restoreWasObserved = false;
  let contractionPollPending = false;
  let resetRestoredScrollHeight = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [candidate, subset, candidate],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    restorePlan: () => ({ windowIndex: 2 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead) return null;
      if (!contractionPollPending && !contractionInjected && readCount >= 18) {
        contractionInjected = true;
        contractionPollPending = true;
        return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (contractionPollPending) {
        contractionPollPending = false;
        restoreWasObserved = true;
        resetRestoredScrollHeight = true;
        return { windowIndex: 0, scrollTop: 0, scrollHeight: 5_000, virtualizerTopOffsetPx: 0 };
      }
      if (resetRestoredScrollHeight) {
        resetRestoredScrollHeight = false;
        return { windowIndex: 0, scrollTop: 0, resetScrollHeight: true, virtualizerTopOffsetPx: 0 };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 50
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(contractionInjected, true);
  assert.equal(restoreWasObserved, true);
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.ok(probe.stablePasses >= 3);
  assert.ok(probe.identityContractionCount > 0, JSON.stringify(probe));
  assert.ok(probe.identityContractionPollCount > 0);
  assert.ok(probe.identityContractionRestoreCount > 0);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
  assert.equal(probe.lastFailureStage, null);
  assert.equal(probe.lastFailureReason, null);
});

test('chatgpt-controller: exact identity contraction keeps the original baseline for actual older materialization', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const subset = [0, 2, 3, 5, 6, 8, 9, 11, 12];
  let pollStage = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [candidate, subset, candidate],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    restorePlan: () => ({ windowIndex: 3 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead || readCount < 18) return null;
      if (pollStage === 0) {
        pollStage += 1;
        return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (pollStage === 1) {
        pollStage += 1;
        return {
          prependRange: Array.from({ length: 13 }, (_, index) => index - 4),
          scrollTop: 0,
          virtualizerTopOffsetPx: 0
        };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 50
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(pollStage, 2);
  assert.equal(probe.progressCount, 1);
  assert.equal(probe.materializationProgressCount, 1);
  assert.ok(probe.identityContractionCount > 0);
  assert.equal(result.windows.some((window) => window.turns.some((turn) => turn.turnId === 'origin-turn--4')),
    true,
    JSON.stringify({ startReached: result.history.startReached, reason: result.history.reason, windowTurnCounts: result.windows.map((window) => window.turns.length), olderIdentityObserved: result.windows.some((window) => window.turns.some((turn) => turn.turnId === 'origin-turn--4')) }));
});

test('chatgpt-controller: repeated exact contractions remain bounded and only prove after the original candidate returns', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const subsetB = [0, 2, 3, 5, 6, 8, 9, 11, 12];
  const subsetC = [0, 3, 5, 8, 9, 12];
  const subsetD = [2, 5, 8, 11];
  let pollStage = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 4,
    windowRanges: [candidate, subsetB, subsetC, subsetD, candidate],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    restorePlan: () => ({ windowIndex: 4 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (traversalRead || readCount < 20) return null;
      const sequence = [1, 2, 3, 0];
      if (pollStage < sequence.length) return { windowIndex: sequence[pollStage++], scrollTop: 0, virtualizerTopOffsetPx: 0 };
      return null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 60
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.equal(pollStage, 4);
  assert.ok(probe.identityContractionCount >= 3);
  assert.equal(probe.identityContractionRestoreCount, 1);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
});

test('chatgpt-controller: exact identity contraction that never restores fails closed at its bounded deadline', async () => {
  const candidate = Array.from({ length: 13 }, (_, index) => index);
  const subset = [0, 2, 3, 5, 6, 8, 9, 11, 12];
  let contractionObserved = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [candidate, subset, candidate],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    restorePlan: () => ({ windowIndex: 2 }),
    virtualizerTopOffsetPlan: ({ readCount, traversalRead }) => {
      if (!contractionObserved && !traversalRead && readCount >= 18) {
        contractionObserved = true;
        return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return contractionObserved ? { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 } : null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 10_000, historyMaxIterations: 50
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(probe.verified, false);
  assert.ok(probe.stablePasses < 3);
  assert.equal(probe.lastFailureStage, 'poll-identity-contraction-timeout');
  assert.equal(probe.lastFailureReason, 'candidate-not-restored-after-contraction');
  assert.ok(probe.identityContractionCount > 0);
  assert.equal(probe.identityContractionRestoreCount, 0);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
});

test('chatgpt-controller: origin probe tolerates wheel-stage newer recoil but proves only after the candidate returns', async () => {
  const candidate = Array.from({ length: 12 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const newest = Array.from({ length: 10 }, (_, index) => index + 8);
  let probeArmed = false;
  let wheelRecoilPending = false;
  let correctiveRetryWheelCalls = 0;
  let correctiveOlderWheelCalls = 0;
  let newerCorrectiveWheelCalls = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [candidate, newer, newest],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (!probeArmed && deltaY < 0 && windowIndex === 0) {
        probeArmed = true;
        wheelRecoilPending = true;
        return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (probeArmed && deltaY < 0 && correctiveRetryWheelCalls === 0 && windowIndex === 1) {
        correctiveRetryWheelCalls += 1;
        correctiveOlderWheelCalls += 1;
        return { windowIndex: 2, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (probeArmed && deltaY < 0 && correctiveRetryWheelCalls === 1 && windowIndex === 2) {
        correctiveRetryWheelCalls += 1;
        correctiveOlderWheelCalls += 1;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (probeArmed && deltaY > 0 && [1, 2].includes(windowIndex)) newerCorrectiveWheelCalls += 1;
      return null;
    },
    restorePlan: () => {
      probeArmed = false;
      return { windowIndex: 2 };
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (traversalRead) return null;
      if (wheelRecoilPending) {
        wheelRecoilPending = false;
        return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 50
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.ok(probe.identityRecoilWheelCount > 0);
  assert.ok(probe.identityRecoilRestoreCount > 0);
  assert.equal(probe.identityCorrectiveRestoreAttemptCount, 2);
  assert.equal(probe.identityCorrectiveRestoreWheelCount, 2);
  assert.equal(probe.identityCorrectiveRestoreSuccessCount, 1);
  assert.equal(correctiveRetryWheelCalls, 2);
  assert.equal(correctiveOlderWheelCalls, 2);
  assert.equal(newerCorrectiveWheelCalls, 0);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
});

test('chatgpt-controller: actual older materialization after newer recoil compares against the original candidate', async () => {
  const candidate = Array.from({ length: 12 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const newest = Array.from({ length: 10 }, (_, index) => index + 8);
  let probeArmed = false;
  let pollCount = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [candidate, newer, newest],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (!probeArmed && deltaY < 0 && windowIndex === 0) {
        probeArmed = true;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    restorePlan: () => {
      probeArmed = false;
      return { windowIndex: 3 };
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!probeArmed || traversalRead) return null;
      pollCount += 1;
      if (pollCount === 1) return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      if (pollCount === 2) return { prependRange: Array.from({ length: 12 }, (_, index) => index - 4), scrollTop: 0, virtualizerTopOffsetPx: 0 };
      return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 50
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.ok(probe.progressCount >= 1);
  assert.ok(probe.materializationProgressCount >= 1);
  assert.ok(probe.identityRecoilCount >= 1);
  const observed = new Set(result.windows.flatMap((window) => window.turns.map((turn) => turn.messageId)));
  for (let position = -4; position <= 7; position += 1) {
    const role = position % 2 ? 'assistant' : 'user';
    assert.ok(observed.has(`origin-turn-${position}:0:${role}`));
  }
});

test('chatgpt-controller: newer recoil without candidate restoration fails closed at the bounded deadline', async () => {
  const candidate = Array.from({ length: 12 }, (_, index) => index);
  const newerA = Array.from({ length: 10 }, (_, index) => index + 4);
  const newerB = Array.from({ length: 10 }, (_, index) => index + 5);
  const newerC = Array.from({ length: 10 }, (_, index) => index + 6);
  const newerD = Array.from({ length: 10 }, (_, index) => index + 7);
  let probeArmed = false;
  let recoilInjected = false;
  let correctiveWheelCalls = 0;
  let correctiveOlderWheels = 0;
  let correctiveNewerWheels = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 4,
    windowRanges: [candidate, newerA, newerB, newerC, newerD],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (!probeArmed && deltaY < 0 && windowIndex === 0) {
        probeArmed = true;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (probeArmed && [1, 2, 3].includes(windowIndex) && deltaY < 0 && correctiveWheelCalls < 3) {
        correctiveWheelCalls += 1;
        correctiveOlderWheels += 1;
        return { windowIndex: windowIndex + 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      if (probeArmed && [1, 2, 3].includes(windowIndex) && deltaY > 0) correctiveNewerWheels += 1;
      return null;
    },
    restorePlan: () => {
      probeArmed = false;
      return { windowIndex: 4 };
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!probeArmed || traversalRead || recoilInjected) return null;
      recoilInjected = true;
      return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyMode: 'complete', historyTimeoutMs: 10_000, historyMaxIterations: 50
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(probe.verified, false);
  assert.equal(probe.stablePasses, 0);
  assert.equal(probe.lastFailureStage, 'poll-identity-recoil-timeout');
  assert.equal(probe.lastFailureReason, 'newer-candidate-not-restored');
  assert.ok(probe.identityRecoilCount > 0);
  assert.equal(probe.identityRecoilRestoreCount, 0);
  assert.equal(probe.identityCorrectiveRestoreAttemptCount, 3);
  assert.equal(probe.identityCorrectiveRestoreWheelCount, 3);
  assert.equal(probe.identityCorrectiveRestoreRetryCount, 3);
  assert.equal(probe.identityCorrectiveRestoreMaxRetries, 3);
  assert.equal(probe.identityCorrectiveRestoreBudgetExhaustedCount, 1);
  assert.equal(correctiveWheelCalls, 3);
  assert.equal(correctiveOlderWheels, 3);
  assert.equal(correctiveNewerWheels, 0);
  assert.equal(probe.identityCorrectiveRestoreOlderProgressCount, 0);
  assert.equal(probe.identityCorrectiveRestoreUnresolvedCount, 0);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
});

test('chatgpt-controller: multiple newer recoil windows keep the original candidate baseline until restoration', async () => {
  const candidate = Array.from({ length: 12 }, (_, index) => index);
  const newer = Array.from({ length: 10 }, (_, index) => index + 4);
  const newerAgain = Array.from({ length: 10 }, (_, index) => index + 6);
  const newest = Array.from({ length: 10 }, (_, index) => index + 8);
  let probeArmed = false;
  let pollCount = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 3,
    windowRanges: [candidate, newer, newerAgain, newest],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: currentDomUnitIdentity,
    mouseWheelPlan: ({ deltaY, windowIndex }) => {
      if (!probeArmed && deltaY < 0 && windowIndex === 0) {
        probeArmed = true;
        return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      }
      return null;
    },
    restorePlan: () => {
      probeArmed = false;
      return { windowIndex: 3 };
    },
    virtualizerTopOffsetPlan: ({ traversalRead }) => {
      if (!probeArmed || traversalRead) return null;
      pollCount += 1;
      if (pollCount === 1) return { windowIndex: 1, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      if (pollCount === 2) return { windowIndex: 2, scrollTop: 0, virtualizerTopOffsetPx: 0 };
      return { windowIndex: 0, scrollTop: 0, virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 20_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 50
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.equal(result.history.startReached, true, JSON.stringify(result.history));
  assert.equal(probe.verified, true);
  assert.equal(probe.stablePasses, 3);
  assert.ok(probe.identityRecoilCount >= 2);
  assert.ok(probe.identityRecoilRestoreCount >= 1);
  assert.equal(probe.progressCount, 0);
  assert.equal(probe.materializationProgressCount, 0);
});

test('chatgpt-controller: virtualized-origin probe fails closed when a current turn has no durable identity', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: ({ position }) => position === 3 ? { messageId: null, turnId: null } : null
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, false);
});

test('chatgpt-controller: virtualized-origin probe fails closed on duplicate provider identity', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    turnIdentityPlan: ({ position }) => position === 0 || position === 1
      ? { messageId: 'duplicate-message', turnId: null }
      : null
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 25_000, historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, false);
});

test('chatgpt-controller: materialization states are excluded from origin boundary count', async () => {
  const olderRanges = [
    [-3, -2, -1, 0, 1, 2, 3, 4],
    [-8, -7, -6, -5, -4, -3, -2, -1]
  ];
  let materializationIndex = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 9, 10, 11], [8, 9, 10, 11, 12, 13, 14, 15]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    olderMaterializationPlan: ({ windowIndex }) => {
      if (windowIndex !== 0 || materializationIndex >= olderRanges.length) return null;
      return { prependRange: olderRanges[materializationIndex++], virtualizerTopOffsetPx: 0 };
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1000, maxTotalChars: 10_000,
    historyTimeoutMs: 25_000, historyMaxIterations: 3
  });
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, false);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.boundaryCount, 1);
  assert.ok(result.history.diagnostics.virtualizedOriginProbe.progressCount > 0);
});

test('chatgpt-controller: unstable virtualized-origin probe fails closed', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    olderMaterializationPlan: ({ attempt }) => attempt >= 3 ? { loading: true, virtualizerTopOffsetPx: 0 } : null
  });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000,
    historyMode: 'complete', historyTimeoutMs: 10_000, historyMaxIterations: 30
  });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-virtualized-origin-unproven');
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.verified, false);
  assert.ok(result.history.diagnostics.virtualizedOriginProbe.attempts > 0);
  assert.equal(result.history.scrollRestored, true);
  assert.equal(result.history.diagnostics.windowLifecycle.restoreVerified, true);
});

test('chatgpt-controller: bounded top materialization wait accepts delayed current-DOM offset progress', async () => {
  let materializationPolls = 0;
  let materializationArmed = false;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 1,
    windowRanges: [[0, 1, 2, 3], [0, 1, 2, 3], [1, 2, 3, 4]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 1_600,
    restorePlan: () => {
      materializationPolls = 0;
      return { virtualizerTopOffsetPx: 1_600 };
    },
    mouseWheelPlan: ({ attempt }) => {
      if (attempt >= 2) materializationArmed = true;
      return null;
    },
    virtualizerTopOffsetPlan: ({ traversalRead, currentOffset, windowIndex }) => {
      if (materializationArmed && windowIndex === 0 && !traversalRead && currentOffset > 0) {
        materializationPolls += 1;
        return { virtualizerTopOffsetPx: materializationPolls >= 3 ? 0 : currentOffset };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.topMaterialization.attempted, true);
  assert.equal(result.history.diagnostics.topMaterialization.attempts, 1);
  assert.ok(result.history.diagnostics.topMaterialization.polls >= 3);
  assert.equal(result.history.diagnostics.topMaterialization.progressObserved, true);
  assert.ok(result.history.diagnostics.virtualizerOffsetProgressCount > 0);
  assert.equal(result.history.diagnostics.startProofMode, 'virtualized-origin');
});

test('chatgpt-controller: complete history proves an already-tail start without a native down round trip', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 4 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.diagnostics.firstNativeUp.changed, true);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(result.history.diagnostics.tailEntry.mode, 'direct-bottom');
  assert.equal(result.history.diagnostics.tailRecheck.mode, 'bottom');
  assert.equal(result.history.diagnostics.tailRecheck.signatureMode, 'semantic-role-text-digest');
  assert.equal(result.history.diagnostics.tailRecheck.verified, true);
  assert.ok(result.history.diagnostics.tailRecheck.baselineEvidence.length <= 5);
  assert.ok(result.history.diagnostics.tailRecheck.restoredEvidence.length <= 5);
  assert.equal(harness.events.filter((event) => event.startsWith('mouse-wheel:')).at(-1).endsWith(':0:-720'), true);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
});

test('chatgpt-controller: tail history is bounded and does not require start proof', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 4 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.deepEqual(result.turns.map((turn) => turn.index), Array.from({ length: 5 }, (_, index) => index));
  assert.ok(result.turns.every((turn, index, turns) => index === 0 || turn.index > turns[index - 1].index));
  assert.equal(result.history.mode, 'tail');
  assert.equal(result.history.complete, false);
  assert.equal(result.history.scopeComplete, true);
  assert.equal(result.history.fullHistoryComplete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.diagnostics.tailProven, true);
  assert.equal(result.history.diagnostics.tailEntry.directAttempted, true);
  assert.equal(result.history.diagnostics.tailEntry.directVerified, true);
  assert.equal(result.history.diagnostics.tailEntry.alreadyAtBottom, true);
  assert.equal(result.history.diagnostics.tailScopeStopReason, 'tail-window');
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(result.history.scrollRestored, true);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
});

test('chatgpt-controller: tail history at bottom performs no scroll mutation', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 4 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  assert.equal(result.history.scopeComplete, true);
  assert.equal(result.history.tailProven, true);
  assert.equal(result.history.diagnostics.wheelUpAttempts, 0);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(harness.getWheelCount(), 0);
  assert.equal(harness.events.includes('conversation-scroll-restore'), false);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
});

test('chatgpt-controller: minimized tail history does not normalize or restore the window', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 4, backend: 'chrome-cdp' });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  const lifecycle = result.history.diagnostics.windowLifecycle;
  assert.equal(result.history.tailProven, true);
  assert.equal(result.history.scopeComplete, true);
  assert.equal(result.history.diagnostics.wheelUpAttempts, 0);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(lifecycle.normalizationApplied, false);
  assert.equal(lifecycle.restoreVerified, true);
  assert.equal(harness.events.some((event) => event === 'window-state:normal'), false);
  assert.equal(harness.events.some((event) => event === 'window-state:minimized'), false);
});

test('chatgpt-controller: minimized tail history can position through CDP without changing window state', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, backend: 'chrome-cdp' });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  assert.equal(result.history.tailProven, true);
  assert.equal(result.history.scopeComplete, true);
  assert.equal(result.history.diagnostics.tailEntry.alreadyAtBottom, false);
  assert.equal(result.history.diagnostics.wheelUpAttempts, 0);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(harness.getWheelCount(), 0);
  assert.equal(harness.events.includes('conversation-scroll-restore'), true);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
  assert.equal(harness.events.some((event) => event.startsWith('window-state:')), false);
});

test('chatgpt-controller: minimized tail history fails closed when DOM proof is impossible', async () => {
  const harness = createNativeWheelHistoryPage({
    backend: 'chrome-cdp',
    layoutSnapshots: [
      { scroller: { candidateCount: 0 } }
    ]
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  assert.equal(result.history.tailProven, false);
  assert.equal(result.history.scopeComplete, false);
  assert.equal(result.history.reason, 'scroll-container-not-found');
  assert.equal(harness.events.some((event) => event.startsWith('window-state:')), false);
});

test('chatgpt-controller: repeated minimized idle tail polls never mutate window state or use native wheels', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 4, backend: 'chrome-cdp' });
  const controller = createController(harness.page);
  const results = [];
  for (let poll = 0; poll < 5; poll += 1) {
    results.push(await controller.readConversationTurns({ maxTurns: 100, maxCharsPerTurn: 1000, maxTotalChars: 100000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 }));
  }
  assert.equal(results.every((result) => result.history.mode === 'tail'), true);
  assert.equal(results.every((result) => result.history.tailProven && result.history.scopeComplete), true);
  assert.equal(results.every((result) => result.history.diagnostics.wheelUpAttempts === 0 && result.history.diagnostics.wheelDownAttempts === 0), true);
  assert.equal(results.every((result) => result.history.diagnostics.windowLifecycle.normalizationApplied === false), true);
  assert.equal(harness.getWheelCount(), 0);
  assert.equal(harness.events.some((event) => event.startsWith('window-state:')), false);
});

test('chatgpt-controller: tail history establishes bottom without upward traversal and restores the original position', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  assert.equal(result.history.scopeComplete, true);
  assert.equal(result.history.tailProven, true);
  assert.equal(result.history.diagnostics.tailEntry.alreadyAtBottom, false);
  assert.equal(result.history.diagnostics.wheelUpAttempts, 0);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(harness.getWheelCount(), 0);
  assert.equal(harness.events.includes('conversation-scroll-restore'), true);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
});

test('chatgpt-controller: tail history does not traverse upward for a long conversation', async () => {
  const harness = createNativeWheelHistoryPage({ windowCount: 20, initialWindow: 10 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 100, maxCharsPerTurn: 1000, maxTotalChars: 100000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  assert.equal(result.history.reason, null);
  assert.equal(result.history.scopeComplete, true);
  assert.equal(result.history.complete, false);
  assert.equal(result.history.fullHistoryComplete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.tailProven, true);
  assert.equal(result.history.snapshotStable, true);
  assert.equal(result.history.diagnostics.tailScopeStopReason, 'tail-window');
  assert.equal(result.history.diagnostics.iterationLimitReached, false);
  assert.equal(result.history.diagnostics.wheelUpAttempts, 0);
  assert.equal(harness.getWheelCount(), 0);
  assert.ok(result.turns.length < 100);
  assert.ok(result.turns.every((turn, index, turns) => index === 0 || turn.index > turns[index - 1].index));
});

test('chatgpt-controller: tail history treats a valid upward no-progress boundary as bounded scope', async () => {
  const harness = createNativeWheelHistoryPage({ windowCount: 20, initialWindow: 19, windowChanges: false });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 100, maxCharsPerTurn: 1000, maxTotalChars: 100000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  assert.equal(result.history.reason, null);
  assert.equal(result.history.scopeComplete, true);
  assert.equal(result.history.complete, false);
  assert.equal(result.history.fullHistoryComplete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.tailProven, true);
  assert.equal(result.history.snapshotStable, true);
  assert.equal(result.history.diagnostics.tailScopeStopReason, 'tail-window');
  assert.equal(result.history.diagnostics.iterationLimitReached, false);
  assert.equal(result.turns.length, 7);
  assert.equal(result.history.diagnostics.wheelUpAttempts, 0);
  assert.equal(harness.getWheelCount(), 0);
  assert.ok(result.turns.every((turn, index, turns) => index === 0 || turn.index > turns[index - 1].index));
});

test('chatgpt-controller: tail history keeps conversation changes fail-closed', async () => {
  const harness = createNativeWheelHistoryPage({ windowCount: 20, initialWindow: 19, changeUrlOnReadAt: 4 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 100, maxCharsPerTurn: 1000, maxTotalChars: 100000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  assert.equal(result.history.reason, 'conversation-changed');
  assert.equal(result.history.scopeComplete, false);
  assert.equal(result.history.tailProven, false);
});

test('chatgpt-controller: tail history keeps an unproven tail fail-closed', async () => {
  const harness = createNativeWheelHistoryPage({ nativeWheel: false });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 100, maxCharsPerTurn: 1000, maxTotalChars: 100000, historyMode: 'tail', historyTimeoutMs: 5000, historyMaxIterations: 16 });
  assert.equal(result.history.reason, 'history-native-scroll-unproven');
  assert.equal(result.history.scopeComplete, false);
  assert.equal(result.history.tailProven, false);
});

test('chatgpt-controller: low range candidate establishes direct top without another native wheel', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 4,
    positionOffset: 1,
    mouseWheelPlan: ({ attempt }) => attempt === 1 ? { windowIndex: 0, scrollTop: 100 } : null
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.diagnostics.startProven, true);
  assert.equal(result.history.diagnostics.wheelUpAttempts, 1);
  assert.equal(result.history.diagnostics.directTop.candidateDetected, true);
  assert.equal(result.history.diagnostics.directTop.candidateRangeMin, 1);
  assert.equal(result.history.diagnostics.directTop.attempted, true);
  assert.equal(result.history.diagnostics.directTop.commandSucceeded, true);
  assert.equal(result.history.diagnostics.directTop.atTopVerified, true);
  assert.equal(result.history.diagnostics.directTop.triggeredAtIteration, 1);
  assert.equal(result.history.diagnostics.startProofMode, 'one-origin');
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.attempted, false);
  assert.equal(harness.events.filter((event) => event.startsWith('mouse-wheel:')).length, 1);
});

test('chatgpt-controller: zero-origin low range candidate also establishes direct top', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 4,
    mouseWheelPlan: ({ attempt }) => attempt === 1 ? { windowIndex: 0, scrollTop: 100 } : null
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.diagnostics.startProven, true);
  assert.equal(result.history.diagnostics.directTop.candidateRangeMin, 0);
  assert.equal(result.history.diagnostics.wheelUpAttempts, 1);
  assert.equal(result.history.diagnostics.virtualizedOriginProbe.attempted, false);
});

test('chatgpt-controller: stalled native input uses direct top fallback for a live-like virtualized range', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 1,
    windowRanges: [[0, 1, 2, 3, 4, 5], [5, 6, 7, 8, 9]],
    backend: 'chrome-cdp',
    windowChanges: false,
    directTopPlan: () => ({ windowIndex: 0 })
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 10000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.nativeScrollControlProven, false);
  assert.equal(result.history.diagnostics.directTop.fallbackTriggered, true);
  assert.equal(result.history.diagnostics.directTop.fallbackReason, 'native-no-progress');
  assert.equal(result.history.diagnostics.directTop.commandSucceeded, true);
  assert.equal(result.history.diagnostics.startProven, true);
  assert.equal(result.history.diagnostics.startProofMode, 'zero-origin');
  assert.equal(result.history.scrollRestored, true);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
  assert.ok(harness.getDirectTopCount() >= 2);
});

test('chatgpt-controller: direct top fallback cannot prove start when virtualization stays above the boundary', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 1,
    windowRanges: [[2, 3, 4, 5, 6], [7, 8, 9, 10, 11]],
    windowChanges: false,
    directTopPlan: () => ({})
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-start-unproven');
  assert.equal(result.history.diagnostics.directTop.fallbackTriggered, true);
  assert.equal(result.history.diagnostics.directTop.commandSucceeded, true);
  assert.equal(result.history.diagnostics.startProven, false);
  assert.equal(result.history.scrollRestored, true);
});

test('chatgpt-controller: range min two may use direct top fallback but still requires strict start proof', async () => {
  const harness = createNativeWheelHistoryPage({
    initialWindow: 1,
    windowRanges: [[2, 3, 4, 5, 6], [2, 3, 4, 5, 6]],
    windowChanges: false
  });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.diagnostics.directTop.candidateDetected, true);
  assert.equal(result.history.diagnostics.directTop.candidateRangeMin, 2);
  assert.equal(result.history.diagnostics.directTop.fallbackTriggered, true);
  assert.equal(result.history.diagnostics.startProven, false);
  assert.equal(result.history.reason, 'history-start-unproven');
});

test('chatgpt-controller: start boundary proof accepts strict one-origin evidence without requiring contiguous positions', () => {
  const proof = conversationStartBoundaryProof({
    range: { min: 1, max: 20 },
    startBoundary: {
      firstMessagePosition: 1,
      firstMessageRole: 'user',
      positionZeroMessageNodeCount: 0,
      positionZeroMarkerInsideScrollerCount: 0,
      positionOneMessageNodeCount: 1
    }
  }, { physicalTopStable: true });
  assert.deepEqual(proof, {
    proven: true,
    mode: 'one-origin',
    rangeMin: 1,
    firstMessagePosition: 1,
    firstMessageRole: 'user',
    positionZeroMessageNodeCount: 0,
    positionZeroMarkerInsideScrollerCount: 0,
    positionOneMessageNodeCount: 1
  });
});

test('chatgpt-controller: start boundary proof rejects incomplete one-origin evidence', () => {
  const base = {
    range: { min: 1, max: 20 },
    startBoundary: {
      firstMessagePosition: 1,
      firstMessageRole: 'user',
      positionZeroMessageNodeCount: 0,
      positionZeroMarkerInsideScrollerCount: 0
    }
  };
  assert.equal(conversationStartBoundaryProof(base, { physicalTopStable: false }).proven, false);
  assert.equal(conversationStartBoundaryProof({ ...base, startBoundary: { ...base.startBoundary, firstMessageRole: 'assistant' } }, { physicalTopStable: true }).proven, false);
  assert.equal(conversationStartBoundaryProof({ ...base, startBoundary: { ...base.startBoundary, positionZeroMessageNodeCount: 1 } }, { physicalTopStable: true }).proven, false);
  assert.equal(conversationStartBoundaryProof({ ...base, startBoundary: { ...base.startBoundary, positionZeroMarkerInsideScrollerCount: 1 } }, { physicalTopStable: true }).proven, false);
  assert.equal(conversationStartBoundaryProof({ range: { min: 2, max: 20 }, startBoundary: base.startBoundary }, { physicalTopStable: true }).proven, false);
  assert.equal(conversationStartBoundaryProof({ range: { min: null, max: null }, startBoundary: base.startBoundary }, { physicalTopStable: true }).proven, false);
});

test('chatgpt-controller: complete history accepts one-origin start evidence while preserving position gaps', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, positionOffset: 1 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.diagnostics.startProven, true);
  assert.equal(result.history.diagnostics.startProofMode, 'one-origin');
  assert.equal(result.history.diagnostics.startBoundary.rangeMin, 1);
  assert.equal(result.history.diagnostics.startBoundary.firstMessagePosition, 1);
  assert.equal(result.history.diagnostics.startBoundary.firstMessageRole, 'user');
  assert.equal(result.history.diagnostics.startBoundary.positionZeroMessageNodeCount, 0);
  assert.equal(result.history.diagnostics.startBoundary.positionZeroMarkerInsideScrollerCount, 0);
});

test('chatgpt-controller: complete history remains incomplete when the UI start position is not proven', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, positionHints: false });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.reason, 'history-start-unproven');
});

test('chatgpt-controller: complete history never treats missing position hints as start proof', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, positionHints: false });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-start-unproven');
});

test('chatgpt-controller: complete history detects position gaps and conflicts', async () => {
  const gap = mergeConversationSnapshots([
    [{ role: 'user', text: 'turn-10', messageId: 'm10', positionHint: 10 }, { role: 'assistant', text: 'turn-14', messageId: 'm14', positionHint: 14 }],
    [{ role: 'user', text: 'turn-0', messageId: 'm0', positionHint: 0 }, { role: 'assistant', text: 'turn-4', messageId: 'm4', positionHint: 4 }]
  ]);
  assert.equal(gap.continuous, false);
  const samePosition = mergeConversationSnapshots([[
    { role: 'user', text: 'first', messageId: 'm1', positionHint: 3 },
    { role: 'assistant', text: 'different', messageId: 'm2', positionHint: 3 }
  ]]);
  assert.equal(samePosition.ambiguous, false);
  const conflict = mergeConversationSnapshots([[
    { role: 'user', text: 'first', messageId: 'm1', positionHint: 3 }
  ], [
    { role: 'user', text: 'changed', messageId: 'm1', positionHint: 3 }
  ]]);
  assert.equal(conflict.ambiguous, true);
});

test('chatgpt-controller: merge identity ignores position hints and reports real conflicts', () => {
  const samePosition = mergeConversationSnapshots([[
    { role: 'user', text: 'a', messageId: 'm-a', positionHint: 7 },
    { role: 'assistant', text: 'b', messageId: 'm-b', positionHint: 7 }
  ]]);
  assert.equal(samePosition.ambiguous, false);
  assert.deepEqual(samePosition.turns.map((turn) => turn.index), [0, 1]);
  assert.deepEqual(samePosition.turns.map((turn) => turn.text), ['a', 'b']);
  assert.deepEqual(samePosition.turns.map((turn) => turn.id), ['m-a', 'm-b']);
  const gapped = mergeConversationSnapshots([
    [{ role: 'user', text: 'a', messageId: 'm-a', positionHint: 1 }, { role: 'assistant', text: 'c', messageId: 'm-c', positionHint: 9 }],
    [{ role: 'assistant', text: 'c', messageId: 'm-c', positionHint: 9 }, { role: 'user', text: 'd', messageId: 'm-d', positionHint: 16 }]
  ]);
  assert.equal(gapped.continuous, true);
  assert.deepEqual(gapped.turns.map((turn) => turn.index), [0, 1, 2]);
  assert.deepEqual(gapped.turns.map((turn) => turn.text), ['a', 'c', 'd']);
  assert.deepEqual(gapped.turns.map((turn) => turn.id), ['m-a', 'm-c', 'm-d']);
  const stableIds = mergeConversationSnapshots([[
    { role: 'user', text: 'question', messageId: 'message-1', turnId: 'turn-1', positionHint: 42 },
    { role: 'assistant', text: 'answer', messageId: null, turnId: 'turn-2', positionHint: 42 }
  ]]);
  assert.deepEqual(stableIds.turns.map((turn) => ({ id: turn.id, messageId: turn.messageId, turnId: turn.turnId })), [
    { id: 'message-1', messageId: 'message-1', turnId: 'turn-1' },
    { id: 'turn-2', messageId: null, turnId: 'turn-2' }
  ]);
  assert.equal(stableIds.ambiguous, false);
  assert.equal(stableIds.continuous, true);
  const disconnected = mergeConversationSnapshots([
    [{ role: 'user', text: 'a', messageId: 'm-a' }],
    [{ role: 'assistant', text: 'b', messageId: 'm-b' }]
  ]);
  assert.equal(disconnected.continuous, false);
  const orderConflict = mergeConversationSnapshots([
    [{ role: 'user', text: 'a', messageId: 'm-a' }, { role: 'assistant', text: 'b', messageId: 'm-b' }],
    [{ role: 'assistant', text: 'b', messageId: 'm-b' }, { role: 'user', text: 'a', messageId: 'm-a' }]
  ]);
  assert.equal(orderConflict.ambiguous, true);
  assert.ok(orderConflict.mergeDiagnostics.reasonCounts.orderConflict > 0);
  const fallbackConflict = mergeConversationSnapshots([
    [{ role: 'user', text: 'a', fingerprint: 'same' }],
    [{ role: 'assistant', text: 'b', fingerprint: 'same' }]
  ]);
  assert.equal(fallbackConflict.ambiguous, true);
  assert.ok(fallbackConflict.mergeDiagnostics.reasonCounts.fallbackIdentityConflict > 0);
  assert.equal(fallbackConflict.mergeDiagnostics.identityConflicts[0].identityKind, 'fallback');
  assert.equal(fallbackConflict.mergeDiagnostics.identityConflictSummary.durableConflictCount, 0);
  assert.doesNotMatch(JSON.stringify(fallbackConflict.mergeDiagnostics), /same/u);
  assert.doesNotMatch(JSON.stringify(fallbackConflict.mergeDiagnostics), /answer-a|answer-b/u);
});

test('chatgpt-controller: merge identity conflicts expose bounded privacy-safe diagnostics', () => {
  const makeConflict = (existing, incoming) => mergeConversationSnapshots([
    [{ role: existing.role, text: existing.text, messageId: existing.messageId, positionHint: existing.positionHint }],
    [{ role: incoming.role, text: incoming.text, messageId: incoming.messageId, positionHint: incoming.positionHint }],
  ]);
  const text = 'private-conflict-text-7d2a9c';
  const changedText = 'private-conflict-text-7d2a9c-mutated';
  const textConflict = makeConflict(
    { role: 'user', text, messageId: 'private-message-id-7d2a9c', positionHint: 1 },
    { role: 'user', text: changedText, messageId: 'private-message-id-7d2a9c', positionHint: 1 },
  );
  const textDetail = textConflict.mergeDiagnostics.identityConflicts[0];
  assert.equal(textConflict.ambiguous, true);
  assert.equal(textConflict.mergeDiagnostics.reasonCounts.durableIdentityConflict, 1);
  assert.equal(textDetail.identityKind, 'message-id');
  assert.equal(textDetail.roleChanged, false);
  assert.equal(textDetail.textChanged, true);
  assert.equal(textDetail.textRelation, 'existing-prefix-of-incoming');
  assert.equal(textDetail.existingTextLength, text.length);
  assert.equal(textDetail.incomingTextLength, changedText.length);
  assert.equal(textConflict.mergeDiagnostics.identityConflictSummary.textConflictCount, 1);
  assert.equal(textConflict.mergeDiagnostics.identityConflictSummary.existingPrefixOfIncomingCount, 1);
  const serializedTextConflict = JSON.stringify(textConflict.mergeDiagnostics);
  assert.doesNotMatch(serializedTextConflict, /private-message-id-7d2a9c/u);
  assert.doesNotMatch(serializedTextConflict, /private-conflict-text-7d2a9c/u);

  const roleConflict = makeConflict(
    { role: 'user', text: 'same-role-change-text', messageId: 'private-role-id' },
    { role: 'assistant', text: 'same-role-change-text', messageId: 'private-role-id' },
  );
  assert.equal(roleConflict.mergeDiagnostics.identityConflicts[0].roleChanged, true);
  assert.equal(roleConflict.mergeDiagnostics.identityConflicts[0].textChanged, false);

  const roleAndTextConflict = makeConflict(
    { role: 'user', text: 'role-and-text-before', messageId: 'private-role-text-id' },
    { role: 'assistant', text: 'role-and-text-after', messageId: 'private-role-text-id' },
  );
  assert.equal(roleAndTextConflict.mergeDiagnostics.identityConflicts[0].roleChanged, true);
  assert.equal(roleAndTextConflict.mergeDiagnostics.identityConflicts[0].textChanged, true);
  assert.equal(roleAndTextConflict.mergeDiagnostics.identityConflictSummary.roleAndTextConflictCount, 1);

  const prefixShrink = makeConflict(
    { role: 'user', text: 'private-long-text-8f31-extra', messageId: 'private-prefix-shrink-id' },
    { role: 'user', text: 'private-long-text-8f31', messageId: 'private-prefix-shrink-id' },
  );
  assert.equal(prefixShrink.mergeDiagnostics.identityConflicts[0].textRelation, 'incoming-prefix-of-existing');
  assert.equal(prefixShrink.mergeDiagnostics.identityConflictSummary.incomingPrefixOfExistingCount, 1);

  const unrelated = makeConflict(
    { role: 'user', text: 'private-unrelated-left', messageId: 'private-unrelated-id' },
    { role: 'user', text: 'private-unrelated-right', messageId: 'private-unrelated-id' },
  );
  assert.equal(unrelated.mergeDiagnostics.identityConflicts[0].textRelation, 'different');
  assert.equal(unrelated.mergeDiagnostics.identityConflictSummary.unrelatedTextChangeCount, 1);

  const positionOnly = mergeConversationSnapshots([
    [{ role: 'user', text: 'private-position-stable', messageId: 'private-position-id', positionHint: 1 }],
    [{ role: 'user', text: 'private-position-stable', messageId: 'private-position-id', positionHint: 9 }],
  ]);
  assert.equal(positionOnly.ambiguous, false);
  assert.equal(positionOnly.mergeDiagnostics.reasonCounts.durableIdentityConflict, 0);
  assert.deepEqual(positionOnly.mergeDiagnostics.identityConflicts, []);

  const manyConflicts = mergeConversationSnapshots([
    Array.from({ length: 10 }, (_, index) => ({ role: 'user', text: `private-many-a-${index}`, messageId: `private-many-id-${index}` })),
    Array.from({ length: 10 }, (_, index) => ({ role: 'user', text: `private-many-b-${index}`, messageId: `private-many-id-${index}` })),
  ]);
  assert.equal(manyConflicts.mergeDiagnostics.reasonCounts.durableIdentityConflict, 10);
  assert.equal(manyConflicts.mergeDiagnostics.identityConflictSummary.durableConflictCount, 10);
  assert.equal(manyConflicts.mergeDiagnostics.identityConflicts.length, 8);
  const serializedManyConflicts = JSON.stringify(manyConflicts.mergeDiagnostics);
  assert.doesNotMatch(serializedManyConflicts, /private-many-id-0/u);
  assert.doesNotMatch(serializedManyConflicts, /private-many-a-0/u);
  assert.doesNotMatch(serializedManyConflicts, /private-many-b-0/u);
});

test('chatgpt-controller: complete history window script resolves a message ancestor and exposes a native wheel target', () => {
  const source = buildConversationWindowReadScript({
    maxTurns: 10,
    maxCharsPerTurn: 1000,
    maxTotalChars: 5000
  });
  assert.match(source, /resolveConversationScroller/u);
  assert.match(source, /common\.filter\(\(node\) => !isNavigationRegion\(node\) && isScrollable\(node\)\)/u);
  assert.match(source, /getBoundingClientRect/u);
  assert.doesNotMatch(source, /scrollTop\s*=\s*target/u);
});

test('chatgpt-controller: conversation loading ignores a busy sidebar profile control', () => {
  const sidebar = { tagName: 'ASIDE' };
  const profileButton = {
    tagName: 'BUTTON', hidden: false,
    matches(selector) { return selector.includes('button'); },
    closest(selector) {
      if (selector.includes('button')) return this;
      if (selector.includes('aside') || selector.includes('sidebar')) return sidebar;
      return null;
    },
    getAttribute(name) {
      if (name === 'aria-busy') return 'true';
      if (name === 'aria-label') return 'プロフィールメニューを開く';
      return null;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40 })
  };
  const result = evaluateConversationWindowReadWithDom({ loadingNodes: [profileButton] });
  assert.equal(result.loading, false);
});

test('chatgpt-controller: conversation loading keeps a visible non-navigation progress indicator', () => {
  const progress = {
    tagName: 'DIV', hidden: false,
    matches: () => false,
    closest: () => null,
    getAttribute(name) { return name === 'role' ? 'progressbar' : null; },
    getBoundingClientRect: () => ({ left: 20, top: 20, right: 120, bottom: 28, width: 100, height: 8 })
  };
  const result = evaluateConversationWindowReadWithDom({ loadingNodes: [progress] });
  assert.equal(result.loading, true);
});

test('chatgpt-controller: document scrolling element is accepted with a real scroll range', () => {
  const result = evaluateConversationWindowReadWithDom();
  assert.equal(result.scroller.candidateCount, 1);
  assert.equal(result.scroller.selected.tagName, 'BODY');
  assert.equal(result.scroller.selected.overflowY, 'visible');
  assert.equal(result.scroller.scrollHeight > result.scroller.clientHeight, true);
});

test('chatgpt-controller: nearer overflow scroller remains preferred over document scrolling element', () => {
  const result = evaluateConversationWindowReadWithDom({
    innerScroller: { overflowY: 'auto', scrollHeight: 1_400, clientHeight: 400 }
  });
  assert.equal(result.scroller.candidateCount, 1);
  assert.equal(result.scroller.selected.id, 'conversation-scroll');
  assert.equal(result.scroller.selected.overflowY, 'auto');
});

test('chatgpt-controller: document scrolling element without a scroll range is rejected', () => {
  const result = evaluateConversationWindowReadWithDom({ documentScrollHeight: 400, documentClientHeight: 400 });
  assert.equal(result.scroller.candidateCount, 0);
  assert.equal(result.scroller.selected, null);
});

test('chatgpt-controller: ordinary visible element with a scroll range is not a scroller', () => {
  const result = evaluateConversationWindowReadWithDom({
    documentScrollHeight: 400,
    documentClientHeight: 400,
    innerScroller: { overflowY: 'visible', scrollHeight: 1_400, clientHeight: 400 }
  });
  assert.equal(result.scroller.candidateCount, 0);
  assert.equal(result.scroller.selected, null);
});

test('chatgpt-controller: document-scroller resolution enters complete-history traversal', async () => {
  const documentWindow = evaluateConversationWindowReadWithDom();
  assert.equal(documentWindow.scroller.candidateCount, 1);
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, layoutSnapshots: [documentWindow] });
  const result = await createController(harness.page).readConversationTurns({
    maxTurns: 50,
    maxCharsPerTurn: 1_000,
    maxTotalChars: 5_000,
    historyMode: 'complete',
    historyTimeoutMs: 20_000,
    historyMaxIterations: 30
  });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.reason, null);
  assert.equal(result.history.diagnostics.scroller.candidateCount, 1);
});

function createCurrentTraversalSafetyFixture() {
  let realDomRemoveCalls = 0;
  let cloneRemoveCalls = 0;
  const controls = [];
  const body = {
    tagName: 'BODY', parentElement: null, scrollHeight: 2_000, clientHeight: 800, scrollTop: 0,
    matches: () => false,
    getAttribute: () => null,
    contains(child) { return child === this || child?.parentElement === this || child?.parentElement?.parentElement === this; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1_000, bottom: 800, width: 1_000, height: 800 })
  };
  const scroller = {
    tagName: 'DIV', parentElement: body, id: 'conversation-scroll', scrollHeight: 1_600, clientHeight: 800, scrollTop: 0,
    matches: () => false,
    getAttribute: () => null,
    contains(child) {
      let current = child;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1_000, bottom: 800, width: 1_000, height: 800 })
  };
  const host = { tagName: 'DIV', parentElement: scroller, style: { marginTop: '0px' }, matches: () => false, getAttribute: () => null };
  const wrappers = [];
  const units = [];
  const contains = (root, child) => {
    let current = child;
    while (current) {
      if (current === root) return true;
      current = current.parentElement;
    }
    return false;
  };
  const makeControl = (label, clone) => {
    const control = {
      label,
      removed: false,
      matches: (selector) => selector.includes('button') || selector.includes('chatgpt-library-file-citation'),
      remove() {
        if (this.removed) return;
        this.removed = true;
        if (clone) cloneRemoveCalls += 1;
        else realDomRemoveCalls += 1;
      }
    };
    return control;
  };
  const textFor = (baseText, currentControls) => [baseText, ...currentControls.filter((control) => !control.removed).map((control) => control.label)].join('\n');
  const makeUnit = (contentTurnKey, unitIndex, role, baseText, labels = []) => {
    const unitKey = `${contentTurnKey}:${unitIndex}:${role}`;
    let contentTurn = null;
    let virtualizerWrapper = null;
    const unit = {
      tagName: 'DIV', parentElement: null,
      get innerText() { return textFor(baseText, controls.filter((control) => control.owner === this)); },
      get textContent() { return this.innerText; },
      getAttribute(name) { return name === 'data-content-search-unit-key' ? unitKey : null; },
      closest(selector) {
        if (selector === '[data-content-search-turn-key]') return contentTurn;
        if (selector === '[data-turn-key]') return virtualizerWrapper;
        return null;
      },
      contains(child) { return child === this || contains(this, child); },
      querySelectorAll() { return controls.filter((control) => control.owner === this && !control.removed); },
      cloneNode() {
        const cloneControls = labels.map((label) => makeControl(label, true));
        const clone = {
          matches: () => false,
          querySelectorAll: () => cloneControls.filter((control) => !control.removed),
          get innerText() { return textFor(baseText, cloneControls); },
          get textContent() { return this.innerText; }
        };
        return clone;
      }
    };
    for (const label of labels) {
      const control = makeControl(label, false);
      control.owner = unit;
      controls.push(control);
    }
    unit.setParents = (content, wrapper) => {
      contentTurn = content;
      virtualizerWrapper = wrapper;
    };
    return unit;
  };
  for (const [turnKey, role, unitIndex, text, labels] of [
    ['content-a', 'user', '0', 'Question', []],
    ['content-a', 'assistant', '2', 'Answer text', ['Copy', 'citation']]
  ]) {
    const wrapper = {
      tagName: 'DIV', parentElement: host, style: {},
      getAttribute(name) { return name === 'data-turn-key' ? `virtual-${turnKey}` : null; },
      closest(selector) { return selector === '[data-turn-key]' ? this : null; },
      contains(child) { return child === this || contains(this, child); },
      matches: () => false
    };
    const contentTurn = {
      tagName: 'DIV', parentElement: wrapper, style: {},
      getAttribute(name) { return name === 'data-content-search-turn-key' ? turnKey : null; },
      closest(selector) { return selector === '[data-content-search-turn-key]' ? this : selector === '[data-turn-key]' ? wrapper : null; },
      contains(child) { return child === this || contains(this, child); },
      matches: () => false
    };
    const unit = makeUnit(turnKey, unitIndex, role, text, labels);
    unit.parentElement = contentTurn;
    unit.setParents(contentTurn, wrapper);
    wrappers.push(wrapper);
    units.push(unit);
  }
  const document = {
    scrollingElement: body,
    documentElement: body,
    querySelectorAll(selector) {
      if (selector === '[data-content-search-unit-key]') return units;
      if (selector === '[data-turn-key]') return wrappers;
      if (selector.includes('[data-message-author-role="user"]') || selector.includes('[data-message-author-role="assistant"]')) return [];
      if (selector.includes('[id*="conversation-turn-"')) return [];
      return [];
    }
  };
  const context = {
    document,
    location: { href: 'https://chatgpt.com/c/traversal-side-effect-test' },
    innerWidth: 1_000,
    innerHeight: 800,
    getComputedStyle(node) { return { overflowY: node === scroller ? 'auto' : 'visible' }; }
  };
  context.globalThis = context;
  const read = () => vm.runInNewContext(buildConversationTraversalReadScript({ maxTurns: 10, maxCharsPerTurn: 1_000, maxTotalChars: 5_000 }), context);
  const structure = () => units.map((unit) => ({
    key: unit.getAttribute('data-content-search-unit-key'),
    text: unit.innerText,
    controls: controls.filter((control) => control.owner === unit && !control.removed).map((control) => control.label)
  }));
  return { read, structure, get realDomRemoveCalls() { return realDomRemoveCalls; }, get cloneRemoveCalls() { return cloneRemoveCalls; } };
}

test('chatgpt-controller: traversal reads filter current controls without mutating live DOM', () => {
  const fixture = createCurrentTraversalSafetyFixture();
  const before = fixture.structure();
  const result = fixture.read();
  assert.equal(fixture.realDomRemoveCalls, 0);
  assert.ok(fixture.cloneRemoveCalls > 0);
  assert.deepEqual(fixture.structure(), before);
  assert.deepEqual(Array.from(result.turns, (turn) => [turn.role, turn.messageId, turn.textLength]), [
    ['user', 'content-a:0:user', 8],
    ['assistant', 'content-a:2:assistant', 11]
  ]);
  assert.equal(result.turns.length, 2);
});

test('chatgpt-controller: repeated traversal reads remain structurally and semantically stable', () => {
  const fixture = createCurrentTraversalSafetyFixture();
  const before = fixture.structure();
  const first = fixture.read();
  const afterFirst = fixture.structure();
  const second = fixture.read();
  assert.deepEqual(afterFirst, before);
  assert.deepEqual(fixture.structure(), before);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(fixture.realDomRemoveCalls, 0);
  assert.equal(fixture.cloneRemoveCalls, 4);
});

test('chatgpt-controller: current content-search units normalize roles and stable identities without positions', () => {
  const { result } = evaluateCurrentDomModel({ offsetPx: 4_800 });
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.messageDomMode, 'content-search-unit');
  assert.equal(result.diagnostics.currentMessageUnitCount, 3);
  assert.equal(result.diagnostics.validCurrentMessageUnitCount, 3);
  assert.equal(result.diagnostics.malformedCurrentMessageUnitCount, 0);
  assert.equal(result.diagnostics.contentTurnKeyValidatedCount, 3);
  assert.equal(result.diagnostics.virtualizerWrapperPresentCount, 3);
  assert.equal(result.diagnostics.renderedTurnWrapperCount, 2);
  assert.equal(result.diagnostics.virtualizerTopOffsetPx, 4_800);
  assert.deepEqual(Array.from(result.records, (record) => [record.role, record.messageId, record.turnId, record.virtualizerTurnKey, record.positionHint]), [
    ['user', 'turn-a:0:user', 'turn-a', 'virtual-wrapper-a', null],
    ['assistant', 'turn-a:2:assistant', 'turn-a', 'virtual-wrapper-a', null],
    ['user', 'turn-b:0:user', 'turn-b', 'virtual-wrapper-b', null]
  ]);
  assert.equal(result.records[1].text, 'assistant answer');
});

test('chatgpt-controller: current units retain canonical text and live innerText diagnostics separately', () => {
  const fixture = evaluateCurrentDomModel({ offsetPx: 4_800 });
  const first = vm.runInNewContext(`${buildChatGPTDomModelScript()}.read()`, fixture.context);
  const second = vm.runInNewContext(`${buildChatGPTDomModelScript()}.read()`, fixture.context);
  assert.equal(first.records[0].text, 'user prompt');
  assert.equal(first.records[0].liveInnerText, 'user prompt');
  assert.equal(first.records[1].text, 'assistant answer');
  assert.equal(first.records[1].liveInnerText, 'assistant answer Copy');
  assert.deepEqual(
    first.records.map((record) => [record.messageId, record.text, record.liveInnerText]),
    second.records.map((record) => [record.messageId, record.text, record.liveInnerText])
  );
});

test('chatgpt-controller: persistent turn shell inventory distinguishes full history from partial mounted content', () => {
  const fixture = evaluatePersistentTurnShells();
  const inventory = fixture.result.diagnostics.persistentTurnShells;
  assert.deepEqual({
    shellCount: inventory.shellCount,
    parseableShellCount: inventory.parseableShellCount,
    malformedShellCount: inventory.malformedShellCount,
    minIndex: inventory.minIndex,
    maxIndex: inventory.maxIndex,
    zeroIndexCount: inventory.zeroIndexCount,
    duplicateIndexCount: inventory.duplicateIndexCount,
    domOrderStrictlyIncreasing: inventory.domOrderStrictlyIncreasing,
    contiguousFromZero: inventory.contiguousFromZero,
    firstMountedShellIndex: inventory.firstMountedShellIndex,
    lastMountedShellIndex: inventory.lastMountedShellIndex,
    mountedContentUnitCount: inventory.mountedContentUnitCount,
    mountedContentUnitWithShellCount: inventory.mountedContentUnitWithShellCount,
    mountedContentUnitWithoutShellCount: inventory.mountedContentUnitWithoutShellCount
  }, {
    shellCount: 45,
    parseableShellCount: 45,
    malformedShellCount: 0,
    minIndex: 0,
    maxIndex: 44,
    zeroIndexCount: 1,
    duplicateIndexCount: 0,
    domOrderStrictlyIncreasing: true,
    contiguousFromZero: true,
    firstMountedShellIndex: 27,
    lastMountedShellIndex: 44,
    mountedContentUnitCount: 18,
    mountedContentUnitWithShellCount: 18,
    mountedContentUnitWithoutShellCount: 0
  });
  assert.equal(inventory.mountedUniqueShellCount, 18);
  assert.equal(inventory.insideConversationScrollerCount, 45);
  assert.equal(inventory.outsideConversationScrollerCount, 0);
  assert.equal(inventory.validRoleCount, 45);
  assert.equal(inventory.invalidRoleCount, 0);
  assert.equal(inventory.zeroShellRole, 'user');
  assert.equal(inventory.mountedShellIndexOrderStrictlyIncreasing, true);
  assert.equal(inventory.mountedShellIndexesUnique, true);
  assert.equal(inventory.zeroShellHasMountedContent, false);
});

test('chatgpt-controller: persistent turn shell diagnostics report zero-height unmounted shells without mutating layout', () => {
  const shellHeights = new Map(Array.from({ length: 27 }, (_, index) => [`conversation-turn-${index}`, 0]));
  const fixture = evaluatePersistentTurnShells({ shellHeights });
  const inventory = fixture.result.diagnostics.persistentTurnShells;
  assert.ok(inventory.zeroHeightShellCount > 0);
  assert.ok(inventory.nonzeroHeightShellCount > 0);
  assert.equal(inventory.zeroShellHasMountedContent, false);
  assert.equal(inventory.contiguousFromZero, true);
});

test('chatgpt-controller: persistent turn shell continuity rejects gaps, missing zero, duplicates, reorder, and malformed IDs', () => {
  for (const [name, shellTestIds, expected] of [
    ['gap', ['conversation-turn-0', 'conversation-turn-1', 'conversation-turn-2', 'conversation-turn-4', 'conversation-turn-5'], { contiguousFromZero: false, domOrderStrictlyIncreasing: true, duplicateIndexCount: 0, malformedShellCount: 0 }],
    ['missing-zero', ['conversation-turn-3', 'conversation-turn-4'], { contiguousFromZero: false, domOrderStrictlyIncreasing: true, duplicateIndexCount: 0, malformedShellCount: 0 }],
    ['duplicate', ['conversation-turn-0', 'conversation-turn-1', 'conversation-turn-7', 'conversation-turn-7'], { contiguousFromZero: false, domOrderStrictlyIncreasing: false, duplicateIndexCount: 1, malformedShellCount: 0 }],
    ['reorder', ['conversation-turn-0', 'conversation-turn-1', 'conversation-turn-3', 'conversation-turn-2', 'conversation-turn-4'], { contiguousFromZero: true, domOrderStrictlyIncreasing: false, duplicateIndexCount: 0, malformedShellCount: 0 }],
    ['malformed', ['conversation-turn-0', 'conversation-turn-x', 'conversation-turn--1', 'conversation-turn-2-extra'], { contiguousFromZero: false, domOrderStrictlyIncreasing: true, duplicateIndexCount: 0, malformedShellCount: 3 }]
  ]) {
    const inventory = evaluatePersistentTurnShells({ shellTestIds }).result.diagnostics.persistentTurnShells;
    assert.deepEqual({ contiguousFromZero: inventory.contiguousFromZero, domOrderStrictlyIncreasing: inventory.domOrderStrictlyIncreasing, duplicateIndexCount: inventory.duplicateIndexCount, malformedShellCount: inventory.malformedShellCount }, expected, name);
  }
});

test('chatgpt-controller: persistent turn shell diagnostics track role validity and mounted shell association', () => {
  const fixture = evaluatePersistentTurnShells({ mountedIndices: [27, 28, 29], unitOutsideShell: true });
  const inventory = fixture.result.diagnostics.persistentTurnShells;
  assert.equal(inventory.mountedContentUnitCount, 3);
  assert.equal(inventory.mountedContentUnitWithShellCount, 2);
  assert.equal(inventory.mountedContentUnitWithoutShellCount, 1);
  assert.equal(inventory.mountedUniqueShellCount, 2);
  assert.equal(inventory.firstMountedShellIndex, 28);
  assert.equal(inventory.lastMountedShellIndex, 29);
  assert.equal(inventory.validRoleCount, 45);
  assert.equal(inventory.invalidRoleCount, 0);
});

test('chatgpt-controller: multiple content units in one shell use unique shell order metrics', () => {
  const fixture = evaluatePersistentTurnShells({
    shellTestIds: ['conversation-turn-0', 'conversation-turn-1', 'conversation-turn-2', 'conversation-turn-3'],
    mountedIndices: [2, 2, 3]
  });
  const inventory = fixture.result.diagnostics.persistentTurnShells;
  assert.equal(inventory.mountedContentUnitCount, 3);
  assert.equal(inventory.mountedContentUnitWithShellCount, 3);
  assert.equal(inventory.mountedContentUnitWithoutShellCount, 0);
  assert.equal(inventory.mountedUniqueShellCount, 2);
  assert.equal(inventory.firstMountedShellIndex, 2);
  assert.equal(inventory.lastMountedShellIndex, 3);
  assert.equal(inventory.mountedShellIndexesUnique, true);
  assert.equal(inventory.mountedShellIndexOrderStrictlyIncreasing, true);
});

test('chatgpt-controller: persistent turn shell role conflicts are diagnostic-only and fail the role count', () => {
  const fixture = evaluatePersistentTurnShells({ shellRoles: new Map([[0, 'system'], [1, null]]) });
  const inventory = fixture.result.diagnostics.persistentTurnShells;
  assert.equal(inventory.validRoleCount, 43);
  assert.equal(inventory.invalidRoleCount, 1);
  assert.equal(inventory.unknownRoleCount, 1);
  assert.equal(inventory.zeroShellRole, null);
  assert.equal(fixture.result.valid, true);
});

test('chatgpt-controller: zero shell role is a role value and unknown roles have a separate count', () => {
  const userInventory = evaluatePersistentTurnShells({ shellRoles: new Map([[0, 'user']]) }).result.diagnostics.persistentTurnShells;
  const assistantInventory = evaluatePersistentTurnShells({ shellRoles: new Map([[0, 'assistant']]) }).result.diagnostics.persistentTurnShells;
  const unresolvedInventory = evaluatePersistentTurnShells({ shellRoles: new Map([[0, null]]) }).result.diagnostics.persistentTurnShells;
  assert.equal(userInventory.zeroShellRole, 'user');
  assert.equal(assistantInventory.zeroShellRole, 'assistant');
  assert.equal(unresolvedInventory.zeroShellRole, null);
  assert.equal(unresolvedInventory.unknownRoleCount, 1);
});

test('chatgpt-controller: persistent shell diagnostics surface in window state and contain no identity leakage', () => {
  const fixture = evaluatePersistentTurnShells();
  const state = fixture.readWindow();
  assert.deepEqual(state.startBoundary.virtualizedOrigin.persistentTurnShells, fixture.result.diagnostics.persistentTurnShells);
  const serialized = JSON.stringify(state.startBoundary.virtualizedOrigin.persistentTurnShells);
  assert.equal(serialized.includes('provider-sentinel-should-not-leak'), false);
  assert.equal(serialized.includes('data-content-search-unit-key'), false);
  assert.equal(serialized.includes('virtualizer'), false);
  assert.equal(serialized.includes('['), false);
});

test('chatgpt-controller: persistent shell inventory is retained on bounded origin probe diagnostics', async () => {
  const persistentTurnShells = {
    observed: true,
    shellCount: 45,
    parseableShellCount: 45,
    malformedShellCount: 0,
    duplicateIndexCount: 0,
    minIndex: 0,
    maxIndex: 44,
    zeroIndexCount: 1,
    domOrderStrictlyIncreasing: true,
    contiguousFromZero: true,
    validRoleCount: 45,
    invalidRoleCount: 0,
    zeroShellRole: 0,
    insideConversationScrollerCount: 45,
    outsideConversationScrollerCount: 0,
    mountedContentUnitCount: 8,
    mountedContentUnitWithShellCount: 8,
    mountedContentUnitWithoutShellCount: 0,
    mountedUniqueShellCount: 8,
    firstMountedShellIndex: 37,
    lastMountedShellIndex: 44,
    mountedShellIndexOrderStrictlyIncreasing: true,
    mountedShellIndexesUnique: true,
    zeroShellHasMountedContent: false,
    nonzeroHeightShellCount: 8,
    zeroHeightShellCount: 37
  };
  const harness = createNativeWheelHistoryPage({
    initialWindow: 0,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    persistentTurnShells
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1_000, maxTotalChars: 10_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 30
  });
  assert.deepEqual(result.history.diagnostics.virtualizedOriginProbe.persistentTurnShells, persistentTurnShells);
  assert.equal(result.history.startReached, true);
});

test('chatgpt-controller: bounded origin probe diagnostics follow the last valid candidate observation', async () => {
  const candidateA = {
    observed: true,
    shellCount: 45,
    parseableShellCount: 45,
    malformedShellCount: 0,
    duplicateIndexCount: 0,
    minIndex: 0,
    maxIndex: 44,
    zeroIndexCount: 1,
    domOrderStrictlyIncreasing: true,
    contiguousFromZero: true,
    validRoleCount: 45,
    invalidRoleCount: 0,
    unknownRoleCount: 0,
    zeroShellRole: 'user',
    insideConversationScrollerCount: 45,
    outsideConversationScrollerCount: 0,
    mountedContentUnitCount: 8,
    mountedContentUnitWithShellCount: 8,
    mountedContentUnitWithoutShellCount: 0,
    mountedUniqueShellCount: 8,
    firstMountedShellIndex: 20,
    lastMountedShellIndex: 30,
    mountedShellIndexOrderStrictlyIncreasing: true,
    mountedShellIndexesUnique: true,
    zeroShellHasMountedContent: false,
    nonzeroHeightShellCount: 8,
    zeroHeightShellCount: 37
  };
  const candidateB = { ...candidateA, firstMountedShellIndex: 5, lastMountedShellIndex: 15 };
  let phase = 0;
  const harness = createNativeWheelHistoryPage({
    initialWindow: 2,
    windowRanges: [[0, 1, 2, 3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 9, 10, 11], [8, 9, 10, 11, 12, 13, 14, 15]],
    positionHints: false,
    currentDom: true,
    virtualizerTopOffsetPx: 0,
    persistentTurnShells: () => phase === 0 ? candidateA : candidateB,
    olderMaterializationPlan: ({ windowIndex }) => {
      if (windowIndex === 0 && phase === 0) {
        phase = 1;
        return { prependRange: [-4, -3, -2, -1, 0, 1, 2, 3], virtualizerTopOffsetPx: 0 };
      }
      return null;
    }
  });
  const result = await createController(harness.page).readConversationWindows({
    maxTurnsPerWindow: 50, maxCharsPerTurn: 1_000, maxTotalChars: 10_000,
    historyTimeoutMs: 20_000, historyMaxIterations: 40
  });
  const probe = result.history.diagnostics.virtualizedOriginProbe;
  assert.ok(probe.persistentTurnShellObservationCount >= 2);
  assert.ok(probe.persistentTurnShellObservationChangedCount >= 1);
  assert.equal(probe.persistentTurnShells.firstMountedShellIndex, 5);
  assert.equal(probe.persistentTurnShells.lastMountedShellIndex, 15);
});

test('chatgpt-controller: backend diagnostics authenticate through one bounded session request before the backend page', async () => {
  const token = 'session-token-secret-sentinel';
  const fixture = createBackendDiagnosticPage({
    sessionBody: { accessToken: token, user: { email: 'account-secret-sentinel' } },
    body: {
      conversation_id: 'backend-diagnostic-test',
      messages: [{ author: { role: 'assistant' }, content: { parts: ['backend-text-secret-sentinel'] } }],
      page_info: { next_cursor: 'cursor-secret-sentinel' }
    }
  });

  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(fixture.allCalls.length, 2);
  const sessionCall = fixture.allCalls[0];
  const backendCall = fixture.allCalls[1];
  assert.equal(sessionCall.url, '/api/auth/session');
  assert.equal(sessionCall.options.method, 'GET');
  assert.equal(sessionCall.options.credentials, 'include');
  assert.equal(sessionCall.options.cache, 'no-store');
  assert.equal(sessionCall.options.headers.Accept, 'application/json');
  assert.equal(sessionCall.options.headers.Authorization, undefined);

  const backendUrl = new URL(backendCall.url, 'https://chatgpt.com');
  assert.equal(backendUrl.pathname, '/backend-api/conversations/backend-diagnostic-test');
  assert.equal(backendUrl.searchParams.get('include_has_versions'), 'true');
  assert.equal(backendUrl.searchParams.get('num_turns'), '100');
  assert.equal(backendUrl.searchParams.has('before'), false);
  assert.equal(backendCall.options.method, 'GET');
  assert.equal(backendCall.options.credentials, 'include');
  assert.equal(backendCall.options.cache, 'no-store');
  assert.equal(backendCall.options.headers.Accept, 'application/json');
  assert.equal(backendCall.options.headers.Authorization, `Bearer ${token}`);
  assert.equal(result.httpOk, true);
  assert.equal(result.jsonParsed, true);
  assert.equal(result.mappingPresent, false);
  assert.equal(result.currentBranchResolved, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /session-token-secret-sentinel|account-secret-sentinel|backend-text-secret-sentinel|cursor-secret-sentinel/u);
});

test('chatgpt-controller: backend diagnostics fail closed before backend fetch for session failures', async () => {
  const cases = [
    { name: '401', options: { sessionStatus: 401 }, expectedStatus: 401 },
    { name: '403', options: { sessionStatus: 403 }, expectedStatus: 403 },
    { name: 'non-json', options: { sessionContentType: 'text/html', sessionResponseText: '<html>session-secret</html>' }, expectedContentType: false },
    { name: 'missing-token', options: { sessionBody: { user: { id: 'account-secret' } } }, expectedRoot: true },
    { name: 'blank-token', options: { sessionBody: { accessToken: '   ' } }, expectedRoot: true },
    { name: 'oversized', options: { sessionContentLength: String(64 * 1024 + 1) }, expectedOversize: true },
    { name: 'network', options: { sessionFetchError: Object.assign(new Error('session-network-secret'), { name: 'TypeError' }) }, expectedError: 'network' }
  ];
  for (const item of cases) {
    const fixture = createBackendDiagnosticPage(item.options);
    const result = await createController(fixture.page).readConversationBackendDiagnostics();
    assert.equal(fixture.allCalls.length, 1, `${item.name}: ${fixture.allCalls.map((call) => String(call.url)).join('|')}`);
    assert.equal(fixture.calls.length, 0, item.name);
    if (item.expectedStatus !== undefined) assert.equal(result.httpStatus, item.expectedStatus, item.name);
    if (item.expectedContentType !== undefined) assert.equal(result.contentTypeJson, item.expectedContentType, item.name);
    if (item.expectedRoot !== undefined) assert.equal(result.rootObject, item.expectedRoot, item.name);
    if (item.expectedOversize) assert.equal(result.sizeLimitExceeded, true, item.name);
    if (item.expectedError) assert.equal(result.fetchErrorKind, item.expectedError, item.name);
    assert.equal(result.jsonParsed && result.mappingNodeCount > 0, false, item.name);
    assert.doesNotMatch(JSON.stringify(result), /session-network-secret|session-secret|account-secret/u, item.name);
  }
});

test('chatgpt-controller: backend diagnostics session body timeout is bounded and does not reach backend', async () => {
  const fixture = createBackendDiagnosticPage({ sessionStallAfterReadIndex: 0 });
  const result = await createController(fixture.page).readConversationBackendDiagnostics({ timeoutMs: 1_000 });
  assert.equal(fixture.allCalls.length, 1, fixture.allCalls.map((call) => String(call.url)).join('|'));
  assert.equal(fixture.calls.length, 0);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.fetchTimedOut, true);
  assert.equal(result.fetchErrorKind, 'timeout');
  assert.equal(result.jsonParsed, false);
  assert.equal(fixture.state.sessionReadCount, 1);
  assert.equal(fixture.state.sessionCancelCount, 1);
});

test('chatgpt-controller: backend diagnostics session cap cancels before parsing or backend fetch', async () => {
  const fixture = createBackendDiagnosticPage({ sessionStreamChunks: [new Uint8Array(64 * 1024), new Uint8Array([123])] });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(fixture.allCalls.length, 1, fixture.allCalls.map((call) => String(call.url)).join('|'));
  assert.equal(fixture.calls.length, 0);
  assert.equal(result.sizeLimitExceeded, true);
  assert.equal(result.jsonParsed, false);
  assert.equal(fixture.state.sessionReadCount, 2);
  assert.equal(fixture.state.sessionCancelCount, 1);
});

test('chatgpt-controller: backend diagnostics retain the existing schema after session authentication', async () => {
  const fixture = createBackendDiagnosticPage({ body: backendMappingFixture() });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.deepEqual(Object.keys(result).sort(), [
    'attempted', 'conversationPathRecognized', 'conversationIdPresent', 'httpStatus', 'httpOk', 'contentTypeJson',
    'fetchTimedOut', 'fetchErrorKind', 'responseByteLength', 'sizeLimitExceeded', 'boundedBodyReadSupported',
    'jsonParsed', 'rootObject', 'mappingPresent', 'mappingObject', 'mappingNodeCount', 'currentNodePresent',
    'currentNodeExistsInMapping', 'responseConversationIdPresent', 'responseConversationIdMatchesUrl',
    'nodesWithMessageCount', 'nodesWithoutMessageCount', 'rootNodeCount', 'leafNodeCount', 'parentReferenceCount',
    'missingParentReferenceCount', 'childReferenceCount', 'missingChildReferenceCount', 'selfParentCount',
    'selfChildCount', 'duplicateChildReferenceCount', 'mappingGraphStructurallyValid', 'cycleDetected',
    'userMessageCount', 'assistantMessageCount', 'systemMessageCount', 'toolMessageCount', 'otherRoleMessageCount',
    'currentBranchResolved', 'currentBranchNodeCount', 'currentBranchMessageCount', 'currentBranchUserCount',
    'currentBranchAssistantCount', 'currentBranchSystemCount', 'currentBranchToolCount', 'currentBranchRootReached',
    'currentBranchCycleDetected', 'currentBranchBrokenParent', 'messagesWithTextualContentCount',
    'messagesWithoutTextualContentCount', 'currentBranchMessagesWithTextCount', 'backendAnchor1ExactMatchCount',
    'backendAnchor2ExactMatchCount', 'currentBranchAnchor1ExactMatchCount', 'currentBranchAnchor2ExactMatchCount',
    'mountedDomTurnCount', 'backendCurrentBranchMessageCount', 'backendBranchAtLeastAsLargeAsMountedDom',
    'mountedDurableIdentityMatchCount', 'mountedDurableIdentityUnmatchedCount'
  ].sort());
});

test('chatgpt-controller: backend diagnostics validate a full mapping and current branch', async () => {
  const fixture = createBackendDiagnosticPage({ body: backendMappingFixture({ branching: true, currentNode: 'assistant-branch' }), mountedDomTurnCount: 2 });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(result.jsonParsed, true);
  assert.equal(result.mappingPresent, true);
  assert.equal(result.mappingObject, true);
  assert.equal(result.mappingNodeCount, 5);
  assert.equal(result.currentBranchResolved, true);
  assert.equal(result.currentBranchRootReached, true);
  assert.equal(result.currentBranchNodeCount, 3);
  assert.equal(result.currentBranchMessageCount, 2);
  assert.equal(result.userMessageCount, 2);
  assert.equal(result.assistantMessageCount, 2);
  assert.equal(result.mappingGraphStructurallyValid, true);
  assert.equal(result.cycleDetected, false);
  assert.equal(result.responseConversationIdMatchesUrl, true);
  assert.equal(result.backendBranchAtLeastAsLargeAsMountedDom, true);
  assert.equal(fixture.calls.length, 1);
  const requestUrl = new URL(fixture.calls[0].url, 'https://chatgpt.com');
  assert.equal(requestUrl.pathname, '/backend-api/conversations/backend-diagnostic-test');
  assert.equal(requestUrl.searchParams.get('include_has_versions'), 'true');
  assert.equal(requestUrl.searchParams.get('num_turns'), '100');
  assert.equal(requestUrl.searchParams.has('before'), false);
  assert.equal(fixture.calls[0].options.method, 'GET');
  assert.equal(fixture.calls[0].options.credentials, 'include');
  assert.equal(fixture.calls[0].options.cache, 'no-store');
  assert.equal(fixture.calls[0].options.headers.Accept, 'application/json');
  assert.equal(fixture.calls[0].options.headers.Authorization, 'Bearer session-access-token-sentinel');
});

test('chatgpt-controller: paginated backend diagnostics aggregate only the first page without changing the response schema', async () => {
  const anchor1 = '70a3a2301fc3acb64bdf29e79ee6a7fe15b81ebdfcd8ab3567d9c68387b7253a';
  const anchor2 = 'a6fb7a19f6274b7f51cf2407a1f39cb412b478b33d34820eb6331acc55de24ad';
  const fixture = createBackendDiagnosticPage({
    body: {
      conversation_id: 'backend-diagnostic-test',
      current_node: 'current-node-secret-sentinel',
      messages: [
        { id: 'message-user-id-secret', author: { role: 'user' }, content: { parts: ['anchor-one-projection'] } },
        { id: 'message-assistant-id-secret', author: { role: 'assistant' }, content: { text: 'anchor-two-projection' } },
        { id: 'message-system-id-secret', author: { role: 'system' }, content: { parts: ['  \n '] } },
        { id: 'message-tool-id-secret', author: { role: 'tool' }, content: { parts: [{ image: 'not-text' }] } },
        { id: 'message-other-id-secret', author: { role: 'developer' }, content: { parts: ['other-role-text-secret'] }, future_field: 'unknown-field-secret' },
        { id: 'message-empty-id-secret', author: { role: 'assistant' }, content: { parts: [null] } }
      ],
      page_info: { next_cursor: 'cursor-secret-sentinel' },
      future_response_field: 'future-response-secret'
    },
    digestOverrides: {
      'anchor-one-projection': anchor1,
      'anchor-two-projection': anchor2
    }
  });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();

  assert.equal(fixture.calls.length, 1);
  const request = fixture.calls[0];
  const requestUrl = new URL(request.url, 'https://chatgpt.com');
  assert.equal(requestUrl.pathname, '/backend-api/conversations/backend-diagnostic-test');
  assert.equal(requestUrl.searchParams.get('include_has_versions'), 'true');
  assert.equal(requestUrl.searchParams.get('num_turns'), '100');
  assert.equal(requestUrl.searchParams.has('before'), false);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers.Accept, 'application/json');
  assert.equal(request.options.headers.Authorization, 'Bearer session-access-token-sentinel');

  assert.equal(result.jsonParsed, true);
  assert.equal(result.rootObject, true);
  assert.equal(result.responseConversationIdMatchesUrl, true);
  assert.equal(result.mappingPresent, false);
  assert.equal(result.mappingObject, false);
  assert.equal(result.mappingNodeCount, 0);
  assert.equal(result.currentNodePresent, true);
  assert.equal(result.currentNodeExistsInMapping, false);
  assert.deepEqual({
    user: result.userMessageCount,
    assistant: result.assistantMessageCount,
    system: result.systemMessageCount,
    tool: result.toolMessageCount,
    other: result.otherRoleMessageCount,
    withText: result.messagesWithTextualContentCount,
    withoutText: result.messagesWithoutTextualContentCount,
    anchor1: result.backendAnchor1ExactMatchCount,
    anchor2: result.backendAnchor2ExactMatchCount
  }, { user: 1, assistant: 2, system: 1, tool: 1, other: 1, withText: 3, withoutText: 3, anchor1: 1, anchor2: 1 });

  assert.equal(result.currentBranchResolved, false);
  assert.equal(result.currentBranchNodeCount, 0);
  assert.equal(result.currentBranchMessageCount, 0);
  assert.equal(result.currentBranchUserCount, 0);
  assert.equal(result.currentBranchAssistantCount, 0);
  assert.equal(result.currentBranchSystemCount, 0);
  assert.equal(result.currentBranchToolCount, 0);
  assert.equal(result.currentBranchRootReached, false);
  assert.equal(result.currentBranchCycleDetected, false);
  assert.equal(result.currentBranchBrokenParent, false);
  assert.equal(result.currentBranchMessagesWithTextCount, 0);
  assert.equal(result.currentBranchAnchor1ExactMatchCount, 0);
  assert.equal(result.currentBranchAnchor2ExactMatchCount, 0);
  assert.equal(result.backendCurrentBranchMessageCount, 0);
  assert.equal(result.backendBranchAtLeastAsLargeAsMountedDom, null);

  assert.deepEqual(Object.keys(result).sort(), [
    'attempted', 'conversationPathRecognized', 'conversationIdPresent', 'httpStatus', 'httpOk', 'contentTypeJson',
    'fetchTimedOut', 'fetchErrorKind', 'responseByteLength', 'sizeLimitExceeded', 'boundedBodyReadSupported',
    'jsonParsed', 'rootObject', 'mappingPresent', 'mappingObject', 'mappingNodeCount', 'currentNodePresent',
    'currentNodeExistsInMapping', 'responseConversationIdPresent', 'responseConversationIdMatchesUrl',
    'nodesWithMessageCount', 'nodesWithoutMessageCount', 'rootNodeCount', 'leafNodeCount', 'parentReferenceCount',
    'missingParentReferenceCount', 'childReferenceCount', 'missingChildReferenceCount', 'selfParentCount',
    'selfChildCount', 'duplicateChildReferenceCount', 'mappingGraphStructurallyValid', 'cycleDetected',
    'userMessageCount', 'assistantMessageCount', 'systemMessageCount', 'toolMessageCount', 'otherRoleMessageCount',
    'currentBranchResolved', 'currentBranchNodeCount', 'currentBranchMessageCount', 'currentBranchUserCount',
    'currentBranchAssistantCount', 'currentBranchSystemCount', 'currentBranchToolCount', 'currentBranchRootReached',
    'currentBranchCycleDetected', 'currentBranchBrokenParent', 'messagesWithTextualContentCount',
    'messagesWithoutTextualContentCount', 'currentBranchMessagesWithTextCount', 'backendAnchor1ExactMatchCount',
    'backendAnchor2ExactMatchCount', 'currentBranchAnchor1ExactMatchCount', 'currentBranchAnchor2ExactMatchCount',
    'mountedDomTurnCount', 'backendCurrentBranchMessageCount', 'backendBranchAtLeastAsLargeAsMountedDom',
    'mountedDurableIdentityMatchCount', 'mountedDurableIdentityUnmatchedCount'
  ].sort());
  const serialized = JSON.stringify(result);
  for (const secret of [
    'current-node-secret-sentinel', 'message-user-id-secret', 'message-assistant-id-secret', 'message-system-id-secret',
    'message-tool-id-secret', 'message-other-id-secret', 'message-empty-id-secret', 'anchor-one-projection',
    'anchor-two-projection', 'other-role-text-secret', 'unknown-field-secret', 'future-response-secret',
    'cursor-secret-sentinel', 'Authorization', 'cookie', 'token'
  ]) assert.equal(serialized.includes(secret), false, `unexpected diagnostic leakage: ${secret}`);
});

test('chatgpt-controller: malformed paginated backend messages fail closed without leaking unknown data', async () => {
  for (const messages of [null, {}, 'messages-secret-sentinel', [{ id: 'message-id-secret' }, null]]) {
    const fixture = createBackendDiagnosticPage({
      body: { conversation_id: 'backend-diagnostic-test', messages, page_info: { next_cursor: 'cursor-secret-sentinel' } }
    });
    const result = await createController(fixture.page).readConversationBackendDiagnostics();
    assert.equal(fixture.calls.length, 1);
    assert.equal(result.mappingPresent, false);
    assert.equal(result.mappingObject, false);
    assert.equal(result.mappingNodeCount, 0);
    assert.equal(result.userMessageCount, 0);
    assert.equal(result.assistantMessageCount, 0);
    assert.equal(result.currentBranchResolved, false);
    assert.equal(result.backendCurrentBranchMessageCount, 0);
    assert.equal(result.backendBranchAtLeastAsLargeAsMountedDom, null);
    assert.doesNotMatch(JSON.stringify(result), /messages-secret-sentinel|message-id-secret|cursor-secret-sentinel/u);
  }
});

test('chatgpt-controller: backend diagnostics resolve only the selected branch', async () => {
  const fixture = createBackendDiagnosticPage({ body: backendMappingFixture({ branching: true, currentNode: 'assistant-2' }) });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(result.mappingNodeCount, 5);
  assert.equal(result.currentBranchResolved, true);
  assert.equal(result.currentBranchNodeCount, 3);
  assert.equal(result.currentBranchMessageCount, 2);
  assert.equal(result.currentBranchUserCount, 1);
  assert.equal(result.currentBranchAssistantCount, 1);
  assert.equal(result.currentBranchAnchor1ExactMatchCount, 0);
  assert.equal(result.currentBranchAnchor2ExactMatchCount, 0);
});

test('chatgpt-controller: backend diagnostics fail closed for broken parents and cycles', async () => {
  const broken = createBackendDiagnosticPage({ body: backendMappingFixture({ brokenParent: true }) });
  const brokenResult = await createController(broken.page).readConversationBackendDiagnostics();
  assert.equal(brokenResult.currentBranchResolved, false);
  assert.equal(brokenResult.currentBranchBrokenParent, true);
  assert.equal(brokenResult.missingParentReferenceCount, 1);
  assert.equal(brokenResult.mappingGraphStructurallyValid, false);

  const cyclic = createBackendDiagnosticPage({ body: backendMappingFixture({ cycle: true, currentNode: 'assistant-2' }) });
  const cyclicResult = await createController(cyclic.page).readConversationBackendDiagnostics();
  assert.equal(cyclicResult.cycleDetected, true);
  assert.equal(cyclicResult.currentBranchCycleDetected, true);
  assert.equal(cyclicResult.currentBranchResolved, false);
});

test('chatgpt-controller: backend diagnostics classify transport, content, and size failures', async () => {
  for (const status of [401, 403, 404]) {
    const failed = createBackendDiagnosticPage({ status, contentType: 'application/json', body: { error: `http-${status}-sentinel` } });
    const failedResult = await createController(failed.page).readConversationBackendDiagnostics();
    assert.equal(failedResult.httpStatus, status);
    assert.equal(failedResult.httpOk, false);
    assert.equal(failedResult.jsonParsed, false);
    assert.equal(failed.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(failedResult), /sentinel/u);
  }

  const html = createBackendDiagnosticPage({ contentType: 'text/html', responseText: '<html>login-sentinel</html>' });
  const htmlResult = await createController(html.page).readConversationBackendDiagnostics();
  assert.equal(htmlResult.httpOk, true);
  assert.equal(htmlResult.contentTypeJson, false);
  assert.equal(htmlResult.jsonParsed, false);

  const oversized = createBackendDiagnosticPage({ contentType: 'application/json', contentLength: String(20 * 1024 * 1024 + 1), responseText: '{}' });
  const oversizedResult = await createController(oversized.page).readConversationBackendDiagnostics();
  assert.equal(oversizedResult.sizeLimitExceeded, true);
  assert.equal(oversizedResult.jsonParsed, false);

  const failed = createBackendDiagnosticPage({ fetchError: Object.assign(new Error('network-sentinel'), { name: 'TypeError' }) });
  const failedResult = await createController(failed.page).readConversationBackendDiagnostics();
  assert.equal(failedResult.fetchErrorKind, 'network');
  assert.equal(failedResult.jsonParsed, false);

  const timedOut = createBackendDiagnosticPage({ fetchDelayMs: 2_000 });
  const timedOutResult = await createController(timedOut.page).readConversationBackendDiagnostics({ timeoutMs: 1_000 });
  assert.equal(timedOutResult.fetchTimedOut, true);
  assert.equal(timedOutResult.fetchErrorKind, 'timeout');
});

test('chatgpt-controller: backend diagnostic timeout covers a stalled response body', async () => {
  const fixture = createBackendDiagnosticPage({ stallAfterReadIndex: 0 });
  const result = await createController(fixture.page).readConversationBackendDiagnostics({ timeoutMs: 1_000 });
  assert.equal(result.attempted, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.httpOk, true);
  assert.equal(result.fetchTimedOut, true);
  assert.equal(result.fetchErrorKind, 'timeout');
  assert.equal(result.jsonParsed, false);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].options.method, 'GET');
  assert.equal(fixture.state.readCount, 1);
  assert.equal(fixture.state.cancelCount, 1);
  assert.equal(JSON.stringify(result).includes('backend-diagnostic-test'), false);
});

test('chatgpt-controller: backend diagnostic timeout covers a partial response body stall', async () => {
  const fixture = createBackendDiagnosticPage({ streamChunks: ['{"mapping":'], stallAfterReadIndex: 1 });
  const result = await createController(fixture.page).readConversationBackendDiagnostics({ timeoutMs: 1_000 });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.fetchTimedOut, true);
  assert.equal(result.fetchErrorKind, 'timeout');
  assert.equal(result.jsonParsed, false);
  assert.equal(fixture.state.readCount, 2);
  assert.equal(fixture.state.cancelCount, 1);
});

test('chatgpt-controller: backend diagnostic streaming cap cancels before another read', async () => {
  const fixture = createBackendDiagnosticPage({
    streamChunks: [new Uint8Array(20 * 1024 * 1024), new Uint8Array([123])]
  });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(result.sizeLimitExceeded, true);
  assert.equal(result.jsonParsed, false);
  assert.equal(fixture.state.readCount, 2);
  assert.equal(fixture.state.cancelCount, 1);
});

test('chatgpt-controller: backend diagnostic declared oversize skips the body reader', async () => {
  const fixture = createBackendDiagnosticPage({ contentLength: String(20 * 1024 * 1024 + 1) });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(result.sizeLimitExceeded, true);
  assert.equal(result.jsonParsed, false);
  assert.equal(fixture.state.readCount, 0);
  assert.equal(fixture.state.cancelCount, 0);
});

test('chatgpt-controller: backend diagnostic fails closed without a bounded stream reader', async () => {
  const fixture = createBackendDiagnosticPage({ omitReader: true, responseText: '{"mapping":{}}' });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(result.boundedBodyReadSupported, false);
  assert.equal(result.fetchErrorKind, 'stream-unavailable');
  assert.equal(result.jsonParsed, false);
  assert.equal(fixture.state.responseTextCalled, false);
  assert.doesNotMatch(JSON.stringify(result), /"mapping"\s*:/u);
});

test('chatgpt-controller: backend diagnostics expose safe ID mismatch and no raw leakage', async () => {
  const fixture = createBackendDiagnosticPage({ body: { ...backendMappingFixture(), conversation_id: 'different-conversation-sentinel' } });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(result.responseConversationIdMatchesUrl, false);
  assert.equal(typeof result.backendAnchor1ExactMatchCount, 'number');
  assert.equal(typeof result.backendAnchor2ExactMatchCount, 'number');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /sentinel/u);
  assert.doesNotMatch(serialized, /root-sentinel|assistant-2|user-1/u);
  assert.doesNotMatch(serialized, /synthetic user|synthetic assistant/u);
});

test('chatgpt-controller: backend diagnostics reject invalid conversation paths without fetching', async () => {
  const fixture = createBackendDiagnosticPage({ pathname: '/share/not-a-conversation', body: backendMappingFixture() });
  const result = await createController(fixture.page).readConversationBackendDiagnostics();
  assert.equal(result.conversationPathRecognized, false);
  assert.equal(result.conversationIdPresent, false);
  assert.equal(fixture.calls.length, 0);
});

test('chatgpt-controller: backend history reads one terminal first page and returns normalized visible turns', async () => {
  const fixture = createBackendDiagnosticPage({
    backendResponses: [{
      responseText: JSON.stringify({
        conversation_id: 'backend-diagnostic-test',
        messages: [
          { id: 'tool-hidden', author: { role: 'assistant' }, recipient: 'python', content: { parts: ['hidden tool'] } },
          { id: 'system-hidden', author: { role: 'system' }, content: { parts: ['system'] } },
          { id: 'user-1', author: { role: 'user' }, content: { parts: ['first user'] } },
          { id: 'assistant-1', author: { role: 'assistant' }, content: { parts: [{ text: 'first assistant' }] } },
          { id: 'user-2', author: { role: 'user' }, content: { parts: [{ content: ['second ', { value: 'user' }] }] } }
        ],
        page_info: { has_previous_page: false }
      })
    }]
  });
  const result = await createController(fixture.page).readConversationBackendHistory();
  assert.equal(fixture.calls.length, 1);
  const requestUrl = new URL(fixture.calls[0].url, 'https://chatgpt.com');
  assert.equal(requestUrl.pathname, '/backend-api/conversations/backend-diagnostic-test');
  assert.equal(requestUrl.searchParams.get('include_has_versions'), 'true');
  assert.equal(requestUrl.searchParams.get('num_turns'), '100');
  assert.equal(requestUrl.searchParams.has('before'), false);
  assert.equal(fixture.calls[0].options.credentials, 'include');
  assert.equal(fixture.calls[0].options.headers.Authorization, 'Bearer session-access-token-sentinel');
  assert.equal(result.history.complete, true);
  assert.equal(result.history.fullHistoryComplete, true);
  assert.equal(result.history.pageCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.turns)), [
    { index: 0, role: 'user', text: 'first user', messageId: null, turnId: null },
    { index: 1, role: 'assistant', text: 'first assistant', messageId: null, turnId: null },
    { index: 2, role: 'user', text: 'second\nuser', messageId: null, turnId: null }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /tool-hidden|system-hidden|user-1|assistant-1|session-access-token-sentinel|hidden tool/u);
});

test('chatgpt-controller: backend history prepends older pages, deduplicates identical overlap, and requires terminal pagination', async () => {
  const fixture = createBackendDiagnosticPage({
    backendResponses: [
      { responseText: JSON.stringify({ messages: [{ id: 'u2', author: { role: 'user' }, content: { parts: ['new'] } }, { id: 'a2', author: { role: 'assistant' }, content: { parts: ['new answer'] } }], page_info: { has_previous_page: true, start_cursor: 'cursor-newer' } }) },
      { responseText: JSON.stringify({ messages: [{ id: 'u1', author: { role: 'user' }, content: { parts: ['old'] } }, { id: 'u2', author: { role: 'user' }, content: { parts: ['new'] } }], page_info: { has_previous_page: false, start_cursor: null } }) }
    ]
  });
  const result = await createController(fixture.page).readConversationBackendHistory();
  assert.equal(fixture.calls.length, 2);
  const olderUrl = new URL(fixture.calls[1].url, 'https://chatgpt.com');
  assert.equal(olderUrl.pathname, '/backend-api/conversations/backend-diagnostic-test/messages');
  assert.equal(olderUrl.searchParams.get('before'), 'cursor-newer');
  assert.deepEqual(JSON.parse(JSON.stringify(result.turns)), [
    { index: 0, role: 'user', text: 'old', messageId: null, turnId: null },
    { index: 1, role: 'user', text: 'new', messageId: null, turnId: null },
    { index: 2, role: 'assistant', text: 'new answer', messageId: null, turnId: null }
  ]);
  assert.equal(result.history.pageCount, 2);
  assert.equal(result.history.totalBackendMessageCount, 3);
});

test('chatgpt-controller: backend history rejects cursor cycles and incomplete page metadata without retry or fallback', async () => {
  for (const [name, responses] of [
    ['cursor-cycle', [
      { responseText: JSON.stringify({ messages: [], page_info: { has_previous_page: true, start_cursor: 'same-cursor' } }) },
      { responseText: JSON.stringify({ messages: [], page_info: { has_previous_page: true, start_cursor: 'same-cursor' } }) }
    ]],
    ['missing-cursor', [
      { responseText: JSON.stringify({ messages: [], page_info: { has_previous_page: true } }) }
    ]],
    ['missing-page-info', [
      { responseText: JSON.stringify({ messages: [] }) }
    ]]
  ]) {
    const fixture = createBackendDiagnosticPage({ backendResponses: responses });
    await assert.rejects(() => createController(fixture.page).readConversationBackendHistory(), /conversation_backend_history_/u, name);
    assert.equal(fixture.calls.length, responses.length, name);
  }
});

test('chatgpt-controller: backend history visibility diagnostics keep raw metadata in page context', async () => {
  const fixture = createBackendDiagnosticPage({
    backendResponses: [{
      responseText: JSON.stringify({
        conversation_id: 'backend-diagnostic-test',
        messages: [
          { id: 'user-visible-sentinel', author: { role: 'user' }, content: { content_type: 'text', parts: ['visible user sentinel'] } },
          { id: 'assistant-visible-sentinel', author: { role: 'assistant' }, content: { content_type: 'multimodal_text', parts: ['visible assistant sentinel'] } },
          { id: 'thought-sentinel', author: { role: 'assistant' }, content: { content_type: 'thought', parts: ['hidden thought sentinel'] } },
          { id: 'tool-sentinel', author: { role: 'assistant' }, recipient: 'python', content: { content_type: 'execution_output', parts: ['hidden tool sentinel'] } },
          { id: 'unknown-sentinel', author: { role: 'user' }, content: { content_type: 'vendor-secret-content-type', parts: ['unknown sentinel'] } },
          { id: 'metadata-sentinel', author: { role: 'assistant' }, metadata: { command: 'metadata secret sentinel' }, content: { content_type: 'text', parts: ['command sentinel'] } }
        ],
        page_info: { has_previous_page: false }
      })
    }]
  });
  const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.allCalls.length, 2);
  assert.equal(result.attempted, true);
  assert.equal(result.backend.complete, true);
  assert.equal(result.backend.pageCount, 1);
  assert.equal(result.backendBuckets.user.text, 1);
  assert.equal(result.backendBuckets.assistant.multimodal_text, 1);
  assert.equal(result.backendBuckets.assistant.thought_or_reasoning, 1);
  assert.equal(result.backendBuckets.assistant.tool_or_execution, 1);
  assert.equal(result.backendBuckets.user.unknown, 1);
  assert.equal(result.exclusionCounts.recipientNonAll, 1);
  assert.equal(result.exclusionCounts.command, 1);
  assert.equal(result.models.CURRENT.backendCandidateTurnCount, 4);
  assert.equal(result.models.VISIBLE_TEXT_BLANKLINE.backendCandidateTurnCount, 2);
  assert.equal(result.models.VISIBLE_TEXT_CODE_BLANKLINE.backendCandidateTurnCount, 2);
  assert.equal(result.models.END_TURN_VISIBLE_TEXT_BLANKLINE.backendCandidateTurnCount, 2);
  assert.equal(result.dom.tailTurnCount, 0);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /visible user sentinel|hidden thought sentinel|user-visible-sentinel|unknown-sentinel|vendor-secret-content-type|metadata secret sentinel|session-access-token-sentinel/u);
});

test('chatgpt-controller: backend visibility buckets use exact content types and redact fabricated values', async () => {
  const fixture = createBackendDiagnosticPage({
    backendResponses: [{
      responseText: JSON.stringify({
        messages: [
          { id: 'known-text', author: { role: 'user' }, content: { content_type: 'text', parts: ['text'] } },
          { id: 'known-multimodal', author: { role: 'assistant' }, content: { content_type: 'multimodal_text', parts: ['multimodal'] } },
          { id: 'known-code', author: { role: 'assistant' }, content: { content_type: 'code', text: 'code' } },
          { id: 'known-thought', author: { role: 'assistant' }, content: { content_type: 'thought', parts: ['thought'] } },
          { id: 'known-tool', author: { role: 'assistant' }, content: { content_type: 'execution_output', parts: ['tool'] } },
          { id: 'unknown-reasoning', author: { role: 'assistant' }, content: { content_type: 'secret_reasoning_unknown_xyz', parts: ['unknown reasoning'] } },
          { id: 'unknown-tool', author: { role: 'assistant' }, content: { content_type: 'tool_private_unknown_xyz', parts: ['unknown tool'] } },
          { id: 'unknown-browser', author: { role: 'user' }, content: { content_type: 'browser_result_unknown_xyz', parts: ['unknown browser'] } },
          { id: 'missing-type', author: { role: 'user' }, content: { parts: ['missing type'] } }
        ],
        page_info: { has_previous_page: false }
      })
    }]
  });
  const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics();
  assert.equal(result.backendBuckets.user.text, 1);
  assert.equal(result.backendBuckets.assistant.multimodal_text, 1);
  assert.equal(result.backendBuckets.assistant.code, 1);
  assert.equal(result.backendBuckets.assistant.thought_or_reasoning, 1);
  assert.equal(result.backendBuckets.assistant.tool_or_execution, 1);
  assert.equal(result.backendBuckets.assistant.unknown, 2);
  assert.equal(result.backendBuckets.user.unknown, 1);
  assert.equal(result.backendBuckets.user.missing, 1);
  assert.equal(result.models.CURRENT.backendCandidateTurnCount, 9);
  assert.equal(result.models.VISIBLE_TEXT_BLANKLINE.backendCandidateTurnCount, 2);
  assert.equal(result.models.VISIBLE_TEXT_CODE_BLANKLINE.backendCandidateTurnCount, 3);
  assert.equal(result.models.END_TURN_VISIBLE_TEXT_BLANKLINE.backendCandidateTurnCount, 2);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret_reasoning_unknown_xyz|tool_private_unknown_xyz|browser_result_unknown_xyz|known-text|unknown reasoning|missing type/u);
});

test('chatgpt-controller: backend history visibility diagnostics compare grouped DOM units and legacy anchors', async () => {
  const turns = [
    { role: 'assistant', text: 'review response' },
    { role: 'user', text: 'answer one' },
    { role: 'user', text: 'answer two' }
  ];
  const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  const digestTurn = (turn, index) => digest(JSON.stringify({ index, role: turn.role, text: turn.text }));
  const probe = {
    reviewResponseIndex: 0,
    reviewResponseDigest: digest(turns[0].text),
    selectedUserTurns: [
      { index: 1, digest: digestTurn(turns[1], 1) },
      { index: 2, digest: digestTurn(turns[2], 2) }
    ],
    answerFirstIndex: 1,
    answerLastIndex: 2,
    answerLatestTurnDigest: digestTurn(turns[2], 2),
    answerTranscriptSha256: digest(JSON.stringify(turns.slice(1).map((turn, index) => ({ index: index + 1, role: turn.role, text: turn.text }))))
  };
  const fixture = createBackendDiagnosticPage({
    backendResponses: [{
      responseText: JSON.stringify({
        messages: turns.map((turn, index) => ({ id: `anchor-${index}`, author: { role: turn.role }, content: { content_type: 'text', parts: [turn.text] } })),
        page_info: { has_previous_page: false }
      })
    }]
  });
  const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics({ legacyAnchorProbe: probe });
  for (const model of Object.values(result.models)) {
    assert.equal(model.legacyAnchorProbe.reviewResponseMatches, true);
    assert.equal(model.legacyAnchorProbe.selectedTurnsMatch, true);
    assert.equal(model.legacyAnchorProbe.answerBoundaryMatches, true);
    assert.equal(model.legacyAnchorProbe.latestTurnDigestMatches, true);
    assert.equal(model.legacyAnchorProbe.transcriptMatches, true);
    assert.equal(model.legacyAnchorProbe.allMatch, true);
  }
  assert.equal(result.groupedModels.CURRENT.noMerge.domGroupedTurnCount, 0);
  assert.equal(result.groupedModels.CURRENT.assistantMergeNewline.backendTurnCount, 3);
  assert.doesNotMatch(JSON.stringify(result), /review response|answer one|anchor-0|session-access-token-sentinel/u);
});

test('chatgpt-controller: backend history visibility diagnostics compares adjacent DOM units without exposing identities', async () => {
  const fixture = createBackendDiagnosticPage({
    domRecords: [
      { role: 'assistant', turnId: 'dom-review', text: 'review response' },
      { role: 'assistant', turnId: 'dom-review', text: 'continued' },
      { role: 'user', turnId: 'dom-answer', text: 'answer one' }
    ],
    backendResponses: [{
      responseText: JSON.stringify({
        messages: [
          { id: 'backend-review', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['review response', 'continued'] } },
          { id: 'backend-answer', author: { role: 'user' }, content: { content_type: 'text', parts: ['answer one'] } }
        ],
        page_info: { has_previous_page: false }
      })
    }]
  });
  const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics();
  assert.equal(result.dom.tailTurnCount, 3);
  assert.equal(result.dom.groupedTurnCountNewline, 2);
  assert.equal(result.dom.multiUnitGroupCount, 1);
  assert.equal(result.models.TEXT_ONLY_NL.orderedExactMatchCount, 1);
  assert.equal(result.groupedModels.TEXT_ONLY_NL.noMerge.orderedExactMatchCount, 2);
  assert.equal(result.groupedModels.TEXT_ONLY_NL.assistantMergeNewline.orderedExactMatchCount, 2);
  assert.equal(result.groupedModels.TEXT_ONLY_NL.assistantMergeBlankline.orderedExactMatchCount, 1);
});

test('chatgpt-controller: actual visibility diagnostics satisfy the server grouped schema with and without anchors', async () => {
  const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  const turns = [
    { role: 'assistant', text: 'review response' },
    { role: 'user', text: 'answer' }
  ];
  const probe = {
    reviewResponseIndex: 0,
    reviewResponseDigest: digest(turns[0].text),
    selectedUserTurns: [{ index: 1, digest: digest(JSON.stringify({ index: 1, role: 'user', text: turns[1].text })) }],
    answerFirstIndex: 1,
    answerLastIndex: 1,
    answerLatestTurnDigest: digest(JSON.stringify({ index: 1, role: 'user', text: turns[1].text })),
    answerTranscriptSha256: digest(JSON.stringify([{ index: 1, role: 'user', text: turns[1].text }]))
  };
  const expectedGroupKeys = [
    'backendTurnCount',
    'domGroupedTurnCount',
    'orderedExactMatchCount',
    'exactCommonSuffixLength',
    'domUnmatchedCount',
    'backendUnmatchedCount'
  ].sort();

  for (const legacyAnchorProbe of [undefined, probe]) {
    const fixture = createBackendDiagnosticPage({
      backendResponses: [{
        responseText: JSON.stringify({
          messages: turns.map((turn, index) => ({
            id: `grouped-schema-${index}`,
            author: { role: turn.role },
            content: { content_type: 'text', parts: [turn.text] }
          })),
          page_info: { has_previous_page: false }
        })
      }]
    });
    const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics({ legacyAnchorProbe });
    assert.deepEqual(Object.keys(result).sort(), [
      'attempted',
      'backend',
      'backendBuckets',
      'branchModels',
      'branchShape',
      'dom',
      'exclusionCounts',
      'groupedModels',
      'models'
    ]);
    for (const model of Object.values(result.models)) {
      assert.equal(Object.prototype.hasOwnProperty.call(model, 'legacyAnchorProbe'), Boolean(legacyAnchorProbe));
    }
    assert.deepEqual(Object.keys(result.backend).sort(), ['complete', 'pageCount', 'terminalOldestReached', 'totalBackendMessageCount'].sort());
    assert.deepEqual(Object.keys(result.dom).sort(), ['groupedTurnCountBlankline', 'groupedTurnCountNewline', 'multiUnitGroupCount', 'tailTurnCount'].sort());
    assert.deepEqual(Object.keys(result.exclusionCounts).sort(), ['aggregateResult', 'command', 'isCompleteFalse', 'recipientNonAll', 'toolCall', 'toolCalls', 'visuallyHidden'].sort());
    for (const bucketCounts of Object.values(result.backendBuckets)) {
      assert.deepEqual(Object.keys(bucketCounts).sort(), ['code', 'missing', 'multimodal_text', 'other_known_nonvisible', 'text', 'thought_or_reasoning', 'tool_or_execution', 'unknown', 'user_editable_context'].sort());
    }
    for (const model of Object.values(result.groupedModels)) {
      for (const group of Object.values(model)) {
        assert.deepEqual(Object.keys(group).sort(), expectedGroupKeys);
        assert.equal(Object.prototype.hasOwnProperty.call(group, 'backendCandidateTurnCount'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(group, 'extraBackendUserCount'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(group, 'extraBackendAssistantCount'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(group, 'extraDomUserCount'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(group, 'extraDomAssistantCount'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(group, 'legacyAnchorProbe'), false);
      }
    }
    const serializedProducerResult = JSON.parse(JSON.stringify(result));
    const sanitized = validateAndSanitizeBackendHistoryDiagnostics(serializedProducerResult);
    assert.deepEqual(sanitized, serializedProducerResult);
  }
});

test('chatgpt-controller: actual diagnostics with both probes pass the exact server schema when branch models are null', async () => {
  const sha = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  const userText = 'schema-user-secret';
  const legacyAnchorProbe = {
    reviewResponseIndex: 0,
    reviewResponseDigest: sha('schema-review-secret'),
    selectedUserTurns: [{ index: 1, digest: sha(JSON.stringify({ index: 1, role: 'user', text: userText })) }],
    answerFirstIndex: 1,
    answerLastIndex: 1,
    answerLatestTurnDigest: sha(JSON.stringify({ index: 1, role: 'user', text: userText })),
    answerTranscriptSha256: sha(JSON.stringify([{ index: 1, role: 'user', text: userText }]))
  };
  const contentAnchorProbe = { selectedUserTurns: [{ expectedIndex: 1, contentDigest: sha(JSON.stringify({ role: 'user', text: userText })) }] };
  const fixture = createBackendDiagnosticPage({ backendResponses: [{ responseText: JSON.stringify({
    messages: [
      { id: 'schema-review-id', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['schema-review-secret'] } },
      { id: 'schema-user-id', author: { role: 'user' }, content: { content_type: 'text', parts: [userText] } }
    ], page_info: { has_previous_page: false }
  }) }] });
  const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics({ legacyAnchorProbe, contentAnchorProbe });
  assert.equal(result.branchModels, null);
  assert.equal(result.models.TEXT_ONLY_NL.contentAnchorProbe.exactExpectedIndices, true);
  assert.deepEqual(validateAndSanitizeBackendHistoryDiagnostics(JSON.parse(JSON.stringify(result))), JSON.parse(JSON.stringify(result)));
  assert.doesNotMatch(JSON.stringify(result), /schema-review-id|schema-user-id|schema-review-secret|schema-user-secret/u);
});

test('chatgpt-controller: content anchor probe localizes selected user content without returning digests', async () => {
  const contentDigest = (text) => crypto.createHash('sha256').update(JSON.stringify({ role: 'user', text: String(text || '').replace(/\r\n?/gu, '\n') }), 'utf8').digest('hex');
  const messages = [
    { id: 'loc-u0', author: { role: 'user' }, content: { content_type: 'text', parts: ['first'] } },
    { id: 'loc-a0', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['reply'] } },
    { id: 'loc-u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['selected one'] } },
    { id: 'loc-a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['reply two'] } },
    { id: 'loc-u2', author: { role: 'user' }, content: { content_type: 'text', parts: ['selected two'] } },
    { id: 'loc-a2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['final'] } }
  ];
  const run = async (selectedUserTurns, suppliedMessages = messages) => {
    const fixture = createBackendDiagnosticPage({ backendResponses: [{ responseText: JSON.stringify({ messages: suppliedMessages, page_info: { has_previous_page: false } }) }] });
    const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics({ contentAnchorProbe: { selectedUserTurns } });
    assert.equal(fixture.calls.length, 1);
    return result;
  };
  const pair = [
    { expectedIndex: 2, contentDigest: contentDigest('selected one') },
    { expectedIndex: 4, contentDigest: contentDigest('selected two') }
  ];
  const exact = await run(pair);
  const exactProbe = exact.models.TEXT_ONLY_NL.contentAnchorProbe;
  assert.deepEqual(JSON.parse(JSON.stringify(exactProbe)), {
    allPresent: true, allUnique: true, ordered: true, exactExpectedIndices: true,
    matches: [
      { expectedIndex: 2, matchCount: 1, uniqueMatchIndex: 2, deltaFromExpected: 0 },
      { expectedIndex: 4, matchCount: 1, uniqueMatchIndex: 4, deltaFromExpected: 0 }
    ],
    expectedGap: 2, resolvedGap: 2
  });

  const shiftedEarlier = await run([{ expectedIndex: 3, contentDigest: pair[0].contentDigest }]);
  assert.deepEqual(JSON.parse(JSON.stringify(shiftedEarlier.models.TEXT_ONLY_NL.contentAnchorProbe.matches[0])), { expectedIndex: 3, matchCount: 1, uniqueMatchIndex: 2, deltaFromExpected: -1 });
  const shiftedLater = await run([{ expectedIndex: 1, contentDigest: pair[0].contentDigest }]);
  assert.deepEqual(JSON.parse(JSON.stringify(shiftedLater.models.TEXT_ONLY_NL.contentAnchorProbe.matches[0])), { expectedIndex: 1, matchCount: 1, uniqueMatchIndex: 2, deltaFromExpected: 1 });

  const globalOffset = await run([
    { expectedIndex: 3, contentDigest: pair[0].contentDigest },
    { expectedIndex: 5, contentDigest: pair[1].contentDigest }
  ]);
  assert.equal(globalOffset.models.TEXT_ONLY_NL.contentAnchorProbe.expectedGap, 2);
  assert.equal(globalOffset.models.TEXT_ONLY_NL.contentAnchorProbe.resolvedGap, 2);
  assert.equal(globalOffset.models.TEXT_ONLY_NL.contentAnchorProbe.ordered, true);
  const changedGapMessages = [messages[0], messages[1], messages[2], messages[3],
    { id: 'loc-extra', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['extra'] } }, ...messages.slice(4)];
  const changedGap = await run(pair, changedGapMessages);
  assert.equal(changedGap.models.TEXT_ONLY_NL.contentAnchorProbe.expectedGap, 2);
  assert.equal(changedGap.models.TEXT_ONLY_NL.contentAnchorProbe.resolvedGap, 3);

  const duplicate = await run([{ expectedIndex: 2, contentDigest: contentDigest('selected one') }], [
    ...messages,
    { id: 'loc-u1-duplicate', author: { role: 'user' }, content: { content_type: 'text', parts: ['selected one'] } }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(duplicate.models.TEXT_ONLY_NL.contentAnchorProbe.matches[0])), { expectedIndex: 2, matchCount: 2, uniqueMatchIndex: null, deltaFromExpected: null });
  assert.equal(duplicate.models.TEXT_ONLY_NL.contentAnchorProbe.allUnique, false);

  const missing = await run([{ expectedIndex: 2, contentDigest: contentDigest('not present') }]);
  assert.equal(missing.models.TEXT_ONLY_NL.contentAnchorProbe.matches[0].matchCount, 0);
  assert.equal(missing.models.TEXT_ONLY_NL.contentAnchorProbe.allPresent, false);
  const wrongRole = await run([{ expectedIndex: 2, contentDigest: contentDigest('same text') }], [
    { id: 'wrong-role-same-text', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['same text'] } }
  ]);
  assert.equal(wrongRole.models.TEXT_ONLY_NL.contentAnchorProbe.matches[0].matchCount, 0);

  for (const result of [exact, shiftedEarlier, shiftedLater, globalOffset, changedGap, duplicate, missing, wrongRole]) {
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /selected one|selected two|loc-u|loc-a|not present|same text|session-access-token-sentinel/u);
    assert.doesNotMatch(serialized, new RegExp(contentDigest('selected one'), 'u'));
  }
});

test('chatgpt-controller: flat backend visibility models resolve current branch shape with exact aliases only', async () => {
  const messages = [
    { id: 'branch-review', parent_id: null, author: { role: 'assistant' }, end_turn: true, content: { content_type: 'text', parts: ['review'] } },
    { id: 'branch-side', parent_id: 'branch-review', author: { role: 'assistant' }, end_turn: true, content: { content_type: 'text', parts: ['side branch'] } },
    { id: 'branch-answer', parent_id: 'branch-review', author: { role: 'user' }, end_turn: true, content: { content_type: 'text', parts: ['selected answer'] } },
    { id: 'branch-final', parent_id: 'branch-answer', author: { role: 'assistant' }, end_turn: true, content: { content_type: 'text', parts: ['current response'] } }
  ];
  const sha = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  const digestTurn = (turn) => sha(JSON.stringify({ index: turn.index, role: turn.role, text: turn.text }));
  const expectedTurns = [
    { index: 0, role: 'assistant', text: 'review' },
    { index: 1, role: 'user', text: 'selected answer' }
  ];
  const legacyAnchorProbe = {
    reviewResponseIndex: 0,
    reviewResponseDigest: sha('review'),
    selectedUserTurns: [{ index: 1, digest: digestTurn(expectedTurns[1]) }],
    answerFirstIndex: 1,
    answerLastIndex: 1,
    answerLatestTurnDigest: digestTurn(expectedTurns[1]),
    answerTranscriptSha256: sha(JSON.stringify([expectedTurns[1]]))
  };
  const contentAnchorProbe = { selectedUserTurns: [{ expectedIndex: 1, contentDigest: sha(JSON.stringify({ role: 'user', text: 'selected answer' })) }] };
  const fixture = createBackendDiagnosticPage({
    domRecords: [{ role: 'assistant', turnId: 'branch-turn-0', text: 'review' }, { role: 'user', turnId: 'branch-turn-1', text: 'selected answer' }, { role: 'assistant', turnId: 'branch-turn-2', text: 'current response' }],
    backendResponses: [{ responseText: JSON.stringify({ current_node: 'branch-final', messages, page_info: { has_previous_page: false } }) }]
  });
  const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics({ legacyAnchorProbe, contentAnchorProbe });
  assert.deepEqual(JSON.parse(JSON.stringify(result.branchShape)), {
    currentNodeField: 'current_node', currentNodePresent: true, messageIdCount: 4,
    parentLinkField: 'parent_id', messagesWithParentLink: 3, parentLinksResolvable: 3, parentLinksMissingTarget: 0,
    currentNodeFound: true, currentPathResolved: true, currentPathMessageCount: 3,
    currentPathCycleDetected: false, currentPathMissingParent: false
  });
  assert.equal(result.models.END_TURN_VISIBLE_TEXT_BLANKLINE.legacyAnchorProbe.allMatch, false);
  assert.equal(result.branchModels.END_TURN_VISIBLE_TEXT_BLANKLINE.legacyAnchorProbe.allMatch, true);
  assert.equal(result.branchModels.END_TURN_VISIBLE_TEXT_BLANKLINE.contentAnchorProbe.exactExpectedIndices, true);
  assert.equal(result.branchModels.END_TURN_VISIBLE_TEXT_BLANKLINE.backendCandidateTurnCount, 3);
  assert.equal(result.models.END_TURN_VISIBLE_TEXT_BLANKLINE.backendCandidateTurnCount, 4);
  assert.deepEqual(Object.keys(result.branchShape).sort(), ['currentNodeField', 'currentNodePresent', 'messageIdCount', 'parentLinkField', 'messagesWithParentLink', 'parentLinksResolvable', 'parentLinksMissingTarget', 'currentNodeFound', 'currentPathResolved', 'currentPathMessageCount', 'currentPathCycleDetected', 'currentPathMissingParent'].sort());
  assert.deepEqual(Object.keys(result.branchModels).sort(), ['CURRENT', 'TEXT_ONLY_NL', 'TEXT_ONLY_BLANKLINE', 'VISIBLE_TEXT_NL', 'VISIBLE_TEXT_BLANKLINE', 'VISIBLE_TEXT_CODE_BLANKLINE', 'END_TURN_VISIBLE_TEXT_BLANKLINE'].sort());
  assert.doesNotMatch(JSON.stringify(result), /branch-review|branch-side|branch-answer|branch-final|side branch|selected answer|current response/u);

  const sanitized = validateAndSanitizeBackendHistoryDiagnostics(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(sanitized, JSON.parse(JSON.stringify(result)));
  const polluted = structuredClone(result);
  polluted.branchModels.END_TURN_VISIBLE_TEXT_BLANKLINE.parentValue = 'parent-secret';
  assert.throws(() => validateAndSanitizeBackendHistoryDiagnostics(polluted), /conversation_backend_history_diagnostics_response_invalid/u);
});

test('chatgpt-controller: branch diagnostics accept camel aliases and fail closed on missing targets, cycles, or alias conflicts', async () => {
  const validCamel = createBackendDiagnosticPage({ backendResponses: [{ responseText: JSON.stringify({
    currentNode: 'camel-a',
    messages: [
      { id: 'camel-u', parent: null, author: { role: 'user' }, content: { content_type: 'text', parts: ['u'] } },
      { id: 'camel-a', parentId: 'camel-u', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['a'] } }
    ], page_info: { has_previous_page: false }
  }) }] });
  const camelResult = await createController(validCamel.page).readConversationBackendHistoryDiagnostics();
  assert.equal(camelResult.branchShape.currentNodeField, 'currentNode');
  assert.equal(camelResult.branchShape.parentLinkField, 'parentId');
  assert.equal(camelResult.branchShape.currentPathResolved, true);

  const cases = [
    { body: { messages: [], page_info: { has_previous_page: false } }, shape: { currentNodeField: 'none', currentNodeFound: false, currentPathResolved: false, currentPathMessageCount: 0 } },
    { body: { current_node: 'absent-id', messages: [{ id: 'other-id', parent_id: null }], page_info: { has_previous_page: false } }, shape: { currentNodeField: 'current_node', currentNodeFound: false, currentPathResolved: false, currentPathMessageCount: 0 } },
    { body: { current_node: 'missing-parent-leaf', messages: [{ id: 'missing-parent-leaf', parent_id: 'not-present' }], page_info: { has_previous_page: false } }, shape: { currentNodeField: 'current_node', currentNodeFound: true, currentPathResolved: false, currentPathMissingParent: true, parentLinksMissingTarget: 1 } },
    { body: { current_node: 'no-parent-field', messages: [{ id: 'no-parent-field' }], page_info: { has_previous_page: false } }, shape: { currentNodeField: 'current_node', currentNodeFound: true, currentPathResolved: false, currentPathMissingParent: true } },
    { body: { current_node: 'cycle-a', messages: [{ id: 'cycle-a', parent_id: 'cycle-b' }, { id: 'cycle-b', parent_id: 'cycle-a' }], page_info: { has_previous_page: false } }, shape: { currentNodeField: 'current_node', currentNodeFound: true, currentPathResolved: false, currentPathCycleDetected: true } },
    { body: { current_node: 'alias-a', currentNode: 'alias-b', messages: [{ id: 'alias-a', parent_id: null }, { id: 'alias-b', parent_id: null }], page_info: { has_previous_page: false } }, shape: { currentNodeField: 'conflict', currentNodeFound: false, currentPathResolved: false } },
    { body: { current_node: 'parent-conflict-a', messages: [{ id: 'parent-conflict-root', parent_id: null }, { id: 'parent-conflict-a', parent_id: 'parent-conflict-root', parentId: 'different-parent' }], page_info: { has_previous_page: false } }, shape: { currentNodeField: 'current_node', currentNodeFound: true, currentPathResolved: false, parentLinkField: 'mixed' } },
    { body: { current_node: 'side-root', messages: [{ id: 'side-root', parent_id: null }, { id: 'side-leaf', parent_id: 'side-root', parentId: 'different-root' }], page_info: { has_previous_page: false } }, shape: { currentNodeField: 'current_node', currentNodeFound: true, currentPathResolved: false, parentLinkField: 'mixed' } }
  ];
  for (const { body, shape } of cases) {
    const fixture = createBackendDiagnosticPage({ backendResponses: [{ responseText: JSON.stringify(body) }] });
    const result = await createController(fixture.page).readConversationBackendHistoryDiagnostics();
    for (const [key, value] of Object.entries(shape)) assert.equal(result.branchShape[key], value, key);
    if (!result.branchShape.currentPathResolved) assert.equal(result.branchModels, null);
    assert.doesNotMatch(JSON.stringify(result), /absent-id|not-present|cycle-a|cycle-b|alias-a|alias-b|parent-conflict|different-parent/u);
  }

  const duplicateId = createBackendDiagnosticPage({ backendResponses: [{ responseText: JSON.stringify({
    current_node: 'duplicate-id',
    messages: [
      { id: 'duplicate-id', author: { role: 'user' }, content: { parts: ['one'] } },
      { id: 'duplicate-id', author: { role: 'user' }, content: { parts: ['different'] } }
    ], page_info: { has_previous_page: false }
  }) }] });
  await assert.rejects(() => createController(duplicateId.page).readConversationBackendHistoryDiagnostics(), /conversation_backend_history_diagnostics_duplicate_conflict/u);
  assert.equal(duplicateId.calls.length, 1);
});

test('chatgpt-controller: backend history visibility diagnostics follows bounded older pages once and fails closed on cursor cycles', async () => {
  const paginated = createBackendDiagnosticPage({
    backendResponses: [
      { responseText: JSON.stringify({ messages: [{ id: 'newer', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['newer'] } }], page_info: { has_previous_page: true, start_cursor: 'cursor-sentinel' } }) },
      { responseText: JSON.stringify({ messages: [{ id: 'older', author: { role: 'user' }, content: { content_type: 'text', parts: ['older'] } }], page_info: { has_previous_page: false } }) }
    ]
  });
  const result = await createController(paginated.page).readConversationBackendHistoryDiagnostics();
  assert.equal(result.backend.complete, true);
  assert.equal(result.backend.pageCount, 2);
  assert.equal(paginated.calls.length, 2);
  assert.equal(new URL(paginated.calls[0].url, 'https://chatgpt.com').searchParams.has('before'), false);
  assert.equal(new URL(paginated.calls[1].url, 'https://chatgpt.com').searchParams.get('before'), 'cursor-sentinel');
  assert.doesNotMatch(JSON.stringify(result), /cursor-sentinel|newer|older|session-access-token-sentinel/u);

  const cycle = createBackendDiagnosticPage({ backendResponses: [
    { responseText: JSON.stringify({ messages: [], page_info: { has_previous_page: true, start_cursor: 'cycle-sentinel' } }) },
    { responseText: JSON.stringify({ messages: [], page_info: { has_previous_page: true, start_cursor: 'cycle-sentinel' } }) }
  ] });
  await assert.rejects(() => createController(cycle.page).readConversationBackendHistoryDiagnostics(), /conversation_backend_history_diagnostics_cursor_cycle/u);
  assert.equal(cycle.calls.length, 2);
});

test('chatgpt-controller: backend history rejects contradictory pagination aliases and accepts equivalent aliases', async () => {
  for (const pageInfo of [
    { has_previous_page: false, hasPreviousPage: true },
    { has_previous_page: true, hasPreviousPage: false, start_cursor: 'cursor-a' },
    { has_previous_page: true, hasPreviousPage: true, start_cursor: 'cursor-a', startCursor: 'cursor-b' },
  ]) {
    const fixture = createBackendDiagnosticPage({
      backendResponses: [{ responseText: JSON.stringify({ messages: [], page_info: pageInfo }) }],
    });
    await assert.rejects(
      () => createController(fixture.page).readConversationBackendHistory(),
      /conversation_backend_history_(page_info|cursor)_conflict/u,
    );
    assert.equal(fixture.calls.length, 1);
  }

  for (const pageInfo of [
    { has_previous_page: false, hasPreviousPage: false, start_cursor: 'same-cursor', startCursor: 'same-cursor' },
    { hasPreviousPage: false },
  ]) {
    const fixture = createBackendDiagnosticPage({
      backendResponses: [{ responseText: JSON.stringify({ messages: [], page_info: pageInfo }) }],
    });
    const result = await createController(fixture.page).readConversationBackendHistory();
    assert.equal(result.history.complete, true);
    assert.equal(fixture.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /same-cursor|session-access-token-sentinel/u);
  }
});

test('chatgpt-controller: backend history validates both outer page-info aliases independently', async () => {
  for (const { pageInfo, expected } of [
    {
      pageInfo: {
        page_info: { has_previous_page: false },
        pageInfo: { hasPreviousPage: true, startCursor: 'older' },
      },
      expected: /conversation_backend_history_page_info_conflict/u,
    },
    {
      pageInfo: {
        page_info: { has_previous_page: true, start_cursor: 'a' },
        pageInfo: { hasPreviousPage: true, startCursor: 'b' },
      },
      expected: /conversation_backend_history_cursor_conflict/u,
    },
    {
      pageInfo: {
        page_info: { has_previous_page: false },
        pageInfo: { hasPreviousPage: 'false' },
      },
      expected: /conversation_backend_history_page_info_invalid/u,
    },
  ]) {
    const fixture = createBackendDiagnosticPage({
      backendResponses: [{ responseText: JSON.stringify({ messages: [], ...pageInfo }) }],
    });
    await assert.rejects(
      () => createController(fixture.page).readConversationBackendHistory(),
      expected,
    );
    assert.equal(fixture.calls.length, 1);
  }

  for (const pageInfo of [
    { has_previous_page: false, start_cursor: 'abc', startCursor: null },
    { has_previous_page: false, start_cursor: null, startCursor: 'abc' },
  ]) {
    const fixture = createBackendDiagnosticPage({
      backendResponses: [{ responseText: JSON.stringify({ messages: [], page_info: pageInfo }) }],
    });
    await assert.rejects(
      () => createController(fixture.page).readConversationBackendHistory(),
      /conversation_backend_history_cursor_conflict/u,
    );
    assert.equal(fixture.calls.length, 1);
  }

  const equivalentOuter = createBackendDiagnosticPage({
    backendResponses: [
      {
        responseText: JSON.stringify({
          messages: [],
          page_info: { has_previous_page: true, start_cursor: ' same ' },
          pageInfo: { hasPreviousPage: true, startCursor: 'same' },
        }),
      },
      { responseText: JSON.stringify({ messages: [], pageInfo: { hasPreviousPage: false } }) },
    ],
  });
  const paginated = await createController(equivalentOuter.page).readConversationBackendHistory();
  assert.equal(equivalentOuter.calls.length, 2);
  assert.equal(paginated.history.pageCount, 2);

  for (const pageInfo of [
    { page_info: { has_previous_page: false }, pageInfo: { hasPreviousPage: false } },
    { page_info: { has_previous_page: false, start_cursor: null, startCursor: null } },
    { page_info: { has_previous_page: false, start_cursor: ' abc ', startCursor: 'abc' } },
  ]) {
    const fixture = createBackendDiagnosticPage({
      backendResponses: [{ responseText: JSON.stringify({ messages: [], ...pageInfo }) }],
    });
    const result = await createController(fixture.page).readConversationBackendHistory();
    assert.equal(result.history.complete, true);
    assert.equal(fixture.calls.length, 1);
  }
});

test('chatgpt-controller: current logical content-turn identity is independent of the outer virtualizer key', () => {
  const { result } = evaluateCurrentDomModel({ offsetPx: 0 });
  assert.equal(result.valid, true);
  assert.deepEqual(Array.from(result.records, (record) => ({
    messageId: record.messageId,
    turnId: record.turnId,
    virtualizerTurnKey: record.virtualizerTurnKey
  })), [
    { messageId: 'turn-a:0:user', turnId: 'turn-a', virtualizerTurnKey: 'virtual-wrapper-a' },
    { messageId: 'turn-a:2:assistant', turnId: 'turn-a', virtualizerTurnKey: 'virtual-wrapper-a' },
    { messageId: 'turn-b:0:user', turnId: 'turn-b', virtualizerTurnKey: 'virtual-wrapper-b' }
  ]);
});

test('chatgpt-controller: current units fail closed without exact logical content-turn binding or virtualizer structure', () => {
  for (const options of [
    { missingContentTurn: true },
    { mismatchedContentTurn: true },
    { missingVirtualizerWrapper: true }
  ]) {
    const { result } = evaluateCurrentDomModel(options);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'message-dom-invalid');
    assert.equal(result.records.length, 0);
  }
});

test('chatgpt-controller: malformed current unit keys fail closed', () => {
  const { result } = evaluateCurrentDomModel({ malformed: true });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'message-dom-invalid');
  assert.equal(result.diagnostics.malformedCurrentMessageUnitCount, 1);
  assert.equal(result.records.length, 0);
});

test('chatgpt-controller: mixed legacy and current markers do not duplicate a logical message', () => {
  const { result } = evaluateCurrentDomModel({ legacy: true, offsetPx: 0 });
  assert.equal(result.valid, true);
  assert.equal(result.diagnostics.messageDomMode, 'mixed');
  assert.equal(result.diagnostics.mixedRepresentationConflict, false);
  assert.equal(result.records.length, 3);
  assert.deepEqual(Array.from(result.records, (record) => record.messageId), ['turn-a:0:user', 'turn-a:2:assistant', 'turn-b:0:user']);
});

test('chatgpt-controller: current units resolve the shared conversation scroller and visible window', () => {
  const fixture = evaluateCurrentDomModel({ offsetPx: 4_800 });
  const result = vm.runInNewContext(buildConversationWindowReadScript({ maxTurns: 10, maxCharsPerTurn: 1_000, maxTotalChars: 5_000 }), fixture.context);
  assert.equal(result.scroller.candidateCount, 1);
  assert.equal(result.scroller.selected.id, 'conversation-scroll');
  assert.equal(result.scroller.selected.overflowY, 'auto');
  assert.equal(result.turns.length, 3);
  assert.deepEqual(Array.from(result.turns, (turn) => turn.positionHint), [null, null, null]);
  assert.equal(result.scroller.messageDomMode, 'content-search-unit');
});

test('chatgpt-controller: current virtualizer offset above zero cannot prove conversation start', () => {
  const fixture = evaluateCurrentDomModel({ offsetPx: 4_800 });
  const state = vm.runInNewContext(buildConversationWindowReadScript({ maxTurns: 10, maxCharsPerTurn: 1_000, maxTotalChars: 5_000 }), fixture.context);
  const proof = conversationStartBoundaryProof({ ...state, urlStable: true }, { physicalTopStable: true });
  assert.equal(proof.proven, false);
  assert.equal(proof.mode, null);
});

test('chatgpt-controller: current virtualizer origin requires verified active older probes', () => {
  const fixture = evaluateCurrentDomModel({ offsetPx: 0 });
  const state = vm.runInNewContext(buildConversationWindowReadScript({ maxTurns: 10, maxCharsPerTurn: 1_000, maxTotalChars: 5_000 }), fixture.context);
  const proof = conversationStartBoundaryProof({ ...state, urlStable: true }, { physicalTopStable: true });
  assert.equal(proof.proven, false);
  assert.equal(proof.mode, null);
  assert.equal(proof.virtualizedOriginCandidate, true);
  const verified = conversationStartBoundaryProof({ ...state, urlStable: true }, { physicalTopStable: true, virtualizedOriginProbeVerified: true });
  assert.equal(verified.proven, true);
  assert.equal(verified.mode, 'virtualized-origin');
});

test('chatgpt-controller: current stable unit IDs merge overlapping virtualized windows', () => {
  const result = mergeConversationSnapshots([
    [
      { role: 'user', text: 'first', messageId: 'turn-a:0:user', turnId: 'turn-a', positionHint: null },
      { role: 'assistant', text: 'answer', messageId: 'turn-a:2:assistant', turnId: 'turn-a', positionHint: null }
    ],
    [
      { role: 'assistant', text: 'answer', messageId: 'turn-a:2:assistant', turnId: 'turn-a', positionHint: null },
      { role: 'user', text: 'second', messageId: 'turn-b:0:user', turnId: 'turn-b', positionHint: null }
    ]
  ]);
  assert.equal(result.ambiguous, false);
  assert.equal(result.turns.length, 3);
  assert.deepEqual(result.turns.map((turn) => turn.messageId), ['turn-a:0:user', 'turn-a:2:assistant', 'turn-b:0:user']);
});

test('chatgpt-controller: virtualizer remounts do not duplicate stable logical current units', () => {
  const result = mergeConversationSnapshots([
    [
      { role: 'assistant', text: 'answer', messageId: 'content-a:2:assistant', turnId: 'content-a', virtualizerTurnKey: 'virtual-A1', positionHint: null }
    ],
    [
      { role: 'assistant', text: 'answer', messageId: 'content-a:2:assistant', turnId: 'content-a', virtualizerTurnKey: 'virtual-A2', positionHint: null }
    ]
  ]);
  assert.equal(result.ambiguous, false);
  assert.equal(result.turns.length, 1);
  assert.deepEqual({
    role: result.turns[0].role,
    text: result.turns[0].text,
    messageId: result.turns[0].messageId,
    turnId: result.turns[0].turnId
  }, {
    role: 'assistant',
    text: 'answer',
    messageId: 'content-a:2:assistant',
    turnId: 'content-a'
  });
});

test('chatgpt-controller: complete history backfills from the tail through virtualization and restores a middle position', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2 });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 20_000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, true);
  assert.equal(result.history.diagnostics.scroller.candidateCount, 1);
  assert.equal(result.history.diagnostics.wheelDownAttempts, 0);
  assert.equal(result.history.diagnostics.tailEntry.mode, 'direct-bottom');
  assert.equal(result.history.diagnostics.tailEntry.directVerified, true);
  assert.ok(result.history.diagnostics.wheelUpAttempts > 0);
  assert.equal(result.history.diagnostics.positions.observedMin, 0);
  assert.equal(result.history.diagnostics.positions.observedMax, 24);
  assert.equal(harness.getWindowIndex(), harness.originalWindowIndex);
});

test('chatgpt-controller: complete history fails closed when scroll progress never establishes a start', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, positionHints: false });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.complete, false);
  assert.equal(result.history.startReached, false);
  assert.equal(result.history.reason, 'history-start-unproven');
});

test('chatgpt-controller: complete history fails closed when the conversation URL changes during backfill', async () => {
  const harness = createNativeWheelHistoryPage({ initialWindow: 2, changeUrlOnWheel: true });
  const result = await createController(harness.page).readConversationTurns({ maxTurns: 50, maxCharsPerTurn: 1000, maxTotalChars: 5000, historyMode: 'complete', historyTimeoutMs: 5000, historyMaxIterations: 30 });
  assert.equal(result.history.reason, 'conversation-changed');
  assert.equal(result.history.startReached, false);
});

test('chatgpt-controller: rendered code-block innerText preserves proposal JSON transport', async () => {
  const source = conversationProposalText();
  const captured = await captureActualConversationExtraction([
    createConversationTurnFixture({ role: 'assistant', innerText: source, textContent: source, messageId: 'proposal-message' })
  ]);
  assert.match(captured.expression, /clone\.innerText \|\| clone\.textContent/u);
  assert.equal(captured.result.turns[0].text, source);
  const proposal = parseValidateProposalResponse(captured.result.turns[0].text, {
    metadata: conversationProposalMetadata,
    now: new Date(conversationProposalMetadata.createdAt)
  });
  assert.equal(proposal.contract.implementation.prompt, conversationProposalPrompt);
  assert.match(proposal.contract.implementation.prompt, /D:\\ghws\\RuntimeUnicodeTextSample/u);
  assert.match(proposal.contract.implementation.prompt, /Commit with message "Replace Fab media with real Unreal screenshots"/u);
  assert.match(proposal.contract.implementation.prompt, /Newline instruction:\nKeep this line/u);
});

test('chatgpt-controller: plain Markdown fixture can lose escaping while the rendered code block avoids it', async () => {
  const source = conversationProposalText();
  const lossyRenderedText = source.replace(/\\\\/gu, '\\').replace(/\\"/gu, '"');
  const plain = await captureActualConversationExtraction([
    createConversationTurnFixture({ role: 'assistant', innerText: lossyRenderedText, textContent: source })
  ]);
  const codeBlock = await captureActualConversationExtraction([
    createConversationTurnFixture({ role: 'assistant', innerText: source, textContent: source })
  ]);
  assert.notEqual(plain.result.turns[0].text, source);
  assert.equal(classifyProposalResponse(plain.result.turns[0].text, {
    metadata: conversationProposalMetadata,
    now: new Date(conversationProposalMetadata.createdAt)
  }).reason, 'proposal_json_invalid');
  const classification = classifyProposalResponse(codeBlock.result.turns[0].text, {
    metadata: conversationProposalMetadata,
    now: new Date(conversationProposalMetadata.createdAt)
  });
  assert.equal(classification.kind, 'valid_proposal');
});

test('chatgpt-controller: returns the latest valid turns while preserving conversation indexes', async () => {
  const page = createPage({
    events: [],
    onEvaluate: async (js) => {
      assert.match(js, /const selectedTurns = turns\.slice\(Math\.max\(0, turns\.length - maxTurns\)\)/u);
      return {
        turns: Array.from({ length: 150 }, (_, index) => ({
          role: index % 2 ? 'assistant' : 'user',
          text: `turn-${index}`,
          index,
          messageId: `message-${index}`
        })),
        limitExceeded: false,
        limitKind: null
      };
    }
  });
  const result = await createController(page).readConversationTurns({ maxTurns: 100, maxCharsPerTurn: 1000, maxTotalChars: 20_000 });
  assert.equal(result.turns.length, 100);
  assert.deepEqual(result.turns.map((turn) => turn.index), Array.from({ length: 100 }, (_, index) => index + 50));
  assert.equal(result.turns[0].text, 'turn-50');
  assert.equal(result.turns.at(-1).text, 'turn-149');
});

test('chatgpt-controller: rejects bounded conversation results instead of returning oversized text', async () => {
  const page = createPage({
    events: [],
    onEvaluate: async () => ({ turns: [], limitExceeded: true, limitKind: 'per-turn' })
  });
  await assert.rejects(
    () => createController(page).readConversationTurns({ maxTurns: 2, maxCharsPerTurn: 10, maxTotalChars: 20 }),
    (error) => error.message === 'conversation_turn_too_large' && error.data.limitKind === 'per-turn'
  );
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
          hasRegenerate: false,
          assistantTerminalSignal: true
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

test('chatgpt-controller: waits for attachment readiness before typing and clicking the normal send button', async () => {
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
            hasRegenerate: false,
            assistantTerminalSignal: true
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
          return attachmentCardSnapshot([{ fileName: 'attachment.txt', found: true, pending: false, failed: false }], { promptTextLength: 0 });
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
    assert.ok(index('attachment-menu-open') < index('attachment-file-option'));
    assert.ok(index('attachment-file-option') < index('files-set:1'));
    assert.ok(index('files-set:1') < index('attachment-ready'));
    assert.ok(index('attachment-ready') < index('text:body before upload'));
    assert.ok(index('text:body before upload') < index('normal-send-click'));
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
  hasContinue = false,
  hasRegenerate = false,
  assistantTerminalSignal = false,
  providerError = false
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
    hasRegenerate,
    assistantTerminalSignal,
    providerError
  };
}

function virtualResponseTiming() {
  let currentMs = 0;
  return {
    responseClock: () => currentMs,
    responseSleep: async (ms) => {
      currentMs += Math.max(1, Number(ms) || 0);
    }
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
          : assistantSnapshot({ count: 1, lastAssistantId: 'new-turn', txt: 'NEW-ANSWER', assistantTerminalSignal: true });
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
      assert.equal(error.data?.lastLength, 'OLD-ANSWER'.length);
      assert.equal(error.data?.lastDigest, userTurnDigestForTest('OLD-ANSWER'));
      return true;
    }
  );
});

test('chatgpt-controller: accepts a stable new answer when a stale stop remains beside regenerate', async () => {
  const events = [];
  let baselineCaptured = false;
  let responsePolls = 0;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) {
        baselineCaptured = true;
        return assistantBaseline();
      }
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        assert.equal(baselineCaptured, true);
        responsePolls += 1;
        return assistantSnapshot({
          stop: true,
          sendPresent: false,
          sendEnabled: false,
          promptTextLength: 0,
          txt: 'COMPLETED-ANSWER',
          count: 1,
          lastAssistantId: 'new-turn',
          hasRegenerate: true,
          assistantTerminalSignal: true
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'return the completed answer', timeoutMs: 4_000 });

  assert.equal(result.text, 'COMPLETED-ANSWER');
  assert.ok(responsePolls > 1);
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
        if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'new-turn', txt: 'uploaded', assistantTerminalSignal: true });
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
        if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'new-turn', txt: 'menu uploaded', assistantTerminalSignal: true });
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

test('chatgpt-controller: does not treat a transient stop with a retained prompt as send confirmation', async () => {
  await withTempAttachments([
    'a/task-contract.json',
    'repository-state.json',
    'changes.patch',
    'b/task-contract.json',
    'worker-last-message.txt',
    'changed-files.json',
    'verification.json'
  ], async (attachments) => {
    const events = [];
    const prompt = 'long unsent draft '.repeat(40).trim();
    const cardDisplayNames = [
      'task-contract(2).json',
      'repository-state(2).json',
      'changes(2).patch',
      'task-contract(3).json',
      'worker-last-message(2).txt',
      'changed-files(2).json',
      'verification(2).json'
    ];
    const selectedFileNames = [
      'task-contract.json',
      'repository-state.json',
      'changes.patch',
      'task-contract.json',
      'worker-last-message.txt',
      'changed-files.json',
      'verification.json'
    ];
    const dom = createCleanupDom({
      events,
      promptText: prompt,
      uploadInputCount: 1,
      selectedFileNames,
      cardDisplayNames,
      cardCount: 7,
      userTurnTexts: ['baseline user turn']
    });
    let assistantEvaluations = 0;
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentState: attachmentCardSnapshot(selectedFileNames.map((fileName, index) => ({
        sourceFileName: fileName,
        displayName: cardDisplayNames[index],
        matched: true,
        pending: false,
        failed: false
      })), { conditionsReady: true, mappingComplete: true }),
      cleanupResult: null,
      cleanupDom: dom,
      userTurnBaseline: { count: 1, lastId: '', lastTextDigest: userTurnDigestForTest('baseline user turn') },
      onEvaluateExtra: async (js) => {
        if (isClickSendEvaluation(js)) {
          return {
            ...normalChatGPTSendResult(sendBaseline({ userCount: 1, lastUserText: 'baseline user turn', activePromptText: prompt })),
            rect: { x: 90, y: 10, w: 20, h: 20 }
          };
        }
        if (js.includes('const assistantCandidates')) {
          assistantEvaluations += 1;
          return assistantSnapshot({ count: 0, lastAssistantId: '', txt: '' });
        }
        if (js.includes('normalStopVisible')) {
          return chatgptSendSignal({
            userCount: 1,
            lastUserId: '',
            lastUserText: 'baseline user turn',
            activePromptText: prompt,
            normalStopVisible: false
          });
        }
        if (js.includes('clickFallbackBaselineText')) {
          events.push('dom-send-click');
          return { attempted: true, lastFallbackResult: 'dom_click' };
        }
        if (js.includes('submitFallbackBaselineText')) {
          events.push('requestSubmit');
          return { attempted: true, lastFallbackResult: 'request_submit_with_button' };
        }
        return undefined;
      }
    });

    await assert.rejects(
      createController(page).query({ prompt, attachments, timeoutMs: 30 }),
      (error) => {
        assert.equal(error.message, 'send_not_triggered');
        assert.equal(error.data?.sendConfirmed, false);
        assert.equal(error.data?.cleanup?.status, 'cleared');
        return true;
      }
    );
    assert.equal(assistantEvaluations, 0);
    assert.equal(events.includes('normal-send-click'), true);
    assert.equal(events.includes('dom-send-click'), true);
    assert.equal(events.includes('requestSubmit'), true);
    assert.deepEqual(dom.uploadInputs[0].files, []);
    assert.equal(dom.composer.querySelectorAll('[role="group"][aria-label]').length, 0);
    assert.equal(dom.prompt.value, '');
    assert.deepEqual(dom.document.querySelectorAll('article[data-turn="user"]').map((node) => node.innerText), ['baseline user turn']);
  });
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
        return assistantSnapshot({ txt: 'DOM-SUBMISSION-ANSWER', count: 1, lastAssistantId: 'new-assistant', assistantTerminalSignal: true });
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
        coordinateClickTimedOut: false,
        domClickAttempted: true,
        requestSubmitAttempted: true,
        lastFallbackResult: 'request_submit_with_button',
        sendConfirmed: false,
        messageDispatchState: 'unknown',
        cleanup: { status: 'skipped', reason: 'user_turn_baseline_unavailable' }
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
          lastAssistantId: 'autopilot-answer',
          assistantTerminalSignal: true
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
          lastAssistantId: 'enabled-send-answer',
          assistantTerminalSignal: true
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
          lastAssistantId: 'stop-then-idle',
          assistantTerminalSignal: true
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

test('chatgpt-controller: waits for an identityless streamed assistant turn to settle', async () => {
  const events = [];
  let responsePolls = 0;
  const partial = 'ATTACHMENT_LIFECYCLE_OK ATTACHAUTO13';
  const complete = 'ATTACHMENT_LIFECYCLE_OK ATTACHAUTO13 TC-A TC-B RS PATCH CF VER WLM';
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
          promptTextLength: 0,
          txt: responsePolls <= 25 ? partial : complete,
          count: 1,
          lastAssistantId: '',
          assistantTerminalSignal: responsePolls > 25
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).query({ prompt: 'wait for streamed response', timeoutMs: 20_000 });

  assert.equal(result.text, complete);
  assert.ok(responsePolls > 25);
});

test('chatgpt-controller: assistant identity and elapsed time do not complete a partial stream', async () => {
  const events = [];
  let responsePolls = 0;
  const timing = virtualResponseTiming();
  const partial = 'PARTIAL-IDENTIFIED-ANSWER';
  const complete = `${partial}-COMPLETE`;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        responsePolls += 1;
        const completeNow = responsePolls > 60;
        return assistantSnapshot({
          sendPresent: true,
          sendEnabled: true,
          promptTextLength: 0,
          txt: completeNow ? complete : partial,
          count: 1,
          lastAssistantId: 'streaming-turn',
          assistantTerminalSignal: completeNow
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: false, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page, timing).query({ prompt: 'wait for authoritative completion', timeoutMs: 40_000 });

  assert.equal(result.text, complete);
  assert.ok(responsePolls > 60);
});

test('chatgpt-controller: enabled send and stable partial text do not complete without a terminal signal', async () => {
  const events = [];
  let responsePolls = 0;
  const timing = virtualResponseTiming();
  const partial = 'STABLE-PARTIAL-ANSWER';
  const complete = `${partial}-COMPLETE`;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        responsePolls += 1;
        const completeNow = responsePolls > 14;
        return assistantSnapshot({
          sendPresent: true,
          sendEnabled: true,
          promptTextLength: 0,
          txt: completeNow ? complete : partial,
          count: 1,
          lastAssistantId: 'stable-partial-turn',
          assistantTerminalSignal: completeNow
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: false, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page, timing).query({ prompt: 'do not settle on stable text', timeoutMs: 20_000 });

  assert.equal(result.text, complete);
  assert.ok(responsePolls > 14);
});

test('chatgpt-controller: a long streaming pause does not return a partial response', async () => {
  const events = [];
  let responsePolls = 0;
  const timing = virtualResponseTiming();
  const partial = 'PAUSED-PARTIAL';
  const complete = `${partial}-AFTER-RESUME`;
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) {
        responsePolls += 1;
        const resumed = responsePolls > 55;
        return assistantSnapshot({
          sendPresent: true,
          sendEnabled: true,
          promptTextLength: 0,
          txt: resumed ? complete : partial,
          count: 1,
          lastAssistantId: 'paused-stream-turn',
          assistantTerminalSignal: resumed
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: false, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page, timing).query({ prompt: 'wait through a streaming pause', timeoutMs: 40_000 });

  assert.equal(result.text, complete);
  assert.ok(responsePolls > 55);
});

test('chatgpt-controller: unconfirmed ChatGPT completion is an explicit failure without partial text', async () => {
  const events = [];
  const timing = virtualResponseTiming();
  const partial = 'UNCONFIRMED-PARTIAL';
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const assistantCandidates')) {
        return assistantSnapshot({
          sendPresent: true,
          sendEnabled: true,
          promptTextLength: 0,
          txt: partial,
          count: 1,
          lastAssistantId: 'unconfirmed-turn',
          assistantTerminalSignal: false
        });
      }
      if (isClickSendEvaluation(js)) {
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: false, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page, timing).query({ prompt: 'require a terminal signal', timeoutMs: 4_000 }),
    (error) => {
      assert.equal(error.message, 'response_completion_unconfirmed');
      assert.equal(error.data?.lastLength, partial.length);
      assert.equal(error.data?.lastDigest, userTurnDigestForTest(partial));
      assert.equal(error.data?.assistantTerminalSignal, false);
      assert.equal('last' in (error.data || {}), false);
      return true;
    }
  );
});

test('chatgpt-controller: visible provider error fails before response timeout', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const assistantCandidates')) {
        return assistantSnapshot({
          sendPresent: false,
          sendEnabled: false,
          promptTextLength: 0,
          txt: '…',
          count: 1,
          lastAssistantId: 'error-turn',
          providerError: true
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
    createController(page).query({ prompt: 'surface provider error', timeoutMs: 4_000 }),
    (error) => {
      assert.equal(error.message, 'provider_response_error');
      assert.equal(error.data?.phase, 'waiting_for_response');
      assert.equal(error.data?.lastLength, 1);
      assert.equal(error.data?.reason, 'visible_provider_error');
      assert.equal('last' in (error.data || {}), false);
      return true;
    }
  );
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
          lastAssistantId: 'unsent-prompt-guarded',
          assistantTerminalSignal: true
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
          lastAssistantId: 'disabled-send-guarded',
          assistantTerminalSignal: true
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
      assert.equal(error.data?.lastLength, 'OLD-ANSWER'.length);
      assert.equal(error.data?.lastDigest, userTurnDigestForTest('OLD-ANSWER'));
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
      assert.equal(error.message, 'response_completion_unconfirmed');
      assert.deepEqual(error.data, {
        lastLength: 'PARTIAL-ANSWER'.length,
        lastDigest: userTurnDigestForTest('PARTIAL-ANSWER'),
        lastAssistantCount: 1,
        lastAssistantId: 'partial-answer',
        sendPresent: true,
        sendEnabled: false,
        stop: false,
        promptTextLength: 8,
        newChatGPTAssistant: true,
        composerIdle: false,
        assistantTerminalSignal: false,
        completionReason: 'terminal_signal_missing',
        messageDispatchState: 'unknown'
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
  assert.equal(source.includes('button[data-testid="copy-turn-action-button"]'), true);
  assert.equal(source.includes('assistantTerminalSignal'), true);
  assert.equal(source.includes('!!snap?.assistantTerminalSignal'), true);
});

async function withTempAttachments(names, fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  const files = [];
  try {
    for (const name of names) {
      const file = path.join(tempDir, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, name);
      files.push(file);
    }
    return await fn(files);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function attachmentCardSnapshot(fileStates, { observedFileNames, promptTextLength = 12, hasSendButton = true, sendDisabled = false, busy = false, conditionsReady = true, mappingComplete = true, mappingErrors = [] } = {}) {
  const sourceName = (state) => state.sourceFileName || state.fileName;
  const matched = (state) => state.matched ?? state.found;
  return {
    isChatGPT: true,
    fileStates,
    attachmentStates: fileStates,
    observedFileNames: observedFileNames || fileStates.filter(matched).map(sourceName),
    observedDisplayNames: fileStates.filter((state) => matched(state) && state.displayNameValid !== false).map((state) => state.displayName || sourceName(state)),
    selectedFileNames: fileStates.map(sourceName),
    cardDisplayNames: fileStates.filter(matched).map((state) => state.displayName || sourceName(state)),
    fileCount: fileStates.length,
    cardCount: fileStates.filter(matched).length,
    countsMatch: fileStates.length === fileStates.filter(matched).length,
    mappingComplete,
    mappingErrors,
    missingFileNames: fileStates.filter((state) => !matched(state)).map(sourceName),
    pendingFileNames: fileStates.filter((state) => state.pending).map(sourceName),
    failedFileNames: fileStates.filter((state) => state.failed).map(sourceName),
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
      if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'uploaded-turn', txt: 'uploaded', assistantTerminalSignal: true });
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
  mappingErrors = [],
  inputValue = ''
} = {}) {
  const draftHasAttachmentState = selectedFileNames.length > 0 || cardDisplayNames.length > 0 || inputValue !== '';
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
    draftHasAttachmentState,
    hasAttachmentState: draftHasAttachmentState,
    draftConflict: draftHasAttachmentState,
    mappingErrors,
    inputValue,
    composerInputCount: 1,
    pageUploadInputCount: 1
  };
}

test('chatgpt-controller: reports preflight query conflicts as not-dispatched', async () => {
  const events = [];
  const staleState = {
    isChatGPT: true,
    hasAttachmentState: true,
    promptLength: 0,
    promptDigest: textDigest(''),
    selectedFiles: [{ transportName: 'orphan.txt', logicalName: 'orphan.txt', size: 4, sha256: '0'.repeat(64) }],
    selectedFileNames: ['orphan.txt'],
    cardDisplayNames: [],
    currentDraftCardCount: 0,
    composerInputCount: 1,
    pageInputCount: 1,
    inputValuePresent: true
  };
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentDraftState: staleState,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: { ok: false, reason: 'orphan_recovery_not_attempted' }
  });
  await assert.rejects(
    createController(page).query({ prompt: 'query conflict', attachments: [], timeoutMs: 5_000 }),
    (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.messageDispatchState === 'not-dispatched'
  );
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: clears only an exact orphan attachment residue before the same query', async () => {
  await withTempAttachments(['orphan.txt'], async ([attachment]) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-orphan-residue-'));
    const events = [];
    const expected = await describeAttachmentFiles([attachment]);
    const residual = {
      isChatGPT: true,
      hasAttachmentState: true,
      promptText: '',
      promptLength: 0,
      promptDigest: textDigest(''),
      selectedFiles: expected,
      selectedFileNames: expected.map((item) => item.transportName),
      cardDisplayNames: [],
      currentDraftCardCount: 0,
      composerInputCount: 1,
      pageInputCount: 1,
      uploadInputIdentityMatch: true,
      inputValuePresent: true
    };
    const clean = {
      ...residual,
      hasAttachmentState: false,
      selectedFiles: [],
      selectedFileNames: [],
      inputValuePresent: false
    };
    let cleaned = false;
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentDraftState: () => cleaned ? clean : residual,
      attachmentState: () => attachmentCardSnapshot([{ fileName: 'orphan.txt', found: true, pending: false, failed: false }]),
      cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
      onEvaluateExtra: async (js) => {
        if (js.includes('const agentifyAttachmentCleanup')) cleaned = true;
        return undefined;
      },
      onBasicEvaluate: async (js) => js.includes('const node = nodes[0] || null') ? '' : undefined
    });
    try {
      const result = await createController(page, { stateDir, tabId: 'orphan-residue-tab' }).query({
        prompt: 'reuse exact requested files',
        attachments: [attachment],
        timeoutMs: 5_000
      });
      assert.equal(result.text, 'cleanup-answer');
      assert.equal(cleaned, true);
      assert.equal(events.filter((event) => event === 'cleanup-draft').length, 1);
      assert.equal(events.filter((event) => event === 'files-set:1').length, 1);
      assert.equal(events.some((event) => event === 'text:reuse exact requested files'), true);
      assert.equal(await new DraftOwnershipStore({ stateDir, tabId: 'orphan-residue-tab' }).read(), null);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

test('chatgpt-controller: refuses orphan cleanup for a same-name attachment with different bytes', async () => {
  await withTempAttachments(['orphan-mismatch.txt'], async ([attachment]) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-orphan-mismatch-'));
    const events = [];
    const expected = await describeAttachmentFiles([attachment]);
    const staleState = {
      isChatGPT: true,
      hasAttachmentState: true,
      promptLength: 0,
      promptDigest: textDigest(''),
      selectedFiles: [{ ...expected[0], sha256: 'f'.repeat(64) }],
      selectedFileNames: [expected[0].transportName],
      cardDisplayNames: [],
      currentDraftCardCount: 0,
      composerInputCount: 1,
      pageInputCount: 1,
      uploadInputIdentityMatch: true,
      inputValuePresent: true
    };
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentDraftState: staleState,
      attachmentState: attachmentCardSnapshot([]),
      cleanupResult: { ok: true }
    });
    try {
      await assert.rejects(
        createController(page, { stateDir, tabId: 'orphan-mismatch-tab' }).query({
          prompt: 'must not clear mismatched bytes',
          attachments: [attachment],
          timeoutMs: 5_000
        }),
        (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.messageDispatchState === 'not-dispatched'
      );
      assert.equal(events.includes('cleanup-draft'), false);
      assert.equal(await new DraftOwnershipStore({ stateDir, tabId: 'orphan-mismatch-tab' }).read(), null);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

test('chatgpt-controller: orphan recovery refuses non-exact residue shapes', async () => {
  const cases = [
    {
      label: 'different size',
      names: ['orphan-size.txt'],
      select: (expected) => [{ ...expected[0], size: expected[0].size + 1 }]
    },
    {
      label: 'requested subset',
      names: ['orphan-subset-a.txt', 'orphan-subset-b.txt'],
      select: (expected) => [expected[0]]
    },
    {
      label: 'selected superset',
      names: ['orphan-superset.txt'],
      select: (expected) => [...expected, { transportName: 'foreign.txt', logicalName: 'foreign.txt', size: 1, sha256: '0'.repeat(64) }]
    },
    {
      label: 'current draft card',
      names: ['orphan-card.txt'],
      select: (expected) => expected,
      state: { currentDraftCardCount: 1, cardDisplayNames: ['orphan-card.txt'] }
    },
    {
      label: 'foreign prompt',
      names: ['orphan-prompt.txt'],
      select: (expected) => expected,
      state: { promptText: 'foreign prompt', promptLength: 14, promptDigest: textDigest('foreign prompt') }
    }
  ];
  for (const [index, item] of cases.entries()) {
    await withTempAttachments(item.names, async (attachments) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-orphan-shape-${index}-`));
      const events = [];
      const expected = await describeAttachmentFiles(attachments);
      const selectedFiles = item.select(expected);
      const staleState = {
        isChatGPT: true,
        hasAttachmentState: true,
        promptText: '',
        promptLength: 0,
        promptDigest: textDigest(''),
        selectedFiles,
        selectedFileNames: selectedFiles.map((file) => file.transportName),
        cardDisplayNames: [],
        currentDraftCardCount: 0,
        composerInputCount: 1,
        pageInputCount: 1,
        uploadInputIdentityMatch: true,
        inputValuePresent: true,
        ...item.state
      };
      const { page } = createAttachmentCleanupPage({
        events,
        attachmentDraftState: staleState,
        attachmentState: attachmentCardSnapshot([]),
        cleanupResult: { ok: true }
      });
      try {
        await assert.rejects(
          createController(page, { stateDir, tabId: `orphan-shape-${index}` }).query({
            prompt: `must reject ${item.label}`,
            attachments,
            timeoutMs: 5_000
          }),
          (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.messageDispatchState === 'not-dispatched'
        );
        assert.equal(events.includes('cleanup-draft'), false);
        assert.equal(events.some((event) => event.startsWith('files-set:')), false);
        assert.equal(events.some((event) => event.startsWith('text:')), false);
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('chatgpt-controller: orphan recovery fails closed when the user baseline changes during cleanup', async () => {
  await withTempAttachments(['orphan-baseline.txt'], async ([attachment]) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-orphan-baseline-'));
    const events = [];
    const expected = await describeAttachmentFiles([attachment]);
    const residual = {
      isChatGPT: true,
      hasAttachmentState: true,
      promptText: '',
      promptLength: 0,
      promptDigest: textDigest(''),
      selectedFiles: expected,
      selectedFileNames: expected.map((file) => file.transportName),
      cardDisplayNames: [],
      currentDraftCardCount: 0,
      composerInputCount: 1,
      pageInputCount: 1,
      uploadInputIdentityMatch: true,
      inputValuePresent: true
    };
    const clean = { ...residual, hasAttachmentState: false, selectedFiles: [], selectedFileNames: [], inputValuePresent: false };
    let cleaned = false;
    let baselineReads = 0;
    const baseline = { count: 0, lastId: '', lastTextDigest: textDigest('') };
    const changedBaseline = { count: 1, lastId: 'foreign-user', lastTextDigest: textDigest('foreign user') };
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentDraftState: () => cleaned ? clean : residual,
      attachmentState: attachmentCardSnapshot([]),
      cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
      userTurnBaseline: () => ++baselineReads <= 1 ? baseline : changedBaseline,
      onEvaluateExtra: async (js) => {
        if (js.includes('const agentifyAttachmentCleanup')) cleaned = true;
        return undefined;
      }
    });
    try {
      await assert.rejects(
        createController(page, { stateDir, tabId: 'orphan-baseline-tab' }).query({
          prompt: 'must stop when baseline changes',
          attachments: [attachment],
          timeoutMs: 5_000
        }),
        (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.messageDispatchState === 'not-dispatched'
      );
      const lease = await new DraftOwnershipStore({ stateDir, tabId: 'orphan-baseline-tab' }).read();
      assert.equal(lease.phase, 'cleanup-required');
      assert.equal(events.filter((event) => event === 'cleanup-draft').length, 1);
      assert.equal(events.some((event) => event.startsWith('files-set:')), false);
      assert.equal(events.some((event) => event.startsWith('text:')), false);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

test('chatgpt-controller: orphan cleanup failure preserves durable ownership without dispatch', async () => {
  await withTempAttachments(['orphan-cleanup-failure.txt'], async ([attachment]) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-orphan-cleanup-failure-'));
    const events = [];
    const expected = await describeAttachmentFiles([attachment]);
    const staleState = {
      isChatGPT: true,
      hasAttachmentState: true,
      promptText: '',
      promptLength: 0,
      promptDigest: textDigest(''),
      selectedFiles: expected,
      selectedFileNames: expected.map((file) => file.transportName),
      cardDisplayNames: [],
      currentDraftCardCount: 0,
      composerInputCount: 1,
      pageInputCount: 1,
      uploadInputIdentityMatch: true,
      inputValuePresent: true
    };
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentDraftState: staleState,
      attachmentState: attachmentCardSnapshot([]),
      cleanupResult: { ok: false, reason: 'cleanup_failed' }
    });
    try {
      await assert.rejects(
        createController(page, { stateDir, tabId: 'orphan-cleanup-failure-tab' }).query({
          prompt: 'must preserve residue after cleanup failure',
          attachments: [attachment],
          timeoutMs: 5_000
        }),
        (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.messageDispatchState === 'not-dispatched'
      );
      const lease = await new DraftOwnershipStore({ stateDir, tabId: 'orphan-cleanup-failure-tab' }).read();
      assert.equal(lease.phase, 'cleanup-required');
      assert.deepEqual(lease.expectedAttachments, expected);
      assert.equal(events.filter((event) => event === 'cleanup-draft').length, 1);
      assert.equal(events.some((event) => event.startsWith('files-set:')), false);
      assert.equal(events.some((event) => event.startsWith('text:')), false);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

function createUploadInputStatePage({ events, initialState, fileStateForPoll = null, onSetFileInputFiles = null, requireAttachmentMenuWhenInputReady = false }) {
  let attachmentPolls = 0;
  let initialAttachmentEvalCount = 0;
  let menuSelectionPolls = 0;
  const page = createPage({
    events,
    attachmentDraftState: { ...initialState, hasAttachmentState: initialState.hasAttachmentState ?? initialState.draftHasAttachmentState },
    onSetFileInputFiles,
    onEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'reselected-turn', txt: 'uploaded', assistantTerminalSignal: true });
      if (js.includes('const chatgptUploadInputs')) {
        initialAttachmentEvalCount += 1;
        if (requireAttachmentMenuWhenInputReady && initialAttachmentEvalCount === 1 && initialState.inputReady) {
          events.push('attachment-menu-open');
          return { ...initialState, opened: true, attachRect: { x: 10, y: 10, w: 20, h: 20 } };
        }
        assert.doesNotThrow(() => new Function(js));
        return initialState;
      }
      if (js.includes('const visibleMenuRoots')) {
        if (requireAttachmentMenuWhenInputReady) {
          assert.match(js, /if \(inputAvailable\) return/u);
        }
        if (requireAttachmentMenuWhenInputReady && menuSelectionPolls++ === 0) {
          events.push('attachment-file-option');
          return { inputAvailable: false, selected: true };
        }
        return { inputAvailable: true, selected: false };
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
    const { page, attachmentPolls } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({ selectedFileNames: [] })
    });

    await createController(page).query({ prompt: 'attach initially', attachments: [attachment], timeoutMs: 5_000 });

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), ['files-set:1', 'files-selector:#upload-files']);
  });
});

test('chatgpt-controller: does not bypass the attachment menu when a hidden input is already ready', async () => {
  await withTempAttachments(['menu-required.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({ selectedFileNames: [] }),
      requireAttachmentMenuWhenInputReady: true,
      fileStateForPoll: () => attachmentCardSnapshot([{ fileName: 'menu-required.txt', found: true, pending: false, failed: false }])
    });

    await createController(page).query({ prompt: 'follow the attachment menu', attachments: [attachment], timeoutMs: 5_000 });

    const index = (event) => events.indexOf(event);
    assert.ok(index('attachment-menu-open') >= 0);
    assert.ok(index('attachment-menu-open') < index('attachment-file-option'));
    assert.ok(index('attachment-file-option') < index('files-set:1'));
  });
});

test('chatgpt-controller: stages duplicate-basename uploads with unique transport names', async () => {
  await withTempAttachments(['a/task-contract.json', 'b/task-contract.json'], async ([first, second]) => {
    const events = [];
    let uploadedNames = [];
    let uploadedPaths = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({ selectedFileNames: [] }),
      onSetFileInputFiles: async (files) => {
        uploadedPaths = [...files];
        uploadedNames = files.map((file) => path.basename(file));
      },
      fileStateForPoll: () => attachmentCardSnapshot(
        uploadedNames.map((fileName) => ({ fileName, found: true, pending: false, failed: false }))
      )
    });

    await createController(page).query({ prompt: 'stage duplicate basenames', attachments: [first, second], timeoutMs: 5_000 });

    assert.deepEqual(uploadedNames.length, 2);
    assert.equal(new Set(uploadedNames.map((name) => name.toLocaleLowerCase())).size, 2);
    assert.deepEqual(uploadedPaths[0], first);
    assert.notDeepEqual(uploadedPaths[1], second);
    await assert.rejects(fs.access(uploadedPaths[1]));
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), ['files-set:2', 'files-selector:#upload-files']);
  });
});

test('chatgpt-controller: blocks a stale selected file before reselecting it', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      }),
    });

    await assert.rejects(
      createController(page).query({ prompt: 'reselect the same file', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.phase === 'attachment_preflight'
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.deepEqual(events.filter((event) => event.startsWith('native-')), []);
  });
});

test('chatgpt-controller: blocks a stale selected file without waiting or clearing it', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      }),
    });

    await assert.rejects(
      createController(page).query({ prompt: 'wait for clear', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.reason === 'current_draft_attachment_conflict'
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(events.includes('native-clear'), false);
  });
});

test('chatgpt-controller: preserves a stale selected file when preflight conflicts', async () => {
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
      (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.selectedFileNames?.[0] === 'repeat.txt'
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(events.includes('native-clear'), false);
  });
});

test('chatgpt-controller: blocks a complete active composer set instead of reusing it', async () => {
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

    await assert.rejects(
      createController(page).query({ prompt: 'do not reuse active attachment', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.reason === 'current_draft_attachment_conflict'
    );

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(attachmentPolls(), 0);
  });
});

test('chatgpt-controller: blocks a matching stale set before readiness or cleanup', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page, attachmentPolls } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        cardDisplayNames: ['repeat.txt'],
        selectionMatchesExpected: true,
        mappingComplete: true
      }),
      fileStateForPoll: () => attachmentCardSnapshot([{ fileName: 'repeat.txt', found: true, pending: true, failed: false }], { conditionsReady: false })
    });

    await assert.rejects(
      createController(page).query({ prompt: 'preserve stale attachment', attachments: [attachment], timeoutMs: 20 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.phase === 'attachment_preflight'
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(events.includes('cleanup-draft'), false);
    assert.equal(attachmentPolls(), 0);
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
        assert.deepEqual(error.data?.selectedFileNames, ['first.txt', 'second.txt']);
        assert.deepEqual(error.data?.cardDisplayNames, ['first.txt']);
        return true;
      }
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
  });
});

test('chatgpt-controller: blocks stale six-file draft before a new four-file upload', async () => {
  await withTempAttachments(['task-contract.json', 'verification.json', 'execution-log.json', 'execution-summary.txt'], async (attachments) => {
    const events = [];
    const staleNames = [
      'task-contract(20260813-123902).json',
      'repository-state(20260813-123902).json',
      'changed-files(20260813-123902).json',
      'verification(20260813-123901).json',
      'execution-log.json',
      'execution-summary.txt'
    ];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: staleNames,
        cardDisplayNames: staleNames,
        selectionMatchesExpected: false,
        mappingComplete: false,
        mappingErrors: ['missing_card:0', 'extra_card']
      }),
      onSetFileInputFiles: async () => { throw new Error('setFileInputFiles must not run for a stale draft'); }
    });

    await assert.rejects(
      createController(page).query({ prompt: 'do not append to stale draft', attachments, timeoutMs: 5_000 }),
      (error) => {
        assert.equal(error.message, 'chatgpt_file_input_state_conflict');
        assert.equal(error.data?.phase, 'attachment_preflight');
        assert.equal(error.data?.reason, 'current_draft_attachment_conflict');
        assert.deepEqual(error.data?.selectedFileNames, staleNames);
        assert.deepEqual(error.data?.cardDisplayNames, staleNames);
        return true;
      }
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
  });
});

test('chatgpt-controller: blocks a selected file when the current card is not present', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      }),
    });

    await assert.rejects(
      createController(page).query({ prompt: 'historical card is irrelevant', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict'
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(events.includes('native-clear'), false);
  });
});

test('chatgpt-controller: blocks a different selected file without clearing first', async () => {
  await withTempAttachments(['repeat.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({ selectedFileNames: ['other.txt'] })
    });

    await assert.rejects(
      createController(page).query({ prompt: 'replace another file', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict'
    );
    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
  });
});

test('chatgpt-controller: blocks basename case differences as stale selected state', async () => {
  await withTempAttachments(['Repeat.TXT'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['repeat.txt'],
        selectionMatchesExpected: true
      }),
    });

    await assert.rejects(
      createController(page).query({ prompt: 'case-insensitive repeat', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict'
    );
    assert.equal(events.filter((event) => event.startsWith('files-')).length, 0);
    assert.equal(events.filter((event) => event.startsWith('native-')).length, 0);
  });
});

test('chatgpt-controller: blocks reordered duplicate basenames as stale selected state', async () => {
  await withTempAttachments(['first.txt', 'second.txt', 'first.txt'], async ([first, second, duplicate]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['SECOND.TXT', 'FIRST.TXT', 'first.txt'],
        selectionMatchesExpected: true
      }),
      fileStateForPoll: () => attachmentCardSnapshot([
        { fileName: 'first.txt', found: true, pending: false, failed: false },
        { fileName: 'second.txt', found: true, pending: false, failed: false },
        { fileName: 'first.txt', found: true, pending: false, failed: false }
      ])
    });

    await assert.rejects(
      createController(page).query({ prompt: 'reordered repeated files', attachments: [first, second, duplicate], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict'
    );
    assert.equal(events.filter((event) => event.startsWith('files-')).length, 0);
    assert.equal(events.filter((event) => event.startsWith('native-')).length, 0);
  });
});

test('chatgpt-controller: accepts only exact or ChatGPT duplicate-suffixed attachment card display names', () => {
  const accepted = [
    ['foo.txt', 'foo.txt'],
    ['foo.txt', 'foo(1).txt'],
    ['foo.txt', 'foo(2).txt'],
    ['foo.txt', 'foo(15).txt'],
    ['foo.txt', 'foo(20260808-105520).txt'],
    ['foo(2).txt', 'foo(2).txt'],
    ['foo(2).txt', 'foo(2)(2).txt'],
    ['archive.tar.gz', 'archive.tar(2).gz'],
    ['README', 'README(2)'],
    ['.env', '.env(2)']
  ];
  const rejected = [
    ['foo.txt', 'foo (2).txt'],
    ['foo.txt', 'foo-2.txt'],
    ['foo.txt', 'foo(0).txt'],
    ['foo.txt', 'foo(-1).txt'],
    ['foo.txt', 'foo(0-0).txt'],
    ['foo.txt', 'foo().txt'],
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

test('chatgpt-controller: maps attachment cards as a unique unordered one-to-one multiset', () => {
  const cases = [
    [['file.json'], ['file.json']],
    [['file.json'], ['file(1).json']],
    [['file.json'], ['file(2).json']],
    [['file.patch'], ['file(12).patch']],
    [['a.json', 'b.json'], ['b.json', 'a.json']],
    [['a.json', 'b.json', 'c.json', 'd.json', 'e.json', 'f.json', 'g.json'], ['c.json', 'g.json', 'a.json', 'f.json', 'd.json', 'b.json', 'e.json']],
    [['file.json', 'file.json'], ['file.json', 'file(1).json']],
    [['file.json', 'file.json'], ['file(2).json', 'file(3).json']],
    [['file.json', 'file.json'], ['file(3).json', 'file(2).json']],
    [['file.json'], ['file(20260808-105520).json']],
    [['file.json', 'file(1).json'], ['file(20260808-105520).json', 'file(1)(5).json']],
    [['file.json', 'file.json', 'file.json'], ['file(2).json', 'file(4).json', 'file(3).json']],
    [['task-contract.json', 'task-contract(1).json'], ['task-contract(6).json', 'task-contract(1)(1).json']],
    [['file.json', 'file(1).json'], ['file(2).json', 'file(1).json']],
    [['FILE.JSON'], ['file.json']]
  ];
  for (const [selected, cards] of cases) {
    const result = mapChatGPTAttachmentCardNames(selected, cards);
    assert.equal(result.mappingComplete, true, `${selected.join(',')} -> ${cards.join(',')}`);
    assert.equal(result.mapping.length, selected.length);
  }
  assert.deepEqual(mapChatGPTAttachmentCardNames(['file.json'], ['file(0).json']).mappingErrors, ['missing_card:0']);
  assert.equal(mapChatGPTAttachmentCardNames(['file.json'], ['file(1).patch']).mappingComplete, false);
  assert.equal(mapChatGPTAttachmentCardNames(['file.json'], ['file.json', 'extra.txt']).mappingComplete, false);
  assert.equal(mapChatGPTAttachmentCardNames(['file.json', 'other.json'], ['file.json']).mappingComplete, false);
  assert.equal(mapChatGPTAttachmentCardNames(['file.json'], ['file(1).json', 'file(2).json']).mappingComplete, false);
  const exactAndRenamed = mapChatGPTAttachmentCardNames(['file.json', 'file.json'], ['file.json', 'file(1).json']);
  assert.equal(exactAndRenamed.mapping[0].matchKind, 'exact');
  assert.equal(exactAndRenamed.mapping[1].matchKind, 'renamed');
  for (const [selected, cards] of [
    [['file.json', 'file.json'], ['file(2).json', 'file(3).json']],
    [['file.json', 'file.json'], ['file(3).json', 'file(2).json']],
    [['file.json', 'file.json', 'file.json'], ['file(2).json', 'file(4).json', 'file(3).json']]
  ]) {
    const result = mapChatGPTAttachmentCardNames(selected, cards);
    assert.equal(result.mappingComplete, true, `${selected.join(',')} -> ${cards.join(',')}`);
    assert.deepEqual(result.mappingErrors, []);
    assert.equal(result.mapping.every((entry) => entry.matched && entry.matchKind === 'renamed'), true);
    assert.equal(new Set(result.mapping.map((entry) => entry.cardIndex)).size, cards.length);
    assert.deepEqual(result.mapping.map((entry) => entry.displayName).sort(), cards.slice().sort());
  }
});

test('chatgpt-controller: accepts timestamped duplicate aliases without losing one-to-one mapping', () => {
  const result = mapChatGPTAttachmentCardNames(
    ['file.json', 'file(1).json'],
    ['file(20260808-105520).json', 'file(1)(5).json']
  );
  assert.equal(result.mappingComplete, true);
  assert.deepEqual(result.mappingErrors, []);
  assert.equal(result.mapping.every((entry) => entry.matched && entry.matchKind === 'renamed'), true);
  assert.equal(new Set(result.mapping.map((entry) => entry.cardIndex)).size, 2);
  assert.deepEqual(result.mapping.map((entry) => entry.displayName).sort(), ['file(1)(5).json', 'file(20260808-105520).json']);
});

test('chatgpt-controller: maps only current-draft cards when conversation history has file cards', () => {
  const makeCard = (name, owner) => ({
    getAttribute: (attribute) => attribute === 'aria-label' ? name : null,
    closest: (selector) => selector.includes('conversation-turn') || selector.includes('data-message-author-role') || selector.includes('article[data-turn')
      ? owner
      : null
  });
  const historyCards = Array.from({ length: 10 }, (_, index) => makeCard(`history-${index}.json`, { kind: 'conversation-turn' }));
  const currentCards = [makeCard('first.json', null), makeCard('second.json', null), makeCard('third.json', null), makeCard('fourth.json', null)];
  const currentDraftCards = [...historyCards, ...currentCards].filter(isChatGPTCurrentDraftAttachmentCard);
  const result = mapChatGPTAttachmentCardNames(
    ['first.json', 'second.json', 'third.json', 'fourth.json'],
    currentDraftCards.map((card) => card.getAttribute('aria-label'))
  );
  assert.equal(currentDraftCards.length, 4);
  assert.equal(result.mappingComplete, true);
  assert.deepEqual(result.mappingErrors, []);
});

test('chatgpt-controller: current-draft extra attachment remains a mapping conflict', () => {
  const makeCard = (name) => ({
    getAttribute: (attribute) => attribute === 'aria-label' ? name : null,
    closest: () => null
  });
  const currentDraftCards = [makeCard('first.json'), makeCard('second.json'), makeCard('unexpected.json')];
  const result = mapChatGPTAttachmentCardNames(
    ['first.json', 'second.json'],
    currentDraftCards.filter(isChatGPTCurrentDraftAttachmentCard).map((card) => card.getAttribute('aria-label'))
  );
  assert.equal(result.mappingComplete, false);
  assert.deepEqual(result.mappingErrors, ['extra_card']);
});

test('chatgpt-controller: zero attachments map to an empty current draft without a conflict', () => {
  const result = mapChatGPTAttachmentCardNames([], []);
  assert.equal(result.mappingComplete, true);
  assert.deepEqual(result.mapping, []);
  assert.deepEqual(result.mappingErrors, []);
});

test('chatgpt-controller: seven-file attachment readiness succeeds with reordered renamed cards and bounded progress', async () => {
  const selected = [
    'task-contract.json',
    'repository-state.json',
    'changes.patch',
    'changed-files.json',
    'commits.txt',
    'verification.json',
    'worker-last-message.txt'
  ];
  const cards = [
    'worker-last-message(1).txt',
    'verification(1).json',
    'commits(1).txt',
    'changed-files(1).json',
    'changes(1).patch',
    'repository-state(2).json',
    'task-contract(1).json'
  ];
  await withTempAttachments(selected, async (files) => {
    const events = [];
    let attachmentPolls = 0;
    const progress = [];
    const mapping = mapChatGPTAttachmentCardNames(selected, cards);
    const { page } = createDirectUploadPage({
      events,
      fileStateForPoll: () => {
        attachmentPolls += 1;
        const attachmentStates = mapping.mapping.map((entry) => ({
          sourceFileName: entry.sourceFileName,
          displayName: entry.displayName,
          matched: entry.matched,
          matchKind: entry.matchKind,
          pending: false,
          failed: false
        }));
        return {
          isChatGPT: true,
          conditionsReady: true,
          expectedFileNames: selected,
          selectedFileNames: selected,
          cardDisplayNames: cards,
          fileCount: selected.length,
          cardCount: cards.length,
          countsMatch: true,
          mappingComplete: true,
          mappingErrors: [],
          attachmentStates,
          missingFileNames: [],
          pendingFileNames: [],
          failedFileNames: [],
          promptTextLength: 22,
          hasSendButton: true,
          sendDisabled: false,
          busy: false
        };
      }
    });
    const result = await createController(page).query({
      prompt: 'seven synthetic attachments',
      attachments: files,
      timeoutMs: 5_000,
      onProgress: (patch) => progress.push(patch)
    });
    assert.equal(result.text, 'uploaded');
    assert.equal(attachmentPolls, 2);
    assert.equal(events.includes('normal-send-click'), true);
    assert.equal(progress.some((patch) => patch.phase === 'uploading_files' && patch.attachmentCount === 7 && patch.readyCount === 7 && patch.pendingCount === 0 && patch.failedCount === 0 && patch.mappingComplete === true), true);
    const attachmentProgress = progress.find((patch) => patch.phase === 'uploading_files' && Array.isArray(patch.attachmentStates));
    assert.equal(attachmentProgress?.attachmentStates?.every((state) => !('absolutePath' in state) && !('content' in state) && !('token' in state)), true);
  });
});

test('chatgpt-controller: live seven-file duplicate-renamed shape reaches readiness and dispatch', async () => {
  const selected = [
    'task-contract.json',
    'repository-state.json',
    'changes.patch',
    'task-contract.json',
    'worker-last-message.txt',
    'changed-files.json',
    'verification.json'
  ];
  const cards = [
    'task-contract(3).json',
    'repository-state(3).json',
    'changes(3).patch',
    'task-contract(2).json',
    'worker-last-message(2).txt',
    'changed-files(2).json',
    'verification(2).json'
  ];
  await withTempAttachments(selected, async (files) => {
    const events = [];
    const mapping = mapChatGPTAttachmentCardNames(selected, cards);
    const progress = [];
    const { page, attachmentPolls } = createDirectUploadPage({
      events,
      fileStateForPoll: (poll) => attachmentCardSnapshot(mapping.mapping.map((entry) => ({
        sourceFileName: entry.sourceFileName,
        displayName: entry.displayName,
        matched: entry.matched,
        pending: false,
        failed: false
      })), {
        conditionsReady: mapping.mappingComplete,
        mappingComplete: mapping.mappingComplete,
        mappingErrors: mapping.mappingErrors,
        promptTextLength: 22
      })
    });
    const result = await createController(page).query({
      prompt: 'live seven-file duplicate shape',
      attachments: files,
      timeoutMs: 5_000,
      onProgress: (patch) => progress.push(patch)
    });
    assert.equal(result.text, 'uploaded');
    assert.equal(attachmentPolls(), 2);
    assert.equal(events.includes('normal-send-click'), true);
    assert.equal(progress.some((patch) => patch.phase === 'uploading_files' && patch.attachmentCount === 7 && patch.readyCount === 7 && patch.pendingCount === 0 && patch.failedCount === 0 && patch.mappingComplete === true), true);
    assert.equal(new Set(mapping.mapping.map((entry) => entry.cardIndex)).size, 7);
  });
});

test('chatgpt-controller: live seven-file timestamped aliases remain ready with staged duplicate names', async () => {
  const selected = [
    'task-contract.json',
    'repository-state.json',
    'changes.patch',
    'task-contract(1).json',
    'worker-last-message.txt',
    'changed-files.json',
    'verification.json'
  ];
  const cards = [
    'task-contract(20260808-105520).json',
    'repository-state(10).json',
    'changes(10).patch',
    'task-contract(1)(5).json',
    'worker-last-message(9).txt',
    'changed-files(9).json',
    'verification(9).json'
  ];
  await withTempAttachments([
    'a/task-contract.json',
    'repository-state.json',
    'changes.patch',
    'b/task-contract.json',
    'worker-last-message.txt',
    'changed-files.json',
    'verification.json'
  ], async (files) => {
    const events = [];
    const progress = [];
    const mapping = mapChatGPTAttachmentCardNames(selected, cards);
    const { page, attachmentPolls } = createDirectUploadPage({
      events,
      fileStateForPoll: () => attachmentCardSnapshot(mapping.mapping.map((entry) => ({
        sourceFileName: entry.sourceFileName,
        displayName: entry.displayName,
        matched: entry.matched,
        pending: false,
        failed: false
      })), {
        conditionsReady: mapping.mappingComplete,
        mappingComplete: mapping.mappingComplete,
        mappingErrors: mapping.mappingErrors,
        promptTextLength: 22
      })
    });
    const result = await createController(page).query({
      prompt: 'live seven-file timestamped alias shape',
      attachments: files,
      timeoutMs: 5_000,
      onProgress: (patch) => progress.push(patch)
    });
    assert.equal(result.text, 'uploaded');
    assert.equal(attachmentPolls(), 2);
    assert.equal(events.includes('normal-send-click'), true);
    assert.equal(mapping.mappingComplete, true);
    assert.deepEqual(mapping.mappingErrors, []);
    assert.equal(new Set(mapping.mapping.map((entry) => entry.cardIndex)).size, 7);
    assert.equal(progress.some((patch) => patch.phase === 'uploading_files' && patch.attachmentCount === 7 && patch.readyCount === 7 && patch.pendingCount === 0 && patch.failedCount === 0 && patch.mappingComplete === true), true);
  });
});

function createCleanupDom({ events, promptText, uploadInputCount = 0, uploadInputValue = '', pageUploadInputCount = 0, pageSelectedFileNames = [], pageUploadInputValue = '', selectedFileNames = [], cardDisplayNames = [], cardCount = 0, userTurnTexts = [], userTurnIds = [] }) {
  class FakeNode {
    constructor(tagName, attributes = {}) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.attributes = { ...attributes };
      this.children = [];
      this.parentElement = null;
      this.innerText = '';
      this.textContent = '';
      this._rect = { x: 10, y: 10, width: 400, height: 40 };
      this.classList = { contains: (name) => String(this.attributes.class || '').split(/\s+/u).includes(name) };
    }

    append(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    getAttribute(name) {
      return this.attributes[name] ?? null;
    }

    matches(selector) {
      return String(selector || '').split(',').some((rawSelector) => {
        const part = rawSelector.trim();
        if (part.startsWith('main ')) return this.tagName === part.slice(5).toUpperCase() && this.hasAncestor('MAIN');
        if (part === 'textarea') return this.tagName === 'TEXTAREA';
        if (part === 'input') return this.tagName === 'INPUT';
        if (part === 'form') return this.tagName === 'FORM';
        if (part === '#prompt-textarea') return this.attributes.id === 'prompt-textarea';
        if (/^input#upload-files(?:\[type="file"\])?$/u.test(part)) return this.tagName === 'INPUT' && this.attributes.id === 'upload-files' && (!part.includes('[type=') || this.attributes.type === 'file');
        if (part === '[role="group"][aria-label]') return this.attributes.role === 'group' && !!this.attributes['aria-label'];
        if (part === 'button[aria-label]') return this.tagName === 'BUTTON' && !!this.attributes['aria-label'];
        if (part === '[role="button"][aria-label]') return this.attributes.role === 'button' && !!this.attributes['aria-label'];
        if (part === '[data-message-author-role="user"]') return this.attributes['data-message-author-role'] === 'user';
        if (part === 'article[data-turn="user"]') return this.tagName === 'ARTICLE' && this.attributes['data-turn'] === 'user';
        if (part === 'textarea, input') return this.tagName === 'TEXTAREA' || this.tagName === 'INPUT';
        if (part === '[role="textbox"]' || part === '[contenteditable="true"]') return this.attributes.role === 'textbox' || this.attributes.contenteditable === 'true';
        if (part === 'main') return this.tagName === 'MAIN';
        return false;
      });
    }

    hasAncestor(tagName) {
      for (let node = this.parentElement; node; node = node.parentElement) {
        if (node.tagName === tagName) return true;
      }
      return false;
    }

    querySelectorAll(selector) {
      const found = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (node.matches(selector)) return node;
      }
      return null;
    }

    getBoundingClientRect() {
      return { x: this._rect.x, y: this._rect.y, width: this._rect.width, height: this._rect.height };
    }

    focus() {}

    dispatchEvent() {}

    click() {
      this._onClick?.();
    }
  }

  class FakeInputElement extends FakeNode {
    constructor(attributes = {}) {
      super('input', attributes);
      this.files = [];
      this._value = '';
    }
  }
  Object.defineProperty(FakeInputElement.prototype, 'value', {
    configurable: true,
    get() { return this._value; },
    set(value) {
      this._value = String(value || '');
      if (!this._value) this.files = [];
      events.push('input-clear');
    }
  });
  class FakeTextAreaElement extends FakeNode {
    constructor(attributes = {}) {
      super('textarea', attributes);
      this._value = '';
    }
  }
  Object.defineProperty(FakeTextAreaElement.prototype, 'value', {
    configurable: true,
    get() { return this._value; },
    set(value) {
      this._value = String(value || '');
      this.innerText = this._value;
      this.textContent = this._value;
      events.push('prompt-clear');
    }
  });

  const documentElement = new FakeNode('html');
  const body = documentElement.append(new FakeNode('body'));
  const main = body.append(new FakeNode('main'));
  const composer = main.append(new FakeNode('form'));
  const prompt = composer.append(new FakeTextAreaElement({ id: 'prompt-textarea', role: 'textbox' }));
  prompt._value = String(promptText || '');
  prompt.innerText = prompt._value;
  prompt.textContent = prompt._value;
  const uploadInputs = [];
  const makeFile = (name) => ({ name, size: name.length, arrayBuffer: async () => new TextEncoder().encode(name).buffer });
  for (let index = 0; index < uploadInputCount; index += 1) {
    const input = composer.append(new FakeInputElement({ id: 'upload-files', type: 'file' }));
    input.files = index === 0 ? selectedFileNames.map(makeFile) : [];
    if (index === 0) input._value = String(uploadInputValue || '');
    uploadInputs.push(input);
  }
  const pageUploadInputs = [];
  for (let index = 0; index < pageUploadInputCount; index += 1) {
    const input = body.append(new FakeInputElement({ id: 'upload-files', type: 'file' }));
    input.files = index === 0 ? pageSelectedFileNames.map(makeFile) : [];
    if (index === 0) input._value = String(pageUploadInputValue || '');
    pageUploadInputs.push(input);
  }
  for (let index = 0; index < cardCount; index += 1) {
    const card = composer.append(new FakeNode('div', { role: 'group', 'aria-label': cardDisplayNames[index] || selectedFileNames[index] || `card-${index + 1}`, class: 'group/file-tile' }));
    const remove = card.append(new FakeNode('button', { 'aria-label': 'Remove file' }));
    remove._onClick = () => {
      events.push('card-remove');
      card.parentElement.children = card.parentElement.children.filter((child) => child !== card);
    };
  }
  for (let index = 0; index < userTurnTexts.length; index += 1) {
    const userTurn = main.append(new FakeNode('article', {
      'data-turn': 'user',
      ...(userTurnIds[index] ? { 'data-message-id': userTurnIds[index] } : {})
    }));
    userTurn.innerText = String(userTurnTexts[index] || '');
    userTurn.textContent = userTurn.innerText;
  }
  const document = {
    body,
    documentElement,
    querySelectorAll(selector) {
      if (selector === '#upload-files') return documentElement.querySelectorAll('input#upload-files');
      if (selector === '[data-message-author-role="user"], article[data-turn="user"]') return documentElement.querySelectorAll('article[data-turn="user"]');
      if (selector === '#prompt-textarea') return [prompt];
      if (selector.includes('main textarea') || selector.includes('textarea')) return [prompt];
      return documentElement.querySelectorAll(selector);
    }
  };
  const appendFileCard = (fileName) => {
    const card = composer.append(new FakeNode('div', { role: 'group', 'aria-label': fileName, class: 'group/file-tile' }));
    const remove = card.append(new FakeNode('button', { 'aria-label': 'Remove file' }));
    remove._onClick = () => {
      events.push('card-remove');
      card.parentElement.children = card.parentElement.children.filter((child) => child !== card);
    };
    return card;
  };
  return {
    document,
    prompt,
    composer,
    uploadInputs,
    pageUploadInputs,
    appendFileCard,
    window: { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) },
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    InputEvent: class InputEvent {},
    Event: class Event {}
  };
}

async function evaluateCleanupScript(js, dom) {
  return await vm.runInNewContext(js, {
    ...dom,
    crypto: crypto.webcrypto,
    TextEncoder,
    setTimeout,
    clearTimeout
  });
}

function createAttachmentCleanupPage({ events, attachmentState, cleanupResult, attachmentDraftState = null, sendResult = null, recordSendEvaluation = true, cleanupDom = null, userTurnBaseline = null, onBasicEvaluate = null, onInsertText = null, onStopTokenEvaluate = null, onMouseDown = null, onMouseUp = null, onSendKey = null, onEvaluateExtra = null, onSetFileInputFiles = null }) {
  let cleanupScript = '';
  const page = createPage({
    events,
    attachmentDraftState,
    includeUserTurnBaseline: true,
    userTurnBaseline,
    onBasicEvaluate,
    onInsertText,
    onStopTokenEvaluate,
    onMouseDown,
    onMouseUp,
    onSendKey,
    onSetFileInputFiles,
    onEvaluate: async (js) => {
      const extra = await onEvaluateExtra?.(js);
      if (extra !== undefined) return extra;
      if (js.includes('const assistantBaseline')) return assistantBaseline();
      if (js.includes('const codeBlocks')) return { codeBlocks: [] };
      if (js.includes('const assistantCandidates')) return assistantSnapshot({ count: 1, lastAssistantId: 'cleanup-answer', txt: 'cleanup-answer', assistantTerminalSignal: true });
      if (js.includes('const chatgptUploadInputs')) return { isChatGPT: true, inputReady: true };
      if (js.includes('const agentifyAttachmentCleanup')) {
        cleanupScript = js;
        events.push('cleanup-draft');
        if (cleanupDom) return await evaluateCleanupScript(js, cleanupDom);
        return cleanupResult;
      }
      if (js.includes('const expectedFileNames')) return typeof attachmentState === 'function' ? await attachmentState() : attachmentState;
      if (isClickSendEvaluation(js)) {
        if (sendResult) return sendResult;
        if (recordSendEvaluation) events.push('normal-send-click');
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('const stop = Array.from')) return false;
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  return { page, cleanupScript: () => cleanupScript };
}

test('chatgpt-controller: blocks same-basename stale evidence before a new query upload', async () => {
  await withTempAttachments(['task-contract.json', 'verification.json', 'execution-log.json', 'execution-summary.txt'], async (attachments) => {
    const events = [];
    const staleState = chatgptUploadInputState({
      selectedFileNames: ['task-contract.json', 'verification.json', 'execution-log.json', 'execution-summary.txt'],
      cardDisplayNames: ['task-contract.json', 'verification.json', 'execution-log.json', 'execution-summary.txt'],
      selectionMatchesExpected: true,
      mappingComplete: true
    });
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentDraftState: staleState,
      attachmentState: attachmentCardSnapshot([]),
      cleanupResult: { ok: true }
    });

    await assert.rejects(
      createController(page).query({ prompt: 'do not send old evidence', attachments, timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.reason === 'current_draft_attachment_conflict'
    );
    assert.equal(events.some((event) => event.startsWith('files-set:')), false);
    assert.equal(events.includes('text:do not send old evidence'), false);
    assert.equal(events.includes('normal-send-click'), false);
    assert.equal(events.includes('cleanup-draft'), false);
  });
});

test('chatgpt-controller: blocks text-only query when a stale draft exists', async () => {
  const events = [];
  const staleState = chatgptUploadInputState({ selectedFileNames: ['stale.txt'], cardDisplayNames: ['stale.txt'] });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentDraftState: staleState,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: { ok: true }
  });

  await assert.rejects(
    createController(page).query({ prompt: 'text-only must not attach stale draft', attachments: [], timeoutMs: 5_000 }),
    (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.phase === 'attachment_preflight'
  );
  assert.equal(events.some((event) => event.startsWith('text:')), false);
  assert.equal(events.includes('normal-send-click'), false);
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: blocks send when a stale draft exists', async () => {
  const events = [];
  const staleState = chatgptUploadInputState({ selectedFileNames: ['stale.txt'], cardDisplayNames: ['stale.txt'] });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentDraftState: staleState,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: { ok: true }
  });

  await assert.rejects(
    createController(page).send({ text: 'send must not attach stale draft', timeoutMs: 5_000 }),
    (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.phase === 'attachment_preflight' && error.data?.messageDispatchState === 'not-dispatched'
  );
  assert.equal(events.some((event) => event.startsWith('text:')), false);
  assert.equal(events.includes('normal-send-click'), false);
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: preflight blocks the next query when failed cleanup leaves a draft', async () => {
  await withTempAttachments(['owned.txt'], async ([attachment]) => {
    const events = [];
    let draftState = { isChatGPT: true, hasAttachmentState: false };
    const staleState = chatgptUploadInputState({ selectedFileNames: ['owned.txt'], cardDisplayNames: ['owned.txt'] });
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentDraftState: () => draftState,
      attachmentState: attachmentCardSnapshot([{ fileName: 'owned.txt', found: true, pending: true, failed: false }], { conditionsReady: false }),
      cleanupResult: { ok: false, reason: 'attachment_set_changed' },
      onSetFileInputFiles: async () => { draftState = staleState; }
    });
    const controller = createController(page);

    await assert.rejects(
      controller.query({ prompt: 'first query leaves a stale draft', attachments: [attachment], timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data?.cleanup?.status === 'failed'
    );
    await assert.rejects(
      controller.query({ prompt: 'second query must stop', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict' && error.data?.phase === 'attachment_preflight'
    );
    assert.equal(events.filter((event) => event.startsWith('files-set:')).length, 1);
    assert.equal(events.filter((event) => event.startsWith('text:')).length, 0);
    assert.equal(events.includes('normal-send-click'), false);
  });
});

function createDispatchRaceHarness({ events, sendResult, actionMode = 'generic', actionGate = null, claimGate = null, startGate = null, startResult = null, onActionStarted = null, onClaimStarted = null, onClaimCompleted = null, onStartStarted = null, onStartCompleted = null, onMouseDown = null, onMouseUp = null, onSendKey = null, onRollback = null, claimStateOverride = null, actionError = null, cleanupResult = null, markDispatchingBeforeActionGate = false }) {
  let browserState = { generation: 0, sequence: 0, token: null, stopRequested: false, retiredSequence: 0, dispatch: null };
  let actionCount = 0;
  let providerStopCount = 0;
  let startEvaluationCount = 0;
  const parseLifecycle = (js) => ({
    generation: Number(/(?:const generation = |dispatch: \{ generation: )([0-9]+)/u.exec(js)?.[1] || 0),
    sequence: Number(/(?:const sequence = |sequence: )([0-9]+)/u.exec(js)?.[1] || 0),
    token: JSON.parse((/(?:const token = |state\?\.token === )("[0-9a-f]+")/u.exec(js)?.[1]) || 'null')
  });
  const parseExpected = (js) => ({
    generation: Number(/const expectedGeneration = ([0-9]+)/u.exec(js)?.[1] || 0),
    sequence: Number(/const expectedSequence = ([0-9]+)/u.exec(js)?.[1] || 0),
    token: JSON.parse(/const expectedToken = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null')
  });
  const parseReadExpected = (js) => ({
    generation: Number(/currentGeneration === ([0-9]+)/u.exec(js)?.[1] || 0),
    sequence: Number(/currentSequence === ([0-9]+)/u.exec(js)?.[1] || 0),
    token: JSON.parse(/state\?\.token === ("[0-9a-f]+")/u.exec(js)?.[1] || 'null')
  });
  const exact = ({ generation, sequence, token }) => browserState.generation === generation && browserState.sequence === sequence && browserState.token === token;
  const pageResult = { actionCount: () => actionCount, providerStopCount: () => providerStopCount, state: () => browserState };
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult,
    onMouseDown,
    onMouseUp,
    onSendKey,
    recordSendEvaluation: false,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStop') && !js.includes('agentifyStopTokenStopCancellation')) {
        const expected = parseExpected(js);
        if (!exact(expected) || browserState.stopRequested) return { ok: true, state: 'mismatch', clicked: false, reason: 'provider_stop_token_mismatch' };
        if (['pending', 'claimed'].includes(browserState.dispatch?.state)) {
          browserState = { ...browserState, stopRequested: true, retiredSequence: expected.sequence, dispatch: { generation: expected.generation, sequence: expected.sequence, state: 'cancelled' } };
          return { ok: true, state: 'cancelled', cancelled: true, clicked: false };
        }
        if (!['dispatching', 'dispatched'].includes(browserState.dispatch?.state)) return { ok: true, state: 'mismatch', clicked: false };
        browserState = { ...browserState, stopRequested: true };
        providerStopCount += 1;
        return { ok: true, state: browserState.dispatch.state, clicked: true, reason: 'provider_stop_clicked' };
      }
      if (js.includes('agentifyStopTokenStopCancellation')) {
        const expected = parseExpected(js);
        if (!exact(expected)) return { ok: true, state: 'mismatch', cancelled: false, terminal: true };
        browserState = { ...browserState, stopRequested: true, stopWatcherActive: false, retiredSequence: Math.max(browserState.retiredSequence, expected.sequence) };
        return { ok: true, state: browserState.dispatch?.state || 'unknown', cancelled: true, terminal: true };
      }
      if (js.includes('agentifyStopTokenStateRead')) return {
        ok: true,
        generation: browserState.generation,
        sequence: browserState.sequence,
        retiredSequence: browserState.retiredSequence,
        dispatchState: browserState.dispatch?.state || null
      };
      if (js.includes('agentifyStopTokenActivation')) {
        const lifecycle = parseLifecycle(js);
        browserState = { generation: lifecycle.generation, sequence: lifecycle.sequence, token: lifecycle.token, stopRequested: false, retiredSequence: 0, dispatch: { generation: lifecycle.generation, sequence: lifecycle.sequence, state: 'pending' } };
        return { ok: true, applied: true, generation: lifecycle.generation, sequence: lifecycle.sequence, token: lifecycle.token };
      }
      if (js.includes('agentifyStopTokenDispatchCheck')) {
        const expected = parseExpected(js);
        return {
          ok: true,
          active: exact(expected) && !browserState.stopRequested && browserState.retiredSequence < expected.sequence && ['pending', 'claimed', 'dispatching', 'dispatched'].includes(browserState.dispatch?.state),
          generation: browserState.generation,
          sequence: browserState.sequence,
          retiredSequence: browserState.retiredSequence,
          dispatchState: browserState.dispatch?.state || 'unknown'
        };
      }
      if (js.includes('agentifyStopTokenDispatchClaim')) {
        onClaimStarted?.();
        if (claimGate) await claimGate;
        const expected = parseExpected(js);
        if (!exact(expected) || browserState.stopRequested || browserState.retiredSequence >= expected.sequence) return { ok: true, claimed: false, state: browserState.dispatch?.state || 'mismatch' };
        browserState = { ...browserState, dispatch: { generation: expected.generation, sequence: expected.sequence, state: 'claimed' } };
        if (claimStateOverride) browserState = { ...browserState, dispatch: { generation: expected.generation, sequence: expected.sequence, state: claimStateOverride } };
        await onClaimCompleted?.();
        return { ok: true, claimed: true, state: 'claimed' };
      }
      if (js.includes('agentifyStopTokenDispatchStart')) {
        const startEvaluationId = ++startEvaluationCount;
        onStartStarted?.(startEvaluationId, js);
        const currentStartGate = typeof startGate === 'function' ? startGate(startEvaluationId, js) : startGate;
        if (currentStartGate) await currentStartGate;
        const expected = parseLifecycle(js);
        if (startResult) {
          const customResult = typeof startResult === 'function' ? await startResult({ count: startEvaluationId, expected, state: browserState, js }) : startResult;
          if (customResult !== undefined) return customResult;
        }
        if (!exact(expected) || browserState.stopRequested || browserState.dispatch?.state !== 'claimed') return { ok: true, started: false, state: browserState.dispatch?.state || 'mismatch', generation: browserState.generation, sequence: browserState.sequence };
        browserState = { ...browserState, dispatch: { generation: expected.generation, sequence: expected.sequence, state: 'dispatching' } };
        await onStartCompleted?.(startEvaluationId, js);
        return { ok: true, started: true, state: 'dispatching', generation: expected.generation, sequence: expected.sequence };
      }
      if (js.includes('agentifyStopTokenDispatchRollback')) {
        const expected = parseLifecycle(js);
        if (!exact(expected) || browserState.dispatch?.state !== 'claimed') {
          const result = { ok: true, rolledBack: false, state: exact(expected) ? browserState.dispatch?.state || 'unknown' : 'mismatch' };
          onRollback?.(result);
          return result;
        }
        browserState = { ...browserState, stopRequested: true, retiredSequence: expected.sequence, dispatch: { generation: expected.generation, sequence: expected.sequence, state: 'cancelled' } };
        const result = { ok: true, rolledBack: true, state: 'cancelled' };
        onRollback?.(result);
        return result;
      }
      if (js.includes('agentifyStopTokenDispatchComplete')) {
        const lifecycle = parseLifecycle(js);
        if (exact(lifecycle) && !browserState.stopRequested && browserState.dispatch?.state === 'dispatching') {
          browserState = { ...browserState, dispatch: { generation: lifecycle.generation, sequence: lifecycle.sequence, state: 'dispatched' } };
          return { ok: true, state: 'dispatched' };
        }
        return { ok: true, state: exact(lifecycle) ? browserState.dispatch?.state || 'unknown' : 'mismatch' };
      }
      if (js.includes('agentifyStopTokenDispatchRead')) {
        return {
          ok: true,
          state: exact(parseReadExpected(js)) && ['pending', 'claimed', 'dispatching', 'dispatched', 'cancelled'].includes(browserState.dispatch?.state) ? browserState.dispatch.state : 'mismatch'
        };
      }
      if (js.includes('agentifyStopTokenRelease')) {
        const lifecycle = parseLifecycle(js);
        if (exact(lifecycle)) browserState = { ...browserState, token: null, retiredSequence: Math.max(browserState.retiredSequence, lifecycle.sequence), dispatch: { generation: lifecycle.generation, sequence: lifecycle.sequence, state: ['dispatching', 'dispatched'].includes(browserState.dispatch?.state) ? browserState.dispatch.state : 'cancelled' } };
      }
      return { ok: true };
    },
    onEvaluateExtra: async (js) => {
      if (js.includes('const agentifyStopTokenDispatchAction')) {
        if (actionMode === 'none') return { attempted: false, state: 'pending' };
        if ((actionMode === 'dom') !== js.includes('clickFallbackBaselineText')) return { attempted: false, state: 'pending' };
        if (markDispatchingBeforeActionGate && actionError) {
          actionCount += 1;
          browserState = { ...browserState, dispatch: { generation: browserState.generation, sequence: browserState.sequence, state: 'dispatched' } };
          await onActionStarted?.();
          if (actionGate) await actionGate;
          throw actionError;
        }
        if (markDispatchingBeforeActionGate) browserState = { ...browserState, dispatch: { generation: browserState.generation, sequence: browserState.sequence, state: 'dispatching' } };
        await onActionStarted?.();
        if (actionGate) await actionGate;
        if (browserState.stopRequested) return { attempted: false, providerStopDispatchUnavailable: true, dispatchState: browserState.dispatch?.state || 'cancelled', state: browserState.dispatch?.state || 'cancelled' };
        actionCount += 1;
        browserState = { ...browserState, dispatch: { generation: browserState.generation, sequence: browserState.sequence, state: 'dispatched' } };
        if (actionError) throw actionError;
        return { attempted: true, dispatchClaimed: true, dispatchState: 'dispatched' };
      }
      if (isClickSendEvaluation(js)) return sendResult;
      if (js.includes('normalStopVisible')) return { isChatGPT: true, userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'pending dispatch', activePromptTextDigest: userTurnDigestForTest('pending dispatch'), activePromptTextLength: 17, hasNormalSend: false, normalStopVisible: false };
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: false, promptLen: 1 };
      return undefined;
    }
  });
  return { page, ...pageResult };
}

test('chatgpt-controller: attachment timeout clears the unsent draft without adding a user turn', async () => {
  await withTempAttachments(['timeout.txt'], async ([attachment]) => {
    const events = [];
    const { page, cleanupScript } = createAttachmentCleanupPage({
      events,
      attachmentState: attachmentCardSnapshot([{ fileName: 'timeout.txt', found: true, pending: true, failed: false }], { promptTextLength: 10, conditionsReady: false }),
      cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
    });
    await assert.rejects(
      createController(page).query({ prompt: 'clear timeout draft', attachments: [attachment], timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data.cleanup.status === 'cleared'
    );
    assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
    assert.match(cleanupScript(), /remove\.click\(\)/u);
    assert.match(cleanupScript(), /nativeValueSetter\.call\(uploadInput, ''\)/u);
    assert.match(cleanupScript(), /finalCardCount/u);
  });
});

test('chatgpt-controller: attachment readiness failure cleanup enables the next query', async () => {
  await withTempAttachments(['first.txt'], async ([attachment]) => {
    const events = [];
    const dom = createCleanupDom({ events, promptText: '', uploadInputCount: 1 });
    let queryNumber = 0;
    const attachFilesToDom = (files) => {
      dom.uploadInputs[0].files = files.map((file) => {
        const name = path.basename(file);
        return { name, size: name.length, arrayBuffer: async () => new TextEncoder().encode(name).buffer };
      });
      for (const file of files) {
        dom.appendFileCard(path.basename(file));
      }
    };
    const { page } = createAttachmentCleanupPage({
      events,
      cleanupDom: dom,
      onSetFileInputFiles: async (files) => {
        queryNumber += 1;
        attachFilesToDom(files);
      },
      attachmentState: () => queryNumber === 1
        ? attachmentCardSnapshot([{ fileName: 'first.txt', found: true, pending: true, failed: false }], { conditionsReady: false })
        : attachmentCardSnapshot([{ fileName: 'first.txt', found: true, pending: false, failed: false }])
    });
    const controller = createController(page);

    await assert.rejects(
      controller.query({ prompt: 'first query must clean up', attachments: [attachment], timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data?.cleanup?.status === 'cleared' && error.data.cleanup.reason !== 'prompt_changed'
    );
    assert.equal(queryNumber, 1);
    assert.equal(dom.prompt.value, '');
    assert.deepEqual(dom.uploadInputs[0].files, []);
    assert.equal(dom.composer.querySelectorAll('[role="group"][aria-label]').length, 0);

    await controller.query({ prompt: 'second query may upload', attachments: [attachment], timeoutMs: 5_000 });
    assert.equal(queryNumber, 2);
    assert.equal(events.filter((event) => event === 'files-set:1').length, 2);
    assert.equal(events.includes('normal-send-click'), true);
  });
});

test('chatgpt-controller: browser evaluation errors preserve diagnostics before any input or dispatch', async () => {
  const events = [];
  const progress = [];
  const browserError = Object.assign(new Error('browser_evaluation_failed'), {
    data: {
      kind: 'runtime_evaluate_exception',
      exceptionClass: 'TypeError',
      exceptionMessage: 'Cannot read properties of undefined',
      lineNumber: 17,
      columnNumber: 9
    }
  });
  const page = createPage({
    events,
    onEvaluate: async (js) => { throw new Error(`unexpected_eval:${js.slice(0, 80)}`); },
    promptEvaluationOverride: async () => { throw browserError; }
  });

  await assert.rejects(
    async () => await createController(page).query({ prompt: 'diagnostic fixture', onProgress: (item) => progress.push(item) }),
    (error) => {
      assert.equal(error, browserError);
      assert.equal(error.message, 'browser_evaluation_failed');
      assert.equal(error.data.kind, 'runtime_evaluate_exception');
      assert.equal(error.data.phase, 'typing_prompt');
      assert.equal(error.data.exceptionClass, 'TypeError');
      assert.equal(error.data.lineNumber, 17);
      assert.equal(error.data.columnNumber, 9);
      assert.equal(error.data?.cleanup, undefined);
      return true;
    }
  );
  assert.equal(progress.some((item) => item?.phase === 'typing_prompt'), true);
  assert.equal(events.some((item) => item.startsWith('text:') || item.startsWith('key:') || item.startsWith('files-set:') || item.includes('send')), false);
});

test('chatgpt-controller: pre-dispatch CDP timeout preserves prompt ownership diagnostics', async () => {
  const cdpError = Object.assign(new Error('chrome_cdp_command_timeout'), {
    data: { method: 'Runtime.evaluate', prompt: 'must not be persisted', params: { expression: 'secret' } }
  });
  const page = createPage({
    events: [],
    onBasicEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) throw cdpError;
      if (js.includes('agentifyAttachmentCleanup')) return { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 };
      return undefined;
    },
    onEvaluate: async (js) => { throw new Error(`unexpected_eval:${js.slice(0, 80)}`); }
  });
  page.targetId = 'target-pre-dispatch';

  await assert.rejects(
    createController(page).query({ prompt: 'diagnostic prompt', operationId: 'operation-pre-dispatch' }),
    (error) => {
      assert.equal(error, cdpError);
      assert.equal(error.data.method, 'Runtime.evaluate');
      assert.equal(error.data.targetId, 'target-pre-dispatch');
      assert.equal(error.data.operationId, 'operation-pre-dispatch');
      assert.equal(error.data.promptTyped, true);
      assert.equal(error.data.messageDispatchStarted, false);
      assert.equal(error.data.sendConfirmed, false);
      assert.equal(error.data.phase, 'typing_prompt');
      assert.equal(error.data.queryPhase, 'typing_prompt');
      assert.equal(error.data.ownershipPhase, 'prompt-owned');
      assert.equal(error.data.messageDispatchState, 'not-dispatched');
      return true;
    }
  );
  assert.equal(cdpError.data.queryDiagnostics.method, 'Runtime.evaluate');
  assert.equal(JSON.stringify(cdpError.data.queryDiagnostics).includes('must not be persisted'), false);
  assert.equal(JSON.stringify(cdpError.data.queryDiagnostics).includes('secret'), false);
});

test('chatgpt-controller: dispatch-started CDP timeout is distinguished from pre-dispatch', async () => {
  const cdpError = Object.assign(new Error('chrome_cdp_command_timeout'), {
    data: { method: 'Input.dispatchMouseEvent' }
  });
  const page = createPage({
    events: [],
    onBasicEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return { isChatGPT: true, assistantCount: 0, lastAssistantId: '', lastAssistantText: '' };
      if (js.includes('const sendBaseline')) return {
        ok: true,
        isChatGPT: true,
        fallbackEnter: false,
        rect: { x: 100, y: 100, w: 30, h: 30 },
        requestSubmit: true,
        host: 'chatgpt.com',
        sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: '', activePromptText: 'diagnostic prompt', activePromptTextDigest: '', activePromptTextLength: 16 }
      };
      if (js.includes('agentifyAttachmentCleanup')) return { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 };
      return undefined;
    },
    onMouseDown: async (x) => {
      if (x >= 80) throw cdpError;
    },
    onEvaluate: async (js) => { throw new Error(`unexpected_eval:${js.slice(0, 80)}`); }
  });
  page.targetId = 'target-dispatch-started';

  await assert.rejects(
    createController(page).query({ prompt: 'diagnostic prompt', operationId: 'operation-dispatch-started' }),
    (error) => {
      assert.equal(error, cdpError);
      assert.equal(error.data.method, 'Input.dispatchMouseEvent');
      assert.equal(error.data.promptTyped, true);
      assert.equal(error.data.messageDispatchStarted, true);
      assert.equal(error.data.sendConfirmed, false);
      assert.equal(error.data.ownershipPhase, 'dispatch-started');
      assert.equal(error.data.messageDispatchState, 'unknown');
      assert.equal(error.data.dispatchState, 'dispatching');
      return true;
    }
  );
});

test('chatgpt-controller: send-confirmed timeout is not classified as pre-dispatch', async () => {
  const cdpError = Object.assign(new Error('chrome_cdp_command_timeout'), {
    data: { method: 'Runtime.evaluate' }
  });
  let sendSignalReads = 0;
  const page = createPage({
    events: [],
    onBasicEvaluate: async (js) => {
      if (js.includes('const assistantBaseline')) return { isChatGPT: true, assistantCount: 0, lastAssistantId: '', lastAssistantText: '' };
      if (js.includes('const sendBaseline')) return {
        ok: true,
        isChatGPT: true,
        fallbackEnter: false,
        rect: { x: 100, y: 100, w: 30, h: 30 },
        requestSubmit: true,
        host: 'chatgpt.com',
        sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: '', activePromptText: 'diagnostic prompt', activePromptTextDigest: '', activePromptTextLength: 16 }
      };
      if (js.includes('const chatgptSendSel') && !js.includes('promptTextLength')) {
        sendSignalReads += 1;
        return {
          isChatGPT: true,
          userCount: 1,
          lastUserId: 'new-user-turn',
          lastUserTextDigest: 'different',
          activePromptText: '',
          activePromptTextDigest: '',
          activePromptTextLength: 0,
          normalStopVisible: true
        };
      }
      if (js.includes('const chatgptSendSel') && js.includes('promptTextLength')) throw cdpError;
      if (js.includes('agentifyAttachmentCleanup')) return { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 1 };
      return undefined;
    },
    onEvaluate: async (js) => { throw new Error(`unexpected_eval:${js.slice(0, 80)}`); }
  });
  page.targetId = 'target-send-confirmed';

  await assert.rejects(
    createController(page).query({ prompt: 'diagnostic prompt', operationId: 'operation-send-confirmed' }),
    (error) => {
      assert.equal(error, cdpError);
      assert.equal(sendSignalReads, 1);
      assert.equal(error.data.promptTyped, true);
      assert.equal(error.data.messageDispatchStarted, true);
      assert.equal(error.data.sendConfirmed, true);
      assert.equal(error.data.messageDispatchState, 'unknown');
      assert.notEqual(error.data.ownershipPhase, 'cleanup-required');
      return true;
    }
  );
});

test('chatgpt-controller: explicit prompt evaluation failure keeps its meaning and phase', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => { throw new Error(`unexpected_eval:${js.slice(0, 80)}`); },
    promptEvaluationOverride: async () => ({ ok: false, error: 'missing_prompt_textarea' })
  });

  await assert.rejects(
    async () => await createController(page).query({ prompt: 'missing prompt fixture' }),
    (error) => {
      assert.equal(error.message, 'missing_prompt_textarea');
      assert.equal(error.data.error, 'missing_prompt_textarea');
      assert.equal(error.data.phase, 'typing_prompt');
      assert.equal(error.data?.cleanup, undefined);
      return true;
    }
  );
  assert.equal(events.some((item) => item.startsWith('text:') || item.startsWith('key:') || item.startsWith('files-set:') || item.includes('send')), false);
});

test('chatgpt-controller: undefined prompt evaluation reports a distinguishable type failure', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => { throw new Error(`unexpected_eval:${js.slice(0, 80)}`); },
    promptEvaluationOverride: async () => undefined
  });

  await assert.rejects(
    async () => await createController(page).query({ prompt: 'undefined evaluation fixture' }),
    (error) => {
      assert.equal(error.message, 'type_failed');
      assert.equal(error.data.phase, 'typing_prompt');
      assert.equal(error.data.reason, 'evaluation_result_unavailable');
      assert.equal(error.data?.cleanup, undefined);
      return true;
    }
  );
  assert.equal(events.some((item) => item.startsWith('text:') || item.startsWith('key:') || item.startsWith('files-set:') || item.includes('send')), false);
});

test('chatgpt-controller: stop during attachment wait aborts quickly and clears the draft', async () => {
  await withTempAttachments(['stop.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentState: attachmentCardSnapshot([{ fileName: 'stop.txt', found: true, pending: true, failed: false }], { conditionsReady: false }),
      cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
    });
    const controller = createController(page);
    const queryPromise = controller.query({ prompt: 'stop while uploading', attachments: [attachment], timeoutMs: 5_000 });
    const waitDeadline = Date.now() + 1_000;
    while (!events.includes('files-selector:#upload-files') && Date.now() < waitDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(events.includes('files-selector:#upload-files'), true);
    await controller.requestStop();
    await assert.rejects(queryPromise, (error) => error.message === 'query_aborted' && error.data?.cleanup?.status === 'cleared');
    assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
  });
});

test('chatgpt-controller: explicit attachment failure clears the unsent draft', async () => {
  await withTempAttachments(['failed-cleanup.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentState: attachmentCardSnapshot([{ fileName: 'failed-cleanup.txt', found: true, pending: false, failed: true }]),
      cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
    });
    await assert.rejects(
      createController(page).query({ prompt: 'clear explicit failure', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'attachment_upload_failed' && error.data.cleanup.status === 'cleared'
    );
    assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
  });
});

test('chatgpt-controller: establishes attachment ownership immediately after file input mutation', async () => {
  await withTempAttachments(['mutation-then-failure.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentState: attachmentCardSnapshot([{ fileName: 'mutation-then-failure.txt', found: true, pending: true, failed: false }], { conditionsReady: false }),
      cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
      onSetFileInputFiles: async () => { await fs.unlink(attachment); }
    });

    await assert.rejects(
      createController(page).query({ prompt: 'cleanup after mutation failure', attachments: [attachment], timeoutMs: 20 }),
      (error) => error.code === 'ENOENT' && error.data?.cleanup?.status === 'cleared'
    );
    assert.deepEqual(events.filter((event) => event === 'files-set:1'), ['files-set:1']);
    assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
  });
});

test('chatgpt-controller: cleanup failure preserves the original error code and diagnostic', async () => {
  await withTempAttachments(['cleanup-failure.txt'], async ([attachment]) => {
    const { page } = createAttachmentCleanupPage({
      events: [],
      attachmentState: attachmentCardSnapshot([{ fileName: 'cleanup-failure.txt', found: true, pending: true, failed: false }], { conditionsReady: false }),
      cleanupResult: { ok: false, reason: 'prompt_changed', promptTextLength: 12, userTurnCount: 0 }
    });
    await assert.rejects(
      createController(page).query({ prompt: 'preserve original error', attachments: [attachment], timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data.cleanup.status === 'failed' && error.data.cleanup.reason === 'prompt_changed'
    );
  });
});

test('chatgpt-controller: text-only cleanup succeeds without an upload input', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'text-only draft' });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'text-only draft', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'cleared'
  );
  assert.equal(dom.prompt.value, '');
  assert.equal(dom.uploadInputs.length, 0);
  assert.equal(events.includes('attachment-menu-click'), false);
  assert.equal(events.filter((event) => event === 'card-remove').length, 0);
});

test('chatgpt-controller: text-only cleanup succeeds with one empty upload input', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'text-only empty input', uploadInputCount: 1 });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'text-only empty input', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'cleared'
  );
  assert.equal(dom.prompt.value, '');
  assert.deepEqual(dom.uploadInputs[0].files, []);
  assert.equal(events.includes('attachment-menu-click'), false);
});

test('chatgpt-controller: text-only cleanup observes one empty composer-external page input', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'external empty input', pageUploadInputCount: 1 });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'external empty input', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'cleared'
  );
  assert.equal(dom.prompt.value, '');
  assert.deepEqual(dom.pageUploadInputs[0].files, []);
  assert.equal(events.includes('attachment-menu-click'), false);
});

test('chatgpt-controller: text-only cleanup refuses a selected composer-external page file', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'external selected file', pageUploadInputCount: 1, pageSelectedFileNames: ['foreign.txt'] });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'external selected file', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'failed' && error.data.cleanup.reason === 'attachment_set_changed'
  );
  assert.equal(dom.prompt.value, 'external selected file');
  assert.deepEqual(dom.pageUploadInputs[0].files.map((file) => file.name), ['foreign.txt']);
});

test('chatgpt-controller: text-only cleanup refuses a non-empty composer-external page input value', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'external input value', pageUploadInputCount: 1, pageUploadInputValue: 'C:\\fakepath\\foreign.txt' });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'external input value', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'failed' && error.data.cleanup.reason === 'attachment_set_changed'
  );
  assert.equal(dom.prompt.value, 'external input value');
});

test('chatgpt-controller: text-only cleanup refuses an owned composer plus another page input', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'multiple inputs', uploadInputCount: 1, pageUploadInputCount: 1 });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'multiple inputs', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'failed' && error.data.cleanup.reason === 'attachment_ownership_unknown'
  );
  assert.equal(dom.prompt.value, 'multiple inputs');
});

test('chatgpt-controller: text-only cleanup refuses multiple page upload inputs', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'two page inputs', pageUploadInputCount: 2 });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'two page inputs', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'failed' && error.data.cleanup.reason === 'attachment_ownership_unknown'
  );
  assert.equal(dom.prompt.value, 'two page inputs');
});

test('chatgpt-controller: text-only cleanup refuses an unexpected attachment card', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'card must remain', cardCount: 1 });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'card must remain', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'failed' && error.data.cleanup.reason === 'attachment_set_changed'
  );
  assert.equal(dom.prompt.value, 'card must remain');
  assert.equal(events.filter((event) => event === 'card-remove').length, 0);
});

test('chatgpt-controller: text-only cleanup refuses an unexpected selected file', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'selected file must remain', uploadInputCount: 1, selectedFileNames: ['foreign.txt'] });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom
  });
  await assert.rejects(
    createController(page).query({ prompt: 'selected file must remain', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'failed' && error.data.cleanup.reason === 'attachment_set_changed'
  );
  assert.equal(dom.prompt.value, 'selected file must remain');
  assert.deepEqual(dom.uploadInputs[0].files.map((file) => file.name), ['foreign.txt']);
});

test('chatgpt-controller: attachment cleanup still removes owned input and cards through the DOM script', async () => {
  await withTempAttachments(['owned.txt'], async ([attachment]) => {
    const events = [];
    const dom = createCleanupDom({ events, promptText: '', uploadInputCount: 1, selectedFileNames: ['owned.txt'], cardCount: 1 });
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentState: attachmentCardSnapshot([{ fileName: 'owned.txt', found: true, pending: true, failed: false }], { conditionsReady: false }),
      cleanupResult: null,
      cleanupDom: dom
    });
    await assert.rejects(
      createController(page).query({ prompt: 'owned attachment draft', attachments: [attachment], timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data.cleanup.status === 'cleared' && error.data.cleanup.reason !== 'prompt_changed'
    );
    assert.equal(dom.prompt.value, '');
    assert.deepEqual(dom.uploadInputs[0].files, []);
    assert.equal(dom.composer.querySelectorAll('[role="group"][aria-label]').length, 0);
    assert.equal(events.includes('card-remove'), true);
  });
});

test('chatgpt-controller: post-send settling clears only exact owned current-draft residue after the sent turn', async () => {
  const events = [];
  const bytes = new TextEncoder().encode('owned.txt');
  const expected = [{ transportName: 'owned.txt', logicalName: 'owned.txt', size: bytes.byteLength, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  const dom = createCleanupDom({
    events,
    promptText: '',
    uploadInputCount: 1,
    uploadInputValue: 'C:\\fakepath\\owned.txt',
    selectedFileNames: ['owned.txt'],
    cardDisplayNames: ['owned.txt'],
    cardCount: 1,
    userTurnTexts: ['previous', 'sent prompt'],
    userTurnIds: ['old-user', 'sent-user']
  });
  const { page } = createAttachmentCleanupPage({ events, cleanupDom: dom, attachmentState: attachmentCardSnapshot([]) });
  const result = await createController(page).cleanupUnsentDraft({
    prompt: '',
    expectedFileNames: ['owned.txt'],
    logicalFileNames: ['owned.txt'],
    expectedAttachmentIdentities: expected,
    userTurnBaseline: { count: 1, lastId: 'old-user', lastTextDigest: textDigest('previous') },
    sentPromptDigest: textDigest('sent prompt'),
    postSend: true
  });
  assert.equal(result.status, 'cleared');
  assert.deepEqual(dom.uploadInputs[0].files, []);
  assert.equal(dom.composer.querySelectorAll('[role="group"][aria-label]').length, 0);
  assert.equal(events.includes('card-remove'), true);
});

test('chatgpt-controller: reproduces the post-send clean lease clear before owned attachment resurrection', async () => {
  await withTempAttachments(['task-contract.json', 'verification.json', 'execution-log.json', 'execution-summary.txt'], async (attachments) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-post-send-resurrection-'));
    try {
      const events = [];
      const prompt = 'attachment query whose draft resurrects after settlement';
      const names = attachments.map((filePath) => path.basename(filePath));
      const expected = await describeAttachmentFiles(attachments);
      const cleanDraft = {
        ...chatgptUploadInputState({}),
        promptLength: 0,
        promptDigest: textDigest(''),
        selectedFiles: [],
        inputValuePresent: false,
        composerInputCount: 1,
        pageUploadInputCount: 1,
        pageInputCount: 1
      };
      const resurrectedDraft = {
        ...chatgptUploadInputState({ selectedFileNames: names, cardDisplayNames: names, inputValue: 'C:\\fakepath\\task-contract.json' }),
        promptLength: 0,
        promptDigest: textDigest(''),
        inputValuePresent: true,
        selectedFiles: expected,
        pageInputCount: 1
      };
      let draftReadCount = 0;
      let cleanupTriggered = false;
      let baselineReadCount = 0;
      const baseline = { count: 0, lastId: '', lastTextDigest: userTurnDigestForTest('') };
      const sentBaseline = { count: 1, lastId: 'sent-user', lastTextDigest: userTurnDigestForTest(prompt) };
      const { page } = createAttachmentCleanupPage({
        events,
        attachmentDraftState: () => {
          if (cleanupTriggered) return cleanDraft;
          draftReadCount += 1;
          return draftReadCount <= 2 ? cleanDraft : resurrectedDraft;
        },
        attachmentState: () => attachmentCardSnapshot(names.map((fileName) => ({
          fileName,
          found: true,
          pending: false,
          failed: false
        }))),
        cleanupResult: { ok: true },
        userTurnBaseline: () => {
          baselineReadCount += 1;
          return baselineReadCount === 1 ? baseline : sentBaseline;
        },
        onBasicEvaluate: async (js) => js.includes('missing_prompt_textarea')
          ? { ok: true, rect: { x: 10, y: 10, w: 400, h: 40 }, userTurnBaseline: baseline }
          : undefined,
        onEvaluateExtra: async (js) => {
          if (js.includes('const agentifyAttachmentCleanup')) {
            cleanupTriggered = true;
            return { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 1 };
          }
          if (isClickSendEvaluation(js)) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
          if (js.includes('const chatgptUserTurns')) return chatgptSendSignal({
            userCount: 1,
            lastUserId: 'sent-user',
            lastUserText: prompt,
            activePromptText: prompt
          });
          return undefined;
        }
      });
      const controller = createController(page, { stateDir, tabId: 'post-send-resurrection-tab' });

      const result = await controller.query({ prompt, attachments, timeoutMs: 5_000 });
      assert.equal(result.text, 'cleanup-answer');
      assert.equal(await new DraftOwnershipStore({ stateDir, tabId: 'post-send-resurrection-tab' }).read(), null);
      assert.equal(cleanupTriggered, true);

      const dispatchesBeforePlainSend = events.filter((event) => event === 'normal-send-click').length;
      await controller.send({ text: 'plain text after owned resurrection cleanup', timeoutMs: 5_000 });
      assert.equal(events.filter((event) => event === 'normal-send-click').length, dispatchesBeforePlainSend + 1);
      assert.equal(draftReadCount, 3);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

test('chatgpt-controller: keeps a clean post-send attachment tombstone until stable clean is proven', async () => {
  await withTempAttachments(['task-contract.json', 'verification.json', 'execution-log.json', 'execution-summary.txt'], async (attachments) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-post-send-stable-clean-'));
    try {
      const events = [];
      const prompt = 'attachment query with stable post-send cleanup';
      const names = attachments.map((filePath) => path.basename(filePath));
      const expected = await describeAttachmentFiles(attachments);
      const cleanDraft = {
        ...chatgptUploadInputState({}),
        promptLength: 0,
        promptDigest: textDigest(''),
        selectedFiles: [],
        inputValuePresent: false,
        composerInputCount: 1,
        pageUploadInputCount: 1,
        pageInputCount: 1
      };
      let draftReadCount = 0;
      let baselineReadCount = 0;
      const baseline = { count: 0, lastId: '', lastTextDigest: userTurnDigestForTest('') };
      const sentBaseline = { count: 1, lastId: 'sent-user', lastTextDigest: userTurnDigestForTest(prompt) };
      const { page } = createAttachmentCleanupPage({
        events,
        attachmentDraftState: () => {
          draftReadCount += 1;
          return cleanDraft;
        },
        attachmentState: attachmentCardSnapshot(names.map((fileName) => ({
          fileName,
          found: true,
          pending: false,
          failed: false
        }))),
        userTurnBaseline: () => {
          baselineReadCount += 1;
          return baselineReadCount === 1 ? baseline : sentBaseline;
        },
        onBasicEvaluate: async (js) => js.includes('missing_prompt_textarea')
          ? { ok: true, rect: { x: 10, y: 10, w: 400, h: 40 }, userTurnBaseline: baseline }
          : undefined,
        onEvaluateExtra: async (js) => {
          if (isClickSendEvaluation(js)) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
          if (js.includes('const chatgptUserTurns')) return chatgptSendSignal({
            userCount: 1,
            lastUserId: 'sent-user',
            lastUserText: prompt,
            activePromptText: prompt
          });
          return undefined;
        }
      });
      const controller = createController(page, { stateDir, tabId: 'post-send-stable-clean-tab' });

      const result = await controller.query({ prompt, attachments, timeoutMs: 5_000 });
      assert.equal(result.text, 'cleanup-answer');
      assert.ok(draftReadCount >= 3);
      assert.equal(events.includes('cleanup-draft'), false);
      assert.equal(await new DraftOwnershipStore({ stateDir, tabId: 'post-send-stable-clean-tab' }).read(), null);
      assert.equal(expected.length, 4);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

test('chatgpt-controller: production-like nine-file and seven-card residual cleanup is safe', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-production-like-'));
  const evidenceNames = ['task-contract.json', 'repository-state.json', 'repository-diff.txt', 'changed-files.json', 'binary-files.json', 'commits.txt', 'verification.json', 'execution-log.json', 'execution-summary.txt'];
  const cardNames = ['task-contract(20260828-053945).json', 'repository-state(20260828-053946).json', 'changed-files(20260828-053946).json', 'binary-files(1).json', 'verification(20260828-053946).json', 'execution-log(7).json', 'execution-summary(7).txt'];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-production-evidence-'));
  const files = evidenceNames.map((name) => path.join(root, name));
  try {
    await Promise.all(files.map((filePath, index) => fs.writeFile(filePath, index === 2 || index === 5 ? '' : path.basename(filePath), 'utf8')));
    const expected = await describeAttachmentFiles(files);
    const events = [];
    const dom = createCleanupDom({ events, promptText: '', uploadInputCount: 1, userTurnTexts: [] });
    const attachFilesToDom = async (pathsToAttach) => {
      dom.uploadInputs[0].files = await Promise.all(pathsToAttach.map(async (filePath) => {
        const bytes = await fs.readFile(filePath);
        return { name: path.basename(filePath), size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      }));
      for (const cardName of cardNames) dom.appendFileCard(cardName);
    };
    const fileStates = evidenceNames.map((name, index) => ({
      fileName: name,
      found: index < cardNames.length,
      displayName: cardNames[index],
      pending: index >= cardNames.length,
      failed: false
    }));
    const { page } = createAttachmentCleanupPage({
      events,
      cleanupDom: dom,
      attachmentState: () => attachmentCardSnapshot(fileStates, { conditionsReady: false, mappingComplete: false }),
      onSetFileInputFiles: async (pathsToAttach) => { await attachFilesToDom(pathsToAttach); }
    });
    await assert.rejects(
      createController(page, { stateDir, tabId: 'production-like-tab' }).query({ prompt: 'production-like residual', attachments: files, timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data?.cleanup?.status === 'cleared'
    );
    assert.deepEqual(dom.uploadInputs[0].files, []);
    assert.equal(dom.composer.querySelectorAll('[role="group"][aria-label]').length, 0);
    assert.equal(await new DraftOwnershipStore({ stateDir, tabId: 'production-like-tab' }).read(), null);
    assert.equal(events.filter((event) => event === 'card-remove').length, 7);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('chatgpt-controller: production-like cleanup failure survives restart and recovers before the next query', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-production-restart-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-production-restart-files-'));
  const evidenceNames = ['task-contract.json', 'repository-state.json', 'repository-diff.txt', 'changed-files.json', 'binary-files.json', 'commits.txt', 'verification.json', 'execution-log.json', 'execution-summary.txt'];
  const files = evidenceNames.map((name) => path.join(root, name));
  try {
    await Promise.all(files.map((filePath, index) => fs.writeFile(filePath, index === 2 || index === 5 ? '' : path.basename(filePath), 'utf8')));
    const expected = await describeAttachmentFiles(files);
    const staleState = {
      ...chatgptUploadInputState({ selectedFileNames: evidenceNames, cardDisplayNames: ['task-contract(2).json', 'repository-state(2).json', 'changed-files(2).json', 'binary-files(1).json', 'verification(2).json', 'execution-log(2).json', 'execution-summary(2).txt'], inputValue: 'C:\\fakepath\\task-contract.json' }),
      selectedFiles: expected,
      promptDigest: textDigest(''),
      promptLength: 0,
      inputValuePresent: true,
      pageInputCount: 1
    };
    const firstPage = createAttachmentCleanupPage({
      events: [],
      attachmentState: () => attachmentCardSnapshot(evidenceNames.map((fileName, index) => ({ fileName, found: index < 7, displayName: staleState.cardDisplayNames[index], pending: index >= 7, failed: false })), { conditionsReady: false, mappingComplete: false }),
      cleanupResult: { ok: false, reason: 'cleanup_settle_timeout' },
      onSetFileInputFiles: async () => {}
    }).page;
    await assert.rejects(
      createController(firstPage, { stateDir, tabId: 'restart-production-tab' }).query({ prompt: 'first production attempt', attachments: files, timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data?.cleanup?.status === 'failed'
    );
    const stored = await new DraftOwnershipStore({ stateDir, tabId: 'restart-production-tab' }).read();
    assert.equal(stored.phase, 'cleanup-required');
    assert.equal(stored.ownedPrompt, false);
    const events = [];
    let preflightCount = 0;
    const cleanDraftState = {
      isChatGPT: true,
      hasAttachmentState: false,
      promptLength: 0,
      promptDigest: textDigest(''),
      selectedFiles: [],
      cardDisplayNames: [],
      inputValuePresent: false,
      composerInputCount: 1,
      pageInputCount: 1
    };
    const secondPage = createAttachmentCleanupPage({
      events,
      attachmentDraftState: () => preflightCount++ === 0 ? staleState : cleanDraftState,
      cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
      attachmentState: () => attachmentCardSnapshot(evidenceNames.map((fileName) => ({ fileName, found: true, pending: false, failed: false }))),
      onBasicEvaluate: async (js) => js.includes('const node = nodes[0] || null') ? '' : undefined,
      onSetFileInputFiles: async () => {}
    }).page;
    await createController(secondPage, { stateDir, tabId: 'restart-production-tab' }).query({ prompt: 'second production attempt', attachments: files, timeoutMs: 5_000 });
    assert.equal(preflightCount, 5);
    assert.equal(events.filter((event) => event === 'files-set:9').length, 1);
    const postSendLease = await new DraftOwnershipStore({ stateDir, tabId: 'restart-production-tab' }).read();
    assert.equal(postSendLease, null);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('chatgpt-controller: restart recovery blocks a duplicate owned-looking card without cleanup', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-production-duplicate-card-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-production-duplicate-files-'));
  const files = ['task-contract.json', 'repository-state.json', 'repository-diff.txt', 'changed-files.json', 'binary-files.json', 'commits.txt', 'verification.json', 'execution-log.json', 'execution-summary.txt'].map((name) => path.join(root, name));
  try {
    await Promise.all(files.map((filePath, index) => fs.writeFile(filePath, index === 2 || index === 5 ? '' : path.basename(filePath), 'utf8')));
    const expected = await describeAttachmentFiles(files);
    const tabId = 'restart-duplicate-card-tab';
    const ownership = new DraftOwnershipStore({ stateDir, tabId });
    await ownership.write(createDraftLease({
      operationId: 'old-duplicate-card-operation',
      tabId,
      conversationDigest: textDigest('https://chatgpt.com/'),
      userTurnBaseline: { count: 0, lastId: '', lastTextDigest: userTurnDigestForTest('') },
      expectedAttachments: expected,
      ownedPrompt: false,
      phase: 'cleanup-required'
    }));
    const cardDisplayNames = ['task-contract(20260828-053945).json', 'task-contract(2).json', 'repository-state(20260828-053946).json', 'changed-files(20260828-053946).json', 'binary-files(1).json', 'verification(20260828-053946).json', 'execution-log(7).json', 'execution-summary(7).txt'];
    const staleState = {
      ...chatgptUploadInputState({ selectedFileNames: files.map((filePath) => path.basename(filePath)), cardDisplayNames, inputValue: 'C:\\fakepath\\task-contract.json' }),
      selectedFiles: expected,
      promptDigest: textDigest(''),
      promptLength: 0,
      inputValuePresent: true,
      pageInputCount: 1
    };
    const events = [];
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentDraftState: staleState,
      attachmentState: attachmentCardSnapshot([]),
      cleanupResult: { ok: true },
      recordSendEvaluation: false
    });
    await assert.rejects(
      createController(page, { stateDir, tabId }).query({ prompt: 'must block duplicate card', attachments: files, timeoutMs: 20 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict'
    );
    assert.equal(events.includes('cleanup-draft'), false);
    assert.equal(events.some((event) => event.startsWith('files-set:')), false);
    assert.deepEqual((await ownership.read()).phase, 'cleanup-required');
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('chatgpt-controller: duplicate-renamed attachment cleanup clears the owned unsent draft', async () => {
  await withTempAttachments(['a/task-contract.json', 'b/task-contract.json'], async ([first, second]) => {
    const events = [];
    const dom = createCleanupDom({
      events,
      promptText: '',
      uploadInputCount: 1,
      selectedFileNames: ['task-contract.json', 'task-contract(1).json'],
      cardDisplayNames: ['task-contract(20260808-105520).json', 'task-contract(1)(5).json'],
      cardCount: 2,
      userTurnTexts: ['existing user turn']
    });
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentState: attachmentCardSnapshot([
        { sourceFileName: 'task-contract.json', displayName: 'task-contract(20260808-105520).json', matched: true, pending: true, failed: false },
        { sourceFileName: 'task-contract(1).json', displayName: 'task-contract(1)(5).json', matched: true, pending: true, failed: false }
      ], { conditionsReady: false }),
      cleanupResult: null,
      recordSendEvaluation: false,
      cleanupDom: dom,
      userTurnBaseline: { count: 1, lastId: '', lastTextDigest: userTurnDigestForTest('existing user turn') }
    });

    await assert.rejects(
      createController(page).query({ prompt: 'duplicate renamed attachment draft', attachments: [first, second], timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data.cleanup.status === 'cleared' && error.data.cleanup.reason !== 'prompt_changed' && error.data.cleanup.userTurnCount === 1
    );
    assert.equal(dom.prompt.value, '');
    assert.deepEqual(dom.uploadInputs[0].files, []);
    assert.equal(dom.composer.querySelectorAll('[role="group"][aria-label]').length, 0);
    assert.equal(events.filter((event) => event === 'card-remove').length, 2);
    assert.equal(events.includes('normal-send-click'), false);
  });
});

test('chatgpt-controller: long user turn without an ID uses a full digest baseline', async () => {
  const longUserText = `${'long-user-turn-'.repeat(40)}end`;
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'long baseline draft', userTurnTexts: [longUserText] });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom,
    userTurnBaseline: { count: 1, lastId: '', lastTextDigest: userTurnDigestForTest(longUserText) }
  });
  await assert.rejects(
    createController(page).query({ prompt: 'long baseline draft', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'cleared'
  );
  assert.equal(dom.prompt.value, '');
});

test('chatgpt-controller: same-count changed user turn refuses text-only cleanup', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'changed baseline draft', userTurnTexts: ['new user turn with same count'] });
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    sendResult: { ok: false, error: 'send_not_triggered' },
    recordSendEvaluation: false,
    cleanupDom: dom,
    userTurnBaseline: { count: 1, lastId: '', lastTextDigest: userTurnDigestForTest('old user turn') }
  });
  await assert.rejects(
    createController(page).query({ prompt: 'changed baseline draft', timeoutMs: 20 }),
    (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'failed' && error.data.cleanup.reason === 'user_turn_added'
  );
  assert.equal(dom.prompt.value, 'changed baseline draft');
});

test('chatgpt-controller: requestStop protects foreign and manual runs from provider stop clicks', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const stop = Array.from')) {
        events.push('provider-stop-click');
        return true;
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  const controller = createController(page);
  controller.currentRun = { operationId: 'operation-b', providerStopToken: 'operation-b-token', requested: false, messageDispatchStarted: true };
  const foreign = await controller.requestStop({ expectedOperationId: 'operation-a' });
  assert.equal(foreign.reason, 'operation_mismatch');
  assert.equal(controller.currentRun.requested, false);
  assert.equal(events.includes('provider-stop-click'), false);
  controller.currentRun = null;
  const manual = await controller.requestStop({ expectedOperationId: 'operation-a' });
  assert.equal(manual.reason, 'no_matching_run');
  assert.equal(events.includes('provider-stop-click'), false);
  controller.currentRun = { operationId: 'operation-a', providerStopToken: 'operation-a-token', requested: false, messageDispatchStarted: true };
  const exact = await controller.requestStop({ expectedOperationId: 'operation-a' });
  assert.equal(exact.reason, 'provider_stop_clicked');
  assert.equal(exact.clicked, true);
  assert.deepEqual(events.filter((event) => event === 'provider-stop-click'), ['provider-stop-click']);
});

test('chatgpt-controller: a retired provider stop cannot click after a held page evaluation resumes', async () => {
  const events = [];
  const providerStopToken = 'a'.repeat(64);
  let browserState = { generation: 1, sequence: 1, token: providerStopToken, retiredSequence: 0, dispatch: { generation: 1, sequence: 1, state: 'dispatched' } };
  let providerStopClicks = 0;
  let stopEvaluationStarted;
  const stopStarted = new Promise((resolve) => { stopEvaluationStarted = resolve; });
  let releaseStopEvaluation;
  const release = new Promise((resolve) => { releaseStopEvaluation = resolve; });
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      const tokenMatch = /const token = ("[0-9a-f]+")/u.exec(js);
      const generationMatch = /const generation = ([0-9]+)/u.exec(js);
      const sequenceMatch = /const sequence = ([0-9]+)/u.exec(js);
      const token = tokenMatch ? JSON.parse(tokenMatch[1]) : null;
      const generation = generationMatch ? Number(generationMatch[1]) : 0;
      const sequence = sequenceMatch ? Number(sequenceMatch[1]) : 0;
      if (js.includes('agentifyStopTokenRelease')) {
        if (browserState.generation === generation && browserState.sequence === sequence && browserState.token === token) {
          browserState = { ...browserState, retiredSequence: Math.max(browserState.retiredSequence, sequence), token: null };
        }
      }
      if (js.includes('agentifyStopTokenStop')) {
        stopEvaluationStarted();
        await release;
        if (browserState.generation !== generation || browserState.sequence !== sequence || browserState.token !== token) {
          return { ok: true, state: 'mismatch', clicked: false, reason: 'provider_stop_token_mismatch' };
        }
        providerStopClicks += 1;
        return { ok: true, state: 'dispatched', clicked: true, reason: 'provider_stop_clicked' };
      }
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  const controller = createController(page);
  const run = {
    operationId: 'operation-a',
    providerStopGeneration: 1,
    providerStopSequence: 1,
    providerStopEpoch: 1,
    providerStopToken,
    providerStopRetired: false,
    requested: false,
    messageDispatchStarted: true
  };
  controller.currentRun = run;
  controller.providerStopOwner = run;

  const stopPromise = controller.requestStop({ expectedOperationId: 'operation-a' });
  await stopStarted;
  const retirement = await controller.retireProviderStop({ expectedOperationId: 'operation-a' });
  assert.equal(retirement.retired, true);
  releaseStopEvaluation();
  const stop = await stopPromise;

  assert.equal(stop.clicked, false);
  assert.equal(stop.reason, 'provider_stop_token_mismatch');
  assert.equal(providerStopClicks, 0);
  assert.equal(browserState.token, null);
  assert.equal(run.providerStopRetired, true);
});

test('chatgpt-controller: retries an exact provider stop until a delayed button appears', async () => {
  let stopVisible = false;
  const token = 'd'.repeat(64);
  const fixture = createProviderStopDomPage({
    state: { generation: 1, sequence: 1, token, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 1, sequence: 1, state: 'dispatching' } },
    isStopVisible: () => stopVisible
  });
  const controller = createController(fixture.page);
  const run = { operationId: 'delayed-stop', providerStopGeneration: 1, providerStopSequence: 1, providerStopToken: token, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  const visibleTimer = setTimeout(() => { stopVisible = true; }, 225);
  const startedAt = Date.now();
  const result = await controller.requestStop({ expectedOperationId: 'delayed-stop' });
  clearTimeout(visibleTimer);
  assert.equal(result.clicked, true);
  assert.equal(result.reason, 'provider_stop_clicked');
  assert.equal(fixture.clickCount(), 1);
  assert.ok(Date.now() - startedAt < 800);
  assert.equal(fixture.state().stopRequested, true);
  assert.equal(fixture.state().stopClicked, true);
  assert.equal(fixture.state().stopWatcherActive, false);
  controller.retireProviderStop({ expectedOperationId: 'delayed-stop' });
  await waitForCondition(() => fixture.state().token === null);
});

test('chatgpt-controller: repeated exact provider stops share one active watcher and one click', async () => {
  let stopVisible = false;
  const token = 'e'.repeat(64);
  const fixture = createProviderStopDomPage({
    state: { generation: 2, sequence: 3, token, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 2, sequence: 3, state: 'dispatched' } },
    isStopVisible: () => stopVisible
  });
  const controller = createController(fixture.page);
  const run = { operationId: 'repeated-stop', providerStopGeneration: 2, providerStopSequence: 3, providerStopToken: token, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  const first = controller.requestStop({ expectedOperationId: 'repeated-stop' });
  await waitForCondition(() => fixture.state().stopWatcherActive === true);
  const second = controller.requestStop({ expectedOperationId: 'repeated-stop' });
  setTimeout(() => { stopVisible = true; }, 225);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.clicked, true);
  assert.equal(secondResult.clicked, true);
  assert.notEqual(firstResult.reason, 'provider_stop_already_requested');
  assert.notEqual(secondResult.reason, 'provider_stop_already_requested');
  assert.equal(fixture.clickCount(), 1);
  assert.equal(fixture.state().stopClicked, true);
  assert.equal(fixture.state().stopWatcherActive, false);
  controller.retireProviderStop({ expectedOperationId: 'repeated-stop' });
  await waitForCondition(() => fixture.state().token === null);
});

test('chatgpt-controller: defers release until an exact delayed stop attempt settles', async () => {
  let stopVisible = false;
  const token = 'f'.repeat(64);
  const fixture = createProviderStopDomPage({
    state: { generation: 3, sequence: 4, token, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 3, sequence: 4, state: 'dispatched' } },
    isStopVisible: () => stopVisible
  });
  const controller = createController(fixture.page);
  const run = { operationId: 'finalization-race', providerStopGeneration: 3, providerStopSequence: 4, providerStopToken: token, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  const stopPromise = controller.requestStop({ expectedOperationId: 'finalization-race' });
  await waitForCondition(() => fixture.state().stopWatcherActive === true);
  const retirement = controller.retireProviderStop({ expectedOperationId: 'finalization-race' });
  assert.equal(retirement.retired, true);
  assert.equal(fixture.state().token, token);
  setTimeout(() => { stopVisible = true; }, 225);
  const result = await stopPromise;
  assert.equal(result.clicked, true);
  assert.equal(fixture.clickCount(), 1);
  await waitForCondition(() => fixture.state().token === null);
  assert.equal(fixture.state().stopWatcherActive, false);
  assert.equal(run.providerStopRetired, true);
});

test('chatgpt-controller: bounded provider stop timeout cleans the watcher without treating it as already stopped', async () => {
  const token = 'g'.repeat(64);
  const fixture = createProviderStopDomPage({
    state: { generation: 4, sequence: 5, token, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 4, sequence: 5, state: 'dispatching' } },
    isStopVisible: () => false
  });
  const controller = createController(fixture.page);
  const run = { operationId: 'never-stop', providerStopGeneration: 4, providerStopSequence: 5, providerStopToken: token, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  const startedAt = Date.now();
  const result = await controller.requestStop({ expectedOperationId: 'never-stop' });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.clicked, false);
  assert.equal(result.reason, 'provider_stop_not_found');
  assert.equal(fixture.clickCount(), 0);
  assert.ok(elapsed >= 700 && elapsed < 1_050);
  assert.equal(fixture.state().stopRequested, true);
  assert.equal(fixture.state().stopClicked, false);
  assert.equal(fixture.state().stopWatcherActive, false);
  controller.retireProviderStop({ expectedOperationId: 'never-stop' });
  await waitForCondition(() => fixture.state().token === null);
});

test('chatgpt-controller: outer provider stop timeout cancels the active watcher before release', async () => {
  const token = 'h'.repeat(64);
  let stopStartedResolve;
  const stopStarted = new Promise((resolve) => { stopStartedResolve = resolve; });
  let releaseHeldStop;
  const heldStop = new Promise((resolve) => { releaseHeldStop = resolve; });
  let watcherEvaluationActive = false;
  const fixture = createProviderStopDomPage({
    state: { generation: 8, sequence: 3, token, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 8, sequence: 3, state: 'dispatching' } },
    isStopVisible: () => true,
    onStopTokenEvaluateExtra: async (js, context) => {
      if (!js.includes('agentifyStopTokenStop') || js.includes('agentifyStopTokenStopCancellation')) return undefined;
      watcherEvaluationActive = true;
      context.__agentifyProviderStopState = { ...context.__agentifyProviderStopState, stopRequested: true, stopWatcherActive: true };
      stopStartedResolve();
      await heldStop;
      watcherEvaluationActive = false;
      return await vm.runInNewContext(js, context);
    }
  });
  const controller = createController(fixture.page);
  const run = { operationId: 'outer-timeout', providerStopGeneration: 8, providerStopSequence: 3, providerStopToken: token, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  const stopPromise = controller.requestStop({ expectedOperationId: 'outer-timeout' });
  await stopStarted;
  assert.equal(watcherEvaluationActive, true);
  const result = await stopPromise;
  assert.equal(result.clicked, false);
  controller.retireProviderStop({ expectedOperationId: 'outer-timeout' });
  releaseHeldStop();
  await waitForCondition(() => fixture.state().token === null, { timeoutMs: 2_500 });
  assert.equal(fixture.state().stopWatcherActive, false);
  assert.equal(fixture.clickCount(), 0);
  assert.equal(watcherEvaluationActive, false);
});

test('chatgpt-controller: deferred provider stop release retries after the watcher is terminal', async () => {
  const token = 'i'.repeat(64);
  let releaseCalls = 0;
  const fixture = createProviderStopDomPage({
    state: { generation: 9, sequence: 4, token, stopRequested: true, stopClicked: false, stopWatcherActive: false, retiredSequence: 4, dispatch: { generation: 9, sequence: 4, state: 'cancelled' } },
    isStopVisible: () => false,
    onStopTokenEvaluateExtra: async (js, context) => {
      if (!js.includes('agentifyStopTokenRelease')) return undefined;
      releaseCalls += 1;
      if (releaseCalls === 1) return { ok: true, cleared: false, deferred: true };
      return await vm.runInNewContext(js, context);
    }
  });
  const controller = createController(fixture.page);
  const run = { operationId: 'deferred-release', providerStopGeneration: 9, providerStopSequence: 4, providerStopToken: token, providerStopRetired: false, requested: true, messageDispatchStarted: false };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  controller.retireProviderStop({ expectedOperationId: 'deferred-release' });
  await waitForCondition(() => fixture.state().token === null);
  assert.ok(releaseCalls >= 2);
  assert.equal(fixture.state().stopWatcherActive, false);
});

test('chatgpt-controller: timed-out stale provider watcher cannot click or clear the next token', async () => {
  const tokenA = 'j'.repeat(64);
  const tokenB = 'k'.repeat(64);
  let stopStartedResolve;
  const stopStarted = new Promise((resolve) => { stopStartedResolve = resolve; });
  let releaseHeldStop;
  const heldStop = new Promise((resolve) => { releaseHeldStop = resolve; });
  const fixture = createProviderStopDomPage({
    state: { generation: 10, sequence: 5, token: tokenA, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 10, sequence: 5, state: 'dispatching' } },
    isStopVisible: () => true,
    onStopTokenEvaluateExtra: async (js, context) => {
      if (!js.includes('agentifyStopTokenStop') || js.includes('agentifyStopTokenStopCancellation')) return undefined;
      context.__agentifyProviderStopState = { ...context.__agentifyProviderStopState, stopRequested: true, stopWatcherActive: true };
      stopStartedResolve();
      await heldStop;
      return await vm.runInNewContext(js, context);
    }
  });
  const controller = createController(fixture.page);
  const runA = { operationId: 'stale-a', providerStopGeneration: 10, providerStopSequence: 5, providerStopToken: tokenA, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = runA;
  controller.providerStopOwner = runA;
  const stopPromise = controller.requestStop({ expectedOperationId: 'stale-a' });
  await stopStarted;
  await stopPromise;
  controller.retireProviderStop({ expectedOperationId: 'stale-a' });
  fixture.context.__agentifyProviderStopState = { generation: 11, sequence: 1, token: tokenB, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 11, sequence: 1, state: 'dispatched' } };
  releaseHeldStop();
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(fixture.clickCount(), 0);
  assert.equal(fixture.state().token, tokenB);
  assert.equal(fixture.state().generation, 11);
});

test('chatgpt-controller: never-settling stop evaluation frees the runtime and releases the old token', async () => {
  const token = 'l'.repeat(64);
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const fixture = createProviderStopDomPage({
    state: { generation: 12, sequence: 6, token, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 12, sequence: 6, state: 'dispatching' } },
    isStopVisible: () => false,
    onStopTokenEvaluateExtra: async (js) => {
      if (js.includes('agentifyStopTokenStop') && !js.includes('agentifyStopTokenStopCancellation')) return await new Promise(() => {});
      return undefined;
    }
  });
  const controller = createController(fixture.page);
  const run = { operationId: 'never-settling-cdp', providerStopGeneration: 12, providerStopSequence: 6, providerStopToken: token, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  const startedAt = Date.now();
  const result = await controller.requestStop({ expectedOperationId: 'never-settling-cdp' });
  assert.ok(Date.now() - startedAt < 1_250);
  assert.equal(result.clicked, false);
  controller.retireProviderStop({ expectedOperationId: 'never-settling-cdp' });
  await waitForCondition(() => fixture.state().token === null, { timeoutMs: 2_000 });
  assert.equal(controller.providerStopOwner, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});

test('chatgpt-controller: stale provider stop script cannot click the following exact operation', async () => {
  const tokenA = 'a'.repeat(64);
  const fixture = createProviderStopDomPage({
    state: { generation: 5, sequence: 6, token: tokenA, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 5, sequence: 6, state: 'dispatched' } },
    isStopVisible: () => true
  });
  const controller = createController(fixture.page);
  const runA = { operationId: 'following-a', providerStopGeneration: 5, providerStopSequence: 6, providerStopToken: tokenA, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = runA;
  controller.providerStopOwner = runA;
  const resultA = await controller.requestStop({ expectedOperationId: 'following-a' });
  assert.equal(resultA.clicked, true);
  const staleScript = fixture.stopScript();
  controller.retireProviderStop({ expectedOperationId: 'following-a' });
  await waitForCondition(() => fixture.state().token === null);

  const tokenB = 'b'.repeat(64);
  fixture.context.__agentifyProviderStopState = {
    generation: 6,
    sequence: 1,
    token: tokenB,
    stopRequested: false,
    stopClicked: false,
    stopWatcherActive: false,
    retiredSequence: 0,
    dispatch: { generation: 6, sequence: 1, state: 'dispatched' }
  };
  const staleResult = await vm.runInNewContext(staleScript, fixture.context);
  assert.equal(staleResult.clicked, false);
  assert.equal(staleResult.reason, undefined);
  assert.equal(fixture.clickCount(), 1);

  const runB = { operationId: 'following-b', providerStopGeneration: 6, providerStopSequence: 1, providerStopToken: tokenB, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = runB;
  controller.providerStopOwner = runB;
  const resultB = await controller.requestStop({ expectedOperationId: 'following-b' });
  assert.equal(resultB.clicked, true);
  assert.equal(fixture.clickCount(), 2);
  controller.retireProviderStop({ expectedOperationId: 'following-b' });
  await waitForCondition(() => fixture.state().token === null);
});

test('chatgpt-controller: an immediately visible provider stop button is clicked once', async () => {
  const token = 'c'.repeat(64);
  const fixture = createProviderStopDomPage({
    state: { generation: 7, sequence: 2, token, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: { generation: 7, sequence: 2, state: 'dispatched' } },
    isStopVisible: () => true
  });
  const controller = createController(fixture.page);
  const run = { operationId: 'immediate-stop', providerStopGeneration: 7, providerStopSequence: 2, providerStopToken: token, providerStopRetired: false, requested: false, messageDispatchStarted: true };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  const startedAt = Date.now();
  const result = await controller.requestStop({ expectedOperationId: 'immediate-stop' });
  assert.equal(result.clicked, true);
  assert.equal(result.reason, 'provider_stop_clicked');
  assert.equal(fixture.clickCount(), 1);
  assert.ok(Date.now() - startedAt < 200);
  controller.retireProviderStop({ expectedOperationId: 'immediate-stop' });
  await waitForCondition(() => fixture.state().token === null);
});

test('chatgpt-controller: activation abort is bounded and never types the prompt', async () => {
  const events = [];
  let activationStartedResolve;
  const activationStarted = new Promise((resolve) => { activationStartedResolve = resolve; });
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStateRead')) return { ok: true, generation: 0, sequence: 0, retiredSequence: 0, dispatchState: null };
      if (js.includes('agentifyStopTokenActivation')) {
        activationStartedResolve();
        return await new Promise(() => {});
      }
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  const controller = createController(page);
  const signalController = new AbortController();
  const query = controller.query({ prompt: 'must not type during activation hang', operationId: 'activation-abort', signal: signalController.signal, timeoutMs: 5_000 });
  await activationStarted;
  const startedAt = Date.now();
  signalController.abort();
  await assert.rejects(query, (error) => error.message === 'query_aborted' && error.data?.reason === 'user_stop');
  assert.ok(Date.now() - startedAt < 500, 'activation abort should not wait for the page evaluation');
  assert.deepEqual(events.filter((event) => event.startsWith('text:')), []);
  assert.equal(controller.currentRun, null);
  assert.equal(controller.providerStopOwner, null);
});

test('chatgpt-controller: activation timeout returns an explicit bounded error', async () => {
  const events = [];
  let activationStartedResolve;
  const activationStarted = new Promise((resolve) => { activationStartedResolve = resolve; });
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStateRead')) return { ok: true, generation: 0, sequence: 0, retiredSequence: 0, dispatchState: null };
      if (js.includes('agentifyStopTokenActivation')) {
        activationStartedResolve();
        return await new Promise(() => {});
      }
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  const controller = createController(page);
  const startedAt = Date.now();
  const query = controller.query({ prompt: 'must not type after activation timeout', operationId: 'activation-timeout', timeoutMs: 5_000 });
  await activationStarted;
  await assert.rejects(query, (error) => error.message === 'provider_stop_token_activation_timeout' && error.data?.timeoutMs === 1_000);
  assert.ok(Date.now() - startedAt < 1_300, 'activation timeout should be bounded');
  assert.deepEqual(events.filter((event) => event.startsWith('text:')), []);
  assert.equal(controller.currentRun, null);
  assert.equal(controller.providerStopOwner, null);
});

test('chatgpt-controller: late activation cannot overwrite a newer generation fence', async () => {
  const events = [];
  let browserState = { generation: 0, sequence: 0, token: null, retiredSequence: 0, dispatch: null };
  let aActivationStartedResolve;
  const aActivationStarted = new Promise((resolve) => { aActivationStartedResolve = resolve; });
  let releaseAActivation;
  const aActivationRelease = new Promise((resolve) => { releaseAActivation = resolve; });
  let aActivationFinishedResolve;
  const aActivationFinished = new Promise((resolve) => { aActivationFinishedResolve = resolve; });
  let bActivationStartedResolve;
  const bActivationStarted = new Promise((resolve) => { bActivationStartedResolve = resolve; });
  let releaseBActivation;
  const bActivationRelease = new Promise((resolve) => { releaseBActivation = resolve; });
  const parseLifecycle = (js) => ({
    generation: Number(/const generation = ([0-9]+)/u.exec(js)?.[1] || 0),
    sequence: Number(/const sequence = ([0-9]+)/u.exec(js)?.[1] || 0),
    token: JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || '""')
  });
  const applyActivation = ({ generation, sequence, token }) => {
    if (generation < browserState.generation || (generation === browserState.generation && (sequence <= browserState.sequence || browserState.retiredSequence >= sequence))) return false;
    browserState = {
      generation,
      sequence,
      token,
      retiredSequence: generation > browserState.generation ? 0 : browserState.retiredSequence,
      dispatch: { generation, sequence, state: 'pending' }
    };
    return true;
  };
  const applyRelease = ({ generation, sequence, token }) => {
    if (browserState.generation !== generation || browserState.sequence !== sequence || browserState.token !== token) return;
    browserState = {
      ...browserState,
      retiredSequence: Math.max(browserState.retiredSequence, sequence),
      token: null,
      dispatch: { generation, sequence, state: 'cancelled' }
    };
  };
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStateRead')) return {
        ok: true,
        generation: browserState.generation,
        sequence: browserState.sequence,
        retiredSequence: browserState.retiredSequence,
        dispatchState: browserState.dispatch?.state || null
      };
      const lifecycle = parseLifecycle(js);
      if (js.includes('agentifyStopTokenActivation')) {
        if (lifecycle.sequence === 1) {
          aActivationStartedResolve();
          await aActivationRelease;
          const applied = applyActivation(lifecycle);
          aActivationFinishedResolve();
          return { ok: true, applied, generation: lifecycle.generation, sequence: lifecycle.sequence, token: lifecycle.token };
        }
        const applied = applyActivation(lifecycle);
        bActivationStartedResolve();
        await bActivationRelease;
        return { ok: true, applied, generation: lifecycle.generation, sequence: lifecycle.sequence, token: lifecycle.token };
      }
      if (js.includes('agentifyStopTokenRelease')) applyRelease(lifecycle);
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  const controller = createController(page);
  const aSignal = new AbortController();
  const aQuery = controller.query({ prompt: 'old activation', operationId: 'activation-a', signal: aSignal.signal, timeoutMs: 5_000 });
  await aActivationStarted;
  aSignal.abort();
  await assert.rejects(aQuery, /query_aborted/u);

  const bSignal = new AbortController();
  const bQuery = controller.query({ prompt: 'new activation', operationId: 'activation-b', signal: bSignal.signal, timeoutMs: 5_000 });
  await bActivationStarted;
  const bToken = browserState.token;
  assert.ok(browserState.generation >= 1);
  assert.equal(browserState.sequence, 2);
  assert.ok(bToken);
  releaseAActivation();
  await aActivationFinished;
  assert.equal(browserState.sequence, 2);
  assert.equal(browserState.token, bToken);
  bSignal.abort();
  releaseBActivation();
  await assert.rejects(bQuery, /query_aborted/u);
});

test('chatgpt-controller: cross-controller same-sequence activation and release preserve the newer dispatch fence', async () => {
  const events = [];
  let operationTokenB = null;
  let browserState = { generation: 0, sequence: 0, token: null, stopRequested: false, retiredSequence: 0, dispatch: null };
  let lastActivationScript = '';
  let aActivationStartedResolve;
  const aActivationStarted = new Promise((resolve) => { aActivationStartedResolve = resolve; });
  let releaseAActivation;
  const aActivationRelease = new Promise((resolve) => { releaseAActivation = resolve; });
  let aReleaseStartedResolve;
  const aReleaseStarted = new Promise((resolve) => { aReleaseStartedResolve = resolve; });
  let releaseARelease;
  const aReleaseGate = new Promise((resolve) => { releaseARelease = resolve; });
  let bActivationStartedResolve;
  const bActivationStarted = new Promise((resolve) => { bActivationStartedResolve = resolve; });
  let bReleaseStartedResolve;
  const bReleaseStarted = new Promise((resolve) => { bReleaseStartedResolve = resolve; });
  let releaseBRelease;
  const bReleaseGate = new Promise((resolve) => { releaseBRelease = resolve; });
  let bReleaseFinishedResolve;
  const bReleaseFinished = new Promise((resolve) => { bReleaseFinishedResolve = resolve; });
  let dispatchCount = 0;
  let providerStopCount = 0;

  const parseLifecycle = (js) => ({
    generation: Number(/const generation = ([0-9]+)/u.exec(js)?.[1] || 0),
    sequence: Number(/const sequence = ([0-9]+)/u.exec(js)?.[1] || 0),
    token: JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null')
  });
  const applyActivation = ({ generation, sequence, token }) => {
    if (generation < browserState.generation || (generation === browserState.generation && (sequence <= browserState.sequence || browserState.retiredSequence >= sequence))) return false;
    browserState = {
      generation,
      sequence,
      token,
      stopRequested: false,
      retiredSequence: generation > browserState.generation ? 0 : browserState.retiredSequence,
      dispatch: { generation, sequence, state: 'pending' }
    };
    return true;
  };
  const applyRelease = ({ generation, sequence, token }) => {
    if (browserState.generation !== generation || browserState.sequence !== sequence || browserState.token !== token) return;
    browserState = {
      ...browserState,
      token: null,
      retiredSequence: Math.max(browserState.retiredSequence, sequence),
      dispatch: { generation, sequence, state: 'cancelled' }
    };
  };

  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
    recordSendEvaluation: false,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStop')) {
        const generation = Number(/const expectedGeneration = ([0-9]+)/u.exec(js)?.[1] || 0);
        const sequence = Number(/const expectedSequence = ([0-9]+)/u.exec(js)?.[1] || 0);
        const token = JSON.parse(/const expectedToken = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null');
        if (browserState.generation !== generation || browserState.sequence !== sequence || browserState.token !== token || browserState.stopRequested) {
          return { ok: true, state: 'mismatch', clicked: false, reason: 'provider_stop_token_mismatch' };
        }
        if (browserState.dispatch?.state === 'pending') {
          browserState = { ...browserState, stopRequested: true, retiredSequence: sequence, dispatch: { generation, sequence, state: 'cancelled' } };
          return { ok: true, state: 'cancelled', cancelled: true, clicked: false };
        }
        if (!['dispatching', 'dispatched'].includes(browserState.dispatch?.state)) return { ok: true, state: 'mismatch', clicked: false };
        browserState = { ...browserState, stopRequested: true };
        providerStopCount += 1;
        return { ok: true, state: browserState.dispatch.state, clicked: true, reason: 'provider_stop_clicked' };
      }
      if (js.includes('agentifyStopTokenStateRead')) return {
        ok: true,
        generation: browserState.generation,
        sequence: browserState.sequence,
        retiredSequence: browserState.retiredSequence,
        dispatchState: browserState.dispatch?.state || null
      };
      const lifecycle = parseLifecycle(js);
      if (js.includes('agentifyStopTokenActivation')) {
        lastActivationScript = js;
        if (lifecycle.generation === 101 && !operationTokenB) operationTokenB = lifecycle.token;
        if (lifecycle.generation === 100) {
          aActivationStartedResolve();
          await aActivationRelease;
        }
        const applied = applyActivation(lifecycle);
        if (lifecycle.generation === 100) return { ok: true, applied, generation: lifecycle.generation, sequence: lifecycle.sequence, token: lifecycle.token };
        bActivationStartedResolve();
        return { ok: true, applied, generation: lifecycle.generation, sequence: lifecycle.sequence, token: lifecycle.token };
      }
      if (js.includes('agentifyStopTokenRelease')) {
        if (lifecycle.generation === 100) {
          aReleaseStartedResolve();
          await aReleaseGate;
        }
        if (lifecycle.generation === 101) {
          bReleaseStartedResolve();
          await bReleaseGate;
        }
        applyRelease(lifecycle);
        if (lifecycle.generation === 101) bReleaseFinishedResolve();
      }
      if (js.includes('agentifyStopTokenDispatchCheck')) return {
        ok: true,
        active: browserState.generation === Number(/const expectedGeneration = ([0-9]+)/u.exec(js)?.[1] || 0) && browserState.sequence === Number(/const expectedSequence = ([0-9]+)/u.exec(js)?.[1] || 0) && browserState.token === JSON.parse(/const expectedToken = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null') && !browserState.stopRequested,
        generation: browserState.generation,
        sequence: browserState.sequence,
        retiredSequence: browserState.retiredSequence,
        dispatchState: browserState.dispatch?.state || 'unknown'
      };
      return { ok: true };
    },
    onEvaluateExtra: async (js) => {
      if (js.includes('const agentifyStopTokenDispatchAction')) {
        dispatchCount += 1;
        browserState = { ...browserState, dispatch: { generation: browserState.generation, sequence: browserState.sequence, state: 'dispatched' } };
        return { attempted: true, dispatchClaimed: true, dispatchState: 'dispatched' };
      }
      if (isClickSendEvaluation(js)) return {
        ok: true,
        isChatGPT: true,
        fallbackEnter: true,
        host: 'chatgpt.com',
        sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'cross-controller', activePromptTextDigest: userTurnDigestForTest('cross-controller'), activePromptTextLength: 17 }
      };
      if (js.includes('normalStopVisible')) return { isChatGPT: true, userCount: 1, lastUserId: 'new-turn', lastUserTextDigest: userTurnDigestForTest('cross-controller'), activePromptText: '', activePromptTextDigest: userTurnDigestForTest(''), activePromptTextLength: 0, hasNormalSend: false, normalStopVisible: true };
      return undefined;
    }
  });

  const controllerA = createController(page);
  controllerA.providerStopGeneration = 100;
  controllerA.providerStopSequence = 20;
  const aSignal = new AbortController();
  const aQuery = controllerA.query({ prompt: 'old controller', operationId: 'cross-a', signal: aSignal.signal, timeoutMs: 5_000 });
  await aActivationStarted;
  aSignal.abort();
  await assert.rejects(aQuery, /query_aborted/u);

  const controllerB = createController(page);
  controllerB.providerStopGeneration = 101;
  controllerB.providerStopSequence = 20;
  const bQuery = controllerB.send({ text: 'cross-controller', operationId: 'cross-b', stopAfterSend: true, timeoutMs: 5_000 });
  await bActivationStarted;
  assert.equal(browserState.generation, 101);
  assert.equal(browserState.sequence, 21);
  assert.equal(browserState.token, operationTokenB);

  const collisionToken = 'c'.repeat(64);
  const collisionScript = lastActivationScript.replace(/const token = "[0-9a-f]+"/u, `const token = ${JSON.stringify(collisionToken)}`);
  const collisionContext = {
    globalThis: {
      __agentifyProviderStopState: structuredClone(browserState)
    }
  };
  const collision = vm.runInNewContext(collisionScript, collisionContext);
  assert.equal(collision.applied, false);
  assert.equal(browserState.token, operationTokenB);
  assert.equal(collisionContext.globalThis.__agentifyProviderStopState.token, operationTokenB);

  releaseAActivation();
  assert.equal(browserState.generation, 101);
  await aReleaseStarted;
  releaseARelease();
  await bQuery;
  assert.equal(dispatchCount, 1);
  assert.equal(providerStopCount, 1);
  assert.equal(browserState.generation, 101);
  assert.equal(browserState.sequence, 21);
  assert.equal(browserState.token, operationTokenB);
  await bReleaseStarted;
  releaseBRelease();
  await bReleaseFinished;
  assert.equal(browserState.token, null);
});

test('chatgpt-controller: coordinate claim stopped before mouseDown rolls back without provider stop or draft loss', async () => {
  const events = [];
  let stopPromise = null;
  let claimCompletedResolve;
  const claimCompleted = new Promise((resolve) => { claimCompletedResolve = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    onClaimCompleted: async () => {
      claimCompletedResolve();
      stopPromise = controller.requestStop();
    },
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'coordinate claim', activePromptTextDigest: userTurnDigestForTest('coordinate claim'), activePromptTextLength: 16 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'coordinate claim', timeoutMs: 5_000 });
  await claimCompleted;
  const run = controller.currentRun;
  const stop = await stopPromise;
  assert.equal(stop.reason, 'before_dispatch');
  assert.equal(stop.clicked, false);
  assert.equal(harness.providerStopCount(), 0);
  assert.equal(run.messageDispatchStarted, false);
  assert.equal(run.dispatchState, 'cancelled');
  assert.equal(events.includes('normal-send-click'), false);
  await assert.rejects(sendPromise, /query_aborted/u);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: keyboard claim stopped before sendKey rolls back without provider stop or draft loss', async () => {
  const events = [];
  let stopPromise = null;
  let claimCompletedResolve;
  const claimCompleted = new Promise((resolve) => { claimCompletedResolve = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    actionMode: 'none',
    onClaimCompleted: async () => {
      claimCompletedResolve();
      stopPromise = controller.requestStop();
    },
    sendResult: { ok: true, isChatGPT: false, fallbackEnter: true, host: 'example.com' },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'keyboard claim', timeoutMs: 5_000 });
  await claimCompleted;
  const run = controller.currentRun;
  const stop = await stopPromise;
  assert.equal(stop.reason, 'before_dispatch');
  assert.equal(stop.clicked, false);
  assert.equal(harness.providerStopCount(), 0);
  assert.equal(run.messageDispatchStarted, false);
  assert.equal(run.dispatchState, 'cancelled');
  await assert.rejects(sendPromise, /query_aborted/u);
  assert.equal(events.some((event) => event === 'key:Enter'), false);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: coordinate action start makes stop provider-owned and preserves the draft', async () => {
  const events = [];
  let mouseDownStartedResolve;
  const mouseDownStarted = new Promise((resolve) => { mouseDownStartedResolve = resolve; });
  let releaseMouseDown;
  const mouseDownGate = new Promise((resolve) => { releaseMouseDown = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    onMouseDown: async (x) => {
      if (x < 80) return;
      mouseDownStartedResolve();
      await mouseDownGate;
    },
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'coordinate started', activePromptTextDigest: userTurnDigestForTest('coordinate started'), activePromptTextLength: 18 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'coordinate started', timeoutMs: 5_000 });
  await mouseDownStarted;
  const run = controller.currentRun;
  assert.equal(run.messageDispatchStarted, true);
  const stop = await controller.requestStop();
  assert.equal(stop.clicked, true);
  assert.equal(harness.providerStopCount(), 1);
  assert.equal(events.includes('normal-send-click'), true);
  releaseMouseDown();
  await assert.rejects(sendPromise, /query_aborted|send_not_triggered|provider_stop_token_not_active/u);
  assert.equal(harness.actionCount(), 0);
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: keyboard action start makes stop provider-owned and preserves the draft', async () => {
  const events = [];
  let keyStartedResolve;
  const keyStarted = new Promise((resolve) => { keyStartedResolve = resolve; });
  let releaseKey;
  const keyGate = new Promise((resolve) => { releaseKey = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    actionMode: 'none',
    onSendKey: async (key) => {
      if (key !== 'Enter') return;
      keyStartedResolve();
      await keyGate;
    },
    sendResult: { ok: true, isChatGPT: false, fallbackEnter: true, host: 'example.com' },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'keyboard started', timeoutMs: 5_000 });
  await keyStarted;
  const run = controller.currentRun;
  assert.equal(run.messageDispatchStarted, true);
  const stop = await controller.requestStop();
  assert.equal(stop.clicked, true);
  assert.equal(harness.providerStopCount(), 1);
  releaseKey();
  await assert.rejects(sendPromise, /query_aborted|send_not_triggered|provider_stop_token_not_active/u);
  assert.equal(events.filter((event) => event === 'key:Enter').length, 1);
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: dispatch rollback rejects a claimed-state mismatch without marking input started', async () => {
  const events = [];
  let claimStartedResolve;
  const claimStarted = new Promise((resolve) => { claimStartedResolve = resolve; });
  let releaseClaim;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  let rollbackResult = null;
  const harness = createDispatchRaceHarness({
    events,
    claimGate,
    onClaimStarted: claimStartedResolve,
    claimStateOverride: 'dispatching',
    onRollback: (result) => { rollbackResult = result; },
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'rollback mismatch', activePromptTextDigest: userTurnDigestForTest('rollback mismatch'), activePromptTextLength: 17 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'rollback mismatch', timeoutMs: 5_000 });
  await claimStarted;
  const run = controller.currentRun;
  run.requested = true;
  run.reason = 'user_stop';
  releaseClaim();
  await assert.rejects(sendPromise, /query_aborted/u);
  assert.deepEqual(rollbackResult, { ok: true, rolledBack: false, state: 'dispatching' });
  assert.equal(run.messageDispatchStarted, false);
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: coordinate start lease held during stop prevents mouse input and cleans the draft', async () => {
  const events = [];
  let mouseDownCount = 0;
  let mouseUpCount = 0;
  let startStartedResolve;
  const startStarted = new Promise((resolve) => { startStartedResolve = resolve; });
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    startGate,
    onStartStarted: startStartedResolve,
    onMouseDown: async (x) => { if (x >= 80) mouseDownCount += 1; },
    onMouseUp: async (x) => { if (x >= 80) mouseUpCount += 1; },
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'held coordinate start', activePromptTextDigest: userTurnDigestForTest('held coordinate start'), activePromptTextLength: 20 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'held coordinate start', timeoutMs: 5_000 });
  await startStarted;
  assert.equal(harness.state().dispatch.state, 'claimed');
  const run = controller.currentRun;
  const stop = await controller.requestStop();
  assert.equal(stop.reason, 'before_dispatch');
  assert.equal(harness.state().dispatch.state, 'cancelled');
  releaseStart();
  await assert.rejects(sendPromise, /query_aborted/u);
  assert.equal(mouseDownCount, 0);
  assert.equal(mouseUpCount, 0);
  assert.equal(harness.providerStopCount(), 0);
  assert.equal(run.messageDispatchStarted, false);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: keyboard start lease held during stop prevents key input and cleans the draft', async () => {
  const events = [];
  let keyCount = 0;
  let startStartedResolve;
  const startStarted = new Promise((resolve) => { startStartedResolve = resolve; });
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    actionMode: 'none',
    startGate,
    onStartStarted: startStartedResolve,
    onSendKey: async (key) => { if (key === 'Enter') keyCount += 1; },
    sendResult: { ok: true, isChatGPT: false, fallbackEnter: true, host: 'example.com' },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'held keyboard start', timeoutMs: 5_000 });
  await startStarted;
  assert.equal(harness.state().dispatch.state, 'claimed');
  const run = controller.currentRun;
  const stop = await controller.requestStop();
  assert.equal(stop.reason, 'before_dispatch');
  assert.equal(harness.state().dispatch.state, 'cancelled');
  releaseStart();
  await assert.rejects(sendPromise, /query_aborted/u);
  assert.equal(keyCount, 0);
  assert.equal(harness.providerStopCount(), 0);
  assert.equal(run.messageDispatchStarted, false);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: start success followed by stop before the input sync section sends nothing and cleans the draft', async () => {
  const events = [];
  let mouseDownCount = 0;
  let stopPromise = null;
  const harness = createDispatchRaceHarness({
    onStartCompleted: async () => {
      stopPromise = controller.requestStop();
    },
    onMouseDown: async (x) => { if (x >= 80) mouseDownCount += 1; },
    events,
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'stop first', activePromptTextDigest: userTurnDigestForTest('stop first'), activePromptTextLength: 10 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'stop first', timeoutMs: 5_000 });
  await assert.rejects(sendPromise, /query_aborted/u);
  await stopPromise;
  assert.equal(mouseDownCount, 0);
  assert.equal(harness.state().token, null);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: start timeout reconciles a claimed lease and cleans the unsent draft', async () => {
  const events = [];
  let startStartedResolve;
  const startStarted = new Promise((resolve) => { startStartedResolve = resolve; });
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  let mouseDownCount = 0;
  const harness = createDispatchRaceHarness({
    events,
    startGate,
    onStartStarted: startStartedResolve,
    onMouseDown: async (x) => { if (x >= 80) mouseDownCount += 1; },
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'start timeout', activePromptTextDigest: userTurnDigestForTest('start timeout'), activePromptTextLength: 12 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'start timeout', timeoutMs: 5_000 });
  await startStarted;
  await assert.rejects(sendPromise, /provider_stop_token_not_active/u);
  releaseStart();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(mouseDownCount, 0);
  assert.equal(controller.currentRun, null);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: keyboard start timeout reconciles a claimed lease and cleans the unsent draft', async () => {
  const events = [];
  let keyCount = 0;
  let startStartedResolve;
  const startStarted = new Promise((resolve) => { startStartedResolve = resolve; });
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    actionMode: 'none',
    startGate,
    onStartStarted: startStartedResolve,
    onSendKey: async (key) => { if (key === 'Enter') keyCount += 1; },
    sendResult: { ok: true, isChatGPT: false, fallbackEnter: true, host: 'example.com' },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'keyboard start timeout', timeoutMs: 5_000 });
  await startStarted;
  await assert.rejects(sendPromise, /provider_stop_token_not_active/u);
  assert.equal(keyCount, 0);
  assert.equal(harness.state().token, null);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
  releaseStart();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(controller.currentRun, null);
});

test('chatgpt-controller: unknown start state suppresses automatic draft cleanup', async () => {
  const events = [];
  let mouseDownCount = 0;
  const harness = createDispatchRaceHarness({
    events,
    claimStateOverride: 'unknown',
    onMouseDown: async (x) => { if (x >= 80) mouseDownCount += 1; },
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'unknown start', activePromptTextDigest: userTurnDigestForTest('unknown start'), activePromptTextLength: 13 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'unknown start', timeoutMs: 5_000 });
  await assert.rejects(sendPromise, /provider_stop_dispatch_unknown/u);
  assert.equal(mouseDownCount, 0);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), []);
});

test('chatgpt-controller: stale start evaluation cannot change the newer run or start input', async () => {
  const events = [];
  let releaseFirstStart;
  const firstStartGate = new Promise((resolve) => { releaseFirstStart = resolve; });
  let firstStartStartedResolve;
  const firstStartStarted = new Promise((resolve) => { firstStartStartedResolve = resolve; });
  let secondStartStartedResolve;
  const secondStartStarted = new Promise((resolve) => { secondStartStartedResolve = resolve; });
  let firstStartFinishedResolve;
  const firstStartFinished = new Promise((resolve) => { firstStartFinishedResolve = resolve; });
  let mouseDownStartedResolve;
  const mouseDownStarted = new Promise((resolve) => { mouseDownStartedResolve = resolve; });
  let releaseMouseDown;
  const mouseDownGate = new Promise((resolve) => { releaseMouseDown = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    startGate: (count) => count === 1 ? firstStartGate : null,
    startResult: ({ count, state }) => {
      if (count !== 1) return undefined;
      firstStartFinishedResolve();
      return { ok: true, started: false, state: 'mismatch', generation: state.generation, sequence: state.sequence };
    },
    onStartStarted: (count) => {
      if (count === 1) firstStartStartedResolve();
      else secondStartStartedResolve();
    },
    onMouseDown: async (x) => {
      if (x < 80) return;
      mouseDownStartedResolve();
      await mouseDownGate;
    },
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'stale start', activePromptTextDigest: userTurnDigestForTest('stale start'), activePromptTextLength: 11 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const firstSend = controller.send({ text: 'stale start', timeoutMs: 5_000 });
  await firstStartStarted;
  await assert.rejects(firstSend, /provider_stop_token_not_active|provider_stop_dispatch_unknown/u);

  const secondSend = controller.send({ text: 'newer start', timeoutMs: 5_000 });
  await secondStartStarted;
  await mouseDownStarted;
  const stateBeforeLateFirstStart = structuredClone(harness.state());
  releaseFirstStart();
  await firstStartFinished;
  assert.deepEqual(harness.state(), stateBeforeLateFirstStart);
  assert.equal(events.filter((event) => event === 'normal-send-click').length, 1);

  const stop = await controller.requestStop();
  assert.equal(stop.clicked, true);
  assert.equal(harness.providerStopCount(), 1);
  releaseMouseDown();
  await assert.rejects(secondSend, /query_aborted|send_not_triggered|provider_stop_token_not_active/u);
  assert.equal(events.filter((event) => event === 'cleanup-draft').length, 1);
});

test('chatgpt-controller: start result fence and state mismatches never start coordinate or keyboard input', async () => {
  const mismatchCases = [
    ['generation mismatch', ({ expected }) => ({ ok: true, started: true, state: 'dispatching', generation: expected.generation + 1, sequence: expected.sequence })],
    ['sequence mismatch', ({ expected }) => ({ ok: true, started: true, state: 'dispatching', generation: expected.generation, sequence: expected.sequence + 1 })],
    ['started false', ({ expected }) => ({ ok: true, started: false, state: 'claimed', generation: expected.generation, sequence: expected.sequence })],
    ['cancelled', ({ expected }) => ({ ok: true, started: false, state: 'cancelled', generation: expected.generation, sequence: expected.sequence })]
  ];

  for (const [label, makeResult] of mismatchCases) {
    for (const mode of ['coordinate', 'keyboard']) {
      const events = [];
      let mouseDownCount = 0;
      let keyCount = 0;
      const harness = createDispatchRaceHarness({
        events,
        actionMode: mode === 'keyboard' ? 'none' : 'generic',
        startResult: makeResult,
        onMouseDown: async (x) => { if (x >= 80) mouseDownCount += 1; },
        onSendKey: async (key) => { if (key === 'Enter') keyCount += 1; },
        sendResult: mode === 'keyboard'
          ? { ok: true, isChatGPT: false, fallbackEnter: true, host: 'example.com' }
          : { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 }, sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: label, activePromptTextDigest: userTurnDigestForTest(label), activePromptTextLength: label.length } },
        cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
      });
      const controller = createController(harness.page);
      const sendPromise = controller.send({ text: `${label} ${mode}`, timeoutMs: 5_000 });
      await assert.rejects(sendPromise, /provider_stop_token_not_active|provider_stop_dispatch_unknown/u, `${label}/${mode}`);
      assert.equal(mouseDownCount, 0, `${label}/${mode} mouseDown`);
      assert.equal(keyCount, 0, `${label}/${mode} sendKey`);
      assert.equal(harness.providerStopCount(), 0, `${label}/${mode} provider stop`);
      assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft'], `${label}/${mode} cleanup`);
    }
  }
});

test('chatgpt-controller: stop during a DOM click fallback prevents the retry and stops only the exact dispatch', async () => {
  const events = [];
  let actionStartedResolve;
  const actionStarted = new Promise((resolve) => { actionStartedResolve = resolve; });
  let releaseAction;
  const actionGate = new Promise((resolve) => { releaseAction = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    actionMode: 'dom',
    actionGate,
    onActionStarted: actionStartedResolve,
    sendResult: {
      ok: true,
      isChatGPT: true,
      fallbackEnter: false,
      host: 'chatgpt.com',
      rect: { x: 90, y: 10, w: 20, h: 20 },
      sendBaseline: {
        userCount: 0,
        lastUserId: '',
        lastUserTextDigest: userTurnDigestForTest(''),
        activePromptText: 'dom fallback race',
        activePromptTextDigest: userTurnDigestForTest('dom fallback race'),
        activePromptTextLength: 17
      }
    },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'dom fallback race', timeoutMs: 5_000 });
  await actionStarted;
  const stop = await controller.requestStop();
  assert.equal(stop.clicked, true);
  assert.equal(harness.providerStopCount(), 1);
  releaseAction();
  await assert.rejects(sendPromise, /provider_stop_token_not_active/u);
  assert.equal(harness.actionCount(), 0);
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: stop while requestSubmit dispatch is pending cancels without sending and cleans the draft', async () => {
  const events = [];
  let actionStartedResolve;
  const actionStarted = new Promise((resolve) => { actionStartedResolve = resolve; });
  let releaseAction;
  const actionGate = new Promise((resolve) => { releaseAction = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    actionGate,
    onActionStarted: actionStartedResolve,
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: true, host: 'chatgpt.com', sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'request submit race', activePromptTextDigest: userTurnDigestForTest('request submit race'), activePromptTextLength: 19 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'request submit race', timeoutMs: 5_000 });
  await actionStarted;
  const stop = await controller.requestStop();
  assert.equal(stop.reason, 'before_dispatch');
  assert.equal(stop.clicked, false);
  assert.equal(harness.providerStopCount(), 0);
  releaseAction();
  await assert.rejects(sendPromise, /provider_stop_token_not_active/u);
  assert.equal(harness.actionCount(), 0);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: stop while the keyboard fallback claim is pending sends no key and cleans the draft', async () => {
  const events = [];
  let claimStartedResolve;
  const claimStarted = new Promise((resolve) => { claimStartedResolve = resolve; });
  let releaseClaim;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    actionMode: 'none',
    claimGate,
    onClaimStarted: claimStartedResolve,
    sendResult: { ok: true, isChatGPT: false, fallbackEnter: true, host: 'example.com' },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'keyboard race', timeoutMs: 5_000 });
  await claimStarted;
  const stop = await controller.requestStop();
  assert.equal(stop.reason, 'before_dispatch');
  assert.equal(stop.clicked, false);
  releaseClaim();
  await assert.rejects(sendPromise, /provider_stop_token_not_active/u);
  assert.equal(events.some((event) => event === 'key:Enter'), false);
  assert.equal(harness.actionCount(), 0);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: dispatch response loss preserves the sent state and exact stop remains available', async () => {
  const events = [];
  let actionStartedResolve;
  const actionStarted = new Promise((resolve) => { actionStartedResolve = resolve; });
  let releaseAction;
  const actionGate = new Promise((resolve) => { releaseAction = resolve; });
  const harness = createDispatchRaceHarness({
    events,
    actionGate,
    onActionStarted: actionStartedResolve,
    actionError: new Error('dispatch_response_lost'),
    markDispatchingBeforeActionGate: true,
    sendResult: { ok: true, isChatGPT: true, fallbackEnter: true, host: 'chatgpt.com', sendBaseline: { userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'response loss', activePromptTextDigest: userTurnDigestForTest('response loss'), activePromptTextLength: 13 } },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  const controller = createController(harness.page);
  const sendPromise = controller.send({ text: 'response loss', timeoutMs: 5_000 });
  await actionStarted;
  const stop = await controller.requestStop();
  assert.equal(stop.clicked, true);
  assert.equal(harness.providerStopCount(), 1);
  releaseAction();
  await assert.rejects(sendPromise, (error) => {
    assert.match(error.message, /dispatch_response_lost/u);
    assert.equal(error.data?.messageDispatchState, 'unknown');
    return true;
  });
  assert.equal(harness.actionCount(), 1);
  assert.equal(harness.state().dispatch.state, 'dispatched');
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: activation follows ready after navigation state wipe and stopAfterSend uses the exact active token', async () => {
  const events = [];
  let browserState = { generation: 4, sequence: 4, token: 'old-token', retiredSequence: 0, dispatch: null };
  let activationGeneration = null;
  let activationSequence = null;
  let activationToken = null;
  const page = createPage({
    events,
    onBasicEvaluate: async (js) => {
      if (js.includes('const hasTurnstile')) {
        events.push('ready');
        browserState = { generation: 0, sequence: 0, token: null, retiredSequence: 0, dispatch: null };
      }
      if (js.includes('missing_prompt_textarea')) events.push('prompt-ready');
    },
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStop')) {
        events.push('exact-stop');
        return { ok: true, state: 'dispatched', clicked: true, reason: 'provider_stop_clicked' };
      }
      if (js.includes('agentifyStopTokenStateRead')) {
        events.push('state-read');
        return {
          ok: true,
          generation: browserState.generation,
          sequence: browserState.sequence,
          retiredSequence: browserState.retiredSequence,
          dispatchState: browserState.dispatch?.state || null
        };
      }
      if (js.includes('agentifyStopTokenActivation')) {
        activationGeneration = Number(/const generation = ([0-9]+)/u.exec(js)?.[1] || 0);
        activationSequence = Number(/const sequence = ([0-9]+)/u.exec(js)?.[1] || 0);
        activationToken = JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null');
        browserState = {
          generation: activationGeneration,
          sequence: activationSequence,
          token: activationToken,
          retiredSequence: 0,
          dispatch: { generation: activationGeneration, sequence: activationSequence, state: 'pending' }
        };
        events.push('activation');
        return { ok: true, applied: true, generation: activationGeneration, sequence: activationSequence, token: activationToken };
      }
      if (js.includes('agentifyStopTokenDispatchCheck')) {
        events.push('dispatch-check');
        const expectedGeneration = Number(/const expectedGeneration = ([0-9]+)/u.exec(js)?.[1] || 0);
        const expectedSequence = Number(/const expectedSequence = ([0-9]+)/u.exec(js)?.[1] || 0);
        return {
          ok: true,
          active: browserState.generation === expectedGeneration && browserState.sequence === expectedSequence && browserState.token === activationToken,
          generation: browserState.generation,
          sequence: browserState.sequence,
          retiredSequence: browserState.retiredSequence,
          dispatchState: browserState.dispatch?.state || null
        };
      }
      return { ok: true };
    },
    onEvaluate: async (js) => {
      if (js.includes('const expectedToken')) {
        events.push('exact-stop');
        return { clicked: true, reason: 'provider_stop_clicked' };
      }
      if (js.includes('form.requestSubmit')) {
        events.push('requestSubmit');
        return true;
      }
      if (isClickSendEvaluation(js)) return { ok: true, isChatGPT: true, fallbackEnter: true, host: 'chatgpt.com' };
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: 'after navigation', timeoutMs: 5_000, stopAfterSend: true });

  assert.deepEqual(result, { ok: true });
  assert.ok(activationGeneration >= 1);
  assert.ok(activationSequence >= 1);
  assert.equal(activationToken?.length, 64);
  assert.ok(events.indexOf('ready') < events.indexOf('state-read'));
  assert.ok(events.indexOf('state-read') < events.indexOf('activation'));
  assert.ok(events.indexOf('activation') < events.indexOf('prompt-ready'));
  assert.ok(events.indexOf('dispatch-check') < events.indexOf('requestSubmit'));
  assert.equal(events.includes('exact-stop'), true);
});

test('chatgpt-controller: state wipe after prompt typing blocks every send dispatch and cleans the unsent draft', async () => {
  const events = [];
  const dom = createCleanupDom({ events, promptText: 'typed but unsent' });
  let browserState = { generation: 0, sequence: 0, token: null, retiredSequence: 0, dispatch: null };
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: null,
    recordSendEvaluation: false,
    cleanupDom: dom,
    onInsertText: async () => {
      browserState = { generation: 1, sequence: 1, token: null, retiredSequence: 1, dispatch: { generation: 1, sequence: 1, state: 'cancelled' } };
    },
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStateRead')) return {
        ok: true,
        generation: browserState.generation,
        sequence: browserState.sequence,
        retiredSequence: browserState.retiredSequence,
        dispatchState: browserState.dispatch?.state || null
      };
      if (js.includes('agentifyStopTokenDispatchClaim')) return { ok: true, claimed: false, state: 'mismatch' };
      if (js.includes('agentifyStopTokenDispatchRead')) return { ok: true, state: 'mismatch' };
      if (js.includes('agentifyStopTokenActivation')) {
        const generation = Number(/const generation = ([0-9]+)/u.exec(js)?.[1] || 0);
        const sequence = Number(/const sequence = ([0-9]+)/u.exec(js)?.[1] || 0);
        const token = JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null');
        browserState = { generation, sequence, token, retiredSequence: 0, dispatch: { generation, sequence, state: 'pending' } };
        return { ok: true, applied: true, generation, sequence, token };
      }
      if (js.includes('agentifyStopTokenDispatchCheck')) return {
        ok: true,
        active: false,
        generation: browserState.generation,
        sequence: browserState.sequence,
        retiredSequence: browserState.retiredSequence,
        dispatchState: browserState.dispatch?.state || 'cancelled'
      };
      return { ok: true };
    }
  });

  await assert.rejects(
    createController(page).send({ text: 'typed but unsent', timeoutMs: 5_000 }),
    (error) => error.message === 'provider_stop_token_not_active' && error.data.cleanup.status === 'cleared'
  );
  assert.equal(events.includes('normal-send-click'), false);
  assert.equal(events.includes('key:Enter'), false);
  assert.equal(events.includes('requestSubmit'), false);
  assert.equal(events.includes('cleanup-draft'), true);
  assert.equal(dom.prompt.value, '');
});

test('chatgpt-controller: applied false activation blocks prompt typing without leaking the token', async () => {
  const events = [];
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStateRead')) return { ok: true, generation: 0, sequence: 0, retiredSequence: 0, dispatchState: null };
      if (js.includes('agentifyStopTokenActivation')) {
        const generation = Number(/const generation = ([0-9]+)/u.exec(js)?.[1] || 0);
        const sequence = Number(/const sequence = ([0-9]+)/u.exec(js)?.[1] || 0);
        const token = JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null');
        return { ok: true, applied: false, generation, sequence, token };
      }
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`prompt_or_dispatch_must_not_run:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).send({ text: 'must not type', timeoutMs: 5_000 }),
    (error) => error.message === 'provider_stop_token_not_active' && error.data.phase === 'activation' && error.data.applied === false && !JSON.stringify(error).includes('providerStopToken')
  );
  assert.deepEqual(events.filter((event) => event.startsWith('text:')), []);
});

test('chatgpt-controller: stale browser generation activation blocks the operation before typing', async () => {
  const events = [];
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStateRead')) return { ok: true, generation: 20, sequence: 20, retiredSequence: 20, dispatchState: 'cancelled' };
      if (js.includes('agentifyStopTokenActivation')) {
        const token = JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null');
        const generation = Number(/const generation = ([0-9]+)/u.exec(js)?.[1] || 0);
        const sequence = Number(/const sequence = ([0-9]+)/u.exec(js)?.[1] || 0);
        return { ok: true, applied: false, generation, sequence, token };
      }
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`prompt_or_dispatch_must_not_run:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).query({ prompt: 'stale epoch', timeoutMs: 5_000 }),
    (error) => error.message === 'provider_stop_token_not_active' && error.data.phase === 'activation'
  );
  assert.deepEqual(events.filter((event) => event.startsWith('text:')), []);
});

test('chatgpt-controller: browser stop state read failure blocks the operation before typing', async () => {
  const events = [];
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStateRead')) throw new Error('browser_state_unavailable');
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`prompt_or_dispatch_must_not_run:${js.slice(0, 80)}`);
    }
  });

  await assert.rejects(
    createController(page).send({ text: 'state read failure', timeoutMs: 5_000 }),
    (error) => error.message === 'provider_stop_token_state_unavailable' && error.data.phase === 'read' && error.data.status === 'failed'
  );
  assert.deepEqual(events.filter((event) => event.startsWith('text:')), []);
});

test('chatgpt-controller: recreated controller starts with a newer generation fence', async () => {
  const events = [];
  let browserState = { generation: 20, sequence: 20, token: null, retiredSequence: 20, dispatch: { generation: 20, sequence: 20, state: 'cancelled' } };
  let firstOperationGeneration = null;
  let firstOperationSequence = null;
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenStateRead')) return {
        ok: true,
        generation: browserState.generation,
        sequence: browserState.sequence,
        retiredSequence: browserState.retiredSequence,
        dispatchState: browserState.dispatch?.state || null
      };
      if (js.includes('agentifyStopTokenActivation')) {
        firstOperationGeneration = Number(/const generation = ([0-9]+)/u.exec(js)?.[1] || 0);
        firstOperationSequence = Number(/const sequence = ([0-9]+)/u.exec(js)?.[1] || 0);
        const token = JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || 'null');
        browserState = {
          generation: firstOperationGeneration,
          sequence: firstOperationSequence,
          token,
          retiredSequence: 0,
          dispatch: { generation: firstOperationGeneration, sequence: firstOperationSequence, state: 'pending' }
        };
        return { ok: true, applied: true, generation: firstOperationGeneration, sequence: firstOperationSequence, token };
      }
      if (js.includes('agentifyStopTokenDispatchCheck')) return {
        ok: true,
        active: true,
        generation: browserState.generation,
        sequence: browserState.sequence,
        retiredSequence: browserState.retiredSequence,
        dispatchState: browserState.dispatch?.state || 'pending'
      };
      return { ok: true };
    },
    onEvaluate: async (js) => {
      if (js.includes('form.requestSubmit')) return true;
      if (isClickSendEvaluation(js)) return { ok: true, fallbackEnter: true, host: 'chatgpt.com', isChatGPT: true };
      if (js.includes('promptLen')) return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });

  const result = await createController(page).send({ text: 'after recreation', timeoutMs: 5_000 });

  assert.deepEqual(result, { ok: true });
  assert.ok(Number.isSafeInteger(firstOperationGeneration));
  assert.ok(Number.isSafeInteger(firstOperationSequence));
  assert.ok(firstOperationGeneration > 20);
  assert.equal(firstOperationSequence, 1);
});

test('chatgpt-controller: release is non-blocking and an old release cannot clear a newer token', async () => {
  const events = [];
  const providerStopTokenA = 'a'.repeat(64);
  const providerStopTokenB = 'b'.repeat(64);
  let browserState = {
    generation: 2,
    sequence: 2,
    token: providerStopTokenB,
    retiredSequence: 0,
    dispatch: { generation: 2, sequence: 2, state: 'dispatched' }
  };
  let releaseStartedResolve;
  const releaseStarted = new Promise((resolve) => { releaseStartedResolve = resolve; });
  let releaseProviderState;
  const releaseGate = new Promise((resolve) => { releaseProviderState = resolve; });
  let releaseFinishedResolve;
  const releaseFinished = new Promise((resolve) => { releaseFinishedResolve = resolve; });
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenRelease')) {
        const generation = Number(/const generation = ([0-9]+)/u.exec(js)?.[1] || 0);
        const sequence = Number(/const sequence = ([0-9]+)/u.exec(js)?.[1] || 0);
        const token = JSON.parse(/const token = ("[0-9a-f]+")/u.exec(js)?.[1] || '""');
        releaseStartedResolve();
        await releaseGate;
        if (browserState.generation === generation && browserState.sequence === sequence && browserState.token === token) {
          browserState = {
            ...browserState,
            retiredSequence: Math.max(browserState.retiredSequence, sequence),
            token: null,
            dispatch: { generation, sequence, state: 'cancelled' }
          };
        }
        releaseFinishedResolve();
      }
      return { ok: true };
    },
    onEvaluate: async (js) => {
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  const controller = createController(page);
  const run = {
    operationId: 'release-a',
    providerStopGeneration: 1,
    providerStopSequence: 1,
    providerStopEpoch: 1,
    providerStopToken: providerStopTokenA,
    providerStopRetired: false,
    requested: false,
    messageDispatchStarted: true
  };
  controller.currentRun = run;
  controller.providerStopOwner = run;
  const startedAt = Date.now();
  const retired = controller.retireProviderStop({ expectedOperationId: 'release-a' });
  assert.equal(retired.retired, true);
  assert.ok(Date.now() - startedAt < 100, 'release must not wait for page evaluation');
  assert.equal(controller.providerStopOwner, null);
  await releaseStarted;
  releaseProviderState();
  await releaseFinished;
  assert.equal(browserState.generation, 2);
  assert.equal(browserState.sequence, 2);
  assert.equal(browserState.token, providerStopTokenB);
});

test('chatgpt-controller: send-started failure never auto-clears the composer', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (js.includes('const agentifyAttachmentCleanup')) throw new Error('cleanup_must_not_run');
      if (isClickSendEvaluation(js)) return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      if (js.includes('const chatgptUserTurns')) return { isChatGPT: true, userCount: 0, lastUserId: '', lastUserText: '', activePromptText: 'send-started', activePromptTextLength: 12, hasNormalSend: true, normalStopVisible: false };
      if (js.includes('const clickFallbackBaselineText')) return { attempted: false, lastFallbackResult: 'normal_send_not_found' };
      if (js.includes('const submitFallbackBaselineText')) return { attempted: false, lastFallbackResult: 'active_composer_form_not_found' };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  await assert.rejects(createController(page).send({ text: 'send-started', timeoutMs: 20 }), /send_not_triggered/u);
  assert.equal(events.includes('cleanup-draft'), false);
});

test('chatgpt-controller: bounds a stalled send discovery evaluation before response waiting', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (isClickSendEvaluation(js)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true, isChatGPT: true, fallbackEnter: false, host: 'chatgpt.com', rect: { x: 90, y: 10, w: 20, h: 20 } };
      }
      if (js.includes('const clickFallbackBaselineText')) return { attempted: false, lastFallbackResult: 'normal_send_not_found' };
      if (js.includes('const submitFallbackBaselineText')) return { attempted: false, lastFallbackResult: 'active_composer_form_not_found' };
      if (js.includes('const chatgptUserTurns')) return { isChatGPT: true, userCount: 0, lastUserId: '', lastUserTextDigest: userTurnDigestForTest(''), activePromptText: 'bounded send', activePromptTextDigest: userTurnDigestForTest('bounded send'), activePromptTextLength: 12, hasNormalSend: true, normalStopVisible: false };
      if (js.includes('agentifyAttachmentCleanup')) return { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  const startedAt = Date.now();
  await assert.rejects(
    createController(page, { sendConfirmationTimeoutMs: 20 }).send({ text: 'bounded send', timeoutMs: 5_000 }),
    (error) => {
      assert.equal(error.message, 'send_not_triggered');
      assert.equal(error.data.reason, 'send_confirmation_timeout');
      assert.equal(error.data.phase, 'sending_prompt');
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 500, 'stalled send discovery must be bounded by the send budget');
  assert.equal(events.includes('normal-send-click'), false);
});

test('chatgpt-controller: bounds a stalled coordinate send action before fallback', async () => {
  const events = [];
  const page = createPage({
    events,
    onEvaluate: async (js) => {
      if (isClickSendEvaluation(js)) return normalChatGPTSendResult(sendBaseline({ activePromptText: 'stalled coordinate' }));
      if (js.includes('const chatgptUserTurns')) return chatgptSendSignal({ activePromptText: 'stalled coordinate' });
      if (js.includes('const clickFallbackBaselineText')) return { attempted: false, lastFallbackResult: 'normal_send_not_found' };
      if (js.includes('const submitFallbackBaselineText')) return { attempted: false, lastFallbackResult: 'active_composer_form_not_found' };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  page.moveMouse = async (x) => {
    if (x >= 80) await new Promise(() => {});
  };
  const startedAt = Date.now();
  await assert.rejects(
    createController(page, { sendConfirmationTimeoutMs: 20 }).send({ text: 'stalled coordinate', timeoutMs: 5_000 }),
    (error) => {
      assert.equal(error.message, 'send_not_triggered');
      assert.equal(error.data.reason, 'send_confirmation_timeout');
      assert.equal(error.data.step, 'coordinate_click');
      return true;
    }
  );
  assert.ok(Date.now() - startedAt < 500, 'stalled coordinate action must be bounded by the send budget');
  assert.equal(events.includes('normal-send-click'), false);
});

test('chatgpt-controller: falls back after a coordinate timeout when dispatch never started', async () => {
  const events = [];
  let domClickAttempted = false;
  const prompt = 'coordinate timeout fallback';
  const page = createPage({
    events,
    onStopTokenEvaluate: async (js) => {
      if (js.includes('agentifyStopTokenDispatchRead')) return { ok: true, state: 'pending' };
      return undefined;
    },
    onEvaluate: async (js) => {
      if (isClickSendEvaluation(js)) return normalChatGPTSendResult(sendBaseline({ activePromptText: prompt }));
      if (js.includes('const chatgptUserTurns')) {
        return chatgptSendSignal({
          userCount: domClickAttempted ? 1 : 0,
          lastUserId: domClickAttempted ? 'fallback-user' : '',
          lastUserText: domClickAttempted ? prompt : '',
          activePromptText: domClickAttempted ? '' : prompt
        });
      }
      if (js.includes('const clickFallbackBaselineText')) {
        events.push('dom-send-click');
        domClickAttempted = true;
        return { attempted: true, lastFallbackResult: 'dom_click' };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    }
  });
  page.moveMouse = async (x) => {
    if (x >= 80) await new Promise(() => {});
  };

  const result = await createController(page, { sendConfirmationTimeoutMs: 1_000 }).send({ text: prompt, timeoutMs: 5_000 });

  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('normal-send-click'), false);
  assert.deepEqual(events.filter((event) => event === 'dom-send-click'), ['dom-send-click']);
});

test('chatgpt-controller: cleans a zero-turn attachment draft after unconfirmed send timeout', async () => {
  await withTempAttachments([
    'a/task-contract.json',
    'repository-state.json',
    'changes.patch',
    'b/task-contract.json',
    'worker-last-message.txt',
    'changed-files.json',
    'verification.json'
  ], async (attachments) => {
    const events = [];
    const prompt = 'zero-turn attachment draft';
    const selectedFileNames = [
      'task-contract.json',
      'repository-state.json',
      'changes.patch',
      'task-contract(1).json',
      'worker-last-message.txt',
      'changed-files.json',
      'verification.json'
    ];
    const cardDisplayNames = [
      'task-contract(20260808-115028).json',
      'repository-state(20260808-115029).json',
      'changes(20260808-115028).patch',
      'task-contract(1)(7).json',
      'worker-last-message(20260808-115029).txt',
      'changed-files(20260808-115029).json',
      'verification(20260808-115028).json'
    ];
    const dom = createCleanupDom({
      events,
      promptText: prompt,
      uploadInputCount: 1,
      selectedFileNames,
      cardDisplayNames,
      cardCount: 7,
      userTurnTexts: []
    });
    const { page } = createAttachmentCleanupPage({
      events,
      attachmentState: attachmentCardSnapshot(selectedFileNames.map((sourceFileName, index) => ({
        sourceFileName,
        displayName: cardDisplayNames[index],
        matched: true,
        pending: false,
        failed: false
      })), { conditionsReady: true, mappingComplete: true }),
      cleanupResult: null,
      cleanupDom: dom,
      userTurnBaseline: { count: 0, lastId: '', lastTextDigest: userTurnDigestForTest('') },
      onEvaluateExtra: async (js) => {
        if (isClickSendEvaluation(js)) return normalChatGPTSendResult(sendBaseline({ userCount: 0, lastUserText: '', activePromptText: prompt }));
        if (js.includes('const chatgptUserTurns')) return chatgptSendSignal({ userCount: 0, lastUserText: '', activePromptText: prompt, normalStopVisible: false });
        if (js.includes('const clickFallbackBaselineText')) return { attempted: false, lastFallbackResult: 'normal_send_not_found' };
        if (js.includes('const submitFallbackBaselineText')) return { attempted: false, lastFallbackResult: 'active_composer_form_not_found' };
        return undefined;
      }
    });

    await assert.rejects(
      createController(page, { sendConfirmationTimeoutMs: 20 }).query({ prompt, attachments, timeoutMs: 5_000 }),
      (error) => error.message === 'send_not_triggered' && error.data.cleanup.status === 'cleared'
    );
    assert.equal(dom.prompt.value, '');
    assert.deepEqual(dom.uploadInputs[0].files, []);
    assert.equal(dom.composer.querySelectorAll('[role="group"][aria-label]').length, 0);
    assert.equal(events.filter((event) => event === 'card-remove').length, 7);
    assert.deepEqual(dom.document.querySelectorAll('article[data-turn="user"]'), []);
  });
});

test('chatgpt-controller: send stop after typing clears the unsent draft before dispatch', async () => {
  const events = [];
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
    recordSendEvaluation: false
  });
  const controller = createController(page);
  const sendPromise = controller.send({ text: 'stop before send', timeoutMs: 5_000 });
  const deadline = Date.now() + 1_000;
  while (!events.includes('text:stop before send') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events.includes('text:stop before send'), true);
  await controller.requestStop();
  await assert.rejects(sendPromise, (error) => error.message === 'query_aborted' && error.data?.cleanup?.status === 'cleared');
  assert.equal(events.includes('normal-send-click'), false);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: pre-aborted send does not type and abort listener is scoped to its run', async () => {
  const events = [];
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
    recordSendEvaluation: false
  });
  const signalController = new AbortController();
  signalController.abort();
  const controller = createController(page);
  await assert.rejects(
    controller.send({ text: 'must not type', signal: signalController.signal }),
    (error) => error.message === 'query_aborted'
  );
  await assert.rejects(
    controller.query({ prompt: 'must not query', signal: signalController.signal }),
    (error) => error.message === 'query_aborted'
  );
  assert.equal(events.some((event) => event.startsWith('text:')), false);
});

test('chatgpt-controller: signal abort during mouse movement clears the unsent send draft before mouseDown', async () => {
  const events = [];
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
    recordSendEvaluation: false
  });
  let releaseMovement = null;
  page.moveMouse = async () => {
    if (events.includes('text:signal movement')) await new Promise((resolve) => { releaseMovement = resolve; });
  };
  const signalController = new AbortController();
  const sendPromise = createController(page).send({ text: 'signal movement', signal: signalController.signal, timeoutMs: 5_000 });
  const deadline = Date.now() + 1_000;
  while (!releaseMovement && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(typeof releaseMovement, 'function');
  signalController.abort();
  releaseMovement();
  await assert.rejects(sendPromise, (error) => error.message === 'query_aborted' && error.data?.cleanup?.status === 'cleared');
  assert.equal(events.includes('normal-send-click'), false);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: send timeout after typing clears the unsent draft', async () => {
  const events = [];
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    sendResult: { ok: false, error: 'timeout_waiting_for_prompt', kind: 'blocked' },
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 }
  });
  await assert.rejects(
    createController(page).send({ text: 'timeout before send', timeoutMs: 20 }),
    (error) => error.message === 'timeout_waiting_for_prompt' && error.data?.cleanup?.status === 'cleared'
  );
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: stop during mouse movement clears a query draft without mouseDown', async () => {
  const events = [];
  const { page } = createAttachmentCleanupPage({
    events,
    attachmentState: attachmentCardSnapshot([]),
    cleanupResult: { ok: true, selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: 0 },
    recordSendEvaluation: false
  });
  let releaseMovement = null;
  page.moveMouse = async () => {
    if (events.includes('text:movement stop')) await new Promise((resolve) => { releaseMovement = resolve; });
  };
  const controller = createController(page);
  const queryPromise = controller.query({ prompt: 'movement stop', timeoutMs: 5_000 });
  const deadline = Date.now() + 1_000;
  while (!releaseMovement && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(typeof releaseMovement, 'function');
  await controller.requestStop();
  releaseMovement();
  await assert.rejects(queryPromise, (error) => error.message === 'query_aborted' && error.data?.cleanup?.status === 'cleared');
  assert.equal(events.includes('normal-send-click'), false);
  assert.deepEqual(events.filter((event) => event === 'cleanup-draft'), ['cleanup-draft']);
});

test('chatgpt-controller: cleanup settle timeout preserves the original error and bounded diagnostic', async () => {
  await withTempAttachments(['settle-timeout.txt'], async ([attachment]) => {
    const { page, cleanupScript } = createAttachmentCleanupPage({
      events: [],
      attachmentState: attachmentCardSnapshot([{ fileName: 'settle-timeout.txt', found: true, pending: true, failed: false }], { conditionsReady: false }),
      cleanupResult: { ok: false, reason: 'cleanup_settle_timeout', cleanupTimeoutMs: 1_500, selectedFileNames: ['settle-timeout.txt'], cardCount: 1, promptTextLength: 14, userTurnCount: 0 }
    });
    await assert.rejects(
      createController(page).query({ prompt: 'preserve settle failure', attachments: [attachment], timeoutMs: 20 }),
      (error) => error.message === 'attachment_upload_timeout' && error.data?.cleanup?.status === 'failed' && error.data.cleanup.reason === 'cleanup_settle_timeout'
    );
    assert.match(cleanupScript(), /cleanup_settle_timeout/u);
    assert.match(cleanupScript(), /setTimeout/u);
    assert.match(cleanupScript(), /cleanupTimeoutMs: 1500/u);
  });
});

test('chatgpt-controller: blocks a completed renamed active draft instead of reusing it', async () => {
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

    await assert.rejects(
      createController(page).query({ prompt: 'do not reuse renamed attachment', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict'
    );

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(events.includes('native-clear'), false);
    assert.equal(attachmentPolls(), 0);
  });
});

test('chatgpt-controller: blocks duplicate active draft entries instead of reusing them', async () => {
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

    await assert.rejects(
      createController(page).query({ prompt: 'do not reuse duplicate attachments', attachments: [attachment, attachment], timeoutMs: 5_000 }),
      (error) => error.message === 'chatgpt_file_input_state_conflict'
    );

    assert.deepEqual(events.filter((event) => event.startsWith('files-')), []);
    assert.equal(attachmentPolls(), 0);
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

test('chatgpt-controller: blocks before clearing when a stale FileList is present', async () => {
  await withTempAttachments(['expected.txt'], async ([attachment]) => {
    const events = [];
    const { page } = createUploadInputStatePage({
      events,
      initialState: chatgptUploadInputState({
        selectedFileNames: ['expected.txt'],
        selectionMatchesExpected: true
      }),
    });

    await assert.rejects(
      createController(page).query({ prompt: 'do not clear another file', attachments: [attachment], timeoutMs: 5_000 }),
      (error) => {
        assert.equal(error.message, 'chatgpt_file_input_state_conflict');
        assert.equal(error.data?.phase, 'attachment_preflight');
        assert.equal(error.data?.reason, 'current_draft_attachment_conflict');
        assert.deepEqual(error.data?.selectedFileNames, ['expected.txt']);
        assert.deepEqual(error.data?.cardDisplayNames, []);
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

test('chatgpt-controller: start-marker diagnostic reports one-origin messages without changing start proof', async () => {
  const harness = createStartMarkerDiagnosticPage({ snapshot: startMarkerSnapshot() });
  const result = await createController(harness.page).diagnoseConversationStartMarkers();
  assert.equal(result.preconditionPassed, true);
  assert.equal(result.physicalTopReached, true);
  assert.equal(result.physicalTopStable, true);
  assert.equal(result.turnZeroElementExists, false);
  assert.equal(result.firstMessagePosition, 1);
  assert.equal(result.firstMessageRole, 'user');
  assert.deepEqual(result.messagePositionOrder, [{ role: 'user', position: 1 }]);
  assert.equal(result.conversationRestore.verified, true);
  assert.equal(result.windowLifecycle.restoreVerified, true);
  assert.equal(harness.getWheelCount(), 0);
  assert.equal(result.reason, null);
  assert.equal(harness.events.some((event) => event.startsWith('scroll-gesture:')), false);
  assert.equal(harness.events.some((event) => event.startsWith('key:')), false);
  assert.equal(harness.events.some((event) => event.startsWith('files-set:')), false);
});

test('chatgpt-controller: start-marker diagnostic settles a transient normalized conversation layout before wheeling', async () => {
  const transient = startMarkerSnapshot({ atTop: true, scrollTop: 0, windowSignature: 'transient1', structuralSignature: 'transient2' });
  const stable = startMarkerSnapshot({ atTop: false, scrollTop: 6_449, scrollHeight: 7_212, clientHeight: 763, windowSignature: 'stable111', structuralSignature: 'stable222' });
  const top = startMarkerSnapshot({ atTop: true, scrollTop: 0, markerPositions: [1, 2], windowSignature: 'top33333', structuralSignature: 'top44444' });
  const harness = createStartMarkerDiagnosticPage({
    snapshot: stable,
    layoutSnapshots: [transient, stable, stable, stable],
    wheelSnapshots: [top]
  });
  const result = await createController(harness.page).diagnoseConversationStartMarkers();
  assert.equal(result.layoutSettle.verified, true);
  assert.equal(result.layoutSettle.sampleCount, 3);
  assert.equal(result.normalized.scrollTop, 6_449);
  assert.equal(result.normalized.atTop, false);
  assert.equal(result.wheelAttempts, 1);
  assert.equal(harness.getWheelCount(), 1);
  assert.equal(result.physicalTopStable, true);
  assert.equal(result.reason, null);
});

test('chatgpt-controller: start-marker diagnostic fails closed when conversation layout never settles', async () => {
  const changingLayout = Array.from({ length: 20 }, (_, index) => startMarkerSnapshot({
    atTop: index === 0,
    scrollTop: index * 100,
    windowSignature: `changing-${index}`,
    structuralSignature: `structure-${index}`
  }));
  const harness = createStartMarkerDiagnosticPage({ snapshot: changingLayout[0], layoutSnapshots: changingLayout });
  const result = await createController(harness.page).diagnoseConversationStartMarkers();
  assert.equal(result.layoutSettle.attempted, true);
  assert.equal(result.layoutSettle.verified, false);
  assert.equal(result.reason, 'probe-layout-not-stable');
  assert.equal(result.wheelAttempts, 0);
  assert.equal(harness.getWheelCount(), 0);
  assert.equal(result.conversationRestore.verified, false);
  assert.equal(result.windowLifecycle.restoreVerified, true);
});

test('chatgpt-controller: start-marker diagnostic distinguishes message turn zero from hidden non-message turn zero', async () => {
  const actualZero = createStartMarkerDiagnosticPage({
    snapshot: startMarkerSnapshot({ range: { min: 0, max: 1 }, markerPositions: [0, 1], firstMessagePosition: 0, firstMessageRole: 'user', turnZero: { elementCount: 1, insideScrollerCount: 1, visibleElementCount: 1, containsUserMessage: true, containsAssistantMessage: false, rawMarkers: [{ tagName: 'DIV', id: 'conversation-turn-0' }] } })
  });
  const actualZeroResult = await createController(actualZero.page).diagnoseConversationStartMarkers();
  assert.equal(actualZeroResult.turnZeroElementExists, true);
  assert.equal(actualZeroResult.turnZeroContainsConversationMessage, true);
  assert.equal(actualZeroResult.firstMessagePosition, 0);

  const hiddenZero = createStartMarkerDiagnosticPage({
    snapshot: startMarkerSnapshot({ turnZero: { elementCount: 1, insideScrollerCount: 1, visibleElementCount: 0, containsUserMessage: false, containsAssistantMessage: false, rawMarkers: [{ tagName: 'DIV', id: 'conversation-turn-0' }] } })
  });
  const hiddenZeroResult = await createController(hiddenZero.page).diagnoseConversationStartMarkers();
  assert.equal(hiddenZeroResult.turnZeroElementExists, true);
  assert.equal(hiddenZeroResult.turnZeroContainsConversationMessage, false);
  assert.equal(hiddenZeroResult.firstMessagePosition, 1);
});

test('chatgpt-controller: start-marker diagnostic treats reverse raw zero as tail and negative scroll as top', async () => {
  const tail = startMarkerSnapshot({ atTop: false, atBottom: true, scrollTop: 0, verticalScrollMode: 'reverse', windowSignature: 'reverse-tail', structuralSignature: 'reverse-tail-structure' });
  const top = startMarkerSnapshot({ atTop: true, atBottom: false, scrollTop: -600, verticalScrollMode: 'reverse', markerPositions: [1, 2], windowSignature: 'reverse-top', structuralSignature: 'reverse-top-structure' });
  const harness = createStartMarkerDiagnosticPage({ snapshot: tail, initialAtTop: false, wheelSnapshots: [top] });
  const result = await createController(harness.page).diagnoseConversationStartMarkers();
  assert.equal(result.layoutSettle.verified, true);
  assert.equal(result.wheelAttempts, 1);
  assert.equal(harness.getWheelCount(), 1);
  assert.equal(result.physicalTopReached, true);
  assert.equal(result.physicalTopStable, true);
  assert.equal(result.conversationRestore.verified, true);
  assert.equal(result.reason, null);
});

test('chatgpt-controller: start-marker diagnostic uses bounded older traversal and stops on the physical top', async () => {
  const base = startMarkerSnapshot({ atTop: false, scrollTop: 500 });
  const first = startMarkerSnapshot({ atTop: false, scrollTop: 500, windowSignature: 'ccc33333', structuralSignature: 'ddd44444' });
  const top = startMarkerSnapshot({ atTop: true, scrollTop: 0, markerPositions: [1, 2], windowSignature: 'eee55555', structuralSignature: 'fff66666' });
  const harness = createStartMarkerDiagnosticPage({ snapshot: base, initialAtTop: false, wheelSnapshots: [first, top] });
  const result = await createController(harness.page).diagnoseConversationStartMarkers();
  assert.equal(result.wheelAttempts, 2);
  assert.equal(result.physicalTopReached, true);
  assert.equal(result.physicalTopStable, true);
  assert.equal(harness.getWheelCount(), 2);
  assert.equal(result.reason, null);
  assert.equal(result.windowLifecycle.restoreVerified, true);
  assert.equal(result.events?.includes('window-state:minimized') ?? harness.events.includes('window-state:minimized'), true);
  assert.equal(harness.events.some((event) => event.startsWith('scroll-gesture:')), false);
});

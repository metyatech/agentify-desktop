import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  canRecoverDraftLease,
  createDraftLease,
  describeAttachmentFiles,
  DraftOwnershipStore,
  canSettlePostSendDraft,
  textDigest
} from './chatgpt-draft-ownership.mjs';

export const MAX_CONVERSATION_TURNS = 200;
export const MAX_CONVERSATION_TURN_CHARS = 200_000;
export const MAX_CONVERSATION_TOTAL_CHARS = 2_000_000;
export const MAX_CONVERSATION_HISTORY_TIMEOUT_MS = 30_000;
export const MAX_CONVERSATION_HISTORY_ITERATIONS = 120;
export const DEFAULT_CONVERSATION_HISTORY_TIMEOUT_MS = MAX_CONVERSATION_HISTORY_TIMEOUT_MS;
export const DEFAULT_CONVERSATION_HISTORY_ITERATIONS = MAX_CONVERSATION_HISTORY_ITERATIONS;
const CONVERSATION_HISTORY_SCROLL_WAIT_MS = 180;
const CONVERSATION_HISTORY_SCROLL_POLL_MS = 50;
const CONVERSATION_HISTORY_SCROLL_SETTLE_MAX_MS = 220;
const CONVERSATION_HISTORY_TOP_SETTLE_WAIT_MS = 540;
const CONVERSATION_HISTORY_TOP_STABLE_SAMPLES = 4;
const CONVERSATION_HISTORY_RESTORE_ATTEMPTS = 4;
const CONVERSATION_HISTORY_RESTORE_SETTLE_WAIT_MS = 240;
const CONVERSATION_HISTORY_TAIL_RECHECK_WAIT_MS = 200;
const CONVERSATION_HISTORY_TAIL_RECHECK_SAMPLES = 3;
const CONVERSATION_TAIL_TIMEOUT_MS = 5_000;
const CONVERSATION_TAIL_MAX_ITERATIONS = 16;
const MAX_ATTACHMENT_DIAGNOSTIC_ITEMS = 50;
const MAX_ATTACHMENT_DIAGNOSTIC_NAME_LENGTH = 256;
const MAX_ATTACHMENT_DIAGNOSTIC_ERROR_LENGTH = 160;
const UNSENT_DRAFT_CLEANUP_TIMEOUT_MS = 1_500;
const UNSENT_DRAFT_CLEANUP_POLL_MS = 50;
const PROVIDER_STOP_TOKEN_ACTIVATION_TIMEOUT_MS = 1_000;
const PROVIDER_STOP_TOKEN_RELEASE_TIMEOUT_MS = 500;
const PROVIDER_STOP_RETRY_TIMEOUT_MS = 800;
const PROVIDER_STOP_RETRY_POLL_MS = 75;
const PROVIDER_STOP_RELEASE_RETRY_MAX = 3;
const PROVIDER_STOP_RELEASE_RETRY_POLL_MS = 50;
const MAX_SEND_CONFIRMATION_TIMEOUT_MS = 15_000;
const MAX_NATIVE_INPUT_ERROR_NAME_LENGTH = 64;
const MAX_NATIVE_INPUT_ERROR_CODE_LENGTH = 64;
const SCROLL_VISIBILITY_PROBE_NORMALIZE_TIMEOUT_MS = 1_500;
const SCROLL_VISIBILITY_PROBE_POLL_MS = 100;
const SCROLL_VISIBILITY_PROBE_RESTORE_WAIT_MS = 100;
const SCROLL_VISIBILITY_PROBE_MAX_RESTORE_ATTEMPTS = 2;
const SCROLL_VISIBILITY_PROBE_MAX_GESTURES = 4;
const SCROLL_VISIBILITY_MOUSE_WHEEL_DELTA_X = 0;
const SCROLL_VISIBILITY_MOUSE_WHEEL_DELTA_Y = -720;
const MOUSE_WHEEL_VISIBILITY_PROBE_MAX_ATTEMPTS = 8;
const MAX_NATIVE_INPUT_ERROR_MESSAGE_LENGTH = 256;
const CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS = 2_000;
const CONVERSATION_LAYOUT_SETTLE_POLL_MS = 200;
const CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES = 3;
const START_MARKER_PROBE_MAX_WHEELS = 24;
const START_MARKER_PROBE_TOP_SAMPLES = 3;
const START_MARKER_PROBE_TOP_SAMPLE_WAIT_MS = 240;

let latestProviderStopGeneration = 0;

function nextProviderStopGeneration() {
  const now = Date.now();
  if (latestProviderStopGeneration >= Number.MAX_SAFE_INTEGER) return null;
  latestProviderStopGeneration = Math.max(latestProviderStopGeneration + 1, now);
  return latestProviderStopGeneration;
}

function normalizeConversationText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .trim();
}

function sanitizeNativeInputDiagnostic(value, maxLength) {
  let text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return null;
  text = text
    .replace(/\bfile:\/\/[^\s'"<>]+/giu, '<redacted-file-url>')
    .replace(/\bhttps?:\/\/[^\s'"<>]+/giu, '<redacted-url>')
    .replace(/\b[A-Za-z]:[\\/][^\s'"<>]+/gu, '<redacted-path>')
    .replace(/\\\\[^\s'"<>]+/gu, '<redacted-path>')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/gu, '<redacted-token>');
  return text.slice(0, maxLength);
}

function normalizeTrustedBackendDiagnostic(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text ? text.slice(0, MAX_NATIVE_INPUT_ERROR_MESSAGE_LENGTH) : null;
}

function sanitizeNativeInputCode(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000 ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^-?\d{1,10}$/u.test(text)) return Number(text);
  if (/^(?=.{1,64}$)[A-Za-z][A-Za-z0-9]*(?:[_.:-][A-Za-z0-9]+)+$/u.test(text)) return text;
  return sanitizeNativeInputDiagnostic(text, MAX_NATIVE_INPUT_ERROR_CODE_LENGTH);
}

function nativeInputErrorDetails(error) {
  const cause = error?.data?.cause && typeof error.data.cause === 'object' ? error.data.cause : error;
  const trustedBackendMessage = normalizeTrustedBackendDiagnostic(error?.data?.backendMessage);
  const fallbackMessage = sanitizeNativeInputDiagnostic(
    cause?.errorMessage || cause?.message || error?.message || error,
    MAX_NATIVE_INPUT_ERROR_MESSAGE_LENGTH
  );
  const backendErrorMessage = trustedBackendMessage || fallbackMessage;
  return {
    errorName: sanitizeNativeInputDiagnostic(cause?.errorName || cause?.name || cause?.constructor?.name || 'Error', MAX_NATIVE_INPUT_ERROR_NAME_LENGTH),
    errorCode: sanitizeNativeInputCode(cause?.errorCode || cause?.code || error?.data?.code || error?.code),
    errorMessage: trustedBackendMessage || fallbackMessage,
    wrapperErrorName: sanitizeNativeInputDiagnostic(error?.name || error?.constructor?.name || 'Error', MAX_NATIVE_INPUT_ERROR_NAME_LENGTH),
    wrapperErrorCode: sanitizeNativeInputCode(error?.data?.wrapperCode || error?.code),
    backendErrorCode: sanitizeNativeInputCode(error?.data?.backendCode),
    backendErrorMessage
  };
}

function normalizeUserTurnText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function userTurnTextDigest(value) {
  return crypto
    .createHash('sha256')
    .update(normalizeUserTurnText(value), 'utf8')
    .digest('hex');
}

function fallbackConversationTurnId({ role, index, text }) {
  const digest = crypto
    .createHash('sha256')
    .update(`${role}\u0000${index}\u0000${text}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `turn-${digest}`;
}

function historyMetadata({ mode, complete = false, reason = null, startReached = false, snapshotStable = false, iterations = 0, observedTurnCount = 0, returnedTurnCount = 0, scrollRestored = true, diagnostics = null }) {
  const metadata = {
    mode,
    complete: complete === true,
    reason: reason || null,
    startReached: startReached === true,
    snapshotStable: snapshotStable === true,
    iterations: Number.isInteger(iterations) && iterations >= 0 ? iterations : 0,
    observedTurnCount: Number.isInteger(observedTurnCount) && observedTurnCount >= 0 ? observedTurnCount : 0,
    returnedTurnCount: Number.isInteger(returnedTurnCount) && returnedTurnCount >= 0 ? returnedTurnCount : 0,
    scrollRestored: scrollRestored !== false
  };
  if (diagnostics && typeof diagnostics === 'object') metadata.diagnostics = diagnostics;
  return metadata;
}

function mergeConversationSnapshotsLegacy(snapshots = []) {
  const records = new Map();
  const positions = new Map();
  const edges = new Map();
  const indegree = new Map();
  const orderPairs = new Set();
  const reasonCounts = { durableIdentityConflict: 0, fallbackIdentityConflict: 0, duplicateIdentityInSnapshot: 0, orderConflict: 0, cycle: 0, disconnectedWindow: 0, invalidObservation: 0 };
  let ambiguous = false;
  let continuous = true;
  let previousKeys = null;

  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    if (!edges.get(from).has(to)) {
      edges.get(from).add(to);
      indegree.set(to, (indegree.get(to) || 0) + 1);
    }
  };

  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const observations = Array.isArray(snapshot) ? snapshot : snapshot?.turns;
    if (!Array.isArray(observations) || observations.length === 0) {
      continuous = false;
      reasonCounts.disconnectedWindow += 1;
      continue;
    }
    const keys = [];
    for (const [localIndex, observation] of observations.entries()) {
      if (observation?.role !== "user" && observation?.role !== "assistant") {
        ambiguous = true;
        reasonCounts.invalidObservation += 1;
        continue;
      }
      const text = normalizeConversationText(observation.text);
      if (!text) {
        ambiguous = true;
        reasonCounts.invalidObservation += 1;
        continue;
      }
      const messageId = String(observation.messageId || "").trim();
      const turnId = String(observation.turnId || "").trim();
      const positionHint = Number.isInteger(observation.positionHint) ? observation.positionHint : null;
      const key = messageId
        ? `message:${messageId}`
        : turnId
          ? `turn:${turnId}`
          : `fingerprint:${String(observation.fingerprint || `${observation.role}\u0000${text}`).slice(0, 256)}`;
      if (keys.includes(key)) {
        ambiguous = true;
        reasonCounts.duplicateIdentityInSnapshot += 1;
      }
      keys.push(key);
      const existing = records.get(key);
      const value = { ...observation, text, messageId: messageId || null, turnId: turnId || null, positionHint };
      if (positionHint !== null) {
        const positionKey = `position:${positionHint}`;
        const positionRecord = positions.get(positionKey);
        const positionConflicts = positionRecord && (
          positionRecord.role !== value.role ||
          positionRecord.text !== value.text ||
          (positionRecord.messageId && value.messageId && positionRecord.messageId !== value.messageId) ||
          (positionRecord.turnId && value.turnId && positionRecord.turnId !== value.turnId)
        );
        if (positionConflicts) ambiguous = true;
        else if (!positionRecord) positions.set(positionKey, { role: value.role, text: value.text, messageId: value.messageId, turnId: value.turnId });
        else {
          if (!positionRecord.messageId) positionRecord.messageId = value.messageId;
          if (!positionRecord.turnId) positionRecord.turnId = value.turnId;
        }
      }
      if (existing && (existing.role !== value.role || existing.text !== value.text || (existing.positionHint !== null && value.positionHint !== null && existing.positionHint !== value.positionHint))) {
        ambiguous = true;
      } else if (!existing) {
        records.set(key, { ...value, firstSeen: records.size });
        indegree.set(key, indegree.get(key) || 0);
      }
    }
    if (previousKeys && !keys.some((key) => previousKeys.includes(key))) continuous = false;
    for (let index = 1; index < keys.length; index += 1) addEdge(keys[index - 1], keys[index]);
    previousKeys = keys;
  }

  const queue = [...records.keys()].filter((key) => (indegree.get(key) || 0) === 0);
  queue.sort((left, right) => records.get(left).firstSeen - records.get(right).firstSeen);
  const orderedKeys = [];
  while (queue.length) {
    const key = queue.shift();
    orderedKeys.push(key);
    for (const next of edges.get(key) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
    queue.sort((left, right) => records.get(left).firstSeen - records.get(right).firstSeen);
  }
  if (orderedKeys.length !== records.size) ambiguous = true;

  const turns = orderedKeys.map((key, index) => {
    const record = records.get(key);
    const turnIndex = Number.isInteger(record.positionHint) ? record.positionHint : index;
    return {
      id: record.messageId || record.turnId || fallbackConversationTurnId({ role: record.role, index: turnIndex, text: record.text }),
      role: record.role,
      text: record.text,
      index: turnIndex,
      messageId: record.messageId || null,
      turnId: record.turnId || null,
    };
  });
  return { turns, ambiguous, continuous, observedTurnCount: records.size };
}

export function mergeConversationSnapshots(snapshots = []) {
  const records = new Map();
  const edges = new Map();
  const indegree = new Map();
  const orderPairs = new Set();
  const reasonCounts = { durableIdentityConflict: 0, fallbackIdentityConflict: 0, duplicateIdentityInSnapshot: 0, orderConflict: 0, cycle: 0, disconnectedWindow: 0, invalidObservation: 0 };
  let ambiguous = false;
  let continuous = true;
  let previousKeys = null;
  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    if (!edges.get(from).has(to)) {
      edges.get(from).add(to);
      indegree.set(to, (indegree.get(to) || 0) + 1);
    }
  };
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const observations = Array.isArray(snapshot) ? snapshot : snapshot?.turns;
    if (!Array.isArray(observations) || observations.length === 0) {
      continuous = false;
      reasonCounts.disconnectedWindow += 1;
      continue;
    }
    const keys = [];
    for (const observation of observations) {
      if (observation?.role !== 'user' && observation?.role !== 'assistant') {
        ambiguous = true;
        reasonCounts.invalidObservation += 1;
        continue;
      }
      const text = normalizeConversationText(observation.text);
      if (!text) {
        ambiguous = true;
        reasonCounts.invalidObservation += 1;
        continue;
      }
      const messageId = String(observation.messageId || '').trim();
      const turnId = String(observation.turnId || '').trim();
      const positionHint = Number.isInteger(observation.positionHint) ? observation.positionHint : null;
      const key = messageId
        ? `message:${messageId}`
        : turnId
          ? `turn:${turnId}`
          : `fingerprint:${String(observation.fingerprint || `${observation.role}\u0000${text}`).slice(0, 256)}`;
      if (keys.includes(key)) {
        ambiguous = true;
        reasonCounts.duplicateIdentityInSnapshot += 1;
      }
      keys.push(key);
      const value = { ...observation, text, messageId: messageId || null, turnId: turnId || null, positionHint };
      const existing = records.get(key);
      if (existing && (existing.role !== value.role || existing.text !== value.text)) {
        ambiguous = true;
        if (key.startsWith('fingerprint:')) reasonCounts.fallbackIdentityConflict += 1;
        else reasonCounts.durableIdentityConflict += 1;
      } else if (!existing) {
        records.set(key, { ...value, firstSeen: records.size });
        indegree.set(key, indegree.get(key) || 0);
      }
    }
    if (previousKeys && !keys.some((key) => previousKeys.includes(key))) {
      continuous = false;
      reasonCounts.disconnectedWindow += 1;
    }
    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        const pair = `${keys[left]}\u0000${keys[right]}`;
        const reverse = `${keys[right]}\u0000${keys[left]}`;
        if (orderPairs.has(reverse) && !orderPairs.has(pair)) {
          ambiguous = true;
          reasonCounts.orderConflict += 1;
        }
        orderPairs.add(pair);
      }
    }
    for (let index = 1; index < keys.length; index += 1) addEdge(keys[index - 1], keys[index]);
    previousKeys = keys;
  }
  const queue = [...records.keys()].filter((key) => (indegree.get(key) || 0) === 0);
  queue.sort((left, right) => records.get(left).firstSeen - records.get(right).firstSeen);
  const orderedKeys = [];
  while (queue.length) {
    const key = queue.shift();
    orderedKeys.push(key);
    for (const next of edges.get(key) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
    queue.sort((left, right) => records.get(left).firstSeen - records.get(right).firstSeen);
  }
  if (orderedKeys.length !== records.size) {
    ambiguous = true;
    reasonCounts.cycle += 1;
  }
  const turns = orderedKeys.map((key, index) => {
    const record = records.get(key);
    const turnIndex = Number.isInteger(record.positionHint) ? record.positionHint : index;
    return {
      id: record.messageId || record.turnId || fallbackConversationTurnId({ role: record.role, index: turnIndex, text: record.text }),
      role: record.role,
      text: record.text,
      index: turnIndex,
      messageId: record.messageId || null,
      turnId: record.turnId || null
    };
  });
  return { turns, ambiguous, continuous, observedTurnCount: records.size, mergeDiagnostics: { ambiguous, continuous, reasonCounts } };
}

function validateConversationHistoryOptions({ historyMode, historyTimeoutMs, historyMaxIterations }) {
  if (historyMode !== "visible" && historyMode !== "tail" && historyMode !== "complete") throw new Error("conversation_history_mode_invalid");
  if (!Number.isInteger(historyTimeoutMs) || historyTimeoutMs < 1 || historyTimeoutMs > MAX_CONVERSATION_HISTORY_TIMEOUT_MS) throw new Error("conversation_history_timeout_invalid");
  if (!Number.isInteger(historyMaxIterations) || historyMaxIterations < 1 || historyMaxIterations > MAX_CONVERSATION_HISTORY_ITERATIONS) throw new Error("conversation_history_iterations_invalid");
}

function conversationTurnRange(turns = []) {
  const values = (Array.isArray(turns) ? turns : [])
    .map((turn) => turn?.positionHint)
    .filter((value) => Number.isInteger(value));
  return { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
}

function conversationWindowSignature(turns = []) {
  return JSON.stringify((Array.isArray(turns) ? turns : []).map((turn) => [
    turn?.role || null,
    turn?.messageId || turn?.turnId || '',
    Number.isInteger(turn?.positionHint) ? turn.positionHint : null,
    turn?.textDigest || textDigest(normalizeConversationText(turn?.text))
  ]));
}

function conversationWindowIdentitySignature(turns = []) {
  return JSON.stringify((Array.isArray(turns) ? turns : []).map((turn) => [
    turn?.role || null,
    turn?.messageId || turn?.turnId || '',
    Number.isInteger(turn?.positionHint) ? turn.positionHint : null
  ]));
}

export function conversationStartBoundaryProof(state, { physicalTopStable = false } = {}) {
  const boundary = state?.startBoundary || {};
  const rangeMin = Number.isInteger(state?.range?.min) ? state.range.min : null;
  const firstMessagePosition = Number.isInteger(boundary.firstMessagePosition)
    ? boundary.firstMessagePosition
    : Number.isInteger(state?.firstMessagePosition) ? state.firstMessagePosition : null;
  const firstMessageRole = boundary.firstMessageRole === 'user' || boundary.firstMessageRole === 'assistant'
    ? boundary.firstMessageRole
    : state?.firstMessageRole === 'user' || state?.firstMessageRole === 'assistant' ? state.firstMessageRole : null;
  const positionZeroMessageNodeCount = Number.isInteger(boundary.positionZeroMessageNodeCount)
    ? boundary.positionZeroMessageNodeCount
    : null;
  const positionZeroMarkerInsideScrollerCount = Number.isInteger(boundary.positionZeroMarkerInsideScrollerCount)
    ? boundary.positionZeroMarkerInsideScrollerCount
    : null;
  const positionOneMessageNodeCount = Number.isInteger(boundary.positionOneMessageNodeCount)
    ? boundary.positionOneMessageNodeCount
    : null;
  const evidence = {
    rangeMin,
    firstMessagePosition,
    firstMessageRole,
    positionZeroMessageNodeCount,
    positionZeroMarkerInsideScrollerCount,
    positionOneMessageNodeCount
  };
  if (!physicalTopStable) return { proven: false, mode: null, ...evidence };
  if (rangeMin === 0) return { proven: true, mode: 'zero-origin', ...evidence };
  const oneOrigin = rangeMin === 1
    && firstMessagePosition === 1
    && firstMessageRole === 'user'
    && positionZeroMessageNodeCount === 0
    && positionZeroMarkerInsideScrollerCount === 0;
  return { proven: oneOrigin, mode: oneOrigin ? 'one-origin' : null, ...evidence };
}

function probeWindowSummary(state) {
  const scroller = state?.scroller;
  const range = conversationTurnRange(state?.turns);
  const signature = conversationWindowSignature(state?.turns);
  return {
    range,
    scrollTop: Number.isFinite(Number(scroller?.scrollTop)) ? Number(scroller.scrollTop) : null,
    clientHeight: Number.isFinite(Number(scroller?.clientHeight)) ? Number(scroller.clientHeight) : null,
    scrollHeight: Number.isFinite(Number(scroller?.scrollHeight)) ? Number(scroller.scrollHeight) : null,
    atTop: typeof scroller?.atTop === 'boolean' ? scroller.atTop : null,
    atBottom: typeof scroller?.atBottom === 'boolean' ? scroller.atBottom : null,
    windowSignature: signature ? textDigest(signature).slice(0, 32) : null
  };
}

function conversationLayoutSummary(state) {
  const scroller = state?.scroller;
  const sourceSignature = state?.windowSignature || state?.signature || conversationWindowSignature(state?.turns);
  return {
    range: {
      min: Number.isInteger(state?.range?.min) ? state.range.min : null,
      max: Number.isInteger(state?.range?.max) ? state.range.max : null
    },
    scrollTop: Number.isFinite(Number(scroller?.scrollTop)) ? Number(scroller.scrollTop) : null,
    scrollHeight: Number.isFinite(Number(scroller?.scrollHeight)) ? Number(scroller.scrollHeight) : null,
    clientHeight: Number.isFinite(Number(scroller?.clientHeight)) ? Number(scroller.clientHeight) : null,
    atTop: typeof scroller?.atTop === 'boolean' ? scroller.atTop : null,
    atBottom: typeof scroller?.atBottom === 'boolean' ? scroller.atBottom : null,
    windowSignature: sourceSignature == null ? null : textDigest(String(sourceSignature)).slice(0, 32),
    loading: state?.loading === true,
    candidateCount: Number.isInteger(scroller?.candidateCount) ? scroller.candidateCount : 0
  };
}

function conversationLayoutSummaryEqual(left, right) {
  if (!conversationLayoutSummaryReady(left) || !conversationLayoutSummaryReady(right)) return false;
  const close = (a, b, tolerance = 1) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  return close(left.scrollTop, right.scrollTop)
    && close(left.scrollHeight, right.scrollHeight)
    && close(left.clientHeight, right.clientHeight)
    && left.atTop === right.atTop
    && left.atBottom === right.atBottom
    && left.range.min === right.range.min
    && left.range.max === right.range.max
    && left.windowSignature === right.windowSignature;
}

function conversationLayoutSummaryReady(summary) {
  return summary
    && summary.loading === false
    && summary.candidateCount === 1
    && Number.isFinite(summary.scrollTop)
    && Number.isFinite(summary.scrollHeight)
    && Number.isFinite(summary.clientHeight)
    && typeof summary.atTop === 'boolean'
    && typeof summary.atBottom === 'boolean'
    && typeof summary.windowSignature === 'string'
    && summary.windowSignature.length > 0;
}

function conversationTailSignature(turns = []) {
  return conversationWindowIdentitySignature((Array.isArray(turns) ? turns : []).slice(-3));
}

export function conversationSemanticTailSignature(turns = []) {
  return JSON.stringify((Array.isArray(turns) ? turns : []).slice(-5).map((turn) => [
    turn?.role || null,
    textDigest(normalizeConversationText(turn?.text))
  ]));
}

function conversationSemanticAnchorEntries(turns = []) {
  const source = Array.isArray(turns) ? turns : [];
  const count = Math.min(3, source.length);
  const start = Math.max(0, Math.floor((source.length - count) / 2));
  return source.slice(start, start + count).map((turn) => ({
    role: turn?.role || null,
    textDigest: textDigest(normalizeConversationText(turn?.text))
  }));
}

export function conversationSemanticAnchorSignature(turns = []) {
  return JSON.stringify(conversationSemanticAnchorEntries(turns).map((entry) => [entry.role, entry.textDigest]));
}

function conversationSemanticAnchorEvidence(turns = []) {
  const source = Array.isArray(turns) ? turns : [];
  const count = Math.min(3, source.length);
  const start = Math.max(0, Math.floor((source.length - count) / 2));
  return source.slice(start, start + count).map((turn) => {
    const normalizedText = normalizeConversationText(turn?.text);
    return {
      role: turn?.role || null,
      positionHint: Number.isInteger(turn?.positionHint) ? turn.positionHint : null,
      textLength: normalizedText.length,
      textDigest: textDigest(normalizedText).slice(0, 32)
    };
  });
}

function conversationSemanticAnchorMatchCount(anchorSignature, turns = []) {
  if (typeof anchorSignature !== 'string' || !anchorSignature) return 0;
  let target;
  try { target = JSON.parse(anchorSignature); } catch { return 0; }
  if (!Array.isArray(target) || target.length === 0) return 0;
  const source = (Array.isArray(turns) ? turns : []).map((turn) => [
    turn?.role || null,
    textDigest(normalizeConversationText(turn?.text))
  ]);
  let matches = 0;
  for (let index = 0; index <= source.length - target.length; index += 1) {
    if (JSON.stringify(source.slice(index, index + target.length)) === JSON.stringify(target)) matches += 1;
  }
  return matches;
}

function conversationSemanticTailEvidence(turns = []) {
  return (Array.isArray(turns) ? turns : []).slice(-5).map((turn) => {
    const normalizedText = normalizeConversationText(turn?.text);
    return {
      role: turn?.role || null,
      positionHint: Number.isInteger(turn?.positionHint) ? turn.positionHint : null,
      textLength: normalizedText.length,
      textDigest: textDigest(normalizedText).slice(0, 32)
    };
  });
}

export function buildCompleteConversationReadScript({ maxTurns, maxCharsPerTurn, maxTotalChars, historyTimeoutMs, historyMaxIterations }) {
  return `(async () => {
    const maxTurns = ${maxTurns};
    const maxCharsPerTurn = ${maxCharsPerTurn};
    const maxTotalChars = ${maxTotalChars};
    const timeoutMs = ${historyTimeoutMs};
    const maxIterations = ${historyMaxIterations};
    const scrollWaitMs = ${CONVERSATION_HISTORY_SCROLL_WAIT_MS};
    const topSettleWaitMs = ${CONVERSATION_HISTORY_TOP_SETTLE_WAIT_MS};
    const topStableSamples = ${CONVERSATION_HISTORY_TOP_STABLE_SAMPLES};
    const tailStableWaitMs = ${CONVERSATION_HISTORY_SCROLL_WAIT_MS * 2};
    const tailStableSamples = 3;
    const messageSelector = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
    const excludedSelector = [
      'button', 'svg', '[role="button"]', 'form', 'textarea', 'input', 'select',
      '[contenteditable="true"]', '[data-testid*="copy" i]', '[data-testid*="feedback" i]',
      '[aria-label*="copy" i]', '[aria-label*="feedback" i]', '[data-testid*="composer" i]',
      '[aria-label*="composer" i]'
    ].join(',');
    const normalize = (value) => String(value || '').replace(/\\u0000/g, '').replace(/\\r\\n?/g, '\\n').split('\\n').map((line) => line.replace(/[ \\t]+$/u, '')).join('\\n').trim();
    const digest = (value) => {
      let hash = 2166136261;
      for (const char of String(value || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const messageNodes = () => Array.from(document.querySelectorAll(messageSelector)).filter((node) => {
      let parent = node.parentElement;
      while (parent) { if (parent.matches?.(messageSelector)) return false; parent = parent.parentElement; }
      return true;
    });
    const visibleText = (node) => {
      const clone = node.cloneNode(true);
      if (clone.matches?.(excludedSelector)) clone.remove(); else clone.querySelectorAll?.(excludedSelector).forEach((child) => child.remove());
      return normalize(clone.innerText || clone.textContent || '');
    };
    const parsePosition = (node) => {
      let current = node;
      while (current) {
        for (const value of [current.id, current.getAttribute?.('data-testid'), current.getAttribute?.('data-conversation-turn'), current.getAttribute?.('data-turn')]) {
          const match = String(value || '').match(/conversation-turn-(\\d+)/i);
          if (match) return Number(match[1]);
        }
        current = current.parentElement;
      }
      return null;
    };
    const extract = () => {
      const raw = messageNodes().map((node, domIndex) => {
      const role = node.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') return null;
      const text = visibleText(node);
      if (!text) return null;
      const messageId = String(node.getAttribute('data-message-id') || node.closest?.('[data-message-id]')?.getAttribute('data-message-id') || '').trim();
      const turnId = String(node.getAttribute('data-turn-id') || node.closest?.('[data-turn-id]')?.getAttribute('data-turn-id') || '').trim();
      const positionHint = parsePosition(node);
      return { role, text, messageId: messageId || null, turnId: turnId || null, positionHint, domIndex };
      }).filter(Boolean);
      return raw.map((turn, index) => ({
        ...turn,
        fingerprint: [turn.role, digest(turn.text), digest(raw[index - 1]?.text), digest(raw[index + 1]?.text)].join('\\u0000')
      }));
    };
    const isScrollable = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
    };
    const isNavigationRegion = (node) => node.matches?.('nav, aside, [role="navigation"], [data-testid*="sidebar" i], [aria-label*="sidebar" i]') === true;
    const describeNode = (node) => ({
      tagName: String(node?.tagName || '').slice(0, 32),
      id: String(node?.id || '').slice(0, 80),
      className: String(node?.className || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      role: String(node?.getAttribute?.('role') || '').slice(0, 40),
      overflowY: String(getComputedStyle(node)?.overflowY || '').slice(0, 16)
    });
    const nodePath = (node) => {
      const parts = [];
      let current = node;
      while (current && parts.length < 6) {
        const tag = String(current.tagName || 'node').toLowerCase();
        const id = String(current.id || '').trim();
        const testId = String(current.getAttribute?.('data-testid') || '').trim();
        parts.unshift(id ? tag + '#' + id.slice(0, 40) : testId ? tag + '[data-testid="' + testId.slice(0, 40) + '"]' : tag);
        current = current.parentElement;
      }
      return parts.join('>').slice(0, 240);
    };
    const resolveConversationScroller = () => {
      const nodes = messageNodes();
      const chains = nodes.map((node) => {
        const chain = [];
        let current = node.parentElement;
        while (current) { chain.push(current); current = current.parentElement; }
        if (document.scrollingElement && !chain.includes(document.scrollingElement)) chain.push(document.scrollingElement);
        return chain;
      });
      const common = chains.length
        ? chains[0].filter((node) => chains.every((chain) => chain.includes(node)))
        : [];
      const candidates = common.filter((node) => !isNavigationRegion(node) && isScrollable(node)).map((node) => {
        const distances = chains.map((chain) => chain.indexOf(node)).filter((distance) => distance >= 0);
        const descendants = nodes.filter((turn) => turn === node || node.contains?.(turn)).length;
        return { node, distance: Math.max(...distances), descendants, details: describeNode(node), path: nodePath(node) };
      }).filter((candidate) => candidate.descendants > 0);
      candidates.sort((left, right) => left.distance - right.distance);
      const nearestDistance = candidates[0]?.distance;
      const nearest = candidates.filter((candidate) => candidate.distance === nearestDistance);
      return {
        nodes,
        candidates,
        selected: nearest.length === 1 ? nearest[0] : null,
        ambiguous: nearest.length > 1,
        diagnostic: {
          candidateCount: candidates.length,
          selectedMessageDescendantCount: nearest.length === 1 ? nearest[0].descendants : 0,
          selected: nearest.length === 1 ? nearest[0].details : null,
          selectedPath: nearest.length === 1 ? nearest[0].path : null,
          candidates: candidates.slice(0, 8).map((candidate) => ({ ...candidate.details, messageDescendantCount: candidate.descendants, path: candidate.path }))
        }
      };
    };
    const resolvedScroller = resolveConversationScroller();
    const scroller = resolvedScroller.selected?.node || null;
    const startedAt = Date.now();
    const initialUrl = location.href;
    const originalScrollTop = scroller?.scrollTop || 0;
    const originalDistanceFromBottom = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : 0;
    const initialTurns = extract();
    const initialWindowSignature = JSON.stringify(initialTurns.map((turn) => [turn.role, turn.messageId || turn.turnId || '', turn.positionHint ?? null, digest(turn.text)]));
    const initialTail = initialTurns.at(-1) ? [initialTurns.at(-1).role, initialTurns.at(-1).messageId || initialTurns.at(-1).turnId || '', digest(initialTurns.at(-1).text)].join('\\u0000') : null;
    const snapshots = [];
    let reason = null;
    let iterations = 0;
    let startReached = false;
    let snapshotStable = false;
    let startPositionProof = false;
    let tailProven = false;
    let tailSnapshot = null;
    let topProven = false;
    let olderWindowObserved = false;
    let scrollProgressObserved = false;
    let oldestProgression = [];
    let scrollRestored = true;
    const capture = () => {
      const turns = extract();
      snapshots.push(turns);
      return turns;
    };
    const emitScroll = (deltaY) => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    };
    const isLoading = () => Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-testid*="loading" i]')).length > 0;
    const range = (turns) => {
      const values = turns.map((turn) => turn.positionHint).filter((value) => Number.isInteger(value));
      return { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
    };
    const windowSignature = (turns) => JSON.stringify(turns.map((turn) => [turn.role, turn.messageId || turn.turnId || '', turn.positionHint ?? null, digest(turn.text)]));
    const tailSignature = (turns) => JSON.stringify(turns.slice(-3).map((turn) => [turn.role, turn.messageId || turn.turnId || '', turn.positionHint ?? null, digest(turn.text)]));
    const currentAtBottom = () => !!scroller && scroller.scrollTop >= Math.max(0, scroller.scrollHeight - scroller.clientHeight - 2);
    if (!scroller) reason = resolvedScroller.ambiguous ? 'scroll-container-ambiguous' : 'scroll-container-not-found';
    if (!reason) {
      // Complete history always begins at the latest tail. The initial position is restored below.
      const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTo?.({ top: bottom, left: 0, behavior: 'auto' });
      scroller.scrollTop = bottom;
      emitScroll(bottom - originalScrollTop);
      let previousTailSignature = null;
      let stableTailCount = 0;
      for (let sample = 0; sample < tailStableSamples && Date.now() - startedAt <= timeoutMs; sample += 1) {
        const settledBottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop !== settledBottom) {
          const previousScrollTop = scroller.scrollTop;
          scroller.scrollTo?.({ top: settledBottom, left: 0, behavior: 'auto' });
          scroller.scrollTop = settledBottom;
          emitScroll(settledBottom - previousScrollTop);
        }
        await sleep(tailStableWaitMs);
        if (location.href !== initialUrl) { reason = 'conversation-changed'; break; }
        const settled = capture();
        const signature = JSON.stringify({ tail: tailSignature(settled), height: scroller.scrollHeight, count: settled.length });
        if (currentAtBottom() && !isLoading() && signature === previousTailSignature) stableTailCount += 1; else stableTailCount = 1;
        previousTailSignature = signature;
          if (stableTailCount >= tailStableSamples) {
            tailProven = true;
          tailSnapshot = settled;
          break;
        }
      }
      if (!reason && !tailProven) reason = Date.now() - startedAt > timeoutMs ? 'timeout' : 'history-tail-unproven';
      while (iterations < maxIterations && Date.now() - startedAt <= timeoutMs) {
        if (reason) break;
        iterations += 1;
        if (location.href !== initialUrl) { reason = 'conversation-changed'; break; }
        const before = scroller.scrollTop;
        const beforeTurns = extract();
        const step = Math.max(240, Math.floor(scroller.clientHeight * 0.65));
        const target = Math.max(0, before - step);
        scroller.scrollBy?.({ top: target - before, left: 0, behavior: 'auto' });
        scroller.scrollTop = target;
        emitScroll(target - before);
        await sleep(scrollWaitMs);
        const current = capture();
        if (location.href !== initialUrl) { reason = 'conversation-changed'; break; }
        const beforeRange = range(beforeTurns);
        const currentRange = range(current);
        if (oldestProgression.length < 80) oldestProgression.push(currentRange.min);
        if (currentRange.min !== null && (beforeRange.min === null || currentRange.min < beforeRange.min)) {
          olderWindowObserved = true;
          scrollProgressObserved = true;
        }
        if (windowSignature(current) !== windowSignature(beforeTurns)) scrollProgressObserved = true;
        if (scroller.scrollTop <= 1 && !isLoading()) {
          let previousTopSnapshot = null;
          let stableTopCount = 0;
          let topSettled = false;
          for (let sample = 0; sample < topStableSamples && Date.now() - startedAt <= timeoutMs; sample += 1) {
            await sleep(topSettleWaitMs);
            const settled = capture();
            if (location.href !== initialUrl) { reason = 'conversation-changed'; break; }
            if (scroller.scrollTop > 1 || isLoading()) break;
            const signature = JSON.stringify({
              first: settled[0]?.fingerprint || null,
              firstPosition: settled[0]?.positionHint ?? null,
              count: settled.length,
              height: scroller.scrollHeight
            });
            if (signature === previousTopSnapshot) stableTopCount += 1; else stableTopCount = 1;
            previousTopSnapshot = signature;
            if (stableTopCount >= topStableSamples) {
              const positioned = settled.filter((turn) => Number.isInteger(turn.positionHint));
              const positionValues = positioned.map((turn) => turn.positionHint);
              const minimumPosition = positionValues.length ? Math.min(...positionValues) : null;
              startPositionProof = positionValues.length > 0 && minimumPosition === 0;
              topProven = true;
              topSettled = true;
              break;
            }
          }
          if (reason) break;
          if (topSettled) {
            if (startPositionProof) { startReached = true; snapshotStable = true; break; }
            reason = startPositionProof ? 'history-scroll-no-progress' : 'history-start-unproven';
            break;
          }
        }
        if (!scrollProgressObserved && before === scroller.scrollTop && current.length === beforeTurns.length) { reason = 'history-scroll-no-progress'; break; }
      }
      if (!startReached && !reason) reason = Date.now() - startedAt > timeoutMs ? 'timeout' : (startPositionProof ? 'history-scroll-no-progress' : 'history-start-unproven');
    }
    const topSnapshot = snapshots.at(-1) || [];
    const topTailBeforeRestore = topSnapshot.at(-1) ? [topSnapshot.at(-1).role, topSnapshot.at(-1).messageId || topSnapshot.at(-1).turnId || '', digest(topSnapshot.at(-1).text)].join('\\u0000') : null;
    if (scroller && tailProven) {
      const tailCheckBottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const previousScrollTop = scroller.scrollTop;
      scroller.scrollTo?.({ top: tailCheckBottom, left: 0, behavior: 'auto' });
      scroller.scrollTop = tailCheckBottom;
      emitScroll(tailCheckBottom - previousScrollTop);
      await sleep(scrollWaitMs);
      const tailCheck = extract();
      if (location.href !== initialUrl || tailSignature(tailCheck) !== tailSignature(tailSnapshot)) reason = 'conversation-changed';
    }
    scroller && (scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - originalDistanceFromBottom));
    await sleep(Math.min(200, scrollWaitMs));
    const restoredTurns = extract();
    if (scroller) scrollRestored = Math.abs((scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) - originalDistanceFromBottom) <= 2;
    if (location.href !== initialUrl) reason = 'conversation-changed';
    const restoredWindowSignature = JSON.stringify(restoredTurns.map((turn) => [turn.role, turn.messageId || turn.turnId || '', turn.positionHint ?? null, digest(turn.text)]));
    if (!reason && initialWindowSignature !== restoredWindowSignature) reason = 'conversation-changed';
    const restoredTail = restoredTurns.at(-1) ? [restoredTurns.at(-1).role, restoredTurns.at(-1).messageId || restoredTurns.at(-1).turnId || '', digest(restoredTurns.at(-1).text)].join('\\u0000') : null;
    const allSnapshots = snapshots.length ? snapshots : [initialTurns];
    const allRanges = allSnapshots.map(range);
    const observedPositions = allRanges.flatMap((item) => [item.min, item.max]).filter((value) => Number.isInteger(value));
    const tailRange = range(tailSnapshot || []);
    const diagnostics = {
      scroller: {
        ...resolvedScroller.diagnostic,
        selectedAtTop: topProven,
        selectedAtBottom: tailProven
      },
      positions: {
        initialMin: range(initialTurns).min,
        initialMax: range(initialTurns).max,
        tailMin: tailRange.min,
        tailMax: tailRange.max,
        observedMin: observedPositions.length ? Math.min(...observedPositions) : null,
        observedMax: observedPositions.length ? Math.max(...observedPositions) : null,
        oldestProgression: oldestProgression.slice(0, 80)
      },
      progress: {
        olderWindowObserved,
        scrollProgressObserved,
        tailProven,
        startProven: startPositionProof
      }
    };
    return { snapshots: allSnapshots, startReached, snapshotStable, startPositionProof, tailProven, iterations, reason, scrollRestored, originalScrollTop, topTailBeforeRestore, initialTail, restoredTail, scrollerFound: !!scroller, diagnostics };
  })()`;
}

export function buildConversationWindowReadScript({ maxTurns, maxCharsPerTurn, maxTotalChars }) {
  return `(() => {
    const maxTurns = ${maxTurns};
    const maxCharsPerTurn = ${maxCharsPerTurn};
    const maxTotalChars = ${maxTotalChars};
    const messageSelector = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
    const markerSelector = '[id*="conversation-turn-" i], [data-testid*="conversation-turn-" i], [data-conversation-turn], [data-turn]';
    const excludedSelector = [
      'button', 'svg', '[role="button"]', 'form', 'textarea', 'input', 'select',
      '[contenteditable="true"]', '[data-testid*="copy" i]', '[data-testid*="feedback" i]',
      '[aria-label*="copy" i]', '[aria-label*="feedback" i]', '[data-testid*="composer" i]',
      '[aria-label*="composer" i]'
    ].join(',');
    const normalize = (value) => String(value || '').replace(/\\u0000/g, '').replace(/\\r\\n?/g, '\\n').split('\\n').map((line) => line.replace(/[ \\t]+$/u, '')).join('\\n').trim();
    const digest = (value) => {
      let hash = 2166136261;
      for (const char of String(value || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    const messageNodes = () => Array.from(document.querySelectorAll(messageSelector)).filter((node) => {
      let parent = node.parentElement;
      while (parent) { if (parent.matches?.(messageSelector)) return false; parent = parent.parentElement; }
      return true;
    });
    const visibleText = (node) => {
      const clone = node.cloneNode(true);
      if (clone.matches?.(excludedSelector)) clone.remove(); else clone.querySelectorAll?.(excludedSelector).forEach((child) => child.remove());
      return normalize(clone.innerText || clone.textContent || '');
    };
    const parsePosition = (node) => {
      let current = node;
      while (current) {
        for (const value of [current.id, current.getAttribute?.('data-testid'), current.getAttribute?.('data-conversation-turn'), current.getAttribute?.('data-turn')]) {
          const match = String(value || '').match(/conversation-turn-(\\d+)/i);
          if (match) return Number(match[1]);
        }
        current = current.parentElement;
      }
      return null;
    };
    const extract = () => {
      const raw = messageNodes().map((node, domIndex) => {
        const role = node.getAttribute('data-message-author-role');
        if (role !== 'user' && role !== 'assistant') return null;
        const text = visibleText(node);
        if (!text) return null;
        const messageId = String(node.getAttribute('data-message-id') || node.closest?.('[data-message-id]')?.getAttribute('data-message-id') || '').trim();
        const turnId = String(node.getAttribute('data-turn-id') || node.closest?.('[data-turn-id]')?.getAttribute('data-turn-id') || '').trim();
        return { role, text, messageId: messageId || null, turnId: turnId || null, positionHint: parsePosition(node), domIndex };
      }).filter(Boolean);
      return raw.map((turn, index) => ({
        ...turn,
        fingerprint: [turn.role, digest(turn.text), digest(raw[index - 1]?.text), digest(raw[index + 1]?.text)].join('\\u0000')
      }));
    };
    const isScrollable = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
    };
    const isNavigationRegion = (node) => node.matches?.('nav, aside, [role="navigation"], [data-testid*="sidebar" i], [aria-label*="sidebar" i]') === true;
    const describeNode = (node) => ({
      tagName: String(node?.tagName || '').slice(0, 32),
      id: String(node?.id || '').slice(0, 80),
      className: String(node?.className || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      role: String(node?.getAttribute?.('role') || '').slice(0, 40),
      overflowY: String(getComputedStyle(node)?.overflowY || '').slice(0, 16)
    });
    const nodePath = (node) => {
      const parts = [];
      let current = node;
      while (current && parts.length < 6) {
        const tag = String(current.tagName || 'node').toLowerCase();
        const id = String(current.id || '').trim();
        const testId = String(current.getAttribute?.('data-testid') || '').trim();
        parts.unshift(id ? tag + '#' + id.slice(0, 40) : testId ? tag + '[data-testid="' + testId.slice(0, 40) + '"]' : tag);
        current = current.parentElement;
      }
      return parts.join('>').slice(0, 240);
    };
    const resolveConversationScroller = () => {
      const nodes = messageNodes();
      const chains = nodes.map((node) => {
        const chain = [];
        let current = node.parentElement;
        while (current) { chain.push(current); current = current.parentElement; }
        if (document.scrollingElement && !chain.includes(document.scrollingElement)) chain.push(document.scrollingElement);
        return chain;
      });
      const common = chains.length ? chains[0].filter((node) => chains.every((chain) => chain.includes(node))) : [];
      const candidates = common.filter((node) => !isNavigationRegion(node) && isScrollable(node)).map((node) => {
        const distances = chains.map((chain) => chain.indexOf(node)).filter((distance) => distance >= 0);
        const descendants = nodes.filter((turn) => turn === node || node.contains?.(turn)).length;
        return { node, distance: Math.max(...distances), descendants, details: describeNode(node), path: nodePath(node) };
      }).filter((candidate) => candidate.descendants > 0);
      candidates.sort((left, right) => left.distance - right.distance);
      const nearestDistance = candidates[0]?.distance;
      const nearest = candidates.filter((candidate) => candidate.distance === nearestDistance);
      return {
        selected: nearest.length === 1 ? nearest[0] : null,
        ambiguous: nearest.length > 1,
        diagnostic: {
          candidateCount: candidates.length,
          selectedMessageDescendantCount: nearest.length === 1 ? nearest[0].descendants : 0,
          selected: nearest.length === 1 ? nearest[0].details : null,
          selectedPath: nearest.length === 1 ? nearest[0].path : null,
          candidates: candidates.slice(0, 8).map((candidate) => ({ ...candidate.details, messageDescendantCount: candidate.descendants, path: candidate.path }))
        }
      };
    };
    const resolved = resolveConversationScroller();
    const scroller = resolved.selected?.node || null;
    const turns = extract();
    const messageNodesInScroller = scroller
      ? messageNodes().filter((node) => node === scroller || scroller.contains?.(node))
      : [];
    const positionZeroMessageNodeCount = messageNodesInScroller.filter((node) => parsePosition(node) === 0).length;
    const positionOneMessageNodeCount = messageNodesInScroller.filter((node) => parsePosition(node) === 1).length;
    const positionZeroMarkerInsideScrollerCount = scroller
      ? Array.from(document.querySelectorAll(markerSelector)).filter((node) => (node === scroller || scroller.contains?.(node)) && parsePosition(node) === 0).length
      : 0;
    const firstMessage = turns[0] || null;
    const values = turns.map((turn) => turn.positionHint).filter((value) => Number.isInteger(value));
    const range = { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
    const totalChars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    const limitKind = turns.some((turn) => turn.text.length > maxCharsPerTurn)
      ? 'per-turn'
      : totalChars > maxTotalChars || turns.length > maxTurns ? 'total'
        : null;
    const rect = scroller?.getBoundingClientRect?.();
    const viewportWidth = Number(globalThis.innerWidth || document.documentElement?.clientWidth || 0);
    const viewportHeight = Number(globalThis.innerHeight || document.documentElement?.clientHeight || 0);
    const validRect = rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 20 && rect.height > 20;
    const left = validRect ? Math.max(0, rect.left) : 0;
    const top = validRect ? Math.max(0, rect.top) : 0;
    const right = validRect ? Math.min(viewportWidth || rect.right, rect.right) : 0;
    const bottom = validRect ? Math.min(viewportHeight || rect.bottom, rect.bottom) : 0;
    const point = validRect && right - left > 20 && bottom - top > 20
      ? { x: Math.round(left + (right - left) / 2), y: Math.round(top + Math.min((bottom - top) * 0.45, (bottom - top) - 12)) }
      : null;
    const signature = JSON.stringify(turns.map((turn) => [turn.role, turn.messageId || turn.turnId || '', turn.positionHint ?? null, digest(turn.text)]));
    return {
      url: location.href,
      turns: turns.slice(-maxTurns),
      limitExceeded: !!limitKind,
      limitKind,
      loading: Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-testid*="loading" i]')).length > 0,
      signature,
      range,
      startBoundary: {
        firstMessagePosition: Number.isInteger(firstMessage?.positionHint) ? firstMessage.positionHint : null,
        firstMessageRole: firstMessage?.role === 'user' || firstMessage?.role === 'assistant' ? firstMessage.role : null,
        positionZeroMessageNodeCount,
        positionZeroMarkerInsideScrollerCount,
        positionOneMessageNodeCount
      },
      scroller: scroller ? {
        ...resolved.diagnostic,
        scrollTop: Number(scroller.scrollTop),
        scrollHeight: Number(scroller.scrollHeight),
        clientHeight: Number(scroller.clientHeight),
        atTop: Number(scroller.scrollTop) <= 1,
        atBottom: Number(scroller.scrollTop) >= Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight) - 2),
        point
      } : { ...resolved.diagnostic, atTop: false, atBottom: false, point: null }
    };
  })()`;
}

export function buildConversationTraversalReadScript({ maxTurns, maxCharsPerTurn, maxTotalChars }) {
  return `(() => {
    const traversalRead = true;
    const maxTurns = ${maxTurns};
    const maxCharsPerTurn = ${maxCharsPerTurn};
    const maxTotalChars = ${maxTotalChars};
    const messageSelector = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
    const markerSelector = '[id*="conversation-turn-" i], [data-testid*="conversation-turn-" i], [data-conversation-turn], [data-turn]';
    const normalize = (value) => String(value || '').replace(/\\u0000/g, '').replace(/\\s+/g, ' ').trim();
    const digest = (value) => {
      let hash = 2166136261;
      for (const char of String(value || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    const messageNodes = () => Array.from(document.querySelectorAll(messageSelector)).filter((node) => {
      let parent = node.parentElement;
      while (parent) { if (parent.matches?.(messageSelector)) return false; parent = parent.parentElement; }
      return true;
    });
    const parsePosition = (node) => {
      let current = node;
      while (current) {
        for (const value of [current.id, current.getAttribute?.('data-testid'), current.getAttribute?.('data-conversation-turn'), current.getAttribute?.('data-turn')]) {
          const match = String(value || '').match(/conversation-turn-(\\d+)/i);
          if (match) return Number(match[1]);
        }
        current = current.parentElement;
      }
      return null;
    };
    const isNavigationRegion = (node) => node.matches?.('nav, aside, [role="navigation"], [data-testid*="sidebar" i], [aria-label*="sidebar" i]') === true;
    const isScrollable = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && Number(node.scrollHeight) > Number(node.clientHeight);
    };
    const nodes = messageNodes();
    const chains = nodes.map((node) => {
      const chain = [];
      let current = node.parentElement;
      while (current) { chain.push(current); current = current.parentElement; }
      if (document.scrollingElement && !chain.includes(document.scrollingElement)) chain.push(document.scrollingElement);
      return chain;
    });
    const common = chains.length ? chains[0].filter((node) => chains.every((chain) => chain.includes(node))) : [];
    const candidates = common.filter((node) => !isNavigationRegion(node) && isScrollable(node)).map((node) => ({ node, distance: Math.max(...chains.map((chain) => chain.indexOf(node))), descendants: nodes.filter((message) => node.contains?.(message)).length })).filter((candidate) => candidate.descendants > 0);
    candidates.sort((left, right) => left.distance - right.distance);
    const nearestDistance = candidates[0]?.distance;
    const nearest = candidates.filter((candidate) => candidate.distance === nearestDistance);
    const selected = nearest.length === 1 ? nearest[0].node : null;
    const inScroller = selected ? nodes.filter((node) => selected.contains?.(node)) : [];
    const turns = inScroller.map((node, domIndex) => {
      const role = node.getAttribute('data-message-author-role');
      const rawText = String(node.innerText || node.textContent || '');
      const text = normalize(rawText.slice(0, 512));
      const messageId = String(node.getAttribute('data-message-id') || node.closest?.('[data-message-id]')?.getAttribute('data-message-id') || '').trim();
      const turnId = String(node.getAttribute('data-turn-id') || node.closest?.('[data-turn-id]')?.getAttribute('data-turn-id') || '').trim();
      return { role, messageId: messageId || null, turnId: turnId || null, positionHint: parsePosition(node), textDigest: digest(text), textLength: rawText.length, domIndex };
    }).filter((turn) => turn.role === 'user' || turn.role === 'assistant');
    const values = turns.map((turn) => turn.positionHint).filter((value) => Number.isInteger(value));
    const range = { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
    const totalChars = turns.reduce((sum, turn) => sum + turn.textLength, 0);
    const limitKind = turns.some((turn) => turn.textLength > maxCharsPerTurn) ? 'per-turn' : totalChars > maxTotalChars || turns.length > maxTurns ? 'total' : null;
    const rect = selected?.getBoundingClientRect?.();
    const viewportWidth = Number(globalThis.innerWidth || document.documentElement?.clientWidth || 0);
    const viewportHeight = Number(globalThis.innerHeight || document.documentElement?.clientHeight || 0);
    const validRect = rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 20 && rect.height > 20;
    const left = validRect ? Math.max(0, rect.left) : 0;
    const top = validRect ? Math.max(0, rect.top) : 0;
    const right = validRect ? Math.min(viewportWidth || rect.right, rect.right) : 0;
    const bottom = validRect ? Math.min(viewportHeight || rect.bottom, rect.bottom) : 0;
    const point = validRect && right - left > 20 && bottom - top > 20 ? { x: Math.round(left + (right - left) / 2), y: Math.round(top + Math.min((bottom - top) * 0.45, (bottom - top) - 12)) } : null;
    const loading = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-testid*="loading" i]')).length > 0;
    const signature = JSON.stringify(turns.map((turn) => [turn.role, turn.messageId || turn.turnId || '', turn.positionHint ?? null, turn.textDigest]));
    const messagePositionZeroCount = turns.filter((turn) => turn.positionHint === 0).length;
    const positionZeroMarkerCount = selected ? Array.from(document.querySelectorAll(markerSelector)).filter((node) => selected.contains?.(node) && parsePosition(node) === 0).length : 0;
    const first = turns[0] || null;
    return {
      url: location.href,
      turns: turns.slice(-maxTurns),
      limitExceeded: !!limitKind,
      limitKind,
      loading,
      windowSignature: signature,
      signature,
      range,
      startBoundary: { firstMessagePosition: Number.isInteger(first?.positionHint) ? first.positionHint : null, firstMessageRole: first?.role === 'user' || first?.role === 'assistant' ? first.role : null, positionZeroMessageNodeCount: messagePositionZeroCount, positionZeroMarkerInsideScrollerCount: positionZeroMarkerCount, positionOneMessageNodeCount: turns.filter((turn) => turn.positionHint === 1).length },
      scroller: selected ? { candidateCount: candidates.length, selectedMessageDescendantCount: nearest[0].descendants, scrollTop: Number(selected.scrollTop), scrollHeight: Number(selected.scrollHeight), clientHeight: Number(selected.clientHeight), atTop: Number(selected.scrollTop) <= 1, atBottom: Number(selected.scrollTop) >= Math.max(0, Number(selected.scrollHeight) - Number(selected.clientHeight) - 2), point } : { candidateCount: candidates.length, selectedMessageDescendantCount: 0, scrollTop: null, scrollHeight: null, clientHeight: null, atTop: false, atBottom: false, point: null }
    };
  })()`;
}

export function buildConversationStartMarkerDiagnosticScript({ maxTurns, maxCharsPerTurn, maxTotalChars }) {
  return `(() => {
    const maxTurns = ${maxTurns};
    const maxCharsPerTurn = ${maxCharsPerTurn};
    const maxTotalChars = ${maxTotalChars};
    const messageSelector = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
    const markerSelector = '[id*="conversation-turn-" i], [data-testid*="conversation-turn-" i], [data-conversation-turn], [data-turn]';
    const excludedSelector = [
      'button', 'svg', '[role="button"]', 'form', 'textarea', 'input', 'select',
      '[contenteditable="true"]', '[data-testid*="copy" i]', '[data-testid*="feedback" i]',
      '[aria-label*="copy" i]', '[aria-label*="feedback" i]', '[data-testid*="composer" i]',
      '[aria-label*="composer" i]'
    ].join(',');
    const normalize = (value) => String(value || '').replace(/\\u0000/g, '').replace(/\\r\\n?/g, '\\n').split('\\n').map((line) => line.replace(/[ \\t]+$/u, '')).join('\\n').trim();
    const digest = (value) => {
      let hash = 2166136261;
      for (const char of String(value || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    const bounded = (value, max = 160) => String(value || '').replace(/[\\u0000-\\u001f\\u007f]/gu, ' ').replace(/\\s+/gu, ' ').trim().slice(0, max);
    const messageNodes = () => Array.from(document.querySelectorAll(messageSelector)).filter((node) => {
      let parent = node.parentElement;
      while (parent) { if (parent.matches?.(messageSelector)) return false; parent = parent.parentElement; }
      return true;
    });
    const visibleText = (node) => {
      const clone = node.cloneNode(true);
      if (clone.matches?.(excludedSelector)) clone.remove(); else clone.querySelectorAll?.(excludedSelector).forEach((child) => child.remove());
      return normalize(clone.innerText || clone.textContent || '');
    };
    const parsePositionWithSource = (node) => {
      let current = node;
      let depth = 0;
      while (current) {
        for (const [attributeName, value] of [
          ['id', current.id],
          ['data-testid', current.getAttribute?.('data-testid')],
          ['data-conversation-turn', current.getAttribute?.('data-conversation-turn')],
          ['data-turn', current.getAttribute?.('data-turn')]
        ]) {
          const match = String(value || '').match(/conversation-turn-(\\d+)/i);
          if (match) return {
            depth,
            attributeName,
            rawValue: bounded(value, 120),
            parsedPosition: Number(match[1]),
            node: current
          };
        }
        current = current.parentElement;
        depth += 1;
      }
      return { depth: null, attributeName: null, rawValue: null, parsedPosition: null, node: null };
    };
    const styleState = (node) => {
      const style = getComputedStyle(node);
      return {
        hidden: node.hasAttribute?.('hidden') === true,
        ariaHidden: node.getAttribute?.('aria-hidden') === 'true',
        display: bounded(style?.display, 16),
        visibility: bounded(style?.visibility, 16)
      };
    };
    const messageCounts = (node, messages) => ({
      user: messages.filter((message) => node.contains?.(message) && message.getAttribute('data-message-author-role') === 'user').length,
      assistant: messages.filter((message) => node.contains?.(message) && message.getAttribute('data-message-author-role') === 'assistant').length
    });
    const markerAttributes = (node) => ({
      tagName: bounded(node?.tagName, 32),
      id: bounded(node?.id, 120),
      dataTestId: bounded(node?.getAttribute?.('data-testid'), 120),
      dataConversationTurn: bounded(node?.getAttribute?.('data-conversation-turn'), 120),
      dataTurn: bounded(node?.getAttribute?.('data-turn'), 120)
    });
    const markerRecord = (node, messages, insideScroller = false) => {
      const source = parsePositionWithSource(node);
      const rect = node.getBoundingClientRect?.();
      return {
        ...markerAttributes(node),
        parsedPosition: Number.isInteger(source.parsedPosition) ? source.parsedPosition : null,
        insideSelectedScroller: insideScroller,
        containsUserMessageCount: messageCounts(node, messages).user,
        containsAssistantMessageCount: messageCounts(node, messages).assistant,
        ...styleState(node),
        rect: rect && Number.isFinite(rect.top) && Number.isFinite(rect.height) ? { top: Math.round(rect.top), height: Math.round(rect.height) } : null
      };
    };
    const parsePosition = (node) => parsePositionWithSource(node).parsedPosition;
    const isNavigationRegion = (node) => node.matches?.('nav, aside, [role="navigation"], [data-testid*="sidebar" i], [aria-label*="sidebar" i]') === true;
    const isScrollable = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && Number(node.scrollHeight) > Number(node.clientHeight);
    };
    const resolveScroller = (messages) => {
      const chains = messages.map((node) => {
        const chain = [];
        let current = node.parentElement;
        while (current) { chain.push(current); current = current.parentElement; }
        if (document.scrollingElement && !chain.includes(document.scrollingElement)) chain.push(document.scrollingElement);
        return chain;
      });
      const common = chains.length ? chains[0].filter((node) => chains.every((chain) => chain.includes(node))) : [];
      const candidates = common.filter((node) => !isNavigationRegion(node) && isScrollable(node)).map((node) => ({
        node,
        distance: Math.max(...chains.map((chain) => chain.indexOf(node))),
        descendants: messages.filter((message) => node.contains?.(message)).length
      })).filter((candidate) => candidate.descendants > 0);
      candidates.sort((left, right) => left.distance - right.distance);
      const nearestDistance = candidates[0]?.distance;
      const nearest = candidates.filter((candidate) => candidate.distance === nearestDistance);
      return { selected: nearest.length === 1 ? nearest[0].node : null, candidates, ambiguous: nearest.length > 1 };
    };
    const messages = messageNodes();
    const resolved = resolveScroller(messages);
    const scroller = resolved.selected;
    const turns = messages.map((node, domIndex) => {
      const role = node.getAttribute('data-message-author-role');
      const text = visibleText(node);
      const source = parsePositionWithSource(node);
      const messageId = String(node.getAttribute('data-message-id') || node.closest?.('[data-message-id]')?.getAttribute('data-message-id') || '').trim();
      const turnId = String(node.getAttribute('data-turn-id') || node.closest?.('[data-turn-id]')?.getAttribute('data-turn-id') || '').trim();
      return { node, domIndex, role, text, position: Number.isInteger(source.parsedPosition) ? source.parsedPosition : null, source, messageId: !!messageId, turnId: !!turnId };
    }).filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && turn.text);
    const markerNodes = Array.from(document.querySelectorAll(markerSelector));
    const markers = markerNodes.slice(0, 40).map((node) => markerRecord(node, messages, !!scroller?.contains?.(node)));
    const positions = markers.map((marker) => marker.parsedPosition).filter((value) => Number.isInteger(value));
    const uniquePositions = [...new Set(positions)].sort((left, right) => left - right).slice(0, 50);
    const scrollerMarkers = scroller
      ? markerNodes.filter((node) => scroller.contains?.(node)).slice(0, 30).map((node) => {
        const source = parsePositionWithSource(node);
        return {
          parsedPosition: Number.isInteger(source.parsedPosition) ? source.parsedPosition : null,
          id: bounded(node.id, 120),
          dataTestId: bounded(node.getAttribute?.('data-testid'), 120),
          roleCounts: messageCounts(node, messages),
          hidden: styleState(node).hidden
        };
      })
      : [];
    const first = turns[0] || null;
    const firstSource = first?.source || { depth: null, attributeName: null, rawValue: null, parsedPosition: null, node: null };
    const ancestors = [];
    let ancestor = first?.node || null;
    let ancestorDepth = 0;
    while (ancestor && ancestors.length < 12) {
      const attrs = markerAttributes(ancestor);
      ancestors.push({
        depth: ancestorDepth,
        ...attrs,
        dataMessageIdPresent: !!ancestor.getAttribute?.('data-message-id'),
        dataTurnIdPresent: !!ancestor.getAttribute?.('data-turn-id'),
        ...styleState(ancestor)
      });
      ancestor = ancestor.parentElement;
      ancestorDepth += 1;
    }
    const previousSiblings = [];
    let sibling = firstSource.node?.previousElementSibling || null;
    while (sibling && previousSiblings.length < 5) {
      const source = parsePositionWithSource(sibling);
      previousSiblings.push({
        ...markerAttributes(sibling),
        parsedPosition: Number.isInteger(source.parsedPosition) ? source.parsedPosition : null,
        ...messageCounts(sibling, messages),
        ...styleState(sibling),
        textLength: Math.min(normalize(sibling.innerText || sibling.textContent || '').length, maxTotalChars)
      });
      sibling = sibling.previousElementSibling;
    }
    const messagePositionOrder = turns.slice(0, 20).map((turn) => ({ role: turn.role, position: turn.position }));
    const textMessages = turns.slice(0, 5).map((turn) => ({
      domIndex: turn.domIndex,
      role: turn.role,
      parsedPosition: turn.position,
      messageIdPresent: turn.messageId,
      turnIdPresent: turn.turnId,
      textLength: Math.min(turn.text.length, maxTotalChars),
      textDigest: digest(turn.text),
      textPrefix: bounded(turn.text, 120)
    }));
    const rangeValues = turns.map((turn) => turn.position).filter((value) => Number.isInteger(value));
    const range = { min: rangeValues.length ? Math.min(...rangeValues) : null, max: rangeValues.length ? Math.max(...rangeValues) : null };
    const totalChars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    const limitKind = turns.some((turn) => turn.text.length > maxCharsPerTurn)
      ? 'per-turn'
      : totalChars > maxTotalChars || turns.length > maxTurns ? 'total' : null;
    const rect = scroller?.getBoundingClientRect?.();
    const viewportWidth = Number(globalThis.innerWidth || document.documentElement?.clientWidth || 0);
    const viewportHeight = Number(globalThis.innerHeight || document.documentElement?.clientHeight || 0);
    const validRect = rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 20 && rect.height > 20;
    const left = validRect ? Math.max(0, rect.left) : 0;
    const top = validRect ? Math.max(0, rect.top) : 0;
    const right = validRect ? Math.min(viewportWidth || rect.right, rect.right) : 0;
    const bottom = validRect ? Math.min(viewportHeight || rect.bottom, rect.bottom) : 0;
    const point = validRect && right - left > 20 && bottom - top > 20 ? { x: Math.round(left + (right - left) / 2), y: Math.round(top + Math.min((bottom - top) * 0.45, (bottom - top) - 12)) } : null;
    const windowSignature = digest(JSON.stringify(turns.map((turn) => [turn.role, turn.messageId, turn.turnId, turn.position, digest(turn.text)])));
    const structuralSignature = digest(JSON.stringify({ positions: uniquePositions, first: textMessages[0]?.parsedPosition ?? null, markerCount: markers.length }));
    return {
      url: location.href,
      limitExceeded: !!limitKind,
      limitKind,
      loading: Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-testid*="loading" i]')).length > 0,
      range,
      windowSignature,
      structuralSignature,
      scroller: scroller ? {
        candidateCount: resolved.candidates.length,
        selectedMessageDescendantCount: resolved.candidates.filter((candidate) => candidate.node === scroller)[0]?.descendants || 0,
        scrollTop: Number(scroller.scrollTop),
        scrollHeight: Number(scroller.scrollHeight),
        clientHeight: Number(scroller.clientHeight),
        atTop: Number(scroller.scrollTop) <= 1,
        atBottom: Number(scroller.scrollTop) >= Math.max(0, Number(scroller.scrollHeight) - Number(scroller.clientHeight) - 2),
        point
      } : { candidateCount: resolved.candidates.length, selectedMessageDescendantCount: 0, scrollTop: null, scrollHeight: null, clientHeight: null, atTop: false, atBottom: false, point: null },
      markers,
      markerPositions: {
        minimum: positions.length ? Math.min(...positions) : null,
        maximum: positions.length ? Math.max(...positions) : null,
        uniquePositions,
        hasPosition0: uniquePositions.includes(0),
        hasPosition1: uniquePositions.includes(1)
      },
      turnZero: {
        elementCount: markers.filter((marker) => marker.parsedPosition === 0).length,
        insideScrollerCount: markers.filter((marker) => marker.parsedPosition === 0 && marker.insideSelectedScroller).length,
        visibleElementCount: markers.filter((marker) => marker.parsedPosition === 0 && !marker.hidden && !marker.ariaHidden && marker.display !== 'none' && marker.visibility !== 'hidden').length,
        containsUserMessage: markers.some((marker) => marker.parsedPosition === 0 && marker.containsUserMessageCount > 0),
        containsAssistantMessage: markers.some((marker) => marker.parsedPosition === 0 && marker.containsAssistantMessageCount > 0),
        rawMarkers: markers.filter((marker) => marker.parsedPosition === 0).slice(0, 5).map((marker) => ({ tagName: marker.tagName, id: marker.id, dataTestId: marker.dataTestId, dataConversationTurn: marker.dataConversationTurn, dataTurn: marker.dataTurn }))
      },
      positionOne: {
        elementCount: markers.filter((marker) => marker.parsedPosition === 1).length,
        containsUserMessage: markers.some((marker) => marker.parsedPosition === 1 && marker.containsUserMessageCount > 0),
        containsAssistantMessage: markers.some((marker) => marker.parsedPosition === 1 && marker.containsAssistantMessageCount > 0)
      },
      firstMessagePosition: first?.position ?? null,
      firstMessageRole: first?.role || null,
      positionSource: firstSource.node ? { depth: firstSource.depth, attributeName: firstSource.attributeName, rawValue: firstSource.rawValue, parsedPosition: firstSource.parsedPosition } : null,
      firstMessages: textMessages,
      firstMessageAncestors: ancestors,
      previousSiblings,
      scrollerMarkerOrder: scrollerMarkers,
      messagePositionOrder,
      turnZeroElementExists: markers.some((marker) => marker.parsedPosition === 0),
      turnZeroContainsConversationMessage: markers.some((marker) => marker.parsedPosition === 0 && (marker.containsUserMessageCount > 0 || marker.containsAssistantMessageCount > 0))
    };
  })()`;
}

function buildRestoreConversationScrollScript(distanceFromBottom, operation = 'restore') {
  return `(() => {
    const operation = ${JSON.stringify(operation)};
    const targetDistance = ${Math.max(0, Math.trunc(Number(distanceFromBottom) || 0))};
    const targetTop = operation === 'top' ? 0 : null;
    const messageSelector = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
    const nodes = Array.from(document.querySelectorAll(messageSelector)).filter((node) => {
      let parent = node.parentElement;
      while (parent) {
        if (parent.matches?.(messageSelector)) return false;
        parent = parent.parentElement;
      }
      return true;
    });
    const isNavigationRegion = (node) => node.matches?.('nav, aside, [role="navigation"], [data-testid*="sidebar" i], [aria-label*="sidebar" i]') === true;
    const isScrollable = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && Number(node.scrollHeight) > Number(node.clientHeight);
    };
    const chains = nodes.map((node) => {
      const chain = [];
      let current = node.parentElement;
      while (current) { chain.push(current); current = current.parentElement; }
      if (document.scrollingElement && !chain.includes(document.scrollingElement)) chain.push(document.scrollingElement);
      return chain;
    });
    const common = chains.length ? chains[0].filter((node) => chains.every((chain) => chain.includes(node))) : [];
    const candidates = common.filter((node) => !isNavigationRegion(node) && isScrollable(node));
    const distances = candidates.map((node) => ({ node, distance: Math.max(...chains.map((chain) => chain.indexOf(node))) }));
    const nearestDistance = distances.length ? Math.min(...distances.map((item) => item.distance)) : null;
    const nearest = distances.filter((item) => item.distance === nearestDistance);
    if (nearest.length !== 1) return { ok: false, reason: nearest.length > 1 ? 'scroll-container-ambiguous' : 'scroll-container-not-found' };
    const node = nearest[0].node;
    node.scrollTop = targetTop === null
      ? Math.max(0, node.scrollHeight - node.clientHeight - targetDistance)
      : targetTop;
    return { ok: true, scrollTop: node.scrollTop };
  })()`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || 0);
  return Math.floor(min + Math.random() * (max - min + 1));
}

function queryAbortedError(reason = 'user_stop') {
  const error = new Error('query_aborted');
  error.data = { reason };
  return error;
}

function throwIfSignalAborted(signal) {
  if (signal?.aborted) throw queryAbortedError();
}

export function isChatGPTAttachmentCardDisplayName(fileName, displayName) {
  const result = mapChatGPTAttachmentCardNames([fileName], [displayName]);
  return result.mappingComplete && result.mapping[0]?.matched === true;
}

export function isChatGPTCurrentDraftAttachmentCard(card) {
  if (!card || typeof card.closest !== 'function') return false;
  return !card.closest('[data-message-author-role], article[data-turn], [data-testid*="conversation-turn" i]');
}

export function mapChatGPTAttachmentCardNames(selectedFileNames, cardDisplayNames) {
  const selected = (Array.isArray(selectedFileNames) ? selectedFileNames : []).map((value) => String(value || '').trim());
  const cards = (Array.isArray(cardDisplayNames) ? cardDisplayNames : []).map((value) => String(value || '').trim());
  const normalize = (value) => String(value || '').toLocaleLowerCase();
  const escapeRegExp = (value) => String(value || '').replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  const isRenamedAlias = (sourceName, cardName) => {
    const source = String(sourceName || '').trim();
    const card = String(cardName || '').trim();
    if (!source || !card || normalize(source) === normalize(card)) return false;
    const dot = source.lastIndexOf('.');
    const stem = dot <= 0 ? source : source.slice(0, dot);
    const extension = dot <= 0 ? '' : source.slice(dot);
    const match = new RegExp(`^${escapeRegExp(stem)}\\(([0-9]+(?:-[0-9]+)*)\\)${escapeRegExp(extension)}$`, 'i').exec(card);
    if (!match) return false;
    return match[1].split('-').some((segment) => (segment.replace(/^0+/u, '') || '0') !== '0');
  };
  const mapping = selected.map((sourceFileName) => ({
    sourceFileName,
    displayName: '',
    matched: false,
    matchKind: null,
    cardIndex: null
  }));
  const usedCards = new Set();
  const mappingErrors = [];

  for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
    const exactCardIndex = cards.findIndex((cardName, cardIndex) => !usedCards.has(cardIndex) && normalize(cardName) === normalize(selected[selectedIndex]));
    if (exactCardIndex < 0) continue;
    usedCards.add(exactCardIndex);
    mapping[selectedIndex] = {
      sourceFileName: selected[selectedIndex],
      displayName: cards[exactCardIndex],
      matched: true,
      matchKind: 'exact',
      cardIndex: exactCardIndex
    };
  }

  const remainingSelected = mapping
    .map((entry, selectedIndex) => entry.matched ? null : selectedIndex)
    .filter((selectedIndex) => selectedIndex !== null);
  const remainingCards = cards
    .map((_, cardIndex) => usedCards.has(cardIndex) ? null : cardIndex)
    .filter((cardIndex) => cardIndex !== null);
  const candidates = new Map(remainingSelected.map((selectedIndex) => [
    selectedIndex,
    remainingCards.filter((cardIndex) => isRenamedAlias(selected[selectedIndex], cards[cardIndex]))
  ]));
  const matching = new Map();
  const findMatching = (blockedEdge = null) => {
    const cardToSelected = new Map();
    const visit = (selectedIndex, seenCards) => {
      for (const cardIndex of candidates.get(selectedIndex) || []) {
        if (blockedEdge && blockedEdge.selectedIndex === selectedIndex && blockedEdge.cardIndex === cardIndex) continue;
        if (seenCards.has(cardIndex)) continue;
        seenCards.add(cardIndex);
        const prior = cardToSelected.get(cardIndex);
        if (prior === undefined || visit(prior, seenCards)) {
          cardToSelected.set(cardIndex, selectedIndex);
          return true;
        }
      }
      return false;
    };
    for (const selectedIndex of remainingSelected) {
      if (!visit(selectedIndex, new Set())) return null;
    }
    return cardToSelected;
  };
  const aliasMatching = findMatching();
  if (remainingSelected.length > 0 && !aliasMatching) {
    for (const selectedIndex of remainingSelected) {
      if (!(candidates.get(selectedIndex) || []).length) mappingErrors.push(`missing_card:${selectedIndex}`);
    }
    if (!mappingErrors.length) mappingErrors.push('mapping_incomplete');
  } else if (aliasMatching && remainingSelected.length > 0) {
    for (const [cardIndex, selectedIndex] of aliasMatching.entries()) matching.set(selectedIndex, cardIndex);
    for (const [selectedIndex, cardIndex] of matching.entries()) {
      mapping[selectedIndex] = {
        sourceFileName: selected[selectedIndex],
        displayName: cards[cardIndex],
        matched: true,
        matchKind: 'renamed',
        cardIndex
      };
    }
    for (const [cardIndex, selectedIndex] of aliasMatching.entries()) {
      const alternative = findMatching({ selectedIndex, cardIndex });
      if (!alternative) continue;
      const changesSourceNameClass = [...aliasMatching.entries()].some(([baselineCardIndex, baselineSelectedIndex]) => {
        const alternativeSelectedIndex = alternative.get(baselineCardIndex);
        return alternativeSelectedIndex !== undefined &&
          normalize(selected[baselineSelectedIndex]) !== normalize(selected[alternativeSelectedIndex]);
      });
      if (changesSourceNameClass) {
        mappingErrors.push('mapping_ambiguous');
        break;
      }
    }
  }

  if (selected.length !== cards.length) mappingErrors.push(selected.length < cards.length ? 'extra_card' : 'missing_card');
  const mappingComplete = selected.length === cards.length && mappingErrors.length === 0 && mapping.every((entry) => entry.matched);
  return {
    mapping,
    mappingComplete,
    mappingErrors: [...new Set(mappingErrors)].slice(0, 50)
  };
}

export function hasSameChatGPTAttachmentFileNameMultiset(expectedFileNames, selectedFileNames) {
  const normalizeFileNames = (fileNames) => (Array.isArray(fileNames) ? fileNames : [])
    .map((fileName) => String(fileName || '').trim().toLocaleLowerCase())
    .sort();
  const expected = normalizeFileNames(expectedFileNames);
  const selected = normalizeFileNames(selectedFileNames);
  return expected.length === selected.length && expected.every((fileName, index) => fileName === selected[index]);
}

function boundedAttachmentName(value) {
  const text = String(value || '').trim().replace(/^.*[\\/]/u, '');
  return text.slice(0, MAX_ATTACHMENT_DIAGNOSTIC_NAME_LENGTH);
}

function boundedAttachmentNameList(values) {
  return (Array.isArray(values) ? values : [])
    .map(boundedAttachmentName)
    .filter(Boolean)
    .slice(0, MAX_ATTACHMENT_DIAGNOSTIC_ITEMS);
}

function boundedAttachmentStates(values) {
  return (Array.isArray(values) ? values : []).slice(0, MAX_ATTACHMENT_DIAGNOSTIC_ITEMS).map((state) => ({
    sourceFileName: boundedAttachmentName(state?.sourceFileName || state?.fileName),
    displayName: boundedAttachmentName(state?.displayName),
    matched: !!(state?.matched ?? state?.found),
    matchKind: state?.matchKind === 'exact' || state?.matchKind === 'renamed' ? state.matchKind : null,
    pending: !!state?.pending,
    failed: !!state?.failed
  }));
}

function boundedAttachmentError(value) {
  return String(value || '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, MAX_ATTACHMENT_DIAGNOSTIC_ERROR_LENGTH);
}

function normalizeUserTurnBaseline(value) {
  const baseline = value && typeof value === 'object' ? value : {};
  const rawDigest = String(baseline.lastTextDigest || '').trim().toLowerCase();
  const lastTextDigest = /^[0-9a-f]{64}$/u.test(rawDigest)
    ? rawDigest
    : typeof baseline.lastText === 'string'
      ? userTurnTextDigest(baseline.lastText)
      : '';
  return {
    count: Math.max(0, Number(baseline.count) || 0),
    lastId: boundedAttachmentError(baseline.lastId),
    lastTextDigest
  };
}

function boundedAttachmentErrorList(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim())
    .filter((item) => /^[a-z][a-z0-9_]*(?::[0-9]+)?$/u.test(item))
    .slice(0, MAX_ATTACHMENT_DIAGNOSTIC_ITEMS);
}

function blockedTitle(kind) {
  if (kind === 'login') return 'Needs sign-in';
  if (kind === 'captcha') return 'Needs CAPTCHA';
  if (kind === 'blocked') return 'Access blocked';
  if (kind === 'ui') return 'Needs page ready';
  return 'Needs attention';
}

class Mutex {
  #p = Promise.resolve();
  async run(fn) {
    const start = this.#p;
    let release;
    this.#p = new Promise((r) => (release = r));
    await start;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ChatGPTController {
  constructor({ page, selectors, onBlocked, onUnblocked, stateDir, tabId = null, sendConfirmationTimeoutMs = MAX_SEND_CONFIRMATION_TIMEOUT_MS, responseClock = null, responseSleep = null }) {
    this.page = page;
    this.selectors = selectors;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.stateDir = stateDir;
    this.tabId = String(tabId || '').trim();
    this.draftOwnership = new DraftOwnershipStore({ stateDir, tabId: this.tabId });
    this.mutex = new Mutex();
    this.blocked = false;
    this.blockedKind = null;
    this.serverId = null;
    this.mouse = { x: 30, y: 30 };
    this.currentRun = null;
    this.providerStopOwner = null;
    this.providerStopGeneration = nextProviderStopGeneration();
    this.providerStopSequence = 0;
    this.sendConfirmationTimeoutMs = Number.isFinite(Number(sendConfirmationTimeoutMs)) && Number(sendConfirmationTimeoutMs) > 0
      ? Math.min(MAX_SEND_CONFIRMATION_TIMEOUT_MS, Math.floor(Number(sendConfirmationTimeoutMs)))
      : MAX_SEND_CONFIRMATION_TIMEOUT_MS;
    this.responseClock = typeof responseClock === 'function' ? responseClock : () => Date.now();
    this.responseSleep = typeof responseSleep === 'function' ? responseSleep : sleep;
  }

  async runExclusive(fn) {
    return await this.mutex.run(fn);
  }

  async navigate(url) {
    await this.page.navigate(url);
  }

  async #eval(js) {
    return await this.page.evaluate(js);
  }

  async #conversationDigest() {
    let url = '';
    try { url = await this.page.getUrl(); } catch {}
    return textDigest(url || '');
  }

  async #readCurrentComposerPrompt() {
    const result = await this.#eval(`(() => {
      const editable = (node) => node && (node.matches('textarea, input') || node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox');
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)})).filter(editable);
      const node = nodes[0] || null;
      return node?.matches('textarea, input') ? String(node.value || '') : String(node?.innerText || node?.textContent || '');
    })()`);
    return typeof result === 'string' ? result : '';
  }

  async #persistDraftLease(run, phase = run?.ownershipPhase || 'prepared') {
    if (!run || !this.draftOwnership.enabled) return;
    const lease = createDraftLease({
      operationId: run.operationId,
      tabId: this.tabId,
      conversationDigest: run.conversationDigest,
      userTurnBaseline: run.userTurnBaseline,
      expectedAttachments: run.expectedAttachmentIdentities,
      promptDigest: run.promptDigest,
      promptLength: run.promptLength,
      ownedPrompt: run.promptTyped === true,
      ownedPromptDigest: run.promptDigest,
      ownedPromptLength: run.promptLength,
      phase,
      sendConfirmed: run.sendConfirmed,
      postSendDiagnostic: run.postSendDiagnostic,
      updatedAt: new Date().toISOString()
    });
    run.ownershipPhase = lease.phase;
    try {
      await this.draftOwnership.write(lease);
      run.ownershipPersisted = true;
    } catch (error) {
      run.ownershipPersistenceError = String(error?.message || error).slice(0, MAX_ATTACHMENT_DIAGNOSTIC_ERROR_LENGTH);
    }
  }

  async #clearDraftLease(run) {
    if (!run || !this.draftOwnership.enabled) return;
    try { await this.draftOwnership.clear(); } catch (error) {
      run.ownershipClearError = String(error?.message || error).slice(0, MAX_ATTACHMENT_DIAGNOSTIC_ERROR_LENGTH);
    }
  }

  async #recoverOwnedDraftIfSafe(conflictError) {
    if (!this.draftOwnership.enabled) return false;
    const lease = await this.draftOwnership.read();
    if (!lease) return false;
    const state = conflictError?.data || {};
    const current = {
      ...state,
      userTurnBaseline: await this.#captureUserTurnBaseline(),
      promptDigest: String(state.promptDigest || ''),
      promptLength: Number(state.promptLength) || 0,
      selectedFiles: Array.isArray(state.selectedFiles) ? state.selectedFiles : [],
      cardDisplayNames: Array.isArray(state.cardDisplayNames) ? state.cardDisplayNames : []
    };
    const conversationDigest = await this.#conversationDigest();
    const safe = canRecoverDraftLease({
      lease,
      current,
      tabId: this.tabId,
      conversationDigest,
      activeOperationId: this.currentRun?.operationId || null
    });
    if (!safe && lease.sendConfirmed === true) {
      const postSend = canSettlePostSendDraft({
        lease,
        current,
        tabId: this.tabId,
        conversationDigest,
        activeOperationId: this.currentRun?.operationId || null,
        allowRuntimeTabRebind: this.draftOwnership.wasFallbackRead
      });
      if (!postSend.safe) return false;
      if (postSend.clean) {
        await this.draftOwnership.clear();
        return true;
      }
      const cleanup = await this.cleanupUnsentDraft({
        prompt: current.promptLength > 0 ? this.currentRun?.prompt || '' : '',
        expectedFileNames: lease.expectedAttachments.map((item) => item.transportName),
        logicalFileNames: lease.expectedAttachments.map((item) => item.logicalName),
        expectedAttachmentIdentities: lease.expectedAttachments,
        userTurnBaseline: lease.userTurnBaseline,
        sentPromptDigest: lease.promptDigest,
        postSend: true
      });
      if (cleanup.status !== 'cleared') return false;
      await this.draftOwnership.clear();
      return true;
    }
    if (!safe) return false;
    const cleanup = await this.cleanupUnsentDraft({
      prompt: await this.#readCurrentComposerPrompt(),
      expectedFileNames: lease.expectedAttachments.map((item) => item.transportName),
      logicalFileNames: lease.expectedAttachments.map((item) => item.logicalName),
      expectedAttachmentIdentities: lease.expectedAttachments,
      userTurnBaseline: current.userTurnBaseline
    });
    if (cleanup.status !== 'cleared') return false;
    await this.draftOwnership.clear();
    return true;
  }

  #newProviderStopToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  #providerStopGeneration(run = null) {
    return Number(run?.providerStopGeneration ?? this.providerStopGeneration);
  }

  #providerStopSequence(run = null) {
    return Number(run?.providerStopSequence ?? run?.providerStopEpoch ?? this.providerStopSequence);
  }

  #setProviderStopFence(run, { generation, sequence }) {
    run.providerStopGeneration = generation;
    run.providerStopSequence = sequence;
    // Keep the old in-memory field populated for diagnostics from older callers;
    // browser arbitration uses generation + sequence exclusively.
    run.providerStopEpoch = sequence;
  }

  #retireProviderStopOwner(run) {
    if (!run) return false;
    run.providerStopRetired = true;
    if (this.providerStopOwner !== run) return false;
    this.providerStopOwner = null;
    return true;
  }

  #providerStopStateReadScript() {
    return `(() => {
      const agentifyStopTokenStateRead = true;
      const state = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const generation = Number(state?.generation ?? 0);
      const sequence = Number(state?.sequence ?? 0);
      const retiredSequence = Number(state?.retiredSequence ?? 0);
      const dispatchState = ['pending', 'dispatching', 'dispatched', 'cancelled'].includes(state?.dispatch?.state)
        ? state.dispatch.state
        : null;
      if (
        !Number.isSafeInteger(generation) || generation < 0 ||
        !Number.isSafeInteger(sequence) || sequence < 0 ||
        !Number.isSafeInteger(retiredSequence) || retiredSequence < 0
      ) return { ok: false, error: 'invalid_provider_stop_state' };
      return { ok: true, generation, sequence, retiredSequence, dispatchState };
    })()`;
  }

  #providerStopStateScript(run, { action = 'activate' } = {}) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    if (action === 'activate') {
      return `(() => {
        const agentifyStopTokenLifecycle = true;
        const agentifyStopTokenActivation = true;
        const generation = ${generation};
        const sequence = ${sequence};
        const token = ${token};
        const current = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
          ? globalThis.__agentifyProviderStopState
          : { generation: 0, sequence: 0, token: null, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: null };
        const currentGeneration = Number(current.generation) || 0;
        const currentSequence = Number(current.sequence) || 0;
        const retiredSequence = Number(current.retiredSequence) || 0;
        const currentDispatch = current.dispatch && typeof current.dispatch === 'object' ? current.dispatch : null;
        const sameFence = currentGeneration === generation && currentSequence === sequence;
        const sameTokenPending = sameFence && current.token === token && currentDispatch?.state === 'pending' && current.stopRequested !== true && retiredSequence < sequence;
        const newerGeneration = generation > currentGeneration;
        const newerSequence = generation === currentGeneration && sequence > currentSequence && retiredSequence < sequence;
        if (!newerGeneration && !newerSequence && !sameTokenPending) return { ok: true, applied: false, generation: currentGeneration, sequence: currentSequence };
        globalThis.__agentifyProviderStopState = {
          generation,
          sequence,
          token,
          stopRequested: false,
          stopClicked: false,
          stopWatcherActive: false,
          retiredSequence: newerGeneration ? 0 : retiredSequence,
          dispatch: { generation, sequence, state: 'pending' }
        };
        return { ok: true, applied: true, generation, sequence, token };
      })()`;
    }
    return `(() => {
      const agentifyStopTokenLifecycle = true;
      const agentifyStopTokenRelease = true;
      const generation = ${generation};
      const sequence = ${sequence};
      const token = ${token};
      const current = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : { generation: 0, sequence: 0, token: null, stopRequested: false, stopClicked: false, stopWatcherActive: false, retiredSequence: 0, dispatch: null };
      const currentGeneration = Number(current.generation) || 0;
      const currentSequence = Number(current.sequence) || 0;
      const exact = currentGeneration === generation && currentSequence === sequence && current.token === token;
      if (exact && current.stopWatcherActive === true) return { ok: true, cleared: false, deferred: true };
      if (exact) {
        const currentDispatch = current.dispatch && typeof current.dispatch === 'object' ? current.dispatch : null;
        const state = ['dispatching', 'dispatched'].includes(currentDispatch?.state) ? currentDispatch.state : 'cancelled';
        globalThis.__agentifyProviderStopState = {
          ...current,
          token: null,
          retiredSequence: Math.max(Number(current.retiredSequence) || 0, sequence),
          dispatch: { generation, sequence, state }
        };
      }
      return { ok: true, cleared: exact };
    })()`;
  }

  #providerStopDispatchCheckScript(run) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    return `(() => {
      const agentifyStopTokenDispatchCheck = true;
      const expectedGeneration = ${generation};
      const expectedSequence = ${sequence};
      const expectedToken = ${token};
      const state = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const currentGeneration = Number(state?.generation);
      const currentSequence = Number(state?.sequence);
      const retiredSequence = Number(state?.retiredSequence);
      const dispatchState = state?.dispatch?.state;
      return {
        ok: true,
        active: Number.isSafeInteger(currentGeneration) && Number.isSafeInteger(currentSequence) && Number.isSafeInteger(retiredSequence) &&
          currentGeneration === expectedGeneration && currentSequence === expectedSequence && state?.token === expectedToken && state?.stopRequested !== true &&
          retiredSequence < expectedSequence && ['pending', 'claimed', 'dispatching', 'dispatched'].includes(dispatchState),
        generation: Number.isSafeInteger(currentGeneration) ? currentGeneration : null,
        sequence: Number.isSafeInteger(currentSequence) ? currentSequence : null,
        retiredSequence: Number.isSafeInteger(retiredSequence) ? retiredSequence : null,
        dispatchState: ['pending', 'claimed', 'dispatching', 'dispatched', 'cancelled'].includes(dispatchState) ? dispatchState : 'unknown'
      };
    })()`;
  }

  #scheduleProviderStopStateScriptNow(run, { action = 'release' } = {}) {
    const evaluation = this.#boundedProviderStopStateEvaluation(this.#providerStopStateScript(run, { action }), {
      signal: null,
      timeoutMs: PROVIDER_STOP_TOKEN_RELEASE_TIMEOUT_MS
    });
    evaluation.catch(() => {});
    return evaluation;
  }

  #scheduleProviderStopStateScript(run, { action = 'release' } = {}) {
    if (action !== 'release' || !run) {
      return this.#scheduleProviderStopStateScriptNow(run, { action });
    }
    run.providerStopReleaseRequested = true;
    if (run.providerStopReleaseScheduled) return run.providerStopReleaseAttempt;
    const stopAttempt = run.providerStopStopCleanupAttempt || run.providerStopStopAttempt;
    if (stopAttempt) {
      if (run.providerStopReleaseWait === stopAttempt) return run.providerStopReleaseWait;
      run.providerStopReleaseWait = stopAttempt;
      Promise.resolve(stopAttempt).then(
        () => {
          if (run.providerStopReleaseWait !== stopAttempt) return;
          run.providerStopReleaseWait = null;
          this.#scheduleProviderStopStateScript(run, { action });
        },
        () => {
          if (run.providerStopReleaseWait !== stopAttempt) return;
          run.providerStopReleaseWait = null;
          this.#scheduleProviderStopStateScript(run, { action });
        }
      ).catch(() => {});
      return stopAttempt;
    }
    run.providerStopReleaseScheduled = true;
    const release = this.#releaseProviderStopStateWithRetry(run, { action });
    run.providerStopReleaseAttempt = release;
    release.catch(() => {});
    return release;
  }

  async #releaseProviderStopStateWithRetry(run, { action = 'release', attempt = 0 } = {}) {
    const outcome = await this.#scheduleProviderStopStateScriptNow(run, { action });
    const retryable = outcome.status === 'timeout' || (outcome.status === 'completed' && outcome.value?.deferred === true);
    if (!retryable || attempt >= PROVIDER_STOP_RELEASE_RETRY_MAX) return outcome;
    await sleep(PROVIDER_STOP_RELEASE_RETRY_POLL_MS);
    return await this.#releaseProviderStopStateWithRetry(run, { action, attempt: attempt + 1 });
  }

  #scheduleProviderStopStopCancellation(run) {
    if (!run || run.providerStopStopCleanupAttempt) return run?.providerStopStopCleanupAttempt || null;
    const cleanup = this.#boundedProviderStopStateEvaluation(this.#providerStopStopCancellationScript(run), {
      signal: null,
      timeoutMs: PROVIDER_STOP_TOKEN_RELEASE_TIMEOUT_MS
    });
    run.providerStopStopCleanupAttempt = cleanup;
    cleanup.then(
      () => { if (run.providerStopStopCleanupAttempt === cleanup) run.providerStopStopCleanupAttempt = null; },
      () => { if (run.providerStopStopCleanupAttempt === cleanup) run.providerStopStopCleanupAttempt = null; }
    ).catch(() => {});
    return cleanup;
  }

  async #boundedProviderStopStateEvaluation(js, { signal = null, timeoutMs = PROVIDER_STOP_TOKEN_ACTIVATION_TIMEOUT_MS } = {}) {
    if (signal?.aborted) return { status: 'aborted' };
    let timer = null;
    let abortHandler = null;
    let settled = false;
    const rawEvaluation = Promise.resolve().then(() => this.#eval(js));
    rawEvaluation.catch(() => {});
    const outcome = await new Promise((resolve) => {
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener('abort', abortHandler);
        resolve(result);
      };
      timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
      abortHandler = () => finish({ status: 'aborted' });
      signal?.addEventListener('abort', abortHandler, { once: true });
      rawEvaluation.then(
        (value) => finish({ status: 'completed', value }),
        (error) => finish({ status: 'failed', error })
      );
      if (signal?.aborted) abortHandler();
    });
    return outcome;
  }

  #providerStopDispatchStateReadScript(run) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    return `(() => {
      const agentifyStopTokenDispatchRead = true;
      const state = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const currentGeneration = Number(state?.generation);
      const currentSequence = Number(state?.sequence);
      const retiredSequence = Number(state?.retiredSequence);
      const dispatchState = state?.dispatch?.state;
      const exact = currentGeneration === ${generation} && currentSequence === ${sequence} && state?.token === ${token} && retiredSequence < ${sequence};
      return {
        ok: true,
        state: exact && ['pending', 'claimed', 'dispatching', 'dispatched', 'cancelled'].includes(dispatchState) ? dispatchState : 'mismatch',
        generation: Number.isSafeInteger(currentGeneration) ? currentGeneration : null,
        sequence: Number.isSafeInteger(currentSequence) ? currentSequence : null,
        retiredSequence: Number.isSafeInteger(retiredSequence) ? retiredSequence : null
      };
    })()`;
  }

  #providerStopDispatchClaimScript(run, { allowRetry = false } = {}) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    return `(() => {
      const agentifyStopTokenDispatchClaim = true;
      const expectedGeneration = ${generation};
      const expectedSequence = ${sequence};
      const expectedToken = ${token};
      const state = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const dispatchState = state?.dispatch?.state;
      const exact = Number(state?.generation) === expectedGeneration && Number(state?.sequence) === expectedSequence &&
        state?.token === expectedToken && state?.stopRequested !== true && Number(state?.retiredSequence) < expectedSequence;
      const canClaim = exact && (dispatchState === 'pending' || (${allowRetry ? 'true' : 'false'} && ['claimed', 'dispatching', 'dispatched'].includes(dispatchState)));
      if (!canClaim) return { ok: true, claimed: false, state: exact ? dispatchState || 'unknown' : 'mismatch' };
      globalThis.__agentifyProviderStopState = {
        ...state,
        dispatch: { generation: expectedGeneration, sequence: expectedSequence, state: 'claimed' }
      };
      return { ok: true, claimed: true, state: 'claimed' };
    })()`;
  }

  #providerStopDispatchStartScript(run) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    return `(() => {
      const agentifyStopTokenDispatchStart = true;
      const state = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const currentGeneration = Number(state?.generation);
      const currentSequence = Number(state?.sequence);
      const exact = currentGeneration === ${generation} && currentSequence === ${sequence} &&
        state?.token === ${token} && Number(state?.retiredSequence) < ${sequence};
      if (exact && state?.stopRequested !== true && state?.dispatch?.state === 'claimed') {
        globalThis.__agentifyProviderStopState = {
          ...state,
          dispatch: { generation: ${generation}, sequence: ${sequence}, state: 'dispatching' }
        };
        return { ok: true, started: true, state: 'dispatching', generation: ${generation}, sequence: ${sequence} };
      }
      return {
        ok: true,
        started: false,
        state: exact ? state?.dispatch?.state || 'unknown' : 'mismatch',
        generation: Number.isSafeInteger(currentGeneration) ? currentGeneration : null,
        sequence: Number.isSafeInteger(currentSequence) ? currentSequence : null
      };
    })()`;
  }

  #providerStopDispatchRollbackScript(run) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    return `(() => {
      const agentifyStopTokenDispatchRollback = true;
      const state = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const exact = Number(state?.generation) === ${generation} && Number(state?.sequence) === ${sequence} &&
        state?.token === ${token} && Number(state?.retiredSequence) < ${sequence};
      if (!exact) return { ok: true, rolledBack: false, state: 'mismatch' };
      if (state?.dispatch?.state !== 'claimed') return { ok: true, rolledBack: false, state: state?.dispatch?.state || 'unknown' };
      globalThis.__agentifyProviderStopState = {
        ...state,
        stopRequested: true,
        stopClicked: false,
        stopWatcherActive: false,
        retiredSequence: Math.max(Number(state.retiredSequence) || 0, ${sequence}),
        dispatch: { generation: ${generation}, sequence: ${sequence}, state: 'cancelled' }
      };
      return { ok: true, rolledBack: true, state: 'cancelled' };
    })()`;
  }

  #providerStopDispatchCompleteScript(run) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    return `(() => {
      const agentifyStopTokenDispatchComplete = true;
      const state = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const exact = Number(state?.generation) === ${generation} && Number(state?.sequence) === ${sequence} &&
        state?.token === ${token} && Number(state?.retiredSequence) < ${sequence};
      if (exact && state?.stopRequested !== true && state?.dispatch?.state === 'dispatching') {
        globalThis.__agentifyProviderStopState = {
          ...state,
          dispatch: { generation: ${generation}, sequence: ${sequence}, state: 'dispatched' }
        };
        return { ok: true, state: 'dispatched' };
      }
      return { ok: true, state: exact ? state?.dispatch?.state || 'unknown' : 'mismatch' };
    })()`;
  }

  #providerStopStopScript(run) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    return `(async () => {
      const agentifyStopTokenStop = true;
      const expectedGeneration = ${generation};
      const expectedSequence = ${sequence};
      const expectedToken = ${token};
      const readState = () => globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const isExact = (state) => Number(state?.generation) === expectedGeneration && Number(state?.sequence) === expectedSequence &&
        state?.token === expectedToken && Number(state?.retiredSequence) < expectedSequence;
      const state = readState();
      if (!isExact(state)) return { ok: true, state: 'mismatch', clicked: false };
      const dispatchState = state?.dispatch?.state;
      if (state.stopClicked === true) return { ok: true, state: dispatchState || 'unknown', clicked: false, reason: 'provider_stop_already_clicked' };
      if (['pending', 'claimed'].includes(dispatchState)) {
        globalThis.__agentifyProviderStopState = {
          ...state,
          stopRequested: true,
          stopClicked: false,
          stopWatcherActive: false,
          retiredSequence: Math.max(Number(state.retiredSequence) || 0, expectedSequence),
          dispatch: { generation: expectedGeneration, sequence: expectedSequence, state: 'cancelled' }
        };
        return { ok: true, state: 'cancelled', cancelled: true, clicked: false };
      }
      if (!['dispatching', 'dispatched'].includes(dispatchState)) return { ok: true, state: dispatchState || 'unknown', clicked: false };
      if (state.stopWatcherActive === true) return { ok: true, state: dispatchState, clicked: false, reason: 'provider_stop_already_requested', retrying: true };
      globalThis.__agentifyProviderStopState = { ...state, stopRequested: true, stopClicked: false, stopWatcherActive: true };
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const finish = ({ clicked, reason }) => {
        const current = readState();
        if (!isExact(current)) return { ok: true, state: 'mismatch', clicked: false, reason: 'provider_stop_token_mismatch' };
        globalThis.__agentifyProviderStopState = {
          ...current,
          stopRequested: true,
          stopClicked: clicked === true,
          stopWatcherActive: false
        };
        return { ok: true, state: dispatchState, clicked: clicked === true, reason };
      };
      const tryClick = () => {
        const current = readState();
        if (!isExact(current)) return { ok: true, state: 'mismatch', clicked: false, reason: 'provider_stop_token_mismatch' };
        if (current.stopRequested !== true || current.stopWatcherActive !== true) {
          return { ok: true, state: dispatchState, clicked: false, reason: 'provider_stop_cancelled' };
        }
        if (current.stopClicked === true) return { ok: true, state: dispatchState, clicked: false, reason: 'provider_stop_already_clicked' };
        const stop = Array.from(document.querySelectorAll(${stopSel})).find(visible);
        if (!stop) return null;
        try {
          stop.click();
          return finish({ clicked: true, reason: 'provider_stop_clicked' });
        } catch {
          return finish({ clicked: false, reason: 'provider_stop_click_failed' });
        }
      };
      let result = tryClick();
      if (result) return result;
      const deadline = Date.now() + ${PROVIDER_STOP_RETRY_TIMEOUT_MS};
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, ${PROVIDER_STOP_RETRY_POLL_MS}));
        result = tryClick();
        if (result) return result;
      }
      return finish({ clicked: false, reason: 'provider_stop_not_found' });
    })()`;
  }

  #providerStopStopCancellationScript(run) {
    const generation = this.#providerStopGeneration(run);
    const sequence = this.#providerStopSequence(run);
    const token = JSON.stringify(run.providerStopToken);
    return `(() => {
      const agentifyStopTokenStopCancellation = true;
      const state = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const exact = Number(state?.generation) === ${generation} && Number(state?.sequence) === ${sequence} &&
        state?.token === ${token} && Number(state?.retiredSequence) < ${sequence};
      if (!exact) return { ok: true, state: 'mismatch', cancelled: false, terminal: true };
      if (state.stopWatcherActive !== true) return { ok: true, state: state?.dispatch?.state || 'unknown', cancelled: false, terminal: true };
      globalThis.__agentifyProviderStopState = {
        ...state,
        stopRequested: true,
        stopClicked: false,
        stopWatcherActive: false,
        retiredSequence: Math.max(Number(state.retiredSequence) || 0, ${sequence})
      };
      return { ok: true, state: state?.dispatch?.state || 'unknown', cancelled: true, terminal: true };
    })()`;
  }

  #providerStopDispatchError(phase, reason = 'provider_stop_token_not_active') {
    const error = new Error(reason);
    error.data = { phase };
    return error;
  }

  async #reconcileProviderStopDispatch(run) {
    const outcome = await this.#boundedProviderStopStateEvaluation(this.#providerStopDispatchStateReadScript(run), { signal: run.signal });
    const state = outcome.status === 'completed' && outcome.value?.ok === true ? outcome.value.state : 'unknown';
    run.dispatchState = state;
    if (state === 'dispatching' || state === 'dispatched') {
      run.messageDispatchStarted = true;
      return state;
    }
    if (!['pending', 'claimed', 'cancelled'].includes(state)) run.dispatchStateUnknown = true;
    return state;
  }

  async #claimProviderStopDispatch(run, { allowRetry = false } = {}) {
    const outcome = await this.#boundedProviderStopStateEvaluation(this.#providerStopDispatchClaimScript(run, { allowRetry }), { signal: run.signal });
    if (outcome.status === 'aborted') throw queryAbortedError(run.reason || 'user_stop');
    if (outcome.status === 'completed' && outcome.value?.ok === true && outcome.value.claimed === true) {
      const providerStopAlreadyCancelled = run.requested && run.dispatchState === 'cancelled';
      run.dispatchState = 'claimed';
      if (run.requested) {
        if (providerStopAlreadyCancelled) run.dispatchState = 'cancelled';
        else await this.#rollbackProviderStopDispatch(run);
        throw queryAbortedError(run.reason || 'user_stop');
      }
      return outcome.value;
    }
    const state = outcome.status === 'completed' && outcome.value?.ok === true ? outcome.value.state : await this.#reconcileProviderStopDispatch(run);
    run.dispatchState = state;
    if (state === 'pending' || state === 'cancelled' || state === 'mismatch') throw this.#providerStopDispatchError('dispatch');
    if (state !== 'dispatching' && state !== 'dispatched') throw this.#providerStopDispatchError('dispatch', 'provider_stop_dispatch_unknown');
    run.messageDispatchStarted = true;
    return { ok: true, claimed: false, state };
  }

  async #rollbackProviderStopDispatch(run) {
    if (!run || run.dispatchState !== 'claimed') return { ok: true, rolledBack: false, state: run?.dispatchState || 'unknown' };
    const outcome = await this.#boundedProviderStopStateEvaluation(this.#providerStopDispatchRollbackScript(run), { signal: null });
    if (outcome.status === 'completed' && outcome.value?.ok === true) {
      run.dispatchState = outcome.value.state;
      if (outcome.value.rolledBack === true) run.dispatchStateUnknown = false;
      else run.dispatchStateUnknown = true;
      return outcome.value;
    }
    await this.#reconcileProviderStopDispatch(run);
    return { ok: false, rolledBack: false, state: run.dispatchState || 'unknown' };
  }

  async #beginProviderStopDispatch(run) {
    if (!run || this.currentRun !== run || run.providerStopRetired || run.dispatchState !== 'claimed') {
      if (run?.requested) throw queryAbortedError(run.reason || 'user_stop');
      throw this.#providerStopDispatchError('dispatch');
    }
    const outcome = await this.#boundedProviderStopStateEvaluation(this.#providerStopDispatchStartScript(run), { signal: run.signal });
    const result = outcome.status === 'completed' && outcome.value?.ok === true ? outcome.value : null;
    const expectedGeneration = this.#providerStopGeneration(run);
    const expectedSequence = this.#providerStopSequence(run);
    const exactFence = result?.generation === expectedGeneration && result.sequence === expectedSequence;
    const exactStarted = result?.started === true && result.state === 'dispatching' && exactFence;
    if (this.currentRun !== run) {
      run.messageDispatchStarted = false;
      run.dispatchStateUnknown = true;
      throw this.#providerStopDispatchError('dispatch', 'provider_stop_dispatch_unknown');
    }
    if (exactStarted && !run.requested && !run.providerStopRetired) {
      run.messageDispatchStarted = false;
      run.dispatchState = 'dispatching';
      run.providerStopDispatchLease = true;
      return result;
    }
    if (exactStarted && run.requested) {
      run.messageDispatchStarted = false;
      run.dispatchState = 'cancelled';
      throw queryAbortedError(run.reason || 'user_stop');
    }
    const state = result && exactFence && ['pending', 'claimed', 'cancelled', 'dispatching', 'dispatched'].includes(result.state)
      ? result.state
      : await this.#reconcileProviderStopDispatch(run);
    run.dispatchState = state;
    if (['pending', 'claimed', 'cancelled'].includes(state)) {
      run.messageDispatchStarted = false;
      throw run.requested || outcome.status === 'aborted'
        ? queryAbortedError(run.reason || 'user_stop')
        : this.#providerStopDispatchError('dispatch');
    }
    run.messageDispatchStarted = false;
    run.dispatchStateUnknown = true;
    throw this.#providerStopDispatchError('dispatch', 'provider_stop_dispatch_unknown');
  }

  #commitProviderStopDispatchBeforeInput(run) {
    if (!run || this.currentRun !== run || run.providerStopRetired || !run.providerStopDispatchLease || run.dispatchState !== 'dispatching') {
      if (run?.requested) {
        run.messageDispatchStarted = false;
        run.dispatchState = 'cancelled';
        throw queryAbortedError(run.reason || 'user_stop');
      }
      if (run) {
        run.messageDispatchStarted = false;
        run.dispatchStateUnknown = true;
      }
      throw this.#providerStopDispatchError('dispatch', 'provider_stop_dispatch_unknown');
    }
    if (run.requested) {
      run.messageDispatchStarted = false;
      run.dispatchState = 'cancelled';
      throw queryAbortedError(run.reason || 'user_stop');
    }
    run.messageDispatchStarted = true;
    run.providerStopInputStarted = true;
  }

  async #completeProviderStopDispatch(run) {
    const outcome = await this.#boundedProviderStopStateEvaluation(this.#providerStopDispatchCompleteScript(run), { signal: run.signal });
    if (outcome.status === 'completed' && outcome.value?.ok === true) {
      run.dispatchState = outcome.value.state;
      return outcome.value;
    }
    await this.#reconcileProviderStopDispatch(run);
    return { ok: false, state: run.dispatchState || 'unknown' };
  }

  async #arbitrateProviderStop(run) {
    if (run.providerStopStopAttempt) return await run.providerStopStopAttempt;
    const attempt = (async () => {
      const outcome = await this.#boundedProviderStopStateEvaluation(this.#providerStopStopScript(run), { signal: null });
      if (outcome.status !== 'completed' || outcome.value?.ok !== true) {
        if (outcome.status === 'timeout' || outcome.status === 'failed') this.#scheduleProviderStopStopCancellation(run);
        run.dispatchStateUnknown = true;
        return { ok: false, state: 'unknown', clicked: false, reason: 'provider_stop_state_unknown' };
      }
      run.dispatchState = outcome.value.state;
      if (outcome.value.state === 'dispatching' || outcome.value.state === 'dispatched') run.messageDispatchStarted = true;
      return outcome.value;
    })();
    run.providerStopStopAttempt = attempt;
    attempt.then(
      () => { if (run.providerStopStopAttempt === attempt) run.providerStopStopAttempt = null; },
      () => { if (run.providerStopStopAttempt === attempt) run.providerStopStopAttempt = null; }
    ).catch(() => {});
    return await attempt;
  }

  async #activateProviderStopToken(run, signal = null) {
    this.providerStopOwner = run;
    const stateOutcome = await this.#boundedProviderStopStateEvaluation(this.#providerStopStateReadScript(), { signal });
    if (stateOutcome.status === 'aborted') {
      this.#retireProviderStopOwner(run);
      this.#scheduleProviderStopStateScript(run, { action: 'release' });
      throw queryAbortedError(run.reason || 'user_stop');
    }
    const browserGeneration = stateOutcome.value?.generation;
    const browserSequence = stateOutcome.value?.sequence;
    if (
      stateOutcome.status !== 'completed' ||
      stateOutcome.value?.ok !== true ||
      !Number.isSafeInteger(browserGeneration) ||
      browserGeneration < 0 ||
      !Number.isSafeInteger(browserSequence) ||
      browserSequence < 0
    ) {
      this.#retireProviderStopOwner(run);
      this.#scheduleProviderStopStateScript(run, { action: 'release' });
      const error = new Error('provider_stop_token_state_unavailable');
      error.data = {
        phase: 'read',
        status: stateOutcome.status,
        timeoutMs: stateOutcome.status === 'timeout' ? PROVIDER_STOP_TOKEN_ACTIVATION_TIMEOUT_MS : undefined
      };
      throw error;
    }
    if (
      !Number.isSafeInteger(this.providerStopGeneration) ||
      !Number.isSafeInteger(this.providerStopSequence) ||
      this.providerStopGeneration >= Number.MAX_SAFE_INTEGER ||
      browserGeneration >= Number.MAX_SAFE_INTEGER ||
      browserSequence >= Number.MAX_SAFE_INTEGER
    ) {
      this.#retireProviderStopOwner(run);
      this.#scheduleProviderStopStateScript(run, { action: 'release' });
      throw new Error('provider_stop_generation_exhausted');
    }
    const sameControllerGeneration = this.providerStopSequence > 0 && this.providerStopGeneration === browserGeneration;
    const generation = sameControllerGeneration
      ? this.providerStopGeneration
      : this.providerStopGeneration > browserGeneration ? this.providerStopGeneration : browserGeneration + 1;
    const sequence = sameControllerGeneration
      ? Math.max(this.providerStopSequence, browserSequence) + 1
      : Math.max(0, this.providerStopSequence) + 1;
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(sequence) || generation > Number.MAX_SAFE_INTEGER || sequence > Number.MAX_SAFE_INTEGER) {
      this.#retireProviderStopOwner(run);
      this.#scheduleProviderStopStateScript(run, { action: 'release' });
      throw new Error('provider_stop_generation_exhausted');
    }
    this.providerStopGeneration = generation;
    this.providerStopSequence = sequence;
    this.#setProviderStopFence(run, { generation, sequence });
    const outcome = await this.#boundedProviderStopStateEvaluation(this.#providerStopStateScript(run, { action: 'activate' }), { signal });
    const activation = outcome.value;
    if (
      outcome.status === 'completed' &&
      activation?.ok === true &&
      activation.applied === true &&
      activation.generation === run.providerStopGeneration &&
      activation.sequence === run.providerStopSequence &&
      activation.token === run.providerStopToken
    ) return activation;
    this.#retireProviderStopOwner(run);
    this.#scheduleProviderStopStateScript(run, { action: 'release' });
    if (outcome.status === 'aborted') throw queryAbortedError(run.reason || 'user_stop');
    if (outcome.status === 'timeout') {
      const error = new Error('provider_stop_token_activation_timeout');
      error.data = { timeoutMs: PROVIDER_STOP_TOKEN_ACTIVATION_TIMEOUT_MS };
      throw error;
    }
    if (outcome.status === 'failed') {
      const error = new Error('provider_stop_token_state_unavailable');
      error.data = { phase: 'activation', status: 'failed' };
      throw error;
    }
    const error = new Error('provider_stop_token_not_active');
    error.data = {
      phase: 'activation',
      applied: activation?.applied === true
    };
    throw error;
  }

  async #verifyProviderStopTokenBeforeDispatch() {
    const run = this.currentRun;
    const expectedGeneration = this.#providerStopGeneration(run);
    const expectedSequence = this.#providerStopSequence(run);
    const outcome = run
      ? await this.#boundedProviderStopStateEvaluation(this.#providerStopDispatchCheckScript(run), { signal: run.signal })
      : { status: 'failed', error: new Error('missing_provider_stop_run') };
    const result = outcome.value;
    if (
      outcome.status === 'completed' &&
      result?.ok === true &&
      result.active === true &&
      result.generation === expectedGeneration &&
      result.sequence === expectedSequence &&
      Number.isSafeInteger(result.retiredSequence) &&
      result.retiredSequence < expectedSequence &&
      ['pending', 'claimed', 'dispatching', 'dispatched'].includes(result.dispatchState)
    ) return result;
    const error = new Error('provider_stop_token_not_active');
    error.data = {
      phase: 'dispatch',
      status: outcome.status,
      dispatchState: ['pending', 'claimed', 'dispatching', 'dispatched', 'cancelled'].includes(result?.dispatchState) ? result.dispatchState : 'unknown'
    };
    throw error;
  }

  #releaseProviderStopToken(run) {
    if (!this.#retireProviderStopOwner(run)) return false;
    this.#scheduleProviderStopStateScript(run, { action: 'release' });
    return true;
  }

  async #emitProgress(patch) {
    if (!this.currentRun?.onProgress || !patch || typeof patch !== 'object') return;
    try {
      await this.currentRun.onProgress({ ...patch });
    } catch {}
  }

  async getUrl() {
    return await this.page.getUrl();
  }

  async getNativeInputDiagnostics() {
    if (typeof this.page?.getNativeInputDiagnostics !== 'function') {
      return {
        backend: null,
        pageClosed: null,
        browserWindowState: null,
        boundsKnown: false,
        adapterMinimized: null,
        documentVisibilityState: null,
        documentHidden: null,
        documentHasFocus: null,
        windowVisible: null,
        windowFocused: null,
        windowMinimized: null,
        windowDestroyed: null,
        webContentsDestroyed: null
      };
    }
    return await this.page.getNativeInputDiagnostics();
  }

  async #waitForStableConversationLayout({ readWindow, initialUrl, timeoutMs = CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS, pollMs = CONVERSATION_LAYOUT_SETTLE_POLL_MS, requiredStableSamples = CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES }) {
    const deadline = Date.now() + Math.min(CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS, Math.max(1, Number(timeoutMs) || CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS));
    const interval = Math.min(CONVERSATION_LAYOUT_SETTLE_POLL_MS, Math.max(1, Number(pollMs) || CONVERSATION_LAYOUT_SETTLE_POLL_MS));
    const required = Math.min(5, Math.max(1, Math.trunc(Number(requiredStableSamples) || CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES)));
    let first = null;
    let final = null;
    let previous = null;
    let samples = 0;
    let stableSamples = 0;
    while (Date.now() <= deadline) {
      let state;
      try {
        state = await readWindow();
      } catch {
        return { ok: false, state: final, first, final, samples, stableSamples, reason: 'conversation-layout-timeout' };
      }
      samples += 1;
      final = state;
      if (!first) first = state;
      if (initialUrl && String(state?.url || '') !== initialUrl) return { ok: false, state, first, final, samples, stableSamples, reason: 'conversation-changed' };
      if (state?.limitExceeded) {
        return {
          ok: false,
          state,
          first,
          final,
          samples,
          stableSamples,
          reason: state.limitKind === 'per-turn' ? 'conversation-turn-too-large' : 'conversation-too-large'
        };
      }
      if (state?.scroller?.candidateCount !== 1) {
        return { ok: false, state, first, final, samples, stableSamples, reason: state?.scroller?.candidateCount > 1 ? 'scroll-container-ambiguous' : 'scroll-container-not-found' };
      }
      const summary = conversationLayoutSummary(state);
      if (!conversationLayoutSummaryReady(summary)) stableSamples = 0;
      else if (conversationLayoutSummaryEqual(summary, previous)) stableSamples += 1;
      else stableSamples = 1;
      previous = summary;
      if (stableSamples >= required) return { ok: true, state, first, final, samples, stableSamples, reason: 'conversation-layout-stable' };
      if (Date.now() + interval > deadline) break;
      await sleep(interval);
    }
    return { ok: false, state: final, first, final, samples, stableSamples, reason: 'conversation-layout-timeout' };
  }

  async probeScrollVisibility() {
    return await this.runExclusive(async () => {
      const limits = {
        maxTurns: 50,
        maxCharsPerTurn: 100_000,
        maxTotalChars: 1_000_000
      };
      const result = {
        backend: null,
        preconditionPassed: false,
        before: null,
        normalized: null,
        normalizationPhysicalScrollChanged: false,
        normalizationConversationWindowChanged: false,
        gestureAttemptLimit: SCROLL_VISIBILITY_PROBE_MAX_GESTURES,
        gestureAttempts: 0,
        steps: [],
        firstWindowChangeAttempt: null,
        gestureAttempted: false,
        gestureSourceType: null,
        gestureDirection: null,
        gestureDistance: null,
        gestureSpeed: null,
        gestureCommandSucceeded: false,
        afterGesture: null,
        physicalScrollChanged: false,
        conversationWindowChanged: false,
        restoreAttempts: 0,
        restoreVerified: false,
        restored: null,
        urlStable: true,
        reason: null
      };
      let normalizationAttempted = false;
      let initialUrl = '';
      let beforeWindow = null;
      let currentWindow = null;

      const readWindow = async () => await this.#eval(buildConversationWindowReadScript(limits));
      const readUrl = async () => String(await this.page.getUrl()).trim();
      const stableAgainstInitialUrl = async (stateUrl = null) => {
        const currentUrl = stateUrl == null ? await readUrl() : String(stateUrl || '').trim();
        if (!initialUrl || currentUrl !== initialUrl) {
          result.urlStable = false;
          return false;
        }
        return true;
      };
      const readNative = async () => await this.getNativeInputDiagnostics();

      try {
        initialUrl = await readUrl();
        beforeWindow = await readWindow();
        const beforeNative = await readNative();
        result.backend = beforeNative?.backend === 'chrome-cdp' ? 'chrome-cdp' : null;
        result.before = {
          browserWindowState: beforeNative?.browserWindowState === 'minimized' ? 'minimized' : null,
          adapterMinimized: beforeNative?.adapterMinimized === true,
          documentVisibilityState: ['visible', 'hidden'].includes(beforeNative?.documentVisibilityState) ? beforeNative.documentVisibilityState : null,
          documentHidden: typeof beforeNative?.documentHidden === 'boolean' ? beforeNative.documentHidden : null,
          documentHasFocus: typeof beforeNative?.documentHasFocus === 'boolean' ? beforeNative.documentHasFocus : null,
          ...probeWindowSummary(beforeWindow)
        };
        const initialStateUrl = String(beforeWindow?.url || '').trim();
        const hasConversationUrl = await stableAgainstInitialUrl(initialStateUrl);
        const hasTarget = typeof this.page?.temporarilyUnminimizeForProbe === 'function'
          && typeof this.page?.restoreMinimizedForProbe === 'function';
        result.preconditionPassed = result.backend === 'chrome-cdp'
          && beforeNative?.pageClosed === false
          && beforeNative?.browserWindowState === 'minimized'
          && beforeNative?.adapterMinimized === true
          && hasConversationUrl
          && hasTarget
          && !!beforeWindow?.scroller
          && beforeWindow?.scroller?.candidateCount === 1;
        if (!result.preconditionPassed) {
          result.reason = 'probe-precondition-failed';
          return result;
        }

        normalizationAttempted = true;
        await this.page.temporarilyUnminimizeForProbe();
        const normalizeDeadline = Date.now() + SCROLL_VISIBILITY_PROBE_NORMALIZE_TIMEOUT_MS;
        let normalizedNative = null;
        let normalizedWindow = null;
        while (Date.now() <= normalizeDeadline) {
          normalizedNative = await readNative();
          normalizedWindow = await readWindow();
          if (!(await stableAgainstInitialUrl(normalizedWindow?.url))) break;
          result.normalized = {
            browserWindowState: ['normal', 'minimized', 'maximized', 'fullscreen'].includes(normalizedNative?.browserWindowState)
              ? normalizedNative.browserWindowState
              : null,
            adapterMinimized: normalizedNative?.adapterMinimized === true,
            documentVisibilityState: ['visible', 'hidden'].includes(normalizedNative?.documentVisibilityState) ? normalizedNative.documentVisibilityState : null,
            documentHidden: typeof normalizedNative?.documentHidden === 'boolean' ? normalizedNative.documentHidden : null,
            documentHasFocus: typeof normalizedNative?.documentHasFocus === 'boolean' ? normalizedNative.documentHasFocus : null,
            ...probeWindowSummary(normalizedWindow)
          };
          if (normalizedNative?.browserWindowState === 'normal' && normalizedNative?.documentVisibilityState === 'visible' && normalizedNative?.documentHidden === false) break;
          if (Date.now() + SCROLL_VISIBILITY_PROBE_POLL_MS > normalizeDeadline) break;
          await sleep(SCROLL_VISIBILITY_PROBE_POLL_MS);
        }

        const readyForGesture = result.urlStable
          && normalizedNative?.browserWindowState === 'normal'
          && normalizedNative?.documentVisibilityState === 'visible'
          && normalizedNative?.documentHidden === false;
        if (!readyForGesture) {
          if (!result.urlStable) result.reason = 'probe-conversation-changed';
          else if (normalizedNative?.browserWindowState !== 'normal') result.reason = 'probe-normalized-but-minimized';
          else result.reason = 'probe-normalized-but-hidden';
          return result;
        }

        currentWindow = normalizedWindow;
        result.normalizationPhysicalScrollChanged = result.before?.scrollTop !== result.normalized?.scrollTop;
        result.normalizationConversationWindowChanged = result.before?.windowSignature !== result.normalized?.windowSignature;
        result.gestureSourceType = 'touch';
        result.gestureDirection = 'older/up';
        result.gestureSpeed = 1_000;

        for (let attempt = 1; attempt <= SCROLL_VISIBILITY_PROBE_MAX_GESTURES; attempt += 1) {
          const gestureNative = await readNative();
          const gestureWindow = await readWindow();
          if (!(await stableAgainstInitialUrl(gestureWindow?.url))) {
            result.reason = 'probe-conversation-changed';
            break;
          }
          if (gestureNative?.pageClosed !== false
            || gestureNative?.browserWindowState !== 'normal'
            || gestureNative?.documentVisibilityState !== 'visible'
            || gestureNative?.documentHidden !== false
            || !gestureWindow?.scroller
            || gestureWindow.scroller.candidateCount !== 1) {
            result.reason = 'probe-precondition-failed';
            break;
          }

          currentWindow = gestureWindow;
          const point = currentWindow?.scroller?.point;
          const visibleHeight = Number(currentWindow?.scroller?.clientHeight);
          const gestureDistance = Math.max(120, Math.min(600, Number.isFinite(visibleHeight) && visibleHeight > 0 ? Math.floor(visibleHeight * 0.7) : 480));
          const beforeStep = probeWindowSummary(currentWindow);
          const step = {
            attempt,
            gestureDistance,
            gestureSpeed: result.gestureSpeed,
            beforeRange: beforeStep.range,
            afterRange: null,
            beforeScrollTop: beforeStep.scrollTop,
            afterScrollTop: null,
            physicalScrollChanged: false,
            conversationWindowChanged: false,
            commandSucceeded: false
          };
          result.steps.push(step);
          result.gestureAttempts = attempt;
          result.gestureAttempted = true;
          result.gestureDistance = gestureDistance;

          if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
            result.reason = 'probe-gesture-failed';
            break;
          }

          try {
            await this.page.scrollGesture({
              x: Number(point.x),
              y: Number(point.y),
              xDistance: 0,
              yDistance: gestureDistance,
              speed: result.gestureSpeed,
              preventFling: true,
              gestureSourceType: result.gestureSourceType
            });
            step.commandSucceeded = true;
            result.gestureCommandSucceeded = true;
          } catch (error) {
            result.gestureCommandSucceeded = false;
            result.reason = 'probe-gesture-failed';
            break;
          }

          await sleep(CONVERSATION_HISTORY_SCROLL_WAIT_MS);
          let afterWindow;
          try {
            afterWindow = await readWindow();
          } catch (error) {
            result.reason = 'probe-gesture-failed';
            break;
          }
          if (!(await stableAgainstInitialUrl(afterWindow?.url))) {
            result.reason = 'probe-conversation-changed';
            break;
          }

          const afterStep = probeWindowSummary(afterWindow);
          step.afterRange = afterStep.range;
          step.afterScrollTop = afterStep.scrollTop;
          step.physicalScrollChanged = beforeStep.scrollTop !== afterStep.scrollTop;
          step.conversationWindowChanged = beforeStep.windowSignature !== afterStep.windowSignature;
          result.afterGesture = afterStep;
          result.physicalScrollChanged ||= step.physicalScrollChanged;
          result.conversationWindowChanged ||= step.conversationWindowChanged;
          if (step.conversationWindowChanged) {
            result.firstWindowChangeAttempt = attempt;
            result.reason = 'probe-success-window-changed';
            break;
          }
          currentWindow = afterWindow;
          if (attempt === SCROLL_VISIBILITY_PROBE_MAX_GESTURES) result.reason = 'probe-window-no-progress';
        }
      } catch (error) {
        if (!result.reason) result.reason = result.gestureAttempted ? 'probe-gesture-failed' : 'probe-precondition-failed';
      } finally {
        if (normalizationAttempted) {
          for (let attempt = 0; attempt < SCROLL_VISIBILITY_PROBE_MAX_RESTORE_ATTEMPTS && !result.restoreVerified; attempt += 1) {
            result.restoreAttempts += 1;
            try {
              await this.page.restoreMinimizedForProbe();
            } catch {}
            await sleep(SCROLL_VISIBILITY_PROBE_RESTORE_WAIT_MS);
            try {
              const restoredNative = await readNative();
              const restoredUrl = await readUrl();
              result.restored = {
                browserWindowState: ['normal', 'minimized', 'maximized', 'fullscreen'].includes(restoredNative?.browserWindowState)
                  ? restoredNative.browserWindowState
                  : null,
                adapterMinimized: restoredNative?.adapterMinimized === true,
                documentVisibilityState: ['visible', 'hidden'].includes(restoredNative?.documentVisibilityState) ? restoredNative.documentVisibilityState : null,
                documentHidden: typeof restoredNative?.documentHidden === 'boolean' ? restoredNative.documentHidden : null,
                documentHasFocus: typeof restoredNative?.documentHasFocus === 'boolean' ? restoredNative.documentHasFocus : null
              };
              if (restoredUrl !== initialUrl) result.urlStable = false;
              result.restoreVerified = result.restored.browserWindowState === 'minimized'
                && result.restored.adapterMinimized === true
                && result.restored.documentVisibilityState === 'hidden'
                && result.restored.documentHidden === true;
            } catch {}
          }
          if (!result.restoreVerified) result.reason = 'probe-restore-failed';
        }
      }
      return result;
    });
  }

  async probeMouseWheelVisibility() {
    return await this.runExclusive(async () => {
      const limits = {
        maxTurns: 50,
        maxCharsPerTurn: 100_000,
        maxTotalChars: 1_000_000
      };
      const result = {
        backend: null,
        preconditionPassed: false,
        before: null,
        normalized: null,
        normalizationPhysicalScrollChanged: false,
        normalizationConversationWindowChanged: false,
        readyForMouseWheel: false,
        interactionPoint: null,
        moveMouseAttempted: false,
        moveMouseSucceeded: false,
        wheelAttemptLimit: MOUSE_WHEEL_VISIBILITY_PROBE_MAX_ATTEMPTS,
        wheelAttempts: 0,
        steps: [],
        wheelAttempted: false,
        wheelDeltaX: SCROLL_VISIBILITY_MOUSE_WHEEL_DELTA_X,
        wheelDeltaY: SCROLL_VISIBILITY_MOUSE_WHEEL_DELTA_Y,
        wheelCommandSucceeded: false,
        afterWheel: null,
        anyPhysicalScrollChanged: false,
        physicalScrollChanged: false,
        conversationWindowChanged: false,
        firstWindowChangeAttempt: null,
        physicalTopReached: false,
        initialNormalizedScrollTop: null,
        finalScrollTop: null,
        totalPhysicalDelta: null,
        initialNormalizedRange: null,
        finalRange: null,
        failureAttempt: null,
        nativeInput: {
          failurePhase: null,
          errorName: null,
          errorCode: null,
          errorMessage: null,
          wrapperErrorName: null,
          wrapperErrorCode: null,
          backendErrorCode: null,
          backendErrorMessage: null,
          coordinates: null,
          deltaX: SCROLL_VISIBILITY_MOUSE_WHEEL_DELTA_X,
          deltaY: SCROLL_VISIBILITY_MOUSE_WHEEL_DELTA_Y
        },
        restoreAttempts: 0,
        restoreVerified: false,
        restored: null,
        urlStable: true,
        reason: null
      };
      let normalizationAttempted = false;
      let initialUrl = '';

      const readWindow = async () => await this.#eval(buildConversationWindowReadScript(limits));
      const readUrl = async () => String(await this.page.getUrl()).trim();
      const stableAgainstInitialUrl = async (stateUrl = null) => {
        const currentUrl = stateUrl == null ? await readUrl() : String(stateUrl || '').trim();
        if (!initialUrl || currentUrl !== initialUrl) {
          result.urlStable = false;
          return false;
        }
        return true;
      };
      const readNative = async () => await this.getNativeInputDiagnostics();
      const stage = (native, window = null) => ({
        browserWindowState: ['normal', 'minimized', 'maximized', 'fullscreen'].includes(native?.browserWindowState)
          ? native.browserWindowState
          : null,
        adapterMinimized: native?.adapterMinimized === true,
        documentVisibilityState: ['visible', 'hidden'].includes(native?.documentVisibilityState) ? native.documentVisibilityState : null,
        documentHidden: typeof native?.documentHidden === 'boolean' ? native.documentHidden : null,
        documentHasFocus: typeof native?.documentHasFocus === 'boolean' ? native.documentHasFocus : null,
        ...(window ? probeWindowSummary(window) : {})
      });
      const recordFailure = (phase, error) => {
        result.nativeInput.failurePhase = phase;
        Object.assign(result.nativeInput, nativeInputErrorDetails(error));
      };
      const finalizeSummary = () => {
        result.initialNormalizedScrollTop = result.normalized?.scrollTop ?? null;
        result.initialNormalizedRange = result.normalized?.range ?? null;
        const finalWindow = result.afterWheel || result.normalized;
        result.finalScrollTop = finalWindow?.scrollTop ?? null;
        result.finalRange = finalWindow?.range ?? null;
        result.totalPhysicalDelta = Number.isFinite(Number(result.initialNormalizedScrollTop))
          && Number.isFinite(Number(result.finalScrollTop))
          ? Number(result.initialNormalizedScrollTop) - Number(result.finalScrollTop)
          : null;
      };

      try {
        initialUrl = await readUrl();
        const beforeWindow = await readWindow();
        const beforeNative = await readNative();
        result.backend = beforeNative?.backend === 'chrome-cdp' ? 'chrome-cdp' : null;
        result.before = stage(beforeNative, beforeWindow);
        const hasConversationUrl = await stableAgainstInitialUrl(beforeWindow?.url);
        const hasTarget = typeof this.page?.temporarilyUnminimizeForProbe === 'function'
          && typeof this.page?.restoreMinimizedForProbe === 'function';
        result.preconditionPassed = result.backend === 'chrome-cdp'
          && beforeNative?.pageClosed === false
          && beforeNative?.browserWindowState === 'minimized'
          && beforeNative?.adapterMinimized === true
          && hasConversationUrl
          && hasTarget
          && !!beforeWindow?.scroller
          && beforeWindow.scroller.candidateCount === 1
          && typeof this.page?.moveMouse === 'function'
          && typeof this.page?.mouseWheel === 'function';
        if (!result.preconditionPassed) {
          result.reason = 'probe-precondition-failed';
          return result;
        }

        normalizationAttempted = true;
        await this.page.temporarilyUnminimizeForProbe();
        const normalizeDeadline = Date.now() + SCROLL_VISIBILITY_PROBE_NORMALIZE_TIMEOUT_MS;
        let normalizedNative = null;
        let normalizedWindow = null;
        while (Date.now() <= normalizeDeadline) {
          normalizedNative = await readNative();
          normalizedWindow = await readWindow();
          if (!(await stableAgainstInitialUrl(normalizedWindow?.url))) break;
          result.normalized = stage(normalizedNative, normalizedWindow);
          if (normalizedNative?.browserWindowState === 'normal'
            && normalizedNative?.documentVisibilityState === 'visible'
            && normalizedNative?.documentHidden === false
            && normalizedNative?.documentHasFocus === true) break;
          if (Date.now() + SCROLL_VISIBILITY_PROBE_POLL_MS > normalizeDeadline) break;
          await sleep(SCROLL_VISIBILITY_PROBE_POLL_MS);
        }

        result.normalizationPhysicalScrollChanged = result.before?.scrollTop !== result.normalized?.scrollTop;
        result.normalizationConversationWindowChanged = result.before?.windowSignature !== result.normalized?.windowSignature;
        const ready = result.urlStable
          && normalizedNative?.browserWindowState === 'normal'
          && normalizedNative?.documentVisibilityState === 'visible'
          && normalizedNative?.documentHidden === false
          && normalizedNative?.documentHasFocus === true;
        if (!ready) {
          if (!result.urlStable) result.reason = 'probe-conversation-changed';
          else if (normalizedNative?.browserWindowState !== 'normal') result.reason = 'probe-normalized-but-minimized';
          else if (normalizedNative?.documentVisibilityState !== 'visible' || normalizedNative?.documentHidden !== false) result.reason = 'probe-normalized-but-hidden';
          else result.reason = 'probe-normalized-but-unfocused';
          return result;
        }

        const initialPoint = normalizedWindow?.scroller?.point;
        if (!initialPoint || !Number.isFinite(Number(initialPoint.x)) || !Number.isFinite(Number(initialPoint.y))) {
          result.reason = 'probe-precondition-failed';
          return result;
        }
        result.readyForMouseWheel = true;
        result.interactionPoint = { x: Number(initialPoint.x), y: Number(initialPoint.y) };
        result.nativeInput.coordinates = { ...result.interactionPoint };
        const normalizedSummary = probeWindowSummary(normalizedWindow);
        if (normalizedSummary.atTop === true
          || (Number.isFinite(normalizedSummary.scrollTop) && normalizedSummary.scrollTop <= 1)) {
          result.afterWheel = normalizedSummary;
          result.physicalTopReached = true;
          result.reason = 'probe-wheel-top-without-window-change';
          return result;
        }

        result.moveMouseAttempted = true;
        try {
          await this.page.moveMouse(result.interactionPoint.x, result.interactionPoint.y);
          result.moveMouseSucceeded = true;
        } catch (error) {
          recordFailure('move-mouse', error);
          result.reason = 'probe-wheel-failed';
          return result;
        }
        if (!(await stableAgainstInitialUrl())) {
          result.reason = 'probe-conversation-changed';
          return result;
        }

        for (let attempt = 1; attempt <= MOUSE_WHEEL_VISIBILITY_PROBE_MAX_ATTEMPTS; attempt += 1) {
          let stepNative;
          let stepWindow;
          try {
            stepNative = await readNative();
            stepWindow = await readWindow();
          } catch {
            result.reason = 'probe-wheel-failed';
            break;
          }
          if (!(await stableAgainstInitialUrl(stepWindow?.url))) {
            result.reason = 'probe-conversation-changed';
            break;
          }
          if (stepNative?.pageClosed !== false
            || stepNative?.browserWindowState !== 'normal'
            || stepNative?.documentVisibilityState !== 'visible'
            || stepNative?.documentHidden !== false
            || stepNative?.documentHasFocus !== true
            || !stepWindow?.scroller
            || stepWindow.scroller.candidateCount !== 1) {
            result.reason = 'probe-precondition-failed';
            break;
          }

          const point = stepWindow.scroller.point;
          if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
            result.reason = 'probe-precondition-failed';
            break;
          }
          const beforeStep = probeWindowSummary(stepWindow);
          const step = {
            attempt,
            beforeRange: beforeStep.range,
            afterRange: null,
            beforeScrollTop: beforeStep.scrollTop,
            afterScrollTop: null,
            beforeAtTop: beforeStep.atTop,
            afterAtTop: null,
            physicalScrollChanged: false,
            conversationWindowChanged: false,
            wheelDeltaX: result.wheelDeltaX,
            wheelDeltaY: result.wheelDeltaY,
            commandSucceeded: false
          };
          result.steps.push(step);
          result.wheelAttempts = attempt;
          result.wheelAttempted = true;
          result.wheelCommandSucceeded = false;
          result.nativeInput.coordinates = { x: Number(point.x), y: Number(point.y) };

          try {
            await this.page.mouseWheel(
              Number(point.x),
              Number(point.y),
              result.wheelDeltaX,
              result.wheelDeltaY
            );
            step.commandSucceeded = true;
            result.wheelCommandSucceeded = true;
          } catch (error) {
            result.failureAttempt = attempt;
            recordFailure('mouse-wheel', error);
            result.reason = 'probe-wheel-failed';
            break;
          }

          await sleep(CONVERSATION_HISTORY_SCROLL_WAIT_MS);
          let afterWheel;
          try {
            afterWheel = await readWindow();
          } catch (error) {
            result.failureAttempt = attempt;
            recordFailure('post-wheel-read', error);
            result.reason = 'probe-wheel-failed';
            break;
          }
          if (!(await stableAgainstInitialUrl(afterWheel?.url))) {
            result.reason = 'probe-conversation-changed';
            break;
          }
          const afterStep = probeWindowSummary(afterWheel);
          step.afterRange = afterStep.range;
          step.afterScrollTop = afterStep.scrollTop;
          step.afterAtTop = afterStep.atTop;
          step.physicalScrollChanged = beforeStep.scrollTop !== afterStep.scrollTop;
          step.conversationWindowChanged = beforeStep.windowSignature !== afterStep.windowSignature;
          result.afterWheel = afterStep;
          result.anyPhysicalScrollChanged ||= step.physicalScrollChanged;
          result.physicalScrollChanged = result.anyPhysicalScrollChanged;
          result.conversationWindowChanged ||= step.conversationWindowChanged;
          if (step.conversationWindowChanged) {
            result.firstWindowChangeAttempt = attempt;
            result.reason = 'probe-wheel-window-changed';
            break;
          }
          if (afterStep.atTop === true || (Number.isFinite(afterStep.scrollTop) && afterStep.scrollTop <= 1)) {
            result.physicalTopReached = true;
            result.reason = 'probe-wheel-top-without-window-change';
            break;
          }
          if (attempt === MOUSE_WHEEL_VISIBILITY_PROBE_MAX_ATTEMPTS) result.reason = 'probe-wheel-no-window-change';
        }
        finalizeSummary();
      } catch (error) {
        if (!result.reason) {
          if (result.wheelAttempted) {
            recordFailure('post-wheel-read', error);
            result.reason = 'probe-wheel-failed';
          } else if (normalizationAttempted) {
            result.reason = 'probe-wheel-failed';
          } else {
            result.reason = 'probe-precondition-failed';
          }
        }
      } finally {
        finalizeSummary();
        if (normalizationAttempted) {
          for (let attempt = 0; attempt < SCROLL_VISIBILITY_PROBE_MAX_RESTORE_ATTEMPTS && !result.restoreVerified; attempt += 1) {
            result.restoreAttempts += 1;
            try {
              await this.page.restoreMinimizedForProbe();
            } catch {}
            await sleep(SCROLL_VISIBILITY_PROBE_RESTORE_WAIT_MS);
            try {
              const restoredNative = await readNative();
              const restoredUrl = await readUrl();
              result.restored = stage(restoredNative);
              if (restoredUrl !== initialUrl) result.urlStable = false;
              result.restoreVerified = result.restored.browserWindowState === 'minimized'
                && result.restored.adapterMinimized === true
                && result.restored.documentVisibilityState === 'hidden'
                && result.restored.documentHidden === true;
            } catch {}
          }
          if (!result.restoreVerified) result.reason = 'probe-restore-failed';
        }
      }
      finalizeSummary();
      return result;
    });
  }

  async diagnoseConversationStartMarkers() {
    return await this.runExclusive(async () => {
      const limits = { maxTurns: 50, maxCharsPerTurn: 100_000, maxTotalChars: 1_000_000 };
      const result = {
        backend: null,
        preconditionPassed: false,
        before: null,
        normalized: null,
        initial: null,
        layoutSettle: {
          attempted: false,
          timeoutMs: CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS,
          pollMs: CONVERSATION_LAYOUT_SETTLE_POLL_MS,
          requiredStableSamples: CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES,
          sampleCount: 0,
          stableSampleCount: 0,
          verified: false,
          first: null,
          final: null
        },
        wheelAttemptLimit: START_MARKER_PROBE_MAX_WHEELS,
        wheelAttempts: 0,
        physicalTopReached: false,
        physicalTopStable: false,
        stableTop: null,
        markerPositions: null,
        turnZero: null,
        positionOne: null,
        firstMessagePosition: null,
        firstMessageRole: null,
        positionSource: null,
        firstMessages: [],
        firstMessageAncestors: [],
        previousSiblings: [],
        scrollerMarkerOrder: [],
        messagePositionOrder: [],
        turnZeroElementExists: false,
        turnZeroContainsConversationMessage: false,
        conversationRestore: {
          attempts: 0,
          verified: false,
          initialDistanceFromBottom: null,
          finalDistanceFromBottom: null,
          distanceMatched: false,
          signatureMatched: false,
          lastFailureReason: null
        },
        windowLifecycle: {
          originalWindowState: null,
          originalAdapterMinimized: null,
          originalVisibilityState: null,
          originalHidden: null,
          originalHasFocus: null,
          normalizationApplied: false,
          normalizedWindowState: null,
          normalizedAdapterMinimized: null,
          normalizedVisibilityState: null,
          normalizedHidden: null,
          normalizedHasFocus: null,
          restoreAttempts: 0,
          restoreVerified: false,
          restoredWindowState: null,
          restoredAdapterMinimized: null,
          restoredVisibilityState: null,
        restoredHidden: null,
        restoredHasFocus: null
        },
        urlStable: true,
        reason: null
      };
      let initialUrl = '';
      let normalizedBaseline = null;
      let normalizationApplied = false;

      const readUrl = async () => String(await this.page.getUrl()).trim();
      const readNative = async () => await this.getNativeInputDiagnostics();
      const readWindow = async () => await this.#eval(buildConversationStartMarkerDiagnosticScript(limits));
      const stateSummary = (native, window) => ({
        browserWindowState: ['normal', 'minimized', 'maximized', 'fullscreen'].includes(native?.browserWindowState) ? native.browserWindowState : null,
        adapterMinimized: typeof native?.adapterMinimized === 'boolean' ? native.adapterMinimized : null,
        documentVisibilityState: ['visible', 'hidden'].includes(native?.documentVisibilityState) ? native.documentVisibilityState : null,
        documentHidden: typeof native?.documentHidden === 'boolean' ? native.documentHidden : null,
        documentHasFocus: typeof native?.documentHasFocus === 'boolean' ? native.documentHasFocus : null,
        range: window?.range || { min: null, max: null },
        scrollTop: Number.isFinite(Number(window?.scroller?.scrollTop)) ? Number(window.scroller.scrollTop) : null,
        scrollHeight: Number.isFinite(Number(window?.scroller?.scrollHeight)) ? Number(window.scroller.scrollHeight) : null,
        clientHeight: Number.isFinite(Number(window?.scroller?.clientHeight)) ? Number(window.scroller.clientHeight) : null,
        atTop: typeof window?.scroller?.atTop === 'boolean' ? window.scroller.atTop : null,
        atBottom: typeof window?.scroller?.atBottom === 'boolean' ? window.scroller.atBottom : null,
        windowSignature: typeof window?.windowSignature === 'string' ? window.windowSignature : null,
        structuralSignature: typeof window?.structuralSignature === 'string' ? window.structuralSignature : null,
        loading: window?.loading === true,
        candidateCount: Number.isInteger(window?.scroller?.candidateCount) ? window.scroller.candidateCount : 0,
        point: window?.scroller?.point || null
      });
      const validPoint = (point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) && Number(point.x) >= 0 && Number(point.y) >= 0;
      const sameUrl = async (stateUrl = null) => {
        const currentUrl = stateUrl == null ? await readUrl() : String(stateUrl || '').trim();
        if (!initialUrl || currentUrl !== initialUrl) {
          result.urlStable = false;
          result.reason ||= 'probe-conversation-changed';
          return false;
        }
        return true;
      };
      const copyStructure = (state) => {
        if (!state || typeof state !== 'object') return;
        for (const field of [
          'markerPositions', 'turnZero', 'positionOne', 'firstMessagePosition', 'firstMessageRole', 'positionSource',
          'firstMessages', 'firstMessageAncestors', 'previousSiblings', 'scrollerMarkerOrder', 'messagePositionOrder',
          'turnZeroElementExists', 'turnZeroContainsConversationMessage'
        ]) {
          if (state[field] !== undefined) result[field] = state[field];
        }
      };
      const recordLifecycle = (prefix, native) => {
        const lifecycle = result.windowLifecycle;
        lifecycle[`${prefix}WindowState`] = ['normal', 'minimized', 'maximized', 'fullscreen'].includes(native?.browserWindowState) ? native.browserWindowState : null;
        lifecycle[`${prefix}AdapterMinimized`] = typeof native?.adapterMinimized === 'boolean' ? native.adapterMinimized : null;
        lifecycle[`${prefix}VisibilityState`] = ['visible', 'hidden'].includes(native?.documentVisibilityState) ? native.documentVisibilityState : null;
        lifecycle[`${prefix}Hidden`] = typeof native?.documentHidden === 'boolean' ? native.documentHidden : null;
        lifecycle[`${prefix}HasFocus`] = typeof native?.documentHasFocus === 'boolean' ? native.documentHasFocus : null;
      };
      const readStage = async () => {
        const [native, window] = await Promise.all([readNative(), readWindow()]);
        await sameUrl(window?.url);
        return { native, window, summary: stateSummary(native, window) };
      };
      const restoreConversation = async () => {
        const restore = result.conversationRestore;
        const distance = normalizedBaseline?.scroller
          ? Number(normalizedBaseline.scroller.scrollHeight) - Number(normalizedBaseline.scroller.clientHeight) - Number(normalizedBaseline.scroller.scrollTop)
          : NaN;
        restore.initialDistanceFromBottom = Number.isFinite(distance) && distance >= 0 ? distance : null;
        const baselineSignature = normalizedBaseline?.windowSignature || null;
        if (restore.initialDistanceFromBottom === null || !baselineSignature) {
          restore.lastFailureReason = 'scroller-missing';
          return false;
        }
        let last = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          restore.attempts += 1;
          let current = null;
          try { current = await readWindow(); } catch { restore.lastFailureReason = 'read-failed'; continue; }
          if (!await sameUrl(current?.url)) { restore.lastFailureReason = 'url-changed'; break; }
          if (current?.limitExceeded) { restore.lastFailureReason = 'limit-exceeded'; continue; }
          if (current?.scroller?.candidateCount !== 1) { restore.lastFailureReason = current?.scroller?.candidateCount > 1 ? 'scroller-ambiguous' : 'scroller-missing'; continue; }
          const command = await this.#eval(buildRestoreConversationScrollScript(restore.initialDistanceFromBottom)).catch(() => null);
          if (command?.ok !== true) { restore.lastFailureReason = command?.reason === 'scroll-container-ambiguous' ? 'scroller-ambiguous' : 'restore-command-failed'; continue; }
          await sleep(CONVERSATION_HISTORY_RESTORE_SETTLE_WAIT_MS);
          try { last = await readWindow(); } catch { restore.lastFailureReason = 'read-failed'; continue; }
          if (!await sameUrl(last?.url)) { restore.lastFailureReason = 'url-changed'; break; }
          if (last?.limitExceeded) { restore.lastFailureReason = 'limit-exceeded'; continue; }
          const restoredDistance = Number(last?.scroller?.scrollHeight) - Number(last?.scroller?.clientHeight) - Number(last?.scroller?.scrollTop);
          const distanceMatched = Number.isFinite(restoredDistance) && Math.abs(restoredDistance - restore.initialDistanceFromBottom) <= 2;
          const signatureMatched = last?.windowSignature === baselineSignature;
          restore.finalDistanceFromBottom = Number.isFinite(restoredDistance) ? restoredDistance : null;
          restore.distanceMatched = distanceMatched;
          restore.signatureMatched = signatureMatched;
          if (distanceMatched && signatureMatched) {
            restore.verified = true;
            restore.lastFailureReason = null;
            return true;
          }
          restore.lastFailureReason = signatureMatched ? 'distance-mismatch' : 'signature-mismatch';
        }
        if (last?.scroller) {
          const finalDistance = Number(last.scroller.scrollHeight) - Number(last.scroller.clientHeight) - Number(last.scroller.scrollTop);
          restore.finalDistanceFromBottom = Number.isFinite(finalDistance) ? finalDistance : null;
        }
        return false;
      };
      const restoreWindow = async () => {
        if (!normalizationApplied) { result.windowLifecycle.restoreVerified = true; return true; }
        let verified = false;
        for (let attempt = 0; attempt < SCROLL_VISIBILITY_PROBE_MAX_RESTORE_ATTEMPTS && !verified; attempt += 1) {
          result.windowLifecycle.restoreAttempts += 1;
          try { await this.page.restoreMinimizedForProbe(); } catch {}
          await sleep(SCROLL_VISIBILITY_PROBE_RESTORE_WAIT_MS);
          try {
            const native = await readNative();
            recordLifecycle('restored', native);
            verified = native?.browserWindowState === 'minimized' && native?.adapterMinimized === true && native?.documentVisibilityState === 'hidden' && native?.documentHidden === true;
          } catch {}
        }
        result.windowLifecycle.restoreVerified = verified;
        return verified;
      };

      try {
        initialUrl = await readUrl();
        const beforeStage = await readStage();
        const beforeNative = beforeStage.native;
        result.backend = beforeNative?.backend === 'chrome-cdp' ? 'chrome-cdp' : null;
        result.before = beforeStage.summary;
        result.initial = beforeStage.summary;
        result.windowLifecycle.originalWindowState = ['normal', 'minimized', 'maximized', 'fullscreen'].includes(beforeNative?.browserWindowState) ? beforeNative.browserWindowState : null;
        result.windowLifecycle.originalAdapterMinimized = typeof beforeNative?.adapterMinimized === 'boolean' ? beforeNative.adapterMinimized : null;
        result.windowLifecycle.originalVisibilityState = ['visible', 'hidden'].includes(beforeNative?.documentVisibilityState) ? beforeNative.documentVisibilityState : null;
        result.windowLifecycle.originalHidden = typeof beforeNative?.documentHidden === 'boolean' ? beforeNative.documentHidden : null;
        result.windowLifecycle.originalHasFocus = typeof beforeNative?.documentHasFocus === 'boolean' ? beforeNative.documentHasFocus : null;
        result.preconditionPassed = result.backend === 'chrome-cdp'
          && beforeNative?.pageClosed === false
          && beforeNative?.browserWindowState === 'minimized'
          && beforeNative?.adapterMinimized === true
          && beforeStage.window?.scroller?.candidateCount === 1
          && typeof this.page?.temporarilyUnminimizeForProbe === 'function'
          && typeof this.page?.restoreMinimizedForProbe === 'function'
          && typeof this.page?.moveMouse === 'function'
          && typeof this.page?.mouseWheel === 'function';
        if (!result.preconditionPassed) { result.reason = 'probe-precondition-failed'; return result; }

        normalizationApplied = true;
        result.windowLifecycle.normalizationApplied = true;
        await this.page.temporarilyUnminimizeForProbe();
        const deadline = Date.now() + SCROLL_VISIBILITY_PROBE_NORMALIZE_TIMEOUT_MS;
        let normalizedStage = null;
        while (Date.now() <= deadline) {
          normalizedStage = await readStage();
          recordLifecycle('normalized', normalizedStage.native);
          if (normalizedStage.native?.browserWindowState === 'normal'
            && normalizedStage.native?.documentVisibilityState === 'visible'
            && normalizedStage.native?.documentHidden === false
            && normalizedStage.native?.documentHasFocus === true) break;
          if (Date.now() + SCROLL_VISIBILITY_PROBE_POLL_MS > deadline) break;
          await sleep(SCROLL_VISIBILITY_PROBE_POLL_MS);
        }
        if (!normalizedStage || normalizedStage.native?.browserWindowState !== 'normal' || normalizedStage.native?.documentVisibilityState !== 'visible' || normalizedStage.native?.documentHidden !== false || normalizedStage.native?.documentHasFocus !== true) {
          result.reason = !result.urlStable ? 'probe-conversation-changed' : normalizedStage?.native?.documentHasFocus !== true ? 'probe-normalized-but-unfocused' : 'probe-normalized-but-hidden';
          return result;
        }
        const settledLayout = await this.#waitForStableConversationLayout({
          readWindow,
          initialUrl,
          timeoutMs: CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS,
          pollMs: CONVERSATION_LAYOUT_SETTLE_POLL_MS,
          requiredStableSamples: CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES
        });
        result.layoutSettle = {
          attempted: true,
          timeoutMs: CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS,
          pollMs: CONVERSATION_LAYOUT_SETTLE_POLL_MS,
          requiredStableSamples: CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES,
          sampleCount: settledLayout.samples,
          stableSampleCount: settledLayout.stableSamples,
          verified: settledLayout.ok === true,
          first: settledLayout.first ? conversationLayoutSummary(settledLayout.first) : null,
          final: settledLayout.final ? conversationLayoutSummary(settledLayout.final) : null
        };
        result.normalized = stateSummary(normalizedStage.native, settledLayout.final || normalizedStage.window);
        result.initial = result.normalized;
        if (!settledLayout.ok) {
          if (settledLayout.reason === 'conversation-changed') result.urlStable = false;
          result.reason = settledLayout.reason === 'conversation-changed'
            ? 'probe-conversation-changed'
            : settledLayout.reason === 'conversation-turn-too-large'
              ? 'conversation_turn_too_large'
              : settledLayout.reason === 'conversation-too-large'
                ? 'conversation_too_large'
                : settledLayout.reason === 'scroll-container-ambiguous'
                  ? 'scroll-container-ambiguous'
                  : settledLayout.reason === 'scroll-container-not-found'
                    ? 'scroll-container-not-found'
                    : 'probe-layout-not-stable';
          return result;
        }
        normalizedBaseline = settledLayout.state;
        const baseline = settledLayout.state;
        copyStructure(baseline);
        if (!baseline?.scroller || baseline.scroller.candidateCount !== 1) { result.reason = baseline?.scroller?.candidateCount > 1 ? 'scroll-container-ambiguous' : 'scroll-container-not-found'; return result; }
        if (baseline.limitExceeded) { result.reason = baseline.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large'; return result; }
        let current = baseline;
        const atTop = (state) => state?.scroller?.atTop === true || Number(state?.scroller?.scrollTop) <= 1;
        if (!atTop(current)) {
          for (let attempt = 1; attempt <= START_MARKER_PROBE_MAX_WHEELS; attempt += 1) {
            const step = await readStage();
            current = step.window;
            if (!result.urlStable) break;
            if (step.native?.pageClosed !== false || step.native?.browserWindowState !== 'normal' || step.native?.documentVisibilityState !== 'visible' || step.native?.documentHidden !== false || step.native?.documentHasFocus !== true) { result.reason = 'probe-precondition-failed'; break; }
            if (current?.limitExceeded) { result.reason = current.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large'; break; }
            if (current?.scroller?.candidateCount !== 1 || !validPoint(current.scroller.point)) { result.reason = current?.scroller?.candidateCount > 1 ? 'scroll-container-ambiguous' : 'scroll-container-not-found'; break; }
            try {
              await this.page.moveMouse(Number(current.scroller.point.x), Number(current.scroller.point.y));
              await this.page.mouseWheel(Number(current.scroller.point.x), Number(current.scroller.point.y), 0, -720);
              result.wheelAttempts = attempt;
            } catch {
              result.wheelAttempts = attempt;
              result.reason = 'probe-wheel-failed';
              break;
            }
            await sleep(CONVERSATION_HISTORY_SCROLL_WAIT_MS);
            let after = null;
            try { after = await readWindow(); } catch { result.reason = 'probe-wheel-failed'; break; }
            result.wheelAttempts = attempt;
            if (!await sameUrl(after?.url)) break;
            if (after?.limitExceeded) { result.reason = after.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large'; break; }
            current = after;
            if (atTop(current)) { result.physicalTopReached = true; break; }
          }
          if (!result.physicalTopReached && !result.reason) result.reason = 'probe-top-not-reached';
        } else result.physicalTopReached = true;

        if (result.physicalTopReached && !result.reason) {
          let stableCount = 0;
          let previousWindow = null;
          let previousStructure = null;
          for (let sample = 0; sample < START_MARKER_PROBE_TOP_SAMPLES; sample += 1) {
            if (sample > 0) await sleep(START_MARKER_PROBE_TOP_SAMPLE_WAIT_MS);
            const top = await readStage();
            if (!await sameUrl(top.window?.url)) break;
            if (top.window?.limitExceeded) { result.reason = top.window.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large'; break; }
            const stable = atTop(top.window) && top.window.loading === false && top.window.windowSignature === previousWindow && top.window.structuralSignature === previousStructure;
            previousWindow = top.window?.windowSignature || null;
            previousStructure = top.window?.structuralSignature || null;
            if (stable || sample === 0) stableCount += 1;
            else stableCount = 1;
            current = top.window;
            result.stableTop = top.summary;
            copyStructure(top.window);
            if (stableCount >= START_MARKER_PROBE_TOP_SAMPLES) { result.physicalTopStable = true; break; }
          }
          if (!result.physicalTopStable && !result.reason) result.reason = 'probe-top-not-stable';
        }
        if (result.physicalTopStable) result.reason = null;
      } catch {
        result.reason ||= normalizationApplied ? 'probe-diagnostic-failed' : 'probe-precondition-failed';
      } finally {
        if (normalizationApplied) {
          if (!result.reason || result.reason.startsWith('probe-')) {
            let restored = false;
            try { restored = await restoreConversation(); } catch { result.conversationRestore.lastFailureReason ||= 'read-failed'; }
            if (!restored && !result.reason) result.reason = 'probe-conversation-restore-failed';
          }
          let windowRestored = false;
          try { windowRestored = await restoreWindow(); } catch {}
          if (!windowRestored && !result.reason) result.reason = 'probe-window-restore-failed';
        }
      }
      return result;
    });
  }

  async readPageText({ maxChars = 200_000 } = {}) {
    const text = await this.#eval(`(() => {
      const cap = ${maxChars};
      const clean = (s) => String(s || '').replace(/\\u0000/g, '').replace(/\\s+\\n/g, '\\n').trim();
      const root = document.querySelector('main') || document.body || document.documentElement;

      let txt = clean(root?.innerText) || clean(document.body?.innerText) || clean(document.documentElement?.innerText);
      if (!txt) txt = clean(root?.textContent) || clean(document.body?.textContent) || clean(document.documentElement?.textContent);

      // Last fallback for heavily client-rendered/shell pages where innerText may be empty pre-hydration.
      if (!txt) {
        const hints = Array.from(document.querySelectorAll('button, a, input, textarea, [role=\"button\"], [aria-label], [placeholder]'))
          .slice(0, 400)
          .map((n) => [n.getAttribute('aria-label'), n.getAttribute('placeholder'), n.textContent].filter(Boolean).join(' ').trim())
          .filter(Boolean);
        txt = clean(hints.join('\\n'));
      }

      return txt.slice(0, cap);
    })()`);
    return String(text || '');
  }

  async #readCompleteConversationTurns({ limits, historyTimeoutMs, historyMaxIterations, tailOnly = false }) {
    const operationStartedAt = Date.now();
    const snapshots = [];
    let initialNative = null;
    try {
      initialNative = await this.getNativeInputDiagnostics();
    } catch {}
    const isChromeCdp = initialNative?.backend === 'chrome-cdp';
    const diagnostics = {
      nativeWheelSupported: isChromeCdp
        ? typeof this.page?.mouseWheel === 'function' && typeof this.page?.moveMouse === 'function'
        : typeof this.page?.scrollGesture === 'function'
          || (typeof this.page?.mouseWheel === 'function' && typeof this.page?.moveMouse === 'function'),
      scrollInputMethod: isChromeCdp
        ? (typeof this.page?.mouseWheel === 'function' && typeof this.page?.moveMouse === 'function' ? 'chrome-cdp-mouse-wheel' : null)
        : (typeof this.page?.scrollGesture === 'function'
          ? 'cdp-synthesize-scroll-gesture'
          : (typeof this.page?.mouseWheel === 'function' && typeof this.page?.moveMouse === 'function' ? 'native-mouse-wheel' : null)),
      nativeScrollControlProven: false,
      wheelDownAttempts: 0,
      wheelUpAttempts: 0,
      gestureAttemptsDown: 0,
      gestureAttemptsUp: 0,
      gestureDistance: null,
      gestureSpeed: null,
      gestureSourceType: null,
      initialRange: { min: null, max: null },
      firstNativeUp: null,
      firstNativeDown: null,
      tailRange: { min: null, max: null },
      tailEntry: {
        mode: null,
        directAttempted: false,
        directVerified: false,
        fallbackUsed: false
      },
      directTop: {
        candidateDetected: false,
        candidateRangeMin: null,
        attempted: false,
        commandSucceeded: false,
        atTopVerified: false,
        loading: null,
        sampleCount: 0,
        stableSampleCount: 0,
        triggeredAtIteration: null,
        reason: null
      },
      observedRange: { min: null, max: null },
      oldestProgression: [],
      tailProven: false,
      startProven: false,
      startProofMode: null,
      startBoundary: null,
      conversationWindowChangeCount: 0,
      physicalScrollChangeCount: 0,
      nativeInput: {
        backend: typeof initialNative?.backend === 'string' ? initialNative.backend.slice(0, 32) : null,
        failurePhase: null,
        errorName: null,
        errorCode: null,
        errorMessage: null,
        wrapperErrorName: null,
        wrapperErrorCode: null,
        backendErrorCode: null,
        backendErrorMessage: null,
        coordinates: null,
        deltaX: null,
        deltaY: null,
        windowVisible: null,
        windowFocused: null,
        windowMinimized: null,
        windowDestroyed: null,
        webContentsDestroyed: null,
        pageClosed: null
      },
      windowLifecycle: {
        originalWindowState: ['normal', 'minimized', 'maximized', 'fullscreen'].includes(initialNative?.browserWindowState) ? initialNative.browserWindowState : null,
        originalAdapterMinimized: typeof initialNative?.adapterMinimized === 'boolean' ? initialNative.adapterMinimized : null,
        originalVisibilityState: ['visible', 'hidden'].includes(initialNative?.documentVisibilityState) ? initialNative.documentVisibilityState : null,
        originalHidden: typeof initialNative?.documentHidden === 'boolean' ? initialNative.documentHidden : null,
        originalHasFocus: typeof initialNative?.documentHasFocus === 'boolean' ? initialNative.documentHasFocus : null,
        normalizationApplied: false,
        normalizedWindowState: null,
        normalizedAdapterMinimized: null,
        normalizedVisibilityState: null,
        normalizedHidden: null,
        normalizedHasFocus: null,
        restoreAttempts: 0,
        restoreVerified: !isChromeCdp,
        restoredWindowState: null,
        restoredVisibilityState: null,
        restoredHidden: null,
        restoredHasFocus: null
      },
      layoutSettle: {
        attempted: false,
        timeoutMs: CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS,
        pollMs: CONVERSATION_LAYOUT_SETTLE_POLL_MS,
        requiredStableSamples: CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES,
        sampleCount: 0,
        stableSampleCount: 0,
        verified: false,
        first: null,
        final: null
      },
      conversationRestore: {
        mode: null,
        targetAtBottom: false,
        anchorIdentityPresent: false,
        attempts: 0,
        verified: false,
        initialDistanceFromBottom: null,
        finalDistanceFromBottom: null,
        distanceMatched: false,
        bottomMatched: false,
        anchorMatched: false,
        anchorLoadingMatched: false,
        signatureMatched: false,
        anchorSignatureMode: 'semantic-role-text-digest',
        anchorBaselineEvidence: [],
        anchorRestoredEvidence: [],
        anchorMatchCount: 0,
        lastFailureReason: null
      },
      tailRecheck: {
        attempted: false,
        mode: null,
        signatureMode: 'semantic-role-text-digest',
        sampleCount: 0,
        requiredStableSamples: CONVERSATION_HISTORY_TAIL_RECHECK_SAMPLES,
        stableSampleCount: 0,
        verified: false,
        baselineSignature: null,
        restoredSignature: null,
        baselineEvidence: [],
        restoredEvidence: [],
        atBottom: false,
        loading: null,
        reason: null
      },
      iterationLimitReached: false,
      iterationLimitReachedAtTop: false,
      topProofStartedAtIteration: null,
      timing: {
        historyElapsedMs: 0,
        traversalElapsedMs: 0,
        topProofElapsedMs: 0,
        tailProofElapsedMs: 0,
        restoreElapsedMs: 0
      },
      reads: { lightweightReadCount: 0, fullReadCount: 0 },
      wheels: { total: 0, up: 0, down: 0 },
      urlStable: true
    };
    let current = null;
    let initialUrl = '';
    let initialScrollTop = null;
    let initialDistanceFromBottom = null;
    let originalSemanticAnchorSignature = null;
    let restoreMode = null;
    let historyStartedAt = null;
    let traversalStartedAt = null;
    let tailProofStartedAt = null;
    let topProofStartedAt = null;
    let restoreStartedAt = null;
    let reason = null;
    let windowNormalizationApplied = false;
    let startReached = false;
    let snapshotStable = false;
    let tailSnapshot = null;
    let tailBaselineSignature = null;
    let iterations = 0;
    const addSnapshot = (state) => {
      if (Array.isArray(state?.turns)) snapshots.push(state.turns);
      const range = conversationTurnRange(state?.turns);
      const values = [range.min, range.max, diagnostics.observedRange.min, diagnostics.observedRange.max].filter((value) => Number.isInteger(value));
      diagnostics.observedRange = values.length
        ? { min: Math.min(...values), max: Math.max(...values) }
        : diagnostics.observedRange;
      return range;
    };
    const currentUrlIsStable = (state) => {
      const stable = String(state?.url || '') === initialUrl;
      if (!stable) diagnostics.urlStable = false;
      return stable;
    };
    const historyElapsedMs = () => Date.now() - (historyStartedAt ?? operationStartedAt);
    const readWindow = async () => {
      diagnostics.reads.fullReadCount += 1;
      return await this.#eval(buildConversationWindowReadScript(limits));
    };
    const readTraversal = async () => {
      diagnostics.reads.lightweightReadCount += 1;
      return await this.#eval(buildConversationTraversalReadScript(limits));
    };
    const recordNativeInputRuntime = async () => {
      if (typeof this.page?.getNativeInputDiagnostics !== 'function') return;
      try {
        const runtime = await this.page.getNativeInputDiagnostics();
        if (!runtime || typeof runtime !== 'object') return;
        if (typeof runtime.backend === 'string') diagnostics.nativeInput.backend = runtime.backend.slice(0, 32);
        for (const field of ['windowVisible', 'windowFocused', 'windowMinimized', 'windowDestroyed', 'webContentsDestroyed', 'pageClosed']) {
          if (runtime[field] === null || typeof runtime[field] === 'boolean') diagnostics.nativeInput[field] = runtime[field];
        }
      } catch {}
    };
    const recordNativeInputFailure = async (phase, error) => {
      diagnostics.nativeInput.failurePhase = phase;
      Object.assign(diagnostics.nativeInput, nativeInputErrorDetails(error));
      await recordNativeInputRuntime();
    };
    const recordWindowLifecycleState = (target, prefix, native) => {
      if (!target || !native) return;
      target[`${prefix}WindowState`] = ['normal', 'minimized', 'maximized', 'fullscreen'].includes(native.browserWindowState)
        ? native.browserWindowState
        : null;
      target[`${prefix}AdapterMinimized`] = typeof native.adapterMinimized === 'boolean' ? native.adapterMinimized : null;
      target[`${prefix}VisibilityState`] = ['visible', 'hidden'].includes(native.documentVisibilityState) ? native.documentVisibilityState : null;
      target[`${prefix}Hidden`] = typeof native.documentHidden === 'boolean' ? native.documentHidden : null;
      target[`${prefix}HasFocus`] = typeof native.documentHasFocus === 'boolean' ? native.documentHasFocus : null;
    };
    try {
      initialUrl = String(await this.page.getUrl()).trim();
      await recordNativeInputRuntime();
      if (isChromeCdp) {
        const ready = (native) => ['normal', 'maximized', 'fullscreen'].includes(native?.browserWindowState)
          && native?.pageClosed === false
          && native?.documentVisibilityState === 'visible'
          && native?.documentHidden === false
          && native?.documentHasFocus === true;
        if (initialNative?.browserWindowState === 'minimized') {
          if (typeof this.page?.temporarilyUnminimizeForProbe !== 'function') {
            reason = 'history-native-window-not-ready';
          } else {
            windowNormalizationApplied = true;
            diagnostics.windowLifecycle.normalizationApplied = true;
            await this.page.temporarilyUnminimizeForProbe();
            const deadline = Date.now() + SCROLL_VISIBILITY_PROBE_NORMALIZE_TIMEOUT_MS;
            let normalized = null;
            while (Date.now() <= deadline) {
              normalized = await this.getNativeInputDiagnostics();
              recordWindowLifecycleState(diagnostics.windowLifecycle, 'normalized', normalized);
              if (ready(normalized)) break;
              if (Date.now() + SCROLL_VISIBILITY_PROBE_POLL_MS > deadline) break;
              await sleep(SCROLL_VISIBILITY_PROBE_POLL_MS);
            }
            if (!ready(normalized)) reason = 'history-native-window-not-ready';
          }
        } else if (!ready(initialNative)) {
          reason = 'history-native-window-not-ready';
        } else {
          recordWindowLifecycleState(diagnostics.windowLifecycle, 'normalized', initialNative);
          diagnostics.windowLifecycle.restoreVerified = true;
        }
      }
      if (!reason) {
        const settledLayout = await this.#waitForStableConversationLayout({
          readWindow,
          initialUrl,
          timeoutMs: CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS,
          pollMs: CONVERSATION_LAYOUT_SETTLE_POLL_MS,
          requiredStableSamples: CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES
        });
        diagnostics.layoutSettle = {
          attempted: true,
          timeoutMs: CONVERSATION_LAYOUT_SETTLE_TIMEOUT_MS,
          pollMs: CONVERSATION_LAYOUT_SETTLE_POLL_MS,
          requiredStableSamples: CONVERSATION_LAYOUT_SETTLE_STABLE_SAMPLES,
          sampleCount: settledLayout.samples,
          stableSampleCount: settledLayout.stableSamples,
          verified: settledLayout.ok === true,
          first: settledLayout.first ? conversationLayoutSummary(settledLayout.first) : null,
          final: settledLayout.final ? conversationLayoutSummary(settledLayout.final) : null
        };
        if (!settledLayout.ok) {
          reason = settledLayout.reason === 'conversation-turn-too-large'
            ? 'conversation_turn_too_large'
            : settledLayout.reason === 'conversation-too-large'
              ? 'conversation_too_large'
              : settledLayout.reason === 'conversation-changed'
                ? 'conversation-changed'
                : settledLayout.reason === 'scroll-container-ambiguous'
                  ? 'scroll-container-ambiguous'
                  : settledLayout.reason === 'scroll-container-not-found'
                    ? 'scroll-container-not-found'
                    : 'history-layout-not-stable';
        } else {
          current = settledLayout.state;
          initialScrollTop = Number(current?.scroller?.scrollTop);
          initialDistanceFromBottom = Number(current?.scroller?.scrollHeight) - Number(current?.scroller?.clientHeight) - initialScrollTop;
          originalSemanticAnchorSignature = conversationSemanticAnchorSignature(current?.turns);
          restoreMode = current?.scroller?.atBottom === true ? 'bottom' : 'anchored-window';
          diagnostics.conversationRestore.mode = restoreMode;
          diagnostics.conversationRestore.targetAtBottom = restoreMode === 'bottom';
          diagnostics.conversationRestore.anchorIdentityPresent = restoreMode !== 'bottom'
            && originalSemanticAnchorSignature !== '[]';
          diagnostics.conversationRestore.anchorBaselineEvidence = restoreMode === 'bottom'
            ? []
            : conversationSemanticAnchorEvidence(current?.turns);
          addSnapshot(current);
          diagnostics.initialRange = conversationTurnRange(current?.turns);
          diagnostics.observedRange = { ...diagnostics.initialRange };
          historyStartedAt = Date.now();
          diagnostics.historyStartedAfterNormalizedBaseline = historyStartedAt >= operationStartedAt;
          diagnostics.historyBudgetMs = historyTimeoutMs;
          diagnostics.historyIterationLimit = historyMaxIterations;
        }
      }
    } catch (error) {
      reason ||= isChromeCdp && windowNormalizationApplied ? 'history-native-window-not-ready' : 'history-native-scroll-unproven';
    }
    const recordWheelResult = (before, after, direction) => {
      const beforeSignature = conversationWindowIdentitySignature(before?.turns);
      const afterSignature = conversationWindowIdentitySignature(after?.turns);
      const windowChanged = beforeSignature !== afterSignature;
      const physicalChanged = Number(before?.scroller?.scrollTop) !== Number(after?.scroller?.scrollTop);
      if (windowChanged) diagnostics.conversationWindowChangeCount += 1;
      if (physicalChanged) diagnostics.physicalScrollChangeCount += 1;
      if (direction < 0 && diagnostics.oldestProgression.length < 80) diagnostics.oldestProgression.push(conversationTurnRange(after?.turns).min);
      return {
        windowChanged,
        physicalChanged,
        beforeRange: conversationTurnRange(before?.turns),
        range: conversationTurnRange(after?.turns)
      };
    };
    const nativeWheel = async (direction, state) => {
      if ((historyStartedAt !== null ? Date.now() - historyStartedAt : Date.now() - operationStartedAt) > historyTimeoutMs || iterations >= historyMaxIterations) return { ok: false, reason: 'timeout' };
      if (isChromeCdp) {
        let runtime = null;
        try {
          runtime = await this.getNativeInputDiagnostics();
        } catch {
          return { ok: false, reason: 'history-native-window-not-ready' };
        }
        if (runtime?.pageClosed !== false
          || !['normal', 'maximized', 'fullscreen'].includes(runtime?.browserWindowState)
          || runtime?.documentVisibilityState !== 'visible'
          || runtime?.documentHidden !== false
          || runtime?.documentHasFocus !== true) {
          return { ok: false, reason: 'history-native-window-not-ready' };
        }
      }
      let beforeState;
      try {
        beforeState = await readTraversal();
      } catch (error) {
        await recordNativeInputFailure('post-wheel-read', error);
        return { ok: false, reason: 'history-native-wheel-failed' };
      }
      if (!currentUrlIsStable(beforeState)) return { ok: false, reason: 'conversation-changed', state: beforeState };
      if (beforeState?.limitExceeded) return { ok: false, reason: beforeState.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large', state: beforeState };
      if (beforeState?.scroller?.candidateCount !== 1) return { ok: false, reason: beforeState?.scroller?.candidateCount > 1 ? 'scroll-container-ambiguous' : 'scroll-container-not-found', state: beforeState };
      current = beforeState;
      const point = beforeState?.scroller?.point;
      if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return { ok: false, reason: 'scroll-target-invalid' };
      iterations += 1;
      if (direction > 0) diagnostics.wheelDownAttempts += 1; else diagnostics.wheelUpAttempts += 1;
      diagnostics.wheels.total += 1;
      if (direction > 0) diagnostics.wheels.down += 1; else diagnostics.wheels.up += 1;
      const deltaX = 0;
      const deltaY = direction > 0 ? 720 : -720;
      const visibleHeight = Number(beforeState?.scroller?.clientHeight);
      const gestureDistance = Math.max(120, Math.min(600, Number.isFinite(visibleHeight) && visibleHeight > 0 ? Math.floor(visibleHeight * 0.7) : 480));
      const gestureSpeed = 1_000;
      const gestureSourceType = 'touch';
      const useScrollGesture = !isChromeCdp && typeof this.page?.scrollGesture === 'function';
      diagnostics.nativeInput.coordinates = { x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) };
      diagnostics.nativeInput.deltaX = deltaX;
      diagnostics.nativeInput.deltaY = useScrollGesture ? (direction > 0 ? -gestureDistance : gestureDistance) : deltaY;
      if (useScrollGesture) {
        if (direction > 0) diagnostics.gestureAttemptsDown += 1; else diagnostics.gestureAttemptsUp += 1;
        diagnostics.gestureDistance = gestureDistance;
        diagnostics.gestureSpeed = gestureSpeed;
        diagnostics.gestureSourceType = gestureSourceType;
      }
      await recordNativeInputRuntime();
      if (useScrollGesture) {
        try {
          await this.page.scrollGesture({
            x: Number(point.x),
            y: Number(point.y),
            xDistance: 0,
            yDistance: direction > 0 ? -gestureDistance : gestureDistance,
            speed: gestureSpeed,
            preventFling: true,
            gestureSourceType
          });
        } catch (error) {
          await recordNativeInputFailure('scroll-gesture', error);
          return { ok: false, reason: 'history-native-wheel-failed' };
        }
      } else {
        try {
          await this.page.moveMouse(Number(point.x), Number(point.y));
        } catch (error) {
          await recordNativeInputFailure('move-mouse', error);
          return { ok: false, reason: 'history-native-wheel-failed' };
        }
        try {
          await this.page.mouseWheel(Number(point.x), Number(point.y), deltaX, deltaY);
        } catch (error) {
          await recordNativeInputFailure('mouse-wheel', error);
          return { ok: false, reason: 'history-native-wheel-failed' };
        }
      }
      let next;
      try {
        const deadline = Date.now() + CONVERSATION_HISTORY_SCROLL_SETTLE_MAX_MS;
        let traversal = null;
        do {
          traversal = await readTraversal();
          if (currentUrlIsStable(traversal) === false) break;
          const changed = conversationWindowIdentitySignature(beforeState.turns) !== conversationWindowIdentitySignature(traversal.turns)
            || Number(beforeState.scroller?.scrollTop) !== Number(traversal.scroller?.scrollTop)
            || beforeState.scroller?.atTop !== traversal.scroller?.atTop
            || beforeState.scroller?.atBottom !== traversal.scroller?.atBottom
            || beforeState.loading !== traversal.loading;
          if (changed || Date.now() >= deadline) break;
          await sleep(CONVERSATION_HISTORY_SCROLL_POLL_MS);
        } while (Date.now() <= deadline);
        if (!traversal || !currentUrlIsStable(traversal)) return { ok: false, reason: 'conversation-changed', state: traversal };
        next = conversationWindowIdentitySignature(beforeState.turns) !== conversationWindowIdentitySignature(traversal.turns)
          ? await readWindow()
          : traversal;
      } catch (error) {
        await recordNativeInputFailure('post-wheel-read', error);
        return { ok: false, reason: 'history-native-wheel-failed' };
      }
      if (!currentUrlIsStable(next)) return { ok: false, reason: 'conversation-changed', state: next };
      if (next?.limitExceeded) return { ok: false, reason: next.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large', state: next };
      const result = recordWheelResult(beforeState, next, direction);
      if (result.windowChanged) addSnapshot(next);
      current = next;
      return { ok: true, state: next, ...result };
    };
    const setTailBaseline = (state, { replaceSnapshots = false } = {}) => {
      tailSnapshot = state;
      tailBaselineSignature = conversationSemanticTailSignature(state?.turns);
      diagnostics.tailRecheck.baselineSignature = textDigest(tailBaselineSignature).slice(0, 32);
      diagnostics.tailRecheck.baselineEvidence = conversationSemanticTailEvidence(state?.turns);
      diagnostics.tailRange = conversationTurnRange(state?.turns);
      current = state;
      if (replaceSnapshots) snapshots.length = 0;
      addSnapshot(state);
      if (!diagnostics.tailEntry.mode) diagnostics.tailEntry.mode = 'native-wheel-fallback';
    };
    const establishDirectTail = async () => {
      const entry = diagnostics.tailEntry;
      entry.directAttempted = true;
      entry.mode = 'direct-bottom';
      let command = null;
      try { command = await this.#eval(buildRestoreConversationScrollScript(0, 'tail')); } catch { command = null; }
      if (command?.ok !== true) {
        entry.fallbackUsed = true;
        entry.mode = 'native-wheel-fallback';
        return false;
      }
      let stableCount = 0;
      let previousSignature = null;
      let settled = null;
      for (let sample = 0; sample < CONVERSATION_HISTORY_TAIL_RECHECK_SAMPLES; sample += 1) {
        if (sample > 0) await sleep(CONVERSATION_HISTORY_TAIL_RECHECK_WAIT_MS);
        let state = null;
        try { state = await readWindow(); } catch { state = null; }
        if (state) current = state;
        if (!state || !currentUrlIsStable(state) || state.limitExceeded || state.scroller?.candidateCount !== 1) {
          entry.fallbackUsed = true;
          entry.mode = 'native-wheel-fallback';
          return false;
        }
        const signature = conversationTailSignature(state.turns);
        if (state.scroller.atBottom === true && state.loading === false) {
          stableCount = previousSignature === null || signature === previousSignature ? stableCount + 1 : 1;
        } else stableCount = 0;
        previousSignature = signature;
        settled = state;
        if (stableCount >= CONVERSATION_HISTORY_TAIL_RECHECK_SAMPLES) break;
      }
      if (stableCount < CONVERSATION_HISTORY_TAIL_RECHECK_SAMPLES || !settled) {
        entry.fallbackUsed = true;
        entry.mode = 'native-wheel-fallback';
        return false;
      }
      entry.directVerified = true;
      setTailBaseline(settled, { replaceSnapshots: true });
      diagnostics.tailProven = true;
      return true;
    };
    const establishDirectTop = async (candidateRangeMin) => {
      const entry = diagnostics.directTop;
      entry.candidateDetected = true;
      entry.candidateRangeMin = Number.isInteger(candidateRangeMin) ? candidateRangeMin : null;
      entry.triggeredAtIteration = iterations;
      entry.attempted = true;
      let command = null;
      try { command = await this.#eval(buildRestoreConversationScrollScript(0, 'top')); } catch { command = null; }
      if (command?.ok !== true) {
        entry.reason = 'direct-top-command-failed';
        reason ||= 'history-direct-top-failed';
        return false;
      }
      entry.commandSucceeded = true;
      let state = null;
      try { state = await readWindow(); } catch {
        entry.reason = 'direct-top-read-failed';
        reason ||= 'history-direct-top-failed';
        return false;
      }
      entry.sampleCount = 1;
      if (!currentUrlIsStable(state)) {
        entry.reason = 'conversation-changed';
        reason ||= 'conversation-changed';
        return false;
      }
      if (state?.limitExceeded) {
        entry.reason = state.limitKind === 'per-turn' ? 'conversation-turn-too-large' : 'conversation-too-large';
        reason ||= state.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large';
        return false;
      }
      if (state?.scroller?.candidateCount !== 1) {
        entry.reason = state?.scroller?.candidateCount > 1 ? 'scroll-container-ambiguous' : 'scroll-container-not-found';
        reason ||= entry.reason;
        return false;
      }
      const before = current;
      current = state;
      entry.loading = state.loading === true;
      entry.atTopVerified = state.scroller.atTop === true;
      entry.stableSampleCount = entry.atTopVerified && !entry.loading ? 1 : 0;
      if (entry.atTopVerified && !entry.loading) {
        if (conversationWindowIdentitySignature(before?.turns) !== conversationWindowIdentitySignature(state.turns)) addSnapshot(state);
        return true;
      }
      entry.reason = entry.loading ? 'direct-top-loading' : 'direct-top-not-verified';
      reason ||= 'history-direct-top-failed';
      return false;
    };
    const restore = async () => {
      const restoreDiagnostics = diagnostics.conversationRestore;
      restoreDiagnostics.initialDistanceFromBottom = Number.isFinite(initialDistanceFromBottom) && initialDistanceFromBottom >= 0
        ? initialDistanceFromBottom
        : null;
      if (restoreDiagnostics.initialDistanceFromBottom === null) {
        restoreDiagnostics.lastFailureReason = 'scroller-missing';
        return false;
      }
      const restoreToTarget = async (targetDistance, validate, targetMode) => {
        while (restoreDiagnostics.attempts < CONVERSATION_HISTORY_RESTORE_ATTEMPTS) {
          restoreDiagnostics.attempts += 1;
          let currentState = null;
          try {
            currentState = await readWindow();
          } catch {
            restoreDiagnostics.lastFailureReason = 'read-failed';
            continue;
          }
          if (!currentState || currentState.limitExceeded) {
            restoreDiagnostics.lastFailureReason = currentState?.limitExceeded ? 'limit-exceeded' : 'read-failed';
            continue;
          }
          if (!currentUrlIsStable(currentState)) {
            restoreDiagnostics.lastFailureReason = 'url-changed';
            return false;
          }
          if (currentState.scroller?.candidateCount !== 1) {
            restoreDiagnostics.lastFailureReason = currentState.scroller?.candidateCount > 1 ? 'scroller-ambiguous' : 'scroller-missing';
            continue;
          }
          const currentScrollHeight = Number(currentState.scroller?.scrollHeight);
          const currentClientHeight = Number(currentState.scroller?.clientHeight);
          if (!Number.isFinite(currentScrollHeight) || !Number.isFinite(currentClientHeight)) {
            restoreDiagnostics.lastFailureReason = 'scroller-missing';
            continue;
          }
          const result = await this.#eval(buildRestoreConversationScrollScript(targetDistance)).catch(() => null);
          if (result?.ok !== true) {
            restoreDiagnostics.lastFailureReason = result?.reason === 'scroll-container-ambiguous' ? 'scroller-ambiguous' : 'restore-command-failed';
            continue;
          }
          await sleep(CONVERSATION_HISTORY_RESTORE_SETTLE_WAIT_MS);
          let restored = null;
          try {
            restored = await readWindow();
          } catch {
            restoreDiagnostics.lastFailureReason = 'read-failed';
            continue;
          }
          if (!restored || restored.limitExceeded) {
            restoreDiagnostics.lastFailureReason = restored?.limitExceeded ? 'limit-exceeded' : 'read-failed';
            continue;
          }
          if (!currentUrlIsStable(restored)) {
            restoreDiagnostics.lastFailureReason = 'url-changed';
            return false;
          }
          if (restored.scroller?.candidateCount !== 1) {
            restoreDiagnostics.lastFailureReason = restored.scroller?.candidateCount > 1 ? 'scroller-ambiguous' : 'scroller-missing';
            continue;
          }
          const restoredDistance = Number(restored.scroller?.scrollHeight) - Number(restored.scroller?.clientHeight) - Number(restored.scroller?.scrollTop);
          const distanceMatched = Number.isFinite(restoredDistance) && Math.abs(restoredDistance - targetDistance) <= 2;
          const bottomMatched = restored.scroller.atBottom === true && restored.loading === false;
          const anchorLoadingMatched = restored.loading === false;
          const anchorMatchCount = conversationSemanticAnchorMatchCount(originalSemanticAnchorSignature, restored.turns);
          const anchorMatched = anchorMatchCount === 1;
          restoreDiagnostics.finalDistanceFromBottom = Number.isFinite(restoredDistance) ? restoredDistance : null;
          restoreDiagnostics.distanceMatched = distanceMatched;
          restoreDiagnostics.bottomMatched = bottomMatched;
          restoreDiagnostics.anchorLoadingMatched = anchorLoadingMatched;
          restoreDiagnostics.anchorMatchCount = anchorMatchCount;
          restoreDiagnostics.anchorRestoredEvidence = conversationSemanticAnchorEvidence(restored.turns);
          restoreDiagnostics.anchorMatched = anchorMatched;
          restoreDiagnostics.signatureMatched = restoreDiagnostics.mode === 'bottom' ? null : null;
          if (validate({ distanceMatched, bottomMatched, anchorMatched, anchorLoadingMatched, restored })) {
            current = restored;
            return true;
          }
          restoreDiagnostics.lastFailureReason = targetMode === 'bottom'
            ? (distanceMatched ? 'bottom-mismatch' : 'distance-mismatch')
            : (!anchorLoadingMatched
              ? 'anchor-loading'
              : (distanceMatched ? (anchorMatchCount === 0 ? 'anchor-not-found' : 'anchor-ambiguous') : 'distance-mismatch'));
        }
        return false;
      };

      const bottomRestored = await restoreToTarget(0, ({ distanceMatched, bottomMatched }) => distanceMatched && bottomMatched, 'bottom');
      if (!bottomRestored) return false;
      let tailVerified = true;
      if (tailBaselineSignature) {
        const recheck = diagnostics.tailRecheck;
        recheck.sampleCount = 0;
        recheck.stableSampleCount = 0;
        recheck.reason = null;
        tailVerified = await recheckTail();
      }
      if (!tailVerified) return false;
      if (restoreDiagnostics.mode === 'bottom') {
        restoreDiagnostics.verified = true;
        restoreDiagnostics.lastFailureReason = null;
        return true;
      }
      const anchoredRestored = await restoreToTarget(restoreDiagnostics.initialDistanceFromBottom, ({ distanceMatched, anchorMatched, anchorLoadingMatched }) => distanceMatched && anchorMatched && anchorLoadingMatched, 'anchor');
      if (anchoredRestored) {
        restoreDiagnostics.verified = true;
        restoreDiagnostics.lastFailureReason = null;
        return true;
      }
      return false;
    };
    const recheckTail = async () => {
      const recheck = diagnostics.tailRecheck;
      recheck.attempted = true;
      recheck.mode = restoreMode;
      if (!tailBaselineSignature) {
        recheck.reason = 'tail-baseline-missing';
        return false;
      }
      let stableCount = 0;
      for (let sample = 0; sample < CONVERSATION_HISTORY_TAIL_RECHECK_SAMPLES; sample += 1) {
        if (sample > 0) await sleep(CONVERSATION_HISTORY_TAIL_RECHECK_WAIT_MS);
        let state = null;
        try {
          state = await readWindow();
        } catch {
          recheck.reason = 'read-failed';
          break;
        }
        recheck.sampleCount += 1;
        if (!currentUrlIsStable(state)) {
          recheck.reason = 'url-changed';
          break;
        }
        if (state?.limitExceeded) {
          recheck.reason = 'limit-exceeded';
          break;
        }
        if (state?.scroller?.candidateCount !== 1) {
          recheck.reason = state?.scroller?.candidateCount > 1 ? 'scroller-ambiguous' : 'scroller-missing';
          break;
        }
        const signature = conversationSemanticTailSignature(state.turns);
        recheck.restoredEvidence = conversationSemanticTailEvidence(state.turns);
        const atBottom = state.scroller.atBottom === true;
        const loading = state.loading === true;
        recheck.restoredSignature = textDigest(signature).slice(0, 32);
        recheck.atBottom = atBottom;
        recheck.loading = loading;
        if (atBottom && !loading && signature === tailBaselineSignature) {
          stableCount += 1;
        } else {
          stableCount = 0;
        }
        recheck.stableSampleCount = stableCount;
        if (stableCount >= CONVERSATION_HISTORY_TAIL_RECHECK_SAMPLES) {
          recheck.verified = true;
          recheck.reason = null;
          return true;
        }
      }
      if (!recheck.reason) recheck.reason = recheck.atBottom ? 'signature-mismatch' : 'bottom-unverified';
      return false;
    };
    const restoreWindow = async () => {
      if (!windowNormalizationApplied) {
        diagnostics.windowLifecycle.restoreVerified = true;
        return true;
      }
      let verified = false;
      for (let attempt = 0; attempt < SCROLL_VISIBILITY_PROBE_MAX_RESTORE_ATTEMPTS && !verified; attempt += 1) {
        diagnostics.windowLifecycle.restoreAttempts += 1;
        try {
          await this.page.restoreMinimizedForProbe();
        } catch {}
        await sleep(SCROLL_VISIBILITY_PROBE_RESTORE_WAIT_MS);
        try {
          const restoredNative = await this.getNativeInputDiagnostics();
          recordWindowLifecycleState(diagnostics.windowLifecycle, 'restored', restoredNative);
          verified = restoredNative?.browserWindowState === 'minimized'
            && restoredNative?.adapterMinimized === true
            && restoredNative?.documentVisibilityState === 'hidden'
            && restoredNative?.documentHidden === true;
        } catch {}
      }
      diagnostics.windowLifecycle.restoreVerified = verified;
      return verified;
    };

    try {
      if (reason) {
        // Preserve a preflight failure and only run the history state machine when setup passed.
      } else if (!initialUrl || !current?.scroller || current.scroller.candidateCount === 0) reason = current?.scroller?.candidateCount > 1 ? 'scroll-container-ambiguous' : 'scroll-container-not-found';
      else if (!diagnostics.nativeWheelSupported) reason = 'history-native-scroll-unproven';
      else if (!tailOnly) {
        traversalStartedAt = Date.now();
        await establishDirectTail();
        let proofDirection = current.scroller.atBottom ? -1 : 1;
        let oppositeAttempted = false;
        let proofNoProgress = 0;
        while (!diagnostics.nativeScrollControlProven && !reason && iterations < historyMaxIterations && historyElapsedMs() <= historyTimeoutMs) {
          const before = current;
          const result = await nativeWheel(proofDirection, before);
          const entry = {
            changed: result.windowChanged === true,
            physicalChanged: result.physicalChanged === true,
            beforeRange: result.beforeRange || null,
            range: result.range || conversationTurnRange(result.state?.turns)
          };
          if (proofDirection < 0 && !diagnostics.firstNativeUp) diagnostics.firstNativeUp = entry;
          if (proofDirection > 0 && !diagnostics.firstNativeDown) diagnostics.firstNativeDown = entry;
          if (!result.ok) { reason = result.reason; break; }
          const candidateMin = result.range?.min;
          if (proofDirection < 0
            && !result.state?.scroller?.atTop
            && (candidateMin === 0 || candidateMin === 1)) {
            if (!await establishDirectTop(candidateMin)) break;
            if (result.windowChanged) {
              diagnostics.nativeScrollControlProven = true;
              break;
            }
            reason = 'history-native-scroll-unproven';
            break;
          }
          if (result.windowChanged) {
            diagnostics.nativeScrollControlProven = true;
            break;
          }
          const beforeMin = conversationTurnRange(before?.turns).min;
          const afterMin = result.range?.min;
          const beforeMax = conversationTurnRange(before?.turns).max;
          const afterMax = result.range?.max;
          const rangeProgress = proofDirection < 0
            ? Number.isInteger(afterMin) && (!Number.isInteger(beforeMin) || afterMin < beforeMin)
            : Number.isInteger(afterMax) && (!Number.isInteger(beforeMax) || afterMax > beforeMax);
          if (result.physicalChanged || rangeProgress) {
            proofNoProgress = 0;
            continue;
          }
          proofNoProgress += 1;
          if (!oppositeAttempted) {
            proofDirection = -proofDirection;
            oppositeAttempted = true;
            continue;
          }
          if (proofNoProgress >= 2) reason = 'history-native-scroll-no-progress';
        }
        if (!diagnostics.nativeScrollControlProven && !reason) reason = historyElapsedMs() > historyTimeoutMs ? 'timeout' : 'history-native-scroll-no-progress';
      }

      if (!reason && !diagnostics.tailProven) {
        tailProofStartedAt = Date.now();
        let tailStableCount = 0;
        let previousTail = null;
        while (!reason && iterations < historyMaxIterations && historyElapsedMs() <= historyTimeoutMs) {
          const result = await nativeWheel(1, current);
          if (!result.ok) { reason = result.reason; break; }
          if (result.state.scroller.atBottom && !result.state.loading) {
            const signature = conversationTailSignature(result.state.turns);
            tailStableCount = signature === previousTail ? tailStableCount + 1 : 1;
            previousTail = signature;
            if (tailStableCount >= 3) {
              const settledTail = await readWindow();
              if (!currentUrlIsStable(settledTail)) { reason = 'conversation-changed'; break; }
              if (settledTail?.limitExceeded) { reason = settledTail.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large'; break; }
              setTailBaseline(settledTail);
              diagnostics.tailProven = true;
              break;
            }
          } else tailStableCount = 0;
        }
        if (!diagnostics.tailProven && !reason) reason = historyElapsedMs() > historyTimeoutMs ? 'timeout' : 'history-tail-unproven';
      }

      if (!reason && tailOnly && diagnostics.tailProven) {
        const observedIdentityCount = () => new Set(snapshots.flatMap((snapshot) => (Array.isArray(snapshot) ? snapshot : []), []).map((turn) => {
          const text = normalizeConversationText(turn?.text);
          return turn?.messageId
            ? `message:${turn.messageId}`
            : turn?.turnId
              ? `turn:${turn.turnId}`
              : `fingerprint:${turn?.role || ''}\u0000${text}`;
        })).size;
        let noProgressCount = 0;
        while (!reason && !current?.scroller?.atTop && observedIdentityCount() < limits.maxTurns) {
          if (historyElapsedMs() > historyTimeoutMs || iterations >= historyMaxIterations) {
            reason = historyElapsedMs() > historyTimeoutMs ? 'timeout' : 'history-tail-limit';
            break;
          }
          const before = current;
          const result = await nativeWheel(-1, before);
          if (!result.ok) { reason = result.reason; break; }
          if (result.windowChanged || result.physicalChanged || result.range.min < conversationTurnRange(before?.turns).min) noProgressCount = 0;
          else noProgressCount += 1;
          if (noProgressCount >= 3) { reason = 'history-tail-no-progress'; break; }
        }
        snapshotStable = diagnostics.tailProven && !reason;
      }

      if (!reason && diagnostics.tailProven && !tailOnly) {
        topProofStartedAt = Date.now();
        diagnostics.topProofStartedAtIteration = iterations;
        let noProgressCount = 0;
        while (historyElapsedMs() <= historyTimeoutMs && !reason) {
          const currentMin = conversationTurnRange(current?.turns).min;
          if (!current?.scroller?.atTop
            && (currentMin === 0 || currentMin === 1)) {
            if (!await establishDirectTop(currentMin)) break;
          }
          if (current?.scroller?.atTop && !current.loading) {
            diagnostics.iterationLimitReached = iterations >= historyMaxIterations;
            diagnostics.iterationLimitReachedAtTop = diagnostics.iterationLimitReached;
            let stableTopCount = 0;
            let previousTop = null;
            for (let sample = 0; sample < CONVERSATION_HISTORY_TOP_STABLE_SAMPLES && historyElapsedMs() <= historyTimeoutMs; sample += 1) {
              await sleep(CONVERSATION_HISTORY_TOP_SETTLE_WAIT_MS);
              const settled = await this.#eval(buildConversationWindowReadScript(limits));
              if (!currentUrlIsStable(settled)) { reason = 'conversation-changed'; break; }
              if (settled?.limitExceeded) {
                reason = settled.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large';
                break;
              }
              addSnapshot(settled);
              const signature = JSON.stringify({ first: conversationTurnRange(settled.turns).min, window: conversationWindowSignature(settled.turns), loading: settled.loading === true });
              if (!settled.loading && signature === previousTop) stableTopCount += 1; else stableTopCount = 1;
              previousTop = signature;
              current = settled;
              if (stableTopCount >= CONVERSATION_HISTORY_TOP_STABLE_SAMPLES) {
                const proof = conversationStartBoundaryProof(settled, { physicalTopStable: true });
                diagnostics.startBoundary = proof;
                diagnostics.startProofMode = proof.mode;
                diagnostics.startProven = proof.proven;
                startReached = diagnostics.startProven;
                snapshotStable = true;
                reason = diagnostics.startProven ? null : 'history-start-unproven';
                break;
              }
            }
            if (reason || startReached) break;
          }
          if (iterations >= historyMaxIterations) {
            diagnostics.iterationLimitReached = true;
            diagnostics.iterationLimitReachedAtTop = current?.scroller?.atTop === true;
            reason = 'history-iteration-limit';
            break;
          }
          const before = current;
          const result = await nativeWheel(-1, current);
          if (!result.ok) { reason = result.reason; break; }
          const rangeProgress = Number.isInteger(result.range?.min)
            && (!Number.isInteger(conversationTurnRange(before.turns).min) || result.range.min < conversationTurnRange(before.turns).min);
          if (result.windowChanged || result.physicalChanged || rangeProgress) noProgressCount = 0;
          else noProgressCount += 1;
          if (noProgressCount >= 3) { reason = 'history-native-scroll-no-progress'; break; }
        }
        if (!startReached && !reason) reason = historyElapsedMs() > historyTimeoutMs ? 'timeout' : 'history-start-unproven';
      }

    } finally {
      restoreStartedAt = Date.now();
      diagnostics.scrollRestored = await restore();
      const windowRestored = await restoreWindow();
      if (!windowRestored && !reason) reason = 'history-window-restore-failed';
    }
    if (!diagnostics.scrollRestored && !reason) reason = 'scroll-restore-failed';
    const finalRange = conversationTurnRange(current?.turns);
    diagnostics.scroller = current?.scroller
      ? {
        candidateCount: Number.isInteger(current.scroller.candidateCount) ? current.scroller.candidateCount : 0,
        selectedMessageDescendantCount: Number.isInteger(current.scroller.selectedMessageDescendantCount) ? current.scroller.selectedMessageDescendantCount : 0,
        selected: current.scroller.selected || null,
        selectedPath: current.scroller.selectedPath || null,
        candidates: Array.isArray(current.scroller.candidates) ? current.scroller.candidates.slice(0, 8) : [],
        selectedAtTop: current.scroller.atTop === true,
        selectedAtBottom: diagnostics.tailProven === true
      }
      : { candidateCount: 0, selectedMessageDescendantCount: 0, selected: null, selectedPath: null, candidates: [], selectedAtTop: false, selectedAtBottom: false };
    diagnostics.positions = {
      initialMin: diagnostics.initialRange.min,
      initialMax: diagnostics.initialRange.max,
      tailMin: diagnostics.tailRange.min,
      tailMax: diagnostics.tailRange.max,
      observedMin: diagnostics.observedRange.min,
      observedMax: diagnostics.observedRange.max,
      oldestProgression: diagnostics.oldestProgression.slice(0, 80),
      finalMin: finalRange.min,
      finalMax: finalRange.max
    };
    diagnostics.progress = {
      olderWindowObserved: diagnostics.oldestProgression.some((value, index, values) => index > 0 && Number.isInteger(value) && Number.isInteger(values[index - 1]) && value < values[index - 1]),
      scrollProgressObserved: diagnostics.conversationWindowChangeCount > 0,
      tailProven: diagnostics.tailProven,
      startProven: diagnostics.startProven
    };
    const clockStart = historyStartedAt ?? operationStartedAt;
    const now = Date.now();
    const elapsed = Math.max(0, now - clockStart);
    diagnostics.timing.historyElapsedMs = elapsed;
    diagnostics.timing.traversalElapsedMs = traversalStartedAt ? Math.max(0, (tailProofStartedAt || topProofStartedAt || restoreStartedAt || now) - traversalStartedAt) : 0;
    diagnostics.timing.tailProofElapsedMs = tailProofStartedAt ? Math.max(0, (topProofStartedAt || restoreStartedAt || now) - tailProofStartedAt) : 0;
    diagnostics.timing.topProofElapsedMs = topProofStartedAt ? Math.max(0, (restoreStartedAt || now) - topProofStartedAt) : 0;
    diagnostics.timing.restoreElapsedMs = restoreStartedAt ? Math.max(0, now - restoreStartedAt) : 0;
    return {
      snapshots,
      startReached,
      startPositionProof: diagnostics.startProven,
      tailProven: diagnostics.tailProven,
      snapshotStable,
      iterations,
      reason,
      scrollRestored: diagnostics.scrollRestored,
      diagnostics
    };
  }

  async readConversationTurns({
    maxTurns = 100,
    maxCharsPerTurn = 100_000,
    maxTotalChars = 1_000_000,
    historyMode = 'visible',
    historyTimeoutMs = DEFAULT_CONVERSATION_HISTORY_TIMEOUT_MS,
    historyMaxIterations = DEFAULT_CONVERSATION_HISTORY_ITERATIONS
  } = {}) {
    const limits = {
      maxTurns: Number(maxTurns),
      maxCharsPerTurn: Number(maxCharsPerTurn),
      maxTotalChars: Number(maxTotalChars)
    };
    const mode = String(historyMode || '').trim().toLowerCase();
    const historyOptions = {
      historyMode: mode,
      historyTimeoutMs: Number(historyTimeoutMs),
      historyMaxIterations: Number(historyMaxIterations)
    };
    if (!Number.isInteger(limits.maxTurns) || limits.maxTurns < 1 || limits.maxTurns > MAX_CONVERSATION_TURNS) {
      throw new Error('conversation_turn_limits_invalid');
    }
    if (!Number.isInteger(limits.maxCharsPerTurn) || limits.maxCharsPerTurn < 1 || limits.maxCharsPerTurn > MAX_CONVERSATION_TURN_CHARS) {
      throw new Error('conversation_turn_limits_invalid');
    }
    if (!Number.isInteger(limits.maxTotalChars) || limits.maxTotalChars < 1 || limits.maxTotalChars > MAX_CONVERSATION_TOTAL_CHARS) {
      throw new Error('conversation_turn_limits_invalid');
    }
    validateConversationHistoryOptions(historyOptions);

    return await this.runExclusive(async () => {
      const result = mode === 'complete'
        ? await this.#readCompleteConversationTurns({
          limits,
          historyTimeoutMs: historyOptions.historyTimeoutMs,
          historyMaxIterations: historyOptions.historyMaxIterations
        })
        : mode === 'tail'
          ? await this.#readCompleteConversationTurns({
            limits,
            historyTimeoutMs: Math.min(historyOptions.historyTimeoutMs, CONVERSATION_TAIL_TIMEOUT_MS),
            historyMaxIterations: Math.min(historyOptions.historyMaxIterations, CONVERSATION_TAIL_MAX_ITERATIONS),
            tailOnly: true
          })
        : await this.#eval(`(() => {
        const maxTurns = ${limits.maxTurns};
        const maxCharsPerTurn = ${limits.maxCharsPerTurn};
        const maxTotalChars = ${limits.maxTotalChars};
        const messageSelector = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
        const excludedSelector = [
          'button', 'svg', '[role="button"]', 'form', 'textarea', 'input', 'select',
          '[contenteditable="true"]', '[data-testid*="copy" i]', '[data-testid*="feedback" i]',
          '[aria-label*="copy" i]', '[aria-label*="feedback" i]', '[data-testid*="composer" i]',
          '[aria-label*="composer" i]'
        ].join(',');
        const normalize = (value) => String(value || '')
          .replace(/\\u0000/g, '')
          .replace(/\\r\\n?/g, '\\n')
          .split('\\n')
          .map((line) => line.replace(/[ \\t]+$/u, ''))
          .join('\\n')
          .trim();
        const nodes = Array.from(document.querySelectorAll(messageSelector));
        const turns = [];

        for (let domIndex = 0; domIndex < nodes.length; domIndex += 1) {
          const node = nodes[domIndex];
          let parent = node.parentElement;
          let nested = false;
          while (parent) {
            if (parent.matches?.(messageSelector)) {
              nested = true;
              break;
            }
            parent = parent.parentElement;
          }
          if (nested) continue;

          const role = node.getAttribute('data-message-author-role');
          if (role !== 'user' && role !== 'assistant') continue;

          const clone = node.cloneNode(true);
          if (clone.matches?.(excludedSelector)) {
            clone.remove();
          } else {
            clone.querySelectorAll?.(excludedSelector).forEach((child) => child.remove());
          }
          const text = normalize(clone.innerText || clone.textContent || '');
          if (!text) continue;
          const directId = String(node.getAttribute('data-message-id') || '').trim();
          const nearestMessage = node.closest?.('[data-message-id]');
          const nearestTurn = node.closest?.('[data-turn-id]');
          const stableId = directId || String(nearestMessage?.getAttribute('data-message-id') || '').trim() || String(nearestTurn?.getAttribute('data-turn-id') || '').trim();
          turns.push({ role, text, index: domIndex, messageId: stableId || null });
        }

        const selectedTurns = turns.slice(Math.max(0, turns.length - maxTurns));
        let totalChars = 0;
        let limitExceeded = false;
        let limitKind = null;
        for (const turn of selectedTurns) {
          if (turn.text.length > maxCharsPerTurn) {
            limitExceeded = true;
            limitKind = 'per-turn';
            break;
          }
          if (totalChars + turn.text.length > maxTotalChars) {
            limitExceeded = true;
            limitKind = 'total';
            break;
          }
          totalChars += turn.text.length;
        }

        return { turns: selectedTurns, limitExceeded, limitKind };
      })()`);

      if (!result || result.limitExceeded) {
        const error = new Error(result?.limitKind === 'per-turn' ? 'conversation_turn_too_large' : 'conversation_too_large');
        error.data = {
          maxTurns: limits.maxTurns,
          maxCharsPerTurn: limits.maxCharsPerTurn,
          maxTotalChars: limits.maxTotalChars,
          limitKind: result?.limitKind || 'unknown'
        };
        throw error;
      }

      let turns = Array.isArray(result.turns)
        ? result.turns.map((turn) => {
          const role = turn?.role === 'user' || turn?.role === 'assistant' ? turn.role : null;
          const text = normalizeConversationText(turn?.text);
          const index = Number.isInteger(turn?.index) ? turn.index : -1;
          if (!role || !text || index < 0) return null;
          const messageId = typeof turn.messageId === 'string' ? turn.messageId.trim() : '';
          return {
            id: messageId || fallbackConversationTurnId({ role, index, text }),
            role,
            text,
            index
          };
        }).filter(Boolean).slice(-limits.maxTurns)
        : [];
      let history = historyMetadata({
        mode,
        reason: mode === 'visible' ? 'visible-window' : 'history-unproven',
        observedTurnCount: turns.length,
        returnedTurnCount: turns.length
      });
      if (mode === 'complete') {
        if (Array.isArray(result?.snapshots)) {
          const merged = mergeConversationSnapshots(result.snapshots);
          turns = merged.turns;
          let reason = result.reason || null;
          if (!reason && result.tailProven !== true) reason = 'history-tail-unproven';
          if (!reason && result.startPositionProof !== true) reason = 'history-start-unproven';
          if (!reason && merged.ambiguous) reason = 'merge-ambiguous';
          if (!reason && !merged.continuous) reason = 'history-gap';
          if (!reason && turns.length > limits.maxTurns) reason = 'turn-limit';
          if (result.diagnostics && typeof result.diagnostics === 'object') {
            result.diagnostics.mergeAmbiguous = merged.ambiguous;
            result.diagnostics.mergeContinuous = merged.continuous;
            result.diagnostics.mergeDiagnostics = merged.mergeDiagnostics;
          }
          history = historyMetadata({
            mode,
            complete: !reason && result.tailProven === true && result.startReached === true && result.startPositionProof === true && result.snapshotStable === true && merged.continuous && !merged.ambiguous,
            reason,
            startReached: result.startReached === true,
            snapshotStable: result.snapshotStable === true,
            iterations: result.iterations,
            observedTurnCount: merged.observedTurnCount,
            returnedTurnCount: Math.min(merged.turns.length, limits.maxTurns),
            scrollRestored: result.scrollRestored,
            diagnostics: result.diagnostics
          });
          turns = turns.slice(-limits.maxTurns);
        } else if (result?.history?.mode === 'complete') {
          history = historyMetadata({ ...result.history, mode: 'complete' });
        } else {
          const error = new Error('conversation_history_unproven');
          error.data = { reason: 'missing-history-metadata' };
          throw error;
        }
      } else if (mode === 'tail') {
        if (Array.isArray(result?.snapshots)) {
          const merged = mergeConversationSnapshots(result.snapshots);
          turns = merged.turns.slice(-limits.maxTurns);
          let reason = result.reason || null;
          if (!reason && result.tailProven !== true) reason = 'history-tail-unproven';
          if (!reason && merged.ambiguous) reason = 'merge-ambiguous';
          if (!reason && !merged.continuous) reason = 'history-gap';
          if (result.diagnostics && typeof result.diagnostics === 'object') {
            result.diagnostics.mergeAmbiguous = merged.ambiguous;
            result.diagnostics.mergeContinuous = merged.continuous;
            result.diagnostics.mergeDiagnostics = merged.mergeDiagnostics;
          }
          history = historyMetadata({
            mode,
            complete: false,
            reason,
            startReached: false,
            snapshotStable: result.snapshotStable === true,
            iterations: result.iterations,
            observedTurnCount: merged.observedTurnCount,
            returnedTurnCount: turns.length,
            scrollRestored: result.scrollRestored,
            diagnostics: result.diagnostics
          });
          history.scopeComplete = !reason;
          history.fullHistoryComplete = false;
          history.tailProven = result.tailProven === true;
          history.startReached = false;
        } else {
          const error = new Error('conversation_history_unproven');
          error.data = { reason: 'missing-tail-metadata' };
          throw error;
        }
      }
      let totalChars = 0;
      for (const turn of turns) {
        if (turn.text.length > limits.maxCharsPerTurn) {
          const error = new Error('conversation_turn_too_large');
          error.data = { ...limits, limitKind: 'per-turn' };
          throw error;
        }
        totalChars += turn.text.length;
        if (totalChars > limits.maxTotalChars) {
          const error = new Error('conversation_too_large');
          error.data = { ...limits, limitKind: 'total' };
          throw error;
        }
      }
      return { url: String(await this.getUrl()), turns, history };
    });
  }

  async detectChallenge() {
    return await this.#eval(`(() => {
      const url = location.href || '';
      const title = document.title || '';
      const readyState = document.readyState || '';
      const bodyText = (document.body?.innerText || '').slice(0, 5000);
      const iframeSrcs = Array.from(document.querySelectorAll('iframe'))
        .map(f => String(f.getAttribute('src') || ''))
        .filter(Boolean);
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const hasTurnstile = iframeSrcs.some(s => /turnstile/i.test(s)) || !!document.querySelector('iframe[src*=\"turnstile\" i]');
      const hasArkose = iframeSrcs.some(s => /arkoselabs|arkose/i.test(s)) || !!document.querySelector('iframe[src*=\"arkose\" i], iframe[src*=\"arkoselabs\" i]');
      const hasVerifyButton = Array.from(document.querySelectorAll('button, a'))
        .some(b => /verify you are human|human verification|i am human/i.test((b.textContent || '').trim()));

      const loginLike = !!document.querySelector('input[type=\"password\"], input[name=\"password\"], input[autocomplete=\"current-password\"]')
        || /log in|sign in|continue with/i.test(bodyText);

      const rawPromptVisible = (() => {
        const pickPrompt = (nodes) => {
          const editable = (n) => {
            if (!n) return false;
            if (!visible(n)) return false;
            if (n.matches('textarea')) return !n.disabled && !n.readOnly;
            if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
            return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
          };
          const score = (n) => {
            const r = n.getBoundingClientRect();
            const label = [
              n.getAttribute('aria-label') || '',
              n.getAttribute('placeholder') || '',
              n.getAttribute('name') || '',
              n.getAttribute('id') || '',
              n.getAttribute('data-testid') || ''
            ].join(' ').toLowerCase();
            let s = 0;
            if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
            if (n.matches('textarea')) s += 50;
            if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
            if (n.getAttribute('role') === 'textbox') s += 25;
            if (r.width >= 260 && r.height >= 26) s += 20;
            s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
            s += Math.max(0, r.y / 8);
            return s;
          };
          let best = null;
          let bestScore = -Infinity;
          for (const n of nodes) {
            if (!editable(n)) continue;
            const s = score(n);
            if (s > bestScore) {
              bestScore = s;
              best = n;
            }
          }
          return best;
        };

        const base = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        return !!pickPrompt(uniq);
      })();

      const sendVisible = (() => {
        const labelOf = (n) =>
          [
            n.getAttribute('aria-label') || '',
            n.getAttribute('title') || '',
            n.getAttribute('data-testid') || '',
            n.textContent || ''
          ]
            .join(' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();
        return Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.sendButton)})).some((n) => {
          if (!visible(n)) return false;
          const label = labelOf(n);
          if (/stop|cancel|retry|signin|sign in|log in|login|continue with|google|microsoft|apple/.test(label)) return false;
          return /send|submit|run|go|ask|reply/.test(label) || n.matches('[data-testid=\"send-button\"], [aria-label=\"Send prompt\"], [aria-label=\"Send\"]');
        });
      })();
      const promptVisible = rawPromptVisible && (!loginLike || sendVisible);
      const challengeText = (() => {
        const clone = document.body?.cloneNode?.(true);
        if (!clone) return bodyText;
        for (const node of clone.querySelectorAll?.('textarea, input, [contenteditable=\"true\"], [role=\"textbox\"]') || []) {
          node.remove?.();
        }
        return String(clone.innerText || clone.textContent || '').slice(0, 5000);
      })();
      const looks403 = !promptVisible && /\\b403\\b|access denied|forbidden|unusual traffic|verify you are human|human verification|i am human/i.test(challengeText);

      const blocked = hasTurnstile || hasArkose || hasVerifyButton || looks403 || (loginLike && !promptVisible);
      const kind = (hasTurnstile || hasArkose || hasVerifyButton) ? 'captcha' : (loginLike ? 'login' : (looks403 ? 'blocked' : null));
      return {
        url, title, readyState,
        blocked,
        promptVisible,
        kind,
        indicators: { hasTurnstile, hasArkose, hasVerifyButton, looks403, loginLike, rawPromptVisible, sendVisible }
      };
    })()`);

    return result;
  }

  async waitForPromptVisible({ timeoutMs = 10 * 60_000, pollMs = 500 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const st = await this.detectChallenge().catch(() => null);
      if (st?.blocked) await this.#enterBlockedState(st);
      if (st?.promptVisible) return st;

      const elapsed = Date.now() - start;
      if (!this.blocked && elapsed > 5000 && st?.readyState === 'complete') {
        await this.#enterBlockedState({ ...(st || {}), blocked: true, kind: 'ui' });
      }
      await sleep(pollMs);
    }
    const last = await this.detectChallenge().catch(() => null);
    const err = new Error('timeout_waiting_for_prompt');
    err.data = last;
    throw err;
  }

  async ensureReady({ timeoutMs = 10 * 60_000 } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_ready', blocked: false, blockedKind: null, blockedTitle: null });
    const st = await this.detectChallenge().catch(() => null);
    if (st?.blocked) {
      await this.#enterBlockedState(st);
    }
    const ready = await this.waitForPromptVisible({ timeoutMs });
    await this.#exitBlockedStateIfNeeded();
    return ready;
  }

  async #enterBlockedState(st) {
    if (!this.blocked) {
      this.blocked = true;
      this.blockedKind = st?.kind || null;
      await this.#emitProgress({
        phase: 'awaiting_user',
        blocked: true,
        blockedKind: this.blockedKind || 'blocked',
        blockedTitle: blockedTitle(this.blockedKind)
      });
      await this.onBlocked?.(st);
    }
  }

  async #exitBlockedStateIfNeeded() {
    if (this.blocked) {
      this.blocked = false;
      this.blockedKind = null;
      await this.#emitProgress({ blocked: false, blockedKind: null, blockedTitle: null });
      await this.onUnblocked?.();
    }
  }

  async #sendKey(key, { modifiers = [] } = {}) {
    await this.page.sendKey(key, { modifiers });
  }

  #throwIfStopRequested() {
    if (!this.currentRun?.requested) return;
    const err = queryAbortedError(this.currentRun.reason || 'user_stop');
    err.data.requestedAt = this.currentRun.requestedAt || null;
    throw err;
  }

  #bindRunSignal(run, signal) {
    if (!signal) return () => {};
    const onAbort = () => {
      if (this.currentRun !== run) return;
      run.requested = true;
      run.requestedAt = Date.now();
      run.reason = 'user_stop';
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    return () => signal.removeEventListener('abort', onAbort);
  }

  async #clickVisibleStop({ expectedToken = null } = {}) {
    if (expectedToken && this.currentRun?.providerStopToken !== expectedToken) {
      return { ok: true, state: 'mismatch', clicked: false, reason: 'provider_stop_token_mismatch' };
    }
    return await this.#arbitrateProviderStop(this.currentRun);
  }

  async requestStop({ reason = 'user_stop', expectedOperationId = null } = {}) {
    const run = this.currentRun;
    if (!run) return { ok: true, requested: false, clicked: false, reason: 'no_matching_run' };
    if (expectedOperationId && run.operationId !== expectedOperationId) {
      return { ok: true, requested: false, clicked: false, reason: 'operation_mismatch' };
    }
    if (run.providerStopRetired) {
      return { ok: true, requested: false, clicked: false, reason: 'provider_stop_retired' };
    }
    run.requested = true;
    run.requestedAt = Date.now();
    run.reason = reason || 'user_stop';
    const stopResult = await this.#clickVisibleStop({ expectedToken: run.providerStopToken }).catch(() => null);
    const clicked = stopResult === true || stopResult?.clicked === true;
    if (stopResult?.state === 'cancelled') {
      run.dispatchState = 'cancelled';
      return { ok: true, requested: true, clicked: false, reason: 'before_dispatch' };
    }
    return {
      ok: true,
      requested: true,
      clicked,
      reason: stopResult?.reason || (stopResult?.state === 'mismatch' ? 'provider_stop_token_mismatch' : clicked ? 'provider_stop_clicked' : 'provider_stop_not_found')
    };
  }

  retireProviderStop({ expectedOperationId = null } = {}) {
    const owner = this.providerStopOwner;
    if (!owner || (expectedOperationId && owner.operationId !== expectedOperationId)) {
      return { ok: true, retired: false, reason: 'operation_mismatch' };
    }
    this.#retireProviderStopOwner(owner);
    this.#scheduleProviderStopStateScript(owner, { action: 'release' });
    return { ok: true, retired: true };
  }

  async #typeHuman(text) {
    this.#throwIfStopRequested();
    await this.page.insertText(String(text));
  }

  async #moveMouseTo(x, y) {
    const from = { ...this.mouse };
    const steps = Math.max(6, Math.min(22, Math.floor(Math.hypot(x - from.x, y - from.y) / 35)));
    for (let i = 1; i <= steps; i++) {
      this.#throwIfStopRequested();
      const t = i / steps;
      const nx = Math.round(from.x + (x - from.x) * t + jitter(-2, 2));
      const ny = Math.round(from.y + (y - from.y) * t + jitter(-2, 2));
      await this.page.moveMouse(nx, ny);
      await sleep(jitter(6, 18));
      this.mouse = { x: nx, y: ny };
    }
  }

  async #clickAt(x, y, { onBeforeMouseDown = null, onBeforeMouseDownAsync = null } = {}) {
    await this.#moveMouseTo(x, y);
    this.#throwIfStopRequested();
    await onBeforeMouseDownAsync?.();
    if (onBeforeMouseDown) onBeforeMouseDown();
    else this.#throwIfStopRequested();
    await this.page.mouseDown(x, y, { button: 'left', clickCount: 1 });
    await sleep(jitter(20, 60));
    await this.page.mouseUp(x, y, { button: 'left', clickCount: 1 });
  }

  async #typePrompt(prompt) {
    await this.#emitProgress({ phase: 'typing_prompt' });
    const sel = JSON.stringify(this.selectors.promptTextarea);
    let ok;
    try {
      ok = await this.#eval(`(async () => {
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const score = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8); // lower on page is more likely the composer
        return s;
      };
      const base = Array.from(document.querySelectorAll(${sel}));
      const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
      const candidates = [];
      const seen = new Set();
      for (const n of [...base, ...fallback]) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        candidates.push(n);
      }
      let el = null;
      let best = -Infinity;
      for (const n of candidates) {
        if (!editable(n)) continue;
        const s = score(n);
        if (s > best) {
          best = s;
          el = n;
        }
      }
      if (!el) return { ok:false, error:'missing_prompt_textarea' };
      el.focus();
      const r = el.getBoundingClientRect();
      const userTurns = Array.from(document.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]'));
      const lastUserTurn = userTurns[userTurns.length - 1] || null;
      const lastUserId = lastUserTurn
        ? [lastUserTurn.getAttribute('data-message-id'), lastUserTurn.id, lastUserTurn.getAttribute('data-testid')]
          .map((value) => String(value || '').trim()).find(Boolean) || ''
        : '';
      const normalizeUserTurnText = ${normalizeUserTurnText.toString()};
      const lastUserText = String(lastUserTurn?.innerText || '');
      const lastUserTextDigest = await (async (value) => {
        const bytes = new TextEncoder().encode(normalizeUserTurnText(value));
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      })(lastUserText);
      return {
        ok:true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        userTurnBaseline: {
          count: userTurns.length,
          lastId: lastUserId,
          lastTextDigest: lastUserTextDigest,
          lastText: lastUserText
        }
      };
      })()`);
    } catch (error) {
      if (error?.message === 'browser_evaluation_failed') {
        error.data = { ...(error.data && typeof error.data === 'object' ? error.data : {}), phase: 'typing_prompt' };
      }
      throw error;
    }
    if (!ok?.ok) {
      const err = new Error(ok?.error || 'type_failed');
      err.data = ok === undefined
        ? { phase: 'typing_prompt', reason: 'evaluation_result_unavailable' }
        : { ...(ok && typeof ok === 'object' ? ok : {}), phase: 'typing_prompt' };
      throw err;
    }
    const userTurnBaseline = normalizeUserTurnBaseline(ok.userTurnBaseline);
    if (this.currentRun) this.currentRun.userTurnBaseline = userTurnBaseline;
    ok.userTurnBaseline = userTurnBaseline;

    // Human-like click + select-all + type.
    if (ok?.rect?.w > 0 && ok?.rect?.h > 0) {
      const cx = Math.round(ok.rect.x + Math.min(ok.rect.w - 6, 18));
      const cy = Math.round(ok.rect.y + Math.min(ok.rect.h - 6, 18));
      await this.#clickAt(cx, cy);
    }

    const isMac = process.platform === 'darwin';
    await sleep(jitter(25, 80));
    await this.#sendKey('A', { modifiers: [isMac ? 'meta' : 'control'] });
    await sleep(jitter(15, 50));
    await this.#sendKey('Backspace');
    await sleep(jitter(25, 80));
    await this.#typeHuman(prompt);
    const expectedPromptText = normalizeUserTurnText(prompt);
    const readTypedPrompt = async () => await this.#eval(`(() => {
      const agentifyPromptTypeVerification = true;
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (n) => {
        if (!n || !visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const candidates = Array.from(document.querySelectorAll(${sel}));
      const node = editable(document.activeElement) ? document.activeElement : candidates.find(editable);
      if (!node) return { ok: false, reason: 'prompt_not_found', promptTextLength: 0 };
      const text = node.matches('textarea, input') ? String(node.value || '') : String(node.innerText || node.textContent || '');
      const normalized = text.replace(/\\s+/g, ' ').trim();
      return { ok: normalized === ${JSON.stringify(expectedPromptText)}, promptTextLength: text.length, promptLength: text.length, promptText: text };
    })()`);
    let typedPrompt = await readTypedPrompt();
    if (!typedPrompt?.ok) {
      const cleared = await this.#eval(`(() => {
        const agentifyPromptTypeClear = true;
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const editable = (n) => {
          if (!n || !visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const node = editable(document.activeElement) ? document.activeElement : Array.from(document.querySelectorAll(${sel})).find(editable);
        if (!node) return { ok: false, reason: 'prompt_not_found', promptTextLength: 0 };
        try {
          node.focus();
          if (node.matches('textarea')) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) setter.call(node, ''); else node.value = '';
          } else if (node.matches('input')) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(node, ''); else node.value = '';
          } else {
            node.textContent = '';
          }
          node.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward', data: null }));
          node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return { ok: true, promptTextLength: 0 };
        } catch (error) {
          return { ok: false, reason: 'prompt_clear_failed', promptTextLength: 0 };
        }
      })()`);
      if (!cleared?.ok) {
        const error = new Error('type_failed');
        error.data = { phase: 'typing_prompt', reason: cleared?.reason || 'prompt_clear_failed', expectedPromptTextLength: expectedPromptText.length, actualPromptTextLength: Number(typedPrompt?.promptTextLength) || 0 };
        throw error;
      }
      await this.#typeHuman(prompt);
      const retried = await readTypedPrompt();
      if (!retried?.ok) {
        const error = new Error('type_failed');
        error.data = { phase: 'typing_prompt', reason: 'prompt_verification_mismatch', expectedPromptTextLength: expectedPromptText.length, actualPromptTextLength: Number(retried?.promptTextLength) || 0 };
        throw error;
      }
      typedPrompt = retried;
    }
    this.#throwIfStopRequested();
    const verifiedPromptText = typeof typedPrompt?.promptText === 'string' ? typedPrompt.promptText : prompt;
    return { ...ok, promptDigest: textDigest(verifiedPromptText), promptLength: Number(typedPrompt?.promptLength) || verifiedPromptText.length };
  }

  async #captureUserTurnBaseline() {
    const result = await this.#eval(`(async () => {
      const agentifyUserTurnBaseline = true;
      const userTurns = Array.from(document.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]'));
      const lastUserTurn = userTurns[userTurns.length - 1] || null;
      const lastUserId = lastUserTurn
        ? [lastUserTurn.getAttribute('data-message-id'), lastUserTurn.id, lastUserTurn.getAttribute('data-testid')]
          .map((value) => String(value || '').trim()).find(Boolean) || ''
        : '';
      const normalizeUserTurnText = ${normalizeUserTurnText.toString()};
      const lastUserText = String(lastUserTurn?.innerText || '');
      const bytes = new TextEncoder().encode(normalizeUserTurnText(lastUserText));
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      const lastTextDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      return { count: userTurns.length, lastId: lastUserId, lastTextDigest };
    })()`);
    const baseline = normalizeUserTurnBaseline(result);
    if (this.currentRun) this.currentRun.userTurnBaseline = baseline;
    return baseline;
  }

  async #waitForSendSignal({ timeoutMs = 1800, pollMs = 120, sendBaseline = null } = {}) {
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const start = Date.now();
    const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const baseline = {
      userCount: Math.max(0, Number(sendBaseline?.userCount) || 0),
      lastUserId: String(sendBaseline?.lastUserId || '').trim(),
      lastUserTextDigest: /^[0-9a-f]{64}$/u.test(String(sendBaseline?.lastUserTextDigest || '').trim().toLowerCase())
        ? String(sendBaseline.lastUserTextDigest).trim().toLowerCase()
        : typeof sendBaseline?.lastUserText === 'string' ? userTurnTextDigest(sendBaseline.lastUserText) : '',
      activePromptText: normalizeText(sendBaseline?.activePromptText),
      activePromptTextDigest: /^[0-9a-f]{64}$/u.test(String(sendBaseline?.activePromptTextDigest || '').trim().toLowerCase())
        ? String(sendBaseline.activePromptTextDigest).trim().toLowerCase()
        : userTurnTextDigest(sendBaseline?.activePromptText || ''),
      activePromptTextLength: Math.max(0, Number(sendBaseline?.activePromptTextLength) || 0)
    };
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(async () => {
        const host = location.hostname || '';
        const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        if (isChatGPT) {
          const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();
          const normalizeUserTurnText = ${normalizeUserTurnText.toString()};
          const digestUserText = async (value) => {
            const bytes = new TextEncoder().encode(normalizeUserTurnText(value));
            const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
          };
          const editable = (n) => {
            if (!n || !visible(n)) return false;
            if (n.matches('textarea')) return !n.disabled && !n.readOnly;
            if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
            return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
          };
          const promptScore = (n) => {
            const r = n.getBoundingClientRect();
            const label = [
              n.getAttribute('aria-label') || '',
              n.getAttribute('placeholder') || '',
              n.getAttribute('name') || '',
              n.getAttribute('id') || '',
              n.getAttribute('data-testid') || ''
            ].join(' ').toLowerCase();
            let score = 0;
            if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
            if (n.matches('textarea')) score += 50;
            if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') score += 35;
            if (n.getAttribute('role') === 'textbox') score += 25;
            if (r.width >= 260 && r.height >= 26) score += 20;
            score += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
            score += Math.max(0, r.y / 8);
            return score;
          };
          const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
          const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
          const candidates = [];
          const seen = new Set();
          for (const node of [...promptCandidates, ...fallback]) {
            if (!node || seen.has(node)) continue;
            seen.add(node);
            candidates.push(node);
          }
          let activePrompt = null;
          let bestScore = -Infinity;
          for (const node of candidates) {
            if (!editable(node)) continue;
            const score = promptScore(node);
            if (score > bestScore) {
              bestScore = score;
              activePrompt = node;
            }
          }
          const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
          const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]';
          let chatgptComposer = activePrompt?.closest('form') || null;
          for (let node = activePrompt?.parentElement || null; !chatgptComposer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) chatgptComposer = node;
          }
          const normalSend = chatgptComposer ? Array.from(chatgptComposer.querySelectorAll(chatgptSendSel)).find(visible) : null;
          const normalStopVisible = !!(chatgptComposer && Array.from(chatgptComposer.querySelectorAll(chatgptStopSel)).find(visible));
          const chatgptUserTurns = Array.from(document.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]'));
          const lastUserTurn = chatgptUserTurns[chatgptUserTurns.length - 1] || null;
          const lastUserId = lastUserTurn
            ? [
                lastUserTurn.getAttribute('data-message-id'),
                lastUserTurn.id,
                lastUserTurn.getAttribute('data-testid')
              ].map((value) => String(value || '').trim()).find(Boolean) || ''
            : '';
          const activePromptText = activePrompt?.matches('textarea, input')
            ? String(activePrompt.value || '')
            : String(activePrompt?.innerText || activePrompt?.textContent || '');
          return {
            isChatGPT: true,
            userCount: chatgptUserTurns.length,
            lastUserId,
            lastUserTextDigest: await digestUserText(lastUserTurn?.innerText || ''),
            activePromptText: normalizeText(activePromptText),
            activePromptTextDigest: await digestUserText(activePromptText),
            activePromptTextLength: normalizeText(activePromptText).length,
            hasNormalSend: !!normalSend,
            normalStopVisible
          };
        }
        const stopVisible = Array.from(document.querySelectorAll(${stopSel})).some(visible);
        const send = Array.from(document.querySelectorAll(${sendSel})).find(visible);
        const sendDisabled = !!send && !!send.disabled;

        const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        let promptLen = -1;
        for (const n of uniq) {
          if (!visible(n)) continue;
          if (n.matches('textarea, input')) {
            promptLen = String(n.value || '').trim().length;
            break;
          }
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox') {
            promptLen = String(n.innerText || n.textContent || '').trim().length;
            break;
          }
        }
        return { stopVisible, sendDisabled, promptLen };
      })()`);

      if (snap?.isChatGPT) {
        const userCountIncreased = (snap.userCount || 0) > baseline.userCount;
        const userIdChanged = !!baseline.lastUserId && !!snap.lastUserId && baseline.lastUserId !== snap.lastUserId;
        const lastUserTextDigest = /^[0-9a-f]{64}$/u.test(String(snap.lastUserTextDigest || '').trim().toLowerCase())
          ? String(snap.lastUserTextDigest).trim().toLowerCase()
          : typeof snap.lastUserText === 'string' ? userTurnTextDigest(snap.lastUserText) : '';
        const userTextMatchesPrompt =
          baseline.activePromptTextLength >= 1 &&
          lastUserTextDigest === baseline.activePromptTextDigest &&
          lastUserTextDigest !== baseline.lastUserTextDigest;
        const promptWasCleared = baseline.activePromptTextLength >= 1 && snap.activePromptTextLength === 0;
        const normalStopConfirmsSend = snap.normalStopVisible && snap.activePromptTextLength === 0;
        if (userCountIncreased || userIdChanged || userTextMatchesPrompt || promptWasCleared || normalStopConfirmsSend) return true;
        await sleep(pollMs);
        continue;
      }

      if (snap?.stopVisible || snap?.sendDisabled || snap?.promptLen === 0) return true;
      await sleep(pollMs);
    }
    return false;
  }

  #recordSendConfirmation(sent) {
    if (sent && this.currentRun) this.currentRun.sendConfirmed = true;
    return sent;
  }

  #recordSendAttemptCompleted(completed) {
    if (completed && this.currentRun) this.currentRun.sendAttemptCompleted = true;
    return completed;
  }

  #canCleanupUnsentDraft(run) {
    if ((!run?.promptTyped && !run?.attachmentOwnershipEstablished) || run.sendConfirmed) return false;
    if (run.dispatchStateUnknown && !run.sendConfirmationTimedOut) return false;
    if (run.requested && run.messageDispatchStarted) return false;
    return run.sendAttemptCompleted || !run.messageDispatchStarted || run.sendConfirmationTimedOut;
  }

  async #tryChatGPTExactSubmissionFallback({ sendBaseline, action, allowRetry = false }) {
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const dispatchGeneration = this.#providerStopGeneration(this.currentRun);
    const dispatchSequence = this.#providerStopSequence(this.currentRun);
    const dispatchToken = JSON.stringify(this.currentRun?.providerStopToken || null);
    const fallbackBaselineName = action === 'dom_click' ? 'clickFallbackBaselineText' : 'submitFallbackBaselineText';
    const fallbackBaselineText = String(sendBaseline?.activePromptText || '').replace(/\s+/g, ' ').trim();
    const actionCode = action === 'dom_click'
      ? `normalSend.click();
          return { attempted: true, lastFallbackResult: 'dom_click' };`
      : `const form = chatgptComposer?.matches('form') ? chatgptComposer : chatgptComposer?.closest('form') || null;
          if (!form || typeof form.requestSubmit !== 'function' || normalSend.form !== form) {
            return { attempted: false, lastFallbackResult: 'active_composer_form_not_found' };
          }
          try {
            form.requestSubmit(normalSend);
            return { attempted: true, lastFallbackResult: 'request_submit_with_button' };
          } catch (error) {
            if (!(error instanceof TypeError)) {
              return { attempted: false, lastFallbackResult: 'request_submit_with_button_failed' };
            }
            try {
              form.requestSubmit();
              return { attempted: true, lastFallbackResult: 'request_submit_without_button' };
            } catch {
              return { attempted: false, lastFallbackResult: 'request_submit_without_button_failed' };
            }
          }`;
    let result;
    try {
      result = await this.#eval(`(() => {
      const agentifyStopTokenDispatchAction = true;
      const host = location.hostname || '';
      const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
      if (!isChatGPT) return { attempted: false, lastFallbackResult: 'not_chatgpt' };
      const ${fallbackBaselineName} = ${JSON.stringify(fallbackBaselineText)};
      const normalizeText = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const disabled = (n) => !!n?.disabled || String(n?.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const editable = (n) => {
        if (!n || !visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const promptScore = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let score = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
        if (n.matches('textarea')) score += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') score += 35;
        if (n.getAttribute('role') === 'textbox') score += 25;
        if (r.width >= 260 && r.height >= 26) score += 20;
        score += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        score += Math.max(0, r.y / 8);
        return score;
      };
      const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
      const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
      const candidates = [];
      const seen = new Set();
      for (const node of [...promptCandidates, ...fallback]) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
      let activePrompt = null;
      let bestScore = -Infinity;
      for (const node of candidates) {
        if (!editable(node)) continue;
        const score = promptScore(node);
        if (score > bestScore) {
          bestScore = score;
          activePrompt = node;
        }
      }
      if (!activePrompt) return { attempted: false, lastFallbackResult: 'active_prompt_not_found' };
      const activePromptText = activePrompt.matches('textarea, input')
        ? String(activePrompt.value || '')
        : String(activePrompt.innerText || activePrompt.textContent || '');
      if (normalizeText(activePromptText) !== ${fallbackBaselineName}) {
        return { attempted: false, lastFallbackResult: 'prompt_changed' };
      }
      const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
      const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]';
      let chatgptComposer = activePrompt.closest('form') || null;
      for (let node = activePrompt.parentElement || null; !chatgptComposer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) chatgptComposer = node;
      }
      if (!chatgptComposer) return { attempted: false, lastFallbackResult: 'active_composer_not_found' };
      const normalSend = Array.from(chatgptComposer.querySelectorAll(chatgptSendSel)).find(visible);
      const normalStop = Array.from(chatgptComposer.querySelectorAll(chatgptStopSel)).find(visible);
      if (!normalSend) return { attempted: false, lastFallbackResult: 'normal_send_not_found' };
      if (disabled(normalSend)) return { attempted: false, lastFallbackResult: 'normal_send_disabled' };
      if (normalStop) return { attempted: false, lastFallbackResult: 'normal_stop_visible' };
      const providerStopState = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
        ? globalThis.__agentifyProviderStopState
        : null;
      const providerStopGeneration = Number(providerStopState?.generation);
      const providerStopSequence = Number(providerStopState?.sequence);
      const providerStopRetiredSequence = Number(providerStopState?.retiredSequence);
      const providerStopDispatchState = providerStopState?.dispatch?.state;
      const exactProviderStopState = Number.isSafeInteger(providerStopGeneration) && Number.isSafeInteger(providerStopSequence) &&
        Number.isSafeInteger(providerStopRetiredSequence) && providerStopGeneration === ${dispatchGeneration} &&
        providerStopSequence === ${dispatchSequence} && providerStopState?.token === ${dispatchToken} && providerStopState?.stopRequested !== true &&
        providerStopRetiredSequence < ${dispatchSequence};
      const canClaimDispatch = exactProviderStopState && (
        providerStopDispatchState === 'pending' ||
        (${allowRetry ? 'true' : 'false'} && ['claimed', 'dispatching', 'dispatched'].includes(providerStopDispatchState))
      );
      if (!canClaimDispatch) return { attempted: false, providerStopDispatchUnavailable: true, dispatchState: exactProviderStopState ? providerStopDispatchState || 'unknown' : 'mismatch', lastFallbackResult: 'provider_stop_token_not_active' };
      const claimedFromPending = ['pending', 'claimed'].includes(providerStopDispatchState);
      globalThis.__agentifyProviderStopState = {
        ...providerStopState,
        dispatch: { generation: ${dispatchGeneration}, sequence: ${dispatchSequence}, state: 'dispatching' }
      };
      let actionResult;
      try {
        actionResult = (() => { ${actionCode} })();
      } catch {
        globalThis.__agentifyProviderStopState = {
          ...globalThis.__agentifyProviderStopState,
          dispatch: { generation: ${dispatchGeneration}, sequence: ${dispatchSequence}, state: 'dispatched' }
        };
        return { attempted: false, dispatchClaimed: true, dispatchState: 'dispatched', providerStopDispatchUnknown: true, lastFallbackResult: 'dispatch_action_error' };
      }
      if (!actionResult?.attempted) {
        if (claimedFromPending) {
          globalThis.__agentifyProviderStopState = {
            ...globalThis.__agentifyProviderStopState,
            dispatch: { generation: ${dispatchGeneration}, sequence: ${dispatchSequence}, state: providerStopDispatchState === 'claimed' ? 'claimed' : 'pending' }
          };
        }
        return actionResult;
      }
      globalThis.__agentifyProviderStopState = {
        ...globalThis.__agentifyProviderStopState,
        dispatch: { generation: ${dispatchGeneration}, sequence: ${dispatchSequence}, state: 'dispatched' }
      };
      return { ...actionResult, dispatchClaimed: true, dispatchState: 'dispatched' };
    })()`);
    } catch (error) {
      await this.#reconcileProviderStopDispatch(this.currentRun);
      throw error;
    }
    if (result?.dispatchClaimed) {
      this.currentRun.messageDispatchStarted = true;
      this.currentRun.dispatchState = result.dispatchState || 'dispatched';
    }
    if (result?.providerStopDispatchUnknown) {
      this.currentRun.dispatchStateUnknown = true;
    }
    if (result?.providerStopDispatchUnavailable) {
      this.currentRun.dispatchState = result.dispatchState || 'unknown';
      if (result.dispatchState !== 'pending' && result.dispatchState !== 'cancelled' && result.dispatchState !== 'mismatch') this.currentRun.dispatchStateUnknown = true;
      throw this.#providerStopDispatchError('dispatch');
    }
    return result;
  }

  async #clickSend({ timeoutMs = 5_000 } = {}) {
    await this.#emitProgress({ phase: 'sending_prompt' });
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const chatgptSignalTimeoutMs = Math.min(5_000, Math.max(0, Number(timeoutMs) || 0));
    const sendConfirmationTimeoutMs = this.sendConfirmationTimeoutMs;
    const sendDeadline = Date.now() + sendConfirmationTimeoutMs;
    const sendTimeoutError = (step) => {
      if (this.currentRun) this.currentRun.sendConfirmationTimedOut = true;
      const error = new Error('send_not_triggered');
      error.data = {
        phase: 'sending_prompt',
        reason: 'send_confirmation_timeout',
        step,
        timeoutMs: sendConfirmationTimeoutMs
      };
      return error;
    };
    const assertSendBudget = (step) => {
      if (Date.now() >= sendDeadline) throw sendTimeoutError(step);
    };
    const awaitSendStep = async (operation, step, { timeoutMs = null } = {}) => {
      assertSendBudget(step);
      const remainingMs = Math.max(1, sendDeadline - Date.now());
      const stepBudgetMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Math.min(remainingMs, Math.floor(Number(timeoutMs)))
        : remainingMs;
      const evaluation = Promise.resolve().then(operation);
      let timer = null;
      let settled = false;
      return await new Promise((resolve, reject) => {
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          handler(value);
        };
        timer = setTimeout(() => finish(reject, sendTimeoutError(step)), stepBudgetMs);
        evaluation.then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error)
        ).catch(() => {});
      });
    };
    const evaluateSendStep = async (js, step) => awaitSendStep(() => this.#eval(js), step);
    const waitForSendConfirmation = async () => {
      assertSendBudget('signal_wait');
      const result = await this.#waitForSendSignal({
        timeoutMs: Math.min(chatgptSignalTimeoutMs, Math.max(0, sendDeadline - Date.now())),
        pollMs: 120,
        sendBaseline: res?.sendBaseline
      });
      assertSendBudget('signal_wait');
      return result;
    };
    const res = await evaluateSendStep(`(async () => {
      const host = location.hostname || '';
      const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const labelOf = (n) =>
        [
          n.getAttribute('aria-label') || '',
          n.getAttribute('title') || '',
          n.getAttribute('data-testid') || '',
          n.textContent || ''
        ]
          .join(' ')
          .replace(/\\s+/g, ' ')
          .trim()
          .toLowerCase();
      const promptScore = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8);
        return s;
      };
      const pickPrompt = () => {
        const base = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const candidates = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          candidates.push(n);
        }
        let best = null;
        let bestScore = -Infinity;
        for (const n of candidates) {
          if (!editable(n)) continue;
          const s = promptScore(n);
          if (s > bestScore) {
            bestScore = s;
            best = n;
          }
        }
        return best;
      };
      const prompt = pickPrompt();
      const composerRoot =
        prompt?.closest('form') ||
        prompt?.closest('[data-testid*=\"composer\" i], [data-testid*=\"prompt\" i], [data-testid*=\"chat-input\" i], [aria-label*=\"message\" i], [aria-label*=\"prompt\" i]') ||
        prompt?.closest('main') ||
        null;
      const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
      const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]';
      if (isChatGPT) {
        let chatgptComposer = prompt?.closest('form') || null;
        for (let node = prompt?.parentElement || null; !chatgptComposer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) chatgptComposer = node;
        }
        const normalSend = chatgptComposer
          ? Array.from(chatgptComposer.querySelectorAll(chatgptSendSel)).find(visible)
          : null;
        const normalStop = chatgptComposer
          ? Array.from(chatgptComposer.querySelectorAll(chatgptStopSel)).find(visible)
          : null;
        const chatgptUserTurns = Array.from(document.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]'));
        const lastUserTurn = chatgptUserTurns[chatgptUserTurns.length - 1] || null;
        const lastUserId = lastUserTurn
          ? [
              lastUserTurn.getAttribute('data-message-id'),
              lastUserTurn.id,
              lastUserTurn.getAttribute('data-testid')
          ].map((value) => String(value || '').trim()).find(Boolean) || ''
            : '';
        const normalizeUserTurnText = ${normalizeUserTurnText.toString()};
        const digestUserText = async (value) => {
          const bytes = new TextEncoder().encode(normalizeUserTurnText(value));
          const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
          return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        };
        const activePromptText = prompt?.matches('textarea, input')
          ? String(prompt.value || '')
          : String(prompt?.innerText || prompt?.textContent || '');
        const sendBaseline = {
          userCount: chatgptUserTurns.length,
          lastUserId,
          lastUserTextDigest: await digestUserText(lastUserTurn?.innerText || ''),
          activePromptText: activePromptText.trim(),
          activePromptTextDigest: await digestUserText(activePromptText),
          activePromptTextLength: activePromptText.trim().length
        };
        if (normalStop && (!normalSend || disabled(normalSend))) {
          return { ok: false, error: 'already_generating', isChatGPT: true, host, sendBaseline };
        }
        if (normalSend && disabled(normalSend)) {
          return { ok: false, error: 'send_button_disabled', isChatGPT: true, host, sendBaseline };
        }
        if (normalSend) {
          const rect = normalSend.getBoundingClientRect();
          return {
            ok: true,
            isChatGPT: true,
            fallbackEnter: false,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            requestSubmit: !!prompt?.closest('form'),
            host,
            sendBaseline
          };
        }
        return {
          ok: true,
          isChatGPT: true,
          fallbackEnter: true,
          requestSubmit: !!prompt?.closest('form'),
          host,
          sendBaseline
        };
      }
      const stop = Array.from(document.querySelectorAll(${stopSel})).find(visible);
      if (stop) return { ok: false, error: 'already_generating', host };
      const promptRect = prompt ? prompt.getBoundingClientRect() : null;
      const score = (n) => {
        const r = n.getBoundingClientRect();
        const label = labelOf(n);
        let s = 0;
        if (n.matches(${sendSel})) s += 120;
        if (/send|submit|run|go|ask|reply/.test(label)) s += 90;
        if (/stop|cancel|retry|signin|sign in|log in|google/.test(label)) s -= 140;
        if (n.getAttribute('type') === 'submit') s += 35;
        if (composerRoot && composerRoot.contains(n)) s += 160;
        if (r.width >= 16 && r.height >= 16) s += 10;
        s += Math.max(0, r.y / 10);
        s += Math.max(0, r.x / 20);
        if (promptRect) {
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const dx = Math.abs(cx - (promptRect.x + promptRect.width));
          const dy = Math.abs(cy - (promptRect.y + promptRect.height / 2));
          s += Math.max(0, 140 - dx / 6 - dy / 4);
        }
        return s;
      };
      const pool = [];
      const seen = new Set();
      const localPool = composerRoot ? [...composerRoot.querySelectorAll(${sendSel}), ...composerRoot.querySelectorAll('button, [role=\"button\"]')] : [];
      for (const n of [...localPool, ...document.querySelectorAll(${sendSel}), ...document.querySelectorAll('button, [role=\"button\"]')]) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        pool.push(n);
      }
      let btn = null;
      let best = -Infinity;
      for (const n of pool) {
        if (!visible(n) || disabled(n)) continue;
        const s = score(n);
        if (s > best) {
          best = s;
          btn = n;
        }
      }
      if (!btn) return { ok:true, fallbackEnter:true, requestSubmit: !!prompt?.closest('form'), host };
      const r = btn.getBoundingClientRect();
      return {
        ok:true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        requestSubmit: !!prompt?.closest('form'),
        host
      };
    })()`, 'send_discovery');
    if (!res?.ok) {
      const err = new Error(res?.error || 'send_failed');
      err.data = res;
      throw err;
    }

    let sent = false;
    let coordinateClickAttempted = false;
    let coordinateClickTimedOut = false;
    let domClickAttempted = false;
    let requestSubmitAttempted = false;
    let lastFallbackResult = null;
    if (res?.rect?.w > 0 && res?.rect?.h > 0) {
      assertSendBudget('coordinate_click');
      this.#throwIfStopRequested();
      const cx = Math.round(res.rect.x + res.rect.w / 2);
      const cy = Math.round(res.rect.y + res.rect.h / 2);
      const fallbackReserveMs = Math.min(10_000, Math.floor(sendConfirmationTimeoutMs * 2 / 3));
      const coordinateClickBudgetMs = Math.max(1, sendConfirmationTimeoutMs - fallbackReserveMs);
      try {
        await awaitSendStep(() => this.#clickAt(cx, cy, {
          onBeforeMouseDownAsync: async () => {
            const run = this.currentRun;
            await this.#claimProviderStopDispatch(run);
            await this.#beginProviderStopDispatch(run);
          },
          onBeforeMouseDown: () => {
            this.#commitProviderStopDispatchBeforeInput(this.currentRun);
          }
        }), 'coordinate_click', { timeoutMs: coordinateClickBudgetMs });
        coordinateClickAttempted = true;
        assertSendBudget('coordinate_click');
        await this.#completeProviderStopDispatch(this.currentRun);
        assertSendBudget('dispatch_complete');
        this.#recordSendAttemptCompleted(true);
        sent = this.#recordSendConfirmation(await waitForSendConfirmation());
      } catch (error) {
        const coordinateTimeout = error?.message === 'send_not_triggered' && error?.data?.step === 'coordinate_click';
        if (!coordinateTimeout) throw error;
        coordinateClickTimedOut = true;
        const dispatchState = await this.#reconcileProviderStopDispatch(this.currentRun);
        const run = this.currentRun;
        const dispatchStarted = run?.providerStopInputStarted || run?.messageDispatchStarted || run?.dispatchStateUnknown || ['dispatching', 'dispatched'].includes(dispatchState);
        if (dispatchStarted || !['pending', 'cancelled'].includes(dispatchState)) throw error;
      }
    }

    if (!sent && res?.isChatGPT && (coordinateClickAttempted || coordinateClickTimedOut)) {
      assertSendBudget('dom_click_fallback');
      this.#throwIfStopRequested();
      await this.#verifyProviderStopTokenBeforeDispatch();
      const domFallback = await awaitSendStep(() => this.#tryChatGPTExactSubmissionFallback({
        sendBaseline: res?.sendBaseline,
        action: 'dom_click',
        allowRetry: true
      }), 'dom_click_fallback');
      domClickAttempted = !!domFallback?.attempted;
      lastFallbackResult = domFallback?.lastFallbackResult || null;
      this.#recordSendAttemptCompleted(domClickAttempted);
      if (domClickAttempted) {
        sent = this.#recordSendConfirmation(await waitForSendConfirmation());
      }

      if (!sent && domClickAttempted) {
        assertSendBudget('request_submit_fallback');
        this.#throwIfStopRequested();
        await this.#verifyProviderStopTokenBeforeDispatch();
        const submitFallback = await awaitSendStep(() => this.#tryChatGPTExactSubmissionFallback({
          sendBaseline: res?.sendBaseline,
          action: 'request_submit',
          allowRetry: true
        }), 'request_submit_fallback');
        requestSubmitAttempted = !!submitFallback?.attempted;
        lastFallbackResult = submitFallback?.lastFallbackResult || lastFallbackResult;
        this.#recordSendAttemptCompleted(requestSubmitAttempted);
        if (requestSubmitAttempted) {
          sent = this.#recordSendConfirmation(await waitForSendConfirmation());
        }
      }
    }

    if (!sent && (!res?.isChatGPT || res?.fallbackEnter)) {
      assertSendBudget('form_dispatch');
      this.#throwIfStopRequested();
      await this.#verifyProviderStopTokenBeforeDispatch();
      const dispatchGeneration = this.#providerStopGeneration(this.currentRun);
      const dispatchSequence = this.#providerStopSequence(this.currentRun);
      const dispatchToken = JSON.stringify(this.currentRun?.providerStopToken || null);
      let dispatchResult;
      try {
        dispatchResult = await evaluateSendStep(`(() => {
        const agentifyStopTokenDispatchAction = true;
        const host = location.hostname || '';
        const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
        const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        const prompt = uniq.find(editable) || document.activeElement;
        const form = prompt?.closest?.('form') || null;
        let action = null;
        if (form && typeof form.requestSubmit === 'function') {
          const submitSel = isChatGPT ? chatgptSendSel : ${sendSel};
          const submitBtn = Array.from(form.querySelectorAll(submitSel)).find((n) => visible(n) && !disabled(n));
          action = () => form.requestSubmit(submitBtn || undefined);
        } else if (!isChatGPT) {
          const submitBtn = form
            ? Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n))
            : document.querySelector(${sendSel});
          if (submitBtn) action = () => submitBtn.click();
        }
        if (!action) return { attempted: false, state: 'pending' };
        const dispatchState = globalThis.__agentifyProviderStopState && typeof globalThis.__agentifyProviderStopState === 'object'
          ? globalThis.__agentifyProviderStopState
          : null;
        const currentGeneration = Number(dispatchState?.generation);
        const currentSequence = Number(dispatchState?.sequence);
        const retiredSequence = Number(dispatchState?.retiredSequence);
        const currentDispatchState = dispatchState?.dispatch?.state;
        const exact = Number.isSafeInteger(currentGeneration) && Number.isSafeInteger(currentSequence) &&
          Number.isSafeInteger(retiredSequence) && currentGeneration === ${dispatchGeneration} &&
          currentSequence === ${dispatchSequence} && dispatchState?.token === ${dispatchToken} && dispatchState?.stopRequested !== true && retiredSequence < ${dispatchSequence};
        const canClaim = exact && (currentDispatchState === 'pending' || ['dispatching', 'dispatched'].includes(currentDispatchState));
        if (!canClaim) return { attempted: false, providerStopDispatchUnavailable: true, state: exact ? currentDispatchState || 'unknown' : 'mismatch' };
        globalThis.__agentifyProviderStopState = {
          ...dispatchState,
          dispatch: { generation: ${dispatchGeneration}, sequence: ${dispatchSequence}, state: 'dispatching' }
        };
        try {
          action();
        } catch {
          globalThis.__agentifyProviderStopState = {
            ...globalThis.__agentifyProviderStopState,
            dispatch: { generation: ${dispatchGeneration}, sequence: ${dispatchSequence}, state: 'dispatched' }
          };
          return { attempted: false, dispatchClaimed: true, dispatchState: 'dispatched', providerStopDispatchUnknown: true };
        }
        globalThis.__agentifyProviderStopState = {
          ...globalThis.__agentifyProviderStopState,
          dispatch: { generation: ${dispatchGeneration}, sequence: ${dispatchSequence}, state: 'dispatched' }
        };
        return { attempted: true, dispatchClaimed: true, dispatchState: 'dispatched' };
        })()`, 'form_dispatch');
      } catch (error) {
        await this.#reconcileProviderStopDispatch(this.currentRun);
        throw error;
      }
      if (dispatchResult?.dispatchClaimed) {
        this.currentRun.messageDispatchStarted = true;
        this.currentRun.dispatchState = dispatchResult.dispatchState || 'dispatched';
      }
      if (dispatchResult?.providerStopDispatchUnknown) this.currentRun.dispatchStateUnknown = true;
      if (dispatchResult?.providerStopDispatchUnavailable) {
        this.currentRun.dispatchState = dispatchResult.state || 'unknown';
        if (dispatchResult.state !== 'pending' && dispatchResult.state !== 'cancelled' && dispatchResult.state !== 'mismatch') this.currentRun.dispatchStateUnknown = true;
        throw this.#providerStopDispatchError('dispatch');
      }
      this.#recordSendAttemptCompleted(!!dispatchResult?.dispatchClaimed);
      sent = this.#recordSendConfirmation(await waitForSendConfirmation());
    }

    if (!sent && !res?.isChatGPT) {
      const host = String(res?.host || '');
      const isMac = process.platform === 'darwin';
      const combos = [];
      if (host.includes('aistudio.google.com')) {
        combos.push(['Enter', ['alt']]);
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', []]);
      } else if (host.includes('grok.com')) {
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', []]);
      } else {
        combos.push(['Enter', []]);
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', ['alt']]);
      }

      for (const [key, modifiers] of combos) {
        this.#throwIfStopRequested();
        await sleep(jitter(25, 90));
        this.#throwIfStopRequested();
        await this.#claimProviderStopDispatch(this.currentRun, { allowRetry: true });
        await this.#beginProviderStopDispatch(this.currentRun);
        this.#throwIfStopRequested();
        try {
          this.#commitProviderStopDispatchBeforeInput(this.currentRun);
          await this.#sendKey(key, { modifiers });
          await this.#completeProviderStopDispatch(this.currentRun);
          this.#recordSendAttemptCompleted(true);
        } catch (error) {
          await this.#reconcileProviderStopDispatch(this.currentRun);
          throw error;
        }
        sent = this.#recordSendConfirmation(await this.#waitForSendSignal({
          timeoutMs: res?.isChatGPT ? chatgptSignalTimeoutMs : 1500,
          pollMs: 120,
          sendBaseline: res?.sendBaseline
        }));
        if (sent) break;
      }
    }

    if (!sent) {
      if (this.currentRun) this.currentRun.sendConfirmationTimedOut = true;
      const err = new Error('send_not_triggered');
      err.data = res?.isChatGPT
        ? {
            host: res?.host || null,
            coordinateClickAttempted,
            coordinateClickTimedOut,
            domClickAttempted,
            requestSubmitAttempted,
            lastFallbackResult,
            sendConfirmed: !!this.currentRun?.sendConfirmed
          }
        : { host: res?.host || null };
      throw err;
    }
  }

  async #preflightChatGPTAttachmentDraft({ returnState = false } = {}) {
    const state = await this.#eval(`(async () => {
      const agentifyAttachmentDraftPreflight = true;
      const host = location.hostname || '';
      const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
      if (!isChatGPT) return { isChatGPT: false, hasAttachmentState: false };
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (node) => {
        if (!node || !visible(node)) return false;
        if (node.matches('textarea, input')) return !node.disabled && !node.readOnly;
        return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox';
      };
      const promptScore = (node) => {
        const rect = node.getBoundingClientRect();
        const label = [node.getAttribute('aria-label') || '', node.getAttribute('placeholder') || '', node.getAttribute('name') || '', node.getAttribute('id') || '', node.getAttribute('data-testid') || ''].join(' ').toLowerCase();
        let score = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
        if (node.matches('textarea')) score += 50;
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') score += 35;
        if (node.getAttribute('role') === 'textbox') score += 25;
        if (rect.width >= 260 && rect.height >= 26) score += 20;
        score += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
        score += Math.max(0, rect.y / 8);
        return score;
      };
      const sendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
      const stopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="生成を停止する"], button[aria-label="生成を停止"], button[aria-label="停止"]';
      const candidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}))
        .concat(Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]')))
        .filter((node, index, nodes) => nodes.indexOf(node) === index)
        .filter(editable);
      const prompt = candidates.reduce((best, node) => !best || promptScore(node) > promptScore(best) ? node : best, null);
      let activeComposer = prompt?.closest('form') || null;
      for (let node = prompt?.parentElement || null; !activeComposer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (node.querySelector(sendSel) || node.querySelector(stopSel)) activeComposer = node;
      }
      const composerInputs = activeComposer ? Array.from(activeComposer.querySelectorAll('input#upload-files[type="file"]')) : [];
      const pageInputs = Array.from(document.querySelectorAll('input#upload-files[type="file"]'));
      const promptText = prompt?.matches('textarea, input') ? String(prompt.value || '') : String(prompt?.innerText || prompt?.textContent || '');
      const digestText = async (value) => {
        const bytes = new TextEncoder().encode(String(value || ''));
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      };
      const digestFile = async (file) => {
        try {
          const bytes = await file.arrayBuffer();
          const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
          return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        } catch {
          return '';
        }
      };
      const selectedFiles = (await Promise.all(pageInputs.flatMap((input) => Array.from(input.files || []).map(async (file) => {
        const name = String(file.name || '').trim();
        return {
          transportName: name,
          logicalName: name,
          size: Number(file.size) || 0,
          sha256: await digestFile(file)
        };
      })))).filter((file) => file.transportName);
      const selectedFileNames = selectedFiles.map((file) => file.transportName);
      const inputValuePresent = pageInputs.some((input) => String(input.value || '') !== '');
      const isFileCard = (card) => card.classList.contains('group/file-tile') || Array.from(card.querySelectorAll('button[aria-label]')).some((button) => /削除|remove/i.test(String(button.getAttribute('aria-label') || '')));
      const isCurrentDraftFileCard = (${isChatGPTCurrentDraftAttachmentCard.toString()});
      const currentDraftCards = activeComposer
        ? Array.from(activeComposer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard).filter(isCurrentDraftFileCard)
        : [];
      const cardDisplayNames = currentDraftCards.map((card) => String(card.getAttribute('aria-label') || '').trim()).filter(Boolean);
      return {
        isChatGPT: true,
        hasAttachmentState: selectedFileNames.length > 0 || inputValuePresent || currentDraftCards.length > 0,
        promptText,
        promptLength: promptText.length,
        promptDigest: await digestText(promptText),
        selectedFileNames,
        selectedFiles,
        cardDisplayNames,
        currentDraftCardCount: currentDraftCards.length,
        composerInputCount: composerInputs.length,
        pageInputCount: pageInputs.length,
        inputValuePresent
      };
    })()`);
    if (state?.isChatGPT && state.hasAttachmentState && !returnState) {
      const err = new Error('chatgpt_file_input_state_conflict');
      err.data = {
        phase: 'attachment_preflight',
        reason: 'current_draft_attachment_conflict',
        selectedFileNames: Array.isArray(state.selectedFileNames) ? state.selectedFileNames : [],
        cardDisplayNames: Array.isArray(state.cardDisplayNames) ? state.cardDisplayNames : [],
        currentDraftCardCount: Number(state.currentDraftCardCount) || 0,
        composerInputCount: Number(state.composerInputCount) || 0,
        pageInputCount: Number(state.pageInputCount) || 0,
        inputValuePresent: state.inputValuePresent === true,
        promptLength: Number(state.promptLength) || 0,
        promptDigest: /^[0-9a-f]{64}$/u.test(String(state.promptDigest || '')) ? state.promptDigest : '',
        selectedFiles: Array.isArray(state.selectedFiles) ? state.selectedFiles : []
      };
      throw err;
    }
    return state;
  }

  async #settlePostSend(run) {
    if (!run?.sendConfirmed) return { status: 'skipped', reason: 'send_not_confirmed' };
    if (!this.draftOwnership.enabled) return { status: 'skipped', reason: 'ownership_disabled' };
    await this.#persistDraftLease(run, 'post-send-settling');
    const state = await this.#preflightChatGPTAttachmentDraft({ returnState: true });
    const current = {
      ...state,
      userTurnBaseline: await this.#captureUserTurnBaseline()
    };
    const proof = canSettlePostSendDraft({
      lease: createDraftLease({
        operationId: run.operationId,
        tabId: this.tabId,
        conversationDigest: run.conversationDigest,
        userTurnBaseline: run.userTurnBaseline,
        expectedAttachments: run.expectedAttachmentIdentities,
        ownedPrompt: run.promptTyped,
        ownedPromptDigest: run.promptDigest,
        ownedPromptLength: run.promptLength,
        phase: 'post-send-settling',
        sendConfirmed: true
      }),
      current,
      tabId: this.tabId,
      conversationDigest: run.conversationDigest,
      activeOperationId: null,
      allowRuntimeTabRebind: false
    });
    if (!proof.safe) {
      run.postSendDiagnostic = { status: 'blocked', reason: proof.reason };
      await this.#persistDraftLease(run, 'cleanup-required');
      return { status: 'blocked', reason: proof.reason };
    }
    if (proof.clean) {
      run.postSendSettled = true;
      await this.#clearDraftLease(run);
      run.ownershipPhase = 'cleared';
      return { status: 'cleared' };
    }
    const cleanup = await this.cleanupUnsentDraft({
      prompt: current.promptLength > 0 ? run.prompt : '',
      expectedFileNames: run.expectedFileNames,
      logicalFileNames: run.logicalExpectedFileNames,
      expectedAttachmentIdentities: run.expectedAttachmentIdentities,
      userTurnBaseline: run.userTurnBaseline,
      sentPromptDigest: run.promptDigest,
      postSend: true
    });
    if (cleanup.status === 'cleared') {
      run.postSendSettled = true;
      await this.#clearDraftLease(run);
      run.ownershipPhase = 'cleared';
      return cleanup;
    }
    run.postSendDiagnostic = { status: 'blocked', reason: cleanup.reason || 'post_send_cleanup_failed' };
    await this.#persistDraftLease(run, 'cleanup-required');
    return { status: 'blocked', reason: cleanup.reason || 'post_send_cleanup_failed', cleanup };
  }

  async #attachFiles(files, { onMutation } = {}) {
    if (!files?.length) return;
    await this.#emitProgress({ phase: 'uploading_files' });
    const absFiles = files.map((p) => path.resolve(p));
    for (const f of absFiles) await fs.access(f);
    const uploadPlan = await this.#stageDuplicateAttachmentFiles(absFiles);
    try {
      const expectedFileNames = uploadPlan.expectedFileNames;
      const logicalFileNames = uploadPlan.logicalFileNames;
      const expectedFileNamesJson = JSON.stringify(expectedFileNames);
      const logicalFileNamesJson = JSON.stringify(logicalFileNames);
      const promptSel = JSON.stringify(this.selectors.promptTextarea);

    const opened = await this.#eval(`(() => {
      const host = location.hostname || '';
      const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelOf = (node) => [
        node.getAttribute('aria-label') || '',
        node.getAttribute('title') || '',
        node.getAttribute('data-testid') || '',
        node.textContent || ''
      ].join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      const excluded = (label) => /deep research|image generation|generate image|camera|microphone|voice|音声|マイク|カメラ|画像生成|ディープリサーチ/i.test(label);
      const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
      const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="生成を停止する"], button[aria-label="生成を停止"], button[aria-label="停止"]';
      const promptCandidates = isChatGPT ? Array.from(document.querySelectorAll(${promptSel})) : [];
      const fallback = isChatGPT ? Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]')) : [];
      const promptScore = (node) => {
        const rect = node.getBoundingClientRect();
        const label = [node.getAttribute('aria-label') || '', node.getAttribute('placeholder') || '', node.getAttribute('name') || '', node.getAttribute('id') || '', node.getAttribute('data-testid') || ''].join(' ').toLowerCase();
        let score = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
        if (node.matches('textarea')) score += 50;
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') score += 35;
        if (node.getAttribute('role') === 'textbox') score += 25;
        if (rect.width >= 260 && rect.height >= 26) score += 20;
        score += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
        score += Math.max(0, rect.y / 8);
        return score;
      };
      const prompt = [...promptCandidates, ...fallback]
        .filter((node, index, nodes) => nodes.indexOf(node) === index)
        .filter((node) => {
          if (!visible(node)) return false;
          if (node.matches('textarea')) return !node.disabled && !node.readOnly;
          if (node.matches('input')) return !node.disabled && !node.readOnly;
          return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox';
        })
        .reduce((best, node) => !best || promptScore(node) > promptScore(best) ? node : best, null);
      let activeComposer = prompt?.closest('form') || null;
      for (let node = prompt?.parentElement || null; !activeComposer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) activeComposer = node;
      }
      const chatgptUploadInputs = isChatGPT && activeComposer ? Array.from(activeComposer.querySelectorAll('input#upload-files[type="file"]')) : [];
      const pageUploadInputs = isChatGPT ? Array.from(document.querySelectorAll('#upload-files')) : [];
      const uploadInput = chatgptUploadInputs[0] || null;
      const inputReady = chatgptUploadInputs.length === 1 && pageUploadInputs.length === 1 && !!uploadInput && !uploadInput.disabled && !uploadInput.readOnly && uploadInput.id === 'upload-files' && uploadInput.id !== 'upload-photos' && uploadInput.id !== 'upload-camera';
      const expectedFileNames = ${expectedFileNamesJson};
      const normalizeFileNames = (fileNames) => fileNames
        .map((fileName) => String(fileName || '').trim().toLocaleLowerCase())
        .sort();
      const sameFileNames = (left, right) => left.length === right.length && left.every((fileName, index) => fileName === right[index]);
       const selectedFiles = Array.from(uploadInput?.files || []).map((file, index) => ({ name: file.name, index }));
       const selectedFileNames = selectedFiles.map((file) => file.name);
       const logicalFileNames = ${logicalFileNamesJson};
       const mappingSelectedFileNames = selectedFiles.map((file, index) => logicalFileNames[index] || file.name);
       const normalizedExpectedFileNames = normalizeFileNames(expectedFileNames);
      const isFileCard = (card) => card.classList.contains('group/file-tile') || Array.from(card.querySelectorAll('button[aria-label]')).some((button) => /削除|remove/i.test(String(button.getAttribute('aria-label') || '')));
      const visibleCirclePending = (card) => Array.from(card.querySelectorAll('svg circle[stroke-dasharray]')).some((circle) => visible(circle) || visible(circle.closest('svg')));
      const visiblePending = (card) => (
        Array.from(card.querySelectorAll('.cursor-wait, button.cursor-wait, [aria-busy="true"], [role="progressbar"]')).some(visible) ||
        visibleCirclePending(card)
      );
      const failureTerms = /upload failed|failed to upload|upload error|processing failed|アップロードに失敗|アップロードエラー|処理に失敗/i;
      const visibleFailed = (card) => [card, ...Array.from(card.querySelectorAll('*'))].some((node) => {
        if (!visible(node)) return false;
        const value = [node.textContent || '', node.className || '', node.getAttribute('aria-label') || ''].join(' ');
        return failureTerms.test(value);
      });
      const isCurrentDraftFileCard = (${isChatGPTCurrentDraftAttachmentCard.toString()});
      const fileCards = activeComposer
        ? Array.from(activeComposer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard).filter(isCurrentDraftFileCard)
        : [];
      const cardDisplayNames = fileCards.map((card) => String(card.getAttribute('aria-label') || '').trim());
       const transportMappingResult = (${mapChatGPTAttachmentCardNames.toString()})(selectedFileNames, cardDisplayNames);
       const logicalMappingResult = (${mapChatGPTAttachmentCardNames.toString()})(mappingSelectedFileNames, cardDisplayNames);
       const mappingResult = transportMappingResult.mappingComplete ? transportMappingResult : logicalMappingResult;
       const selectionMatchesExpected = sameFileNames(normalizeFileNames(selectedFileNames), normalizedExpectedFileNames) || sameFileNames(normalizeFileNames(selectedFileNames), normalizeFileNames(logicalFileNames));
       const fileCount = selectedFiles.length;
       const cardCount = fileCards.length;
       const countsMatch = fileCount === cardCount;
       const mappingErrors = Array.isArray(mappingResult.mappingErrors) ? [...mappingResult.mappingErrors] : [];
       if (!selectionMatchesExpected) mappingErrors.push('file_selection_mismatch');
       if (!countsMatch) mappingErrors.push('file_card_count_mismatch');
       const fileStates = selectedFiles.map((file, index) => {
         const mapped = mappingResult.mapping?.[index] || {};
         const card = mapped.cardIndex == null ? null : fileCards[mapped.cardIndex] || null;
         const displayName = String(mapped.displayName || (card?.getAttribute('aria-label') || '')).trim();
         return {
           sourceFileName: mappingSelectedFileNames[index] || file.name,
           displayName,
           matched: !!mapped.matched && !!card,
           matchKind: mapped.matchKind || null,
           pending: !!card && visiblePending(card),
           failed: !!card && visibleFailed(card)
         };
       });
       const mappingComplete = selectionMatchesExpected && countsMatch && !!mappingResult.mappingComplete && fileStates.every((state) => state.matched);
      const pageInputHasAttachmentState = pageUploadInputs.some((input) => Array.from(input.files || []).length > 0 || String(input.value || '') !== '');
      const draftHasAttachmentState = selectedFileNames.length > 0 || pageInputHasAttachmentState || fileCards.length > 0 || String(uploadInput?.value || '') !== '';
      const inputState = {
        isChatGPT: true,
        opened: false,
        inputReady,
        selectedFileNames,
        selectedFiles,
        expectedFileNames,
        logicalFileNames,
        cardDisplayNames,
        selectionMatchesExpected,
        fileCount,
        cardCount,
        countsMatch,
        mappingComplete,
        draftHasAttachmentState,
        draftConflict: draftHasAttachmentState,
        mappingErrors,
        fileStates,
        composerInputCount: chatgptUploadInputs.length,
        pageUploadInputCount: pageUploadInputs.length
      };
      if (chatgptUploadInputs.length > 0 && !inputReady) {
        return {
          ...inputState,
          inputPresent: true,
          inputDisabled: !!uploadInput?.disabled
        };
      }
      const attachCandidates = isChatGPT
        ? activeComposer ? Array.from(activeComposer.querySelectorAll('button, [role="button"]')) : []
        : Array.from(document.querySelectorAll('button, [role="button"]'));
      const attach = attachCandidates.find((node) => {
        const label = labelOf(node);
        return visible(node) && !excluded(label) && /attach|upload|paperclip|add photos? & files?|添付|写真とファイルを追加|ファイル/i.test(label);
      });
      if (!attach) return inputReady ? inputState : { isChatGPT, opened: false };
      const rect = attach.getBoundingClientRect();
      return {
        ...inputState,
        opened: true,
        attachRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      };
    })()`);

    if (opened?.isChatGPT && opened?.draftConflict) {
      const err = new Error('chatgpt_file_input_state_conflict');
      err.data = {
        phase: 'attachment_preflight',
        reason: 'current_draft_attachment_conflict',
        expectedFileNames: opened.expectedFileNames || expectedFileNames,
        selectedFileNames: opened.selectedFileNames || [],
        cardDisplayNames: opened.cardDisplayNames || [],
        fileCount: Number(opened.fileCount) || 0,
        cardCount: Number(opened.cardCount) || 0,
        mappingErrors: Array.isArray(opened.mappingErrors) ? opened.mappingErrors : []
      };
      throw err;
    }

    if (opened?.isChatGPT && opened?.opened && opened?.attachRect?.w > 0 && opened?.attachRect?.h > 0) {
      const rect = opened.attachRect;
      await this.#clickAt(
        Math.round(Number(rect.x) + Number(rect.w) / 2),
        Math.round(Number(rect.y) + Number(rect.h) / 2)
      );
    }

    if (opened?.isChatGPT && opened?.inputReady && !opened?.opened) {
      await this.page.setFileInputFiles(uploadPlan.files, { selector: '#upload-files' });
      await onMutation?.(uploadPlan);
      return uploadPlan;
    }

    if (opened?.isChatGPT && opened?.inputPresent) {
      const err = new Error('chatgpt_file_input_invalid');
      err.data = opened;
      throw err;
    }

    if (opened?.isChatGPT && !opened?.opened) {
      const err = new Error('attachment_button_not_found');
      err.data = opened;
      throw err;
    }

    if (opened?.isChatGPT) {
      await this.#waitForChatGPTFileInputOrMenu();
      await this.page.setFileInputFiles(uploadPlan.files, { selector: '#upload-files' });
      await onMutation?.(uploadPlan);
    } else {
      await this.page.setFileInputFiles(uploadPlan.files);
      await onMutation?.(uploadPlan);
    }
    return uploadPlan;
    } catch (error) {
      await uploadPlan.cleanup();
      throw error;
    }
  }

  async #stageDuplicateAttachmentFiles(absFiles) {
    const expectedFileNames = absFiles.map((file) => path.basename(file).trim());
    const counts = new Map();
    for (const fileName of expectedFileNames) {
      const normalized = fileName.toLocaleLowerCase();
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
    if (![...counts.values()].some((count) => count > 1)) {
      return { files: absFiles, expectedFileNames, logicalFileNames: expectedFileNames, cleanup: async () => {} };
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-attachment-upload-'));
    const usedNames = new Set(expectedFileNames.map((fileName) => fileName.toLocaleLowerCase()));
    const occurrences = new Map();
    const uploadFiles = [];
    try {
      for (const sourceFile of absFiles) {
        const sourceName = path.basename(sourceFile).trim();
        const normalized = sourceName.toLocaleLowerCase();
        const occurrence = (occurrences.get(normalized) || 0) + 1;
        occurrences.set(normalized, occurrence);
        if (occurrence === 1) {
          uploadFiles.push(sourceFile);
          continue;
        }

        const extension = path.extname(sourceName);
        const stem = extension ? sourceName.slice(0, -extension.length) : sourceName;
        let suffix = occurrence - 1;
        let transportName = `${stem}(${suffix})${extension}`;
        while (usedNames.has(transportName.toLocaleLowerCase())) {
          suffix += 1;
          transportName = `${stem}(${suffix})${extension}`;
        }
        usedNames.add(transportName.toLocaleLowerCase());
        const transportFile = path.join(tempDir, transportName);
        await fs.copyFile(sourceFile, transportFile);
        uploadFiles.push(transportFile);
      }
      return {
        files: uploadFiles,
        expectedFileNames: uploadFiles.map((file) => path.basename(file).trim()),
        logicalFileNames: expectedFileNames,
        cleanup: async () => {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async #clearChatGPTFileInput({
    expectedFileNames = [],
    selectedFileNames = [],
    cardDisplayNames = [],
    composerInputCount = 0,
    pageUploadInputCount = 0
  } = {}) {
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const expectedFileNamesJson = JSON.stringify(expectedFileNames);
    const result = await this.#eval(`(() => {
      const host = location.hostname || '';
      const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
      if (!isChatGPT) return { ok: false, reason: 'not_chatgpt' };
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (node) => {
        if (!node || !visible(node)) return false;
        if (node.matches('textarea, input')) return !node.disabled && !node.readOnly;
        return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox';
      };
      const promptScore = (node) => {
        const rect = node.getBoundingClientRect();
        const label = [node.getAttribute('aria-label') || '', node.getAttribute('placeholder') || '', node.getAttribute('name') || '', node.getAttribute('id') || '', node.getAttribute('data-testid') || ''].join(' ').toLowerCase();
        let score = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
        if (node.matches('textarea')) score += 50;
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') score += 35;
        if (node.getAttribute('role') === 'textbox') score += 25;
        if (rect.width >= 260 && rect.height >= 26) score += 20;
        score += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
        score += Math.max(0, rect.y / 8);
        return score;
      };
      const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
      const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="生成を停止する"], button[aria-label="生成を停止"], button[aria-label="停止"]';
      const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
      const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
      const prompt = [...promptCandidates, ...fallback]
        .filter((node, index, nodes) => nodes.indexOf(node) === index)
        .filter(editable)
        .reduce((best, node) => !best || promptScore(node) > promptScore(best) ? node : best, null);
      let activeComposer = prompt?.closest('form') || null;
      for (let node = prompt?.parentElement || null; !activeComposer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) activeComposer = node;
      }
      const composerUploadInputs = activeComposer ? Array.from(activeComposer.querySelectorAll('input#upload-files[type="file"]')) : [];
      const pageUploadInputs = Array.from(document.querySelectorAll('#upload-files'));
      const uploadInput = composerUploadInputs[0] || null;
      const isFileCard = (card) => card.classList.contains('group/file-tile') || Array.from(card.querySelectorAll('button[aria-label]')).some((button) => /削除|remove/i.test(String(button.getAttribute('aria-label') || '')));
      const isCurrentDraftFileCard = (${isChatGPTCurrentDraftAttachmentCard.toString()});
      const fileCards = activeComposer ? Array.from(activeComposer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard).filter(isCurrentDraftFileCard) : [];
      const expectedFileNames = ${expectedFileNamesJson};
      const snapshot = {
        expectedFileNames,
        selectedFileNames: Array.from(uploadInput?.files || []).map((file) => file.name),
        cardDisplayNames: fileCards.map((card) => String(card.getAttribute('aria-label') || '').trim()),
        composerInputCount: composerUploadInputs.length,
        pageUploadInputCount: pageUploadInputs.length
      };
      if (!uploadInput || composerUploadInputs.length !== 1 || pageUploadInputs.length !== 1 || fileCards.length !== 0) {
        return { ok: false, reason: 'invalid_clear_state', ...snapshot };
      }
      const selectionMatchesExpected = (${hasSameChatGPTAttachmentFileNameMultiset.toString()})(expectedFileNames, snapshot.selectedFileNames);
      if (!selectionMatchesExpected) return { ok: false, reason: 'file_selection_changed', ...snapshot };
      const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!nativeValueSetter) return { ok: false, reason: 'missing_native_value_setter', ...snapshot };
      try {
        nativeValueSetter.call(uploadInput, '');
        uploadInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        uploadInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return { ok: true, ...snapshot };
      } catch (error) {
        return { ok: false, reason: 'native_clear_error', error: String(error?.message || error), ...snapshot };
      }
    })()`);

    if (result?.ok) return;
    const err = new Error('chatgpt_file_input_clear_failed');
    err.data = {
      expectedFileNames,
      selectedFileNames,
      cardDisplayNames,
      composerInputCount,
      pageUploadInputCount,
      ...(result || {})
    };
    throw err;
  }

  async #waitForChatGPTFileInputCleared({
    expectedFileNames = [],
    selectedFileNames = [],
    cardDisplayNames = [],
    composerInputCount = 0,
    pageUploadInputCount = 0,
    timeoutMs = 2_000
  } = {}) {
    const start = Date.now();
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    let last = null;

    while (true) {
      this.#throwIfStopRequested();
      last = await this.#eval(`(() => {
        const host = location.hostname || '';
        const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
        if (!isChatGPT) return { isChatGPT: false, cleared: true };
        const visible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const editable = (node) => {
          if (!node || !visible(node)) return false;
          if (node.matches('textarea, input')) return !node.disabled && !node.readOnly;
          return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox';
        };
        const promptScore = (node) => {
          const rect = node.getBoundingClientRect();
          const label = [node.getAttribute('aria-label') || '', node.getAttribute('placeholder') || '', node.getAttribute('name') || '', node.getAttribute('id') || '', node.getAttribute('data-testid') || ''].join(' ').toLowerCase();
          let score = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
          if (node.matches('textarea')) score += 50;
          if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') score += 35;
          if (node.getAttribute('role') === 'textbox') score += 25;
          if (rect.width >= 260 && rect.height >= 26) score += 20;
          score += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
          score += Math.max(0, rect.y / 8);
          return score;
        };
        const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
        const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="生成を停止する"], button[aria-label="生成を停止"], button[aria-label="停止"]';
        const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
        const prompt = [...promptCandidates, ...fallback]
          .filter((node, index, nodes) => nodes.indexOf(node) === index)
          .filter(editable)
          .reduce((best, node) => !best || promptScore(node) > promptScore(best) ? node : best, null);
        let activeComposer = prompt?.closest('form') || null;
        for (let node = prompt?.parentElement || null; !activeComposer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) activeComposer = node;
        }
        const composerUploadInputs = activeComposer ? Array.from(activeComposer.querySelectorAll('input#upload-files[type="file"]')) : [];
        const clearInput = composerUploadInputs[0] || null;
        const pageUploadInputs = Array.from(document.querySelectorAll('#upload-files'));
        const isFileCard = (card) => card.classList.contains('group/file-tile') || Array.from(card.querySelectorAll('button[aria-label]')).some((button) => /削除|remove/i.test(String(button.getAttribute('aria-label') || '')));
        const isCurrentDraftFileCard = (${isChatGPTCurrentDraftAttachmentCard.toString()});
        const fileCards = activeComposer ? Array.from(activeComposer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard).filter(isCurrentDraftFileCard) : [];
        const selectedFileNames = Array.from(clearInput?.files || []).map((file) => file.name);
        const inputValue = String(clearInput?.value || '');
        return {
          isChatGPT: true,
          cleared: !!clearInput && composerUploadInputs.length === 1 && pageUploadInputs.length === 1 && selectedFileNames.length === 0 && inputValue === '' && fileCards.length === 0,
          selectedFileNames,
          cardDisplayNames: fileCards.map((card) => String(card.getAttribute('aria-label') || '').trim()),
          composerInputCount: composerUploadInputs.length,
          pageUploadInputCount: pageUploadInputs.length,
          filesLength: selectedFileNames.length,
          inputValueLength: inputValue.length,
          cardCount: fileCards.length
        };
      })()`);

      if (last?.cleared) return;
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) break;
      await sleep(Math.min(100, timeoutMs - elapsed));
    }

    const err = new Error('chatgpt_file_input_clear_timeout');
    err.data = {
      expectedFileNames,
      selectedFileNames,
      cardDisplayNames,
      composerInputCount,
      pageUploadInputCount,
      filesLength: Number(last?.filesLength) || 0,
      inputValueLength: Number(last?.inputValueLength) || 0,
      cardCount: Number(last?.cardCount) || 0
    };
    throw err;
  }

  async #waitForChatGPTFileInputOrMenu({ timeoutMs = 5_000 } = {}) {
    const start = Date.now();
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    let last = null;

    while (true) {
      this.#throwIfStopRequested();
      last = await this.#eval(`(() => {
        const host = location.hostname || '';
        const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
        if (!isChatGPT) return { inputAvailable: true, selected: false };

        const visible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const promptSel = ${promptSel};
        const editable = (node) => {
          if (!node || !visible(node)) return false;
          if (node.matches('textarea, input')) return !node.disabled && !node.readOnly;
          return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox';
        };
        const promptScore = (node) => {
          const rect = node.getBoundingClientRect();
          const label = [node.getAttribute('aria-label') || '', node.getAttribute('placeholder') || '', node.getAttribute('name') || '', node.getAttribute('id') || '', node.getAttribute('data-testid') || ''].join(' ').toLowerCase();
          let score = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
          if (node.matches('textarea')) score += 50;
          if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') score += 35;
          if (node.getAttribute('role') === 'textbox') score += 25;
          if (rect.width >= 260 && rect.height >= 26) score += 20;
          score += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
          score += Math.max(0, rect.y / 8);
          return score;
        };
        const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
        const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="生成を停止する"], button[aria-label="生成を停止"], button[aria-label="停止"]';
        const promptCandidates = Array.from(document.querySelectorAll(promptSel));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
        const prompt = [...promptCandidates, ...fallback]
          .filter((node, index, nodes) => nodes.indexOf(node) === index)
          .filter(editable)
          .reduce((best, node) => !best || promptScore(node) > promptScore(best) ? node : best, null);
        let activeComposer = prompt?.closest('form') || null;
        for (let node = prompt?.parentElement || null; !activeComposer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) activeComposer = node;
        }
        const chatgptUploadInput = activeComposer?.querySelector('input#upload-files[type="file"]') || null;
        const pageUploadInputs = Array.from(document.querySelectorAll('#upload-files'));
        const inputAvailable = !!chatgptUploadInput && !chatgptUploadInput.disabled && !chatgptUploadInput.readOnly && pageUploadInputs.length === 1;
        if (inputAvailable) return { inputAvailable: true, selected: false };

        const labelsOf = (node) => [
          node.getAttribute('aria-label') || '',
          node.getAttribute('title') || '',
          node.textContent || ''
        ].map((label) => label.replace(/\s+/g, ' ').trim().toLocaleLowerCase()).filter(Boolean);
        const fileLabels = new Set(['add photos & files', 'add files', 'files', '写真とファイルを追加', 'ファイルを追加']);
        const visibleMenuRoots = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper]')).filter(visible);
        const fileMenuItems = visibleMenuRoots.flatMap((menu) => Array.from(menu.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a')));
        const fileMenuItem = fileMenuItems.find((node) => visible(node) && labelsOf(node).some((label) => fileLabels.has(label)));
        if (!fileMenuItem) return { inputAvailable: false, selected: false };
        fileMenuItem.click();
        return { inputAvailable: false, selected: true };
      })()`);

      if (last?.inputAvailable) return;
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) break;
      await sleep(Math.min(100, timeoutMs - elapsed));
    }

    const err = new Error('attachment_file_option_not_found');
    err.data = last;
    throw err;
  }

  async #waitForAttachmentsReady({ timeoutMs, expectedFileNames = [], logicalFileNames = expectedFileNames }) {
    const maxWaitMs = Math.min(120_000, Math.max(0, Number(timeoutMs) || 0));
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const requiredFileNames = boundedAttachmentNameList(expectedFileNames.map((file) => path.basename(String(file || '')).trim()));
    const requiredFileNamesJson = JSON.stringify(requiredFileNames);
    const logicalFileNamesJson = JSON.stringify(boundedAttachmentNameList(logicalFileNames.map((file) => path.basename(String(file || '')).trim())));
    const start = Date.now();
    let last = null;
    let consecutiveReadyPolls = 0;
    let lastProgressSignature = '';
    let lastProgressAt = 0;

    const emitAttachmentProgress = async () => {
      const diagnostics = this.#attachmentReadinessErrorData(last, requiredFileNames, {
        elapsedMs: Date.now() - start,
        timeoutMs: maxWaitMs
      });
      const attachmentStates = diagnostics.attachmentStates;
      const readyCount = attachmentStates.filter((state) => state.matched && !state.pending && !state.failed).length;
      const pendingCount = attachmentStates.filter((state) => state.pending).length;
      const failedCount = attachmentStates.filter((state) => state.failed).length;
      const progress = {
        phase: 'uploading_files',
        attachmentCount: attachmentStates.length,
        readyCount,
        pendingCount,
        failedCount,
        mappingComplete: diagnostics.mappingComplete,
        attachmentStates
      };
      const signature = JSON.stringify(progress);
      const now = Date.now();
      if (signature !== lastProgressSignature || now - lastProgressAt >= 250) {
        lastProgressSignature = signature;
        lastProgressAt = now;
        await this.#emitProgress(progress);
      }
      return diagnostics;
    };

    while (true) {
      this.#throwIfStopRequested();
      last = await this.#eval(`(() => {
        const host = location.hostname || '';
        const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
        if (!isChatGPT) return { isChatGPT: false, ready: true };

        const visible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const disabled = (node) => !!node?.disabled || String(node?.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const editable = (node) => {
          if (!node || !visible(node)) return false;
          if (node.matches('textarea')) return !node.disabled && !node.readOnly;
          if (node.matches('input')) return !node.disabled && !node.readOnly && !/password|search|email|url|number|tel/i.test(String(node.type || 'text'));
          return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox';
        };
        const promptScore = (node) => {
          const rect = node.getBoundingClientRect();
          const label = [node.getAttribute('aria-label') || '', node.getAttribute('placeholder') || '', node.getAttribute('name') || '', node.getAttribute('id') || '', node.getAttribute('data-testid') || ''].join(' ').toLowerCase();
          let score = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
          if (node.matches('textarea')) score += 50;
          if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') score += 35;
          if (node.getAttribute('role') === 'textbox') score += 25;
          if (rect.width >= 260 && rect.height >= 26) score += 20;
          score += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
          score += Math.max(0, rect.y / 8);
          return score;
        };
        const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
        const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="生成を停止する"], button[aria-label="生成を停止"], button[aria-label="停止"]';
        const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
        const candidates = [];
        const seen = new Set();
        for (const node of [...promptCandidates, ...fallback]) {
          if (!node || seen.has(node) || !editable(node)) continue;
          seen.add(node);
          candidates.push(node);
        }
        const prompt = candidates.reduce((best, node) => !best || promptScore(node) > promptScore(best) ? node : best, null);
        let composer = prompt?.closest('form') || null;
        for (let node = prompt?.parentElement || null; !composer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) composer = node;
        }
        const send = composer ? Array.from(composer.querySelectorAll(chatgptSendSel)).find(visible) : null;
        const promptText = prompt?.matches('textarea, input')
          ? String(prompt.value || '').trim()
          : String(prompt?.innerText || prompt?.textContent || '').trim();
        const busy = !!composer && Array.from(composer.querySelectorAll('[role="progressbar"], [aria-busy="true"]')).some(visible);
        const expectedFileNames = ${requiredFileNamesJson};
        const logicalFileNames = ${logicalFileNamesJson};
        const normalizeFileName = (value) => String(value || '').trim().toLocaleLowerCase();
        const normalizeFileNames = (fileNames) => fileNames.map(normalizeFileName).sort();
        const sameFileNames = (left, right) => left.length === right.length && left.every((fileName, index) => fileName === right[index]);
        const visibleCirclePending = (card) => Array.from(card.querySelectorAll('svg circle[stroke-dasharray]')).some((circle) => visible(circle) || visible(circle.closest('svg')));
        const visiblePending = (card) => (
          Array.from(card.querySelectorAll('.cursor-wait, button.cursor-wait, [aria-busy="true"], [role="progressbar"]')).some(visible) ||
          visibleCirclePending(card)
        );
        const failureTerms = /upload failed|failed to upload|upload error|processing failed|アップロードに失敗|アップロードエラー|処理に失敗/i;
        const visibleFailed = (card) => [card, ...Array.from(card.querySelectorAll('*'))].some((node) => {
          if (!visible(node)) return false;
          const value = [node.textContent || '', node.className || '', node.getAttribute('aria-label') || ''].join(' ');
          return failureTerms.test(value);
        });
        const isFileCard = (card) => card.classList.contains('group/file-tile') || Array.from(card.querySelectorAll('button[aria-label]')).some((button) => /削除|remove/i.test(String(button.getAttribute('aria-label') || '')));
        const isCurrentDraftFileCard = (${isChatGPTCurrentDraftAttachmentCard.toString()});
        const fileCards = composer ? Array.from(composer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard).filter(isCurrentDraftFileCard) : [];
        const cardDisplayNames = fileCards.map((card) => String(card.getAttribute('aria-label') || '').trim());
        const uploadInputs = composer ? Array.from(composer.querySelectorAll('input#upload-files[type="file"]')) : [];
        const pageUploadInputCount = document.querySelectorAll('#upload-files').length;
        const uploadInput = uploadInputs[0] || null;
        const selectedFiles = Array.from(uploadInput?.files || []).map((file, index) => ({ name: file.name, index }));
        const selectedFileNames = selectedFiles.map((file) => file.name);
        const inputIsUnique = uploadInputs.length === 1 && pageUploadInputCount === 1;
        const selectionMatchesExpected = inputIsUnique && (sameFileNames(normalizeFileNames(selectedFileNames), normalizeFileNames(expectedFileNames)) || sameFileNames(normalizeFileNames(selectedFileNames), normalizeFileNames(logicalFileNames)));
        const mappingSelectedFileNames = selectedFiles.map((file, index) => logicalFileNames[index] || file.name);
        const fileCount = selectedFiles.length;
        const cardCount = fileCards.length;
        const countsMatch = fileCount === cardCount;
        const transportMappingResult = (${mapChatGPTAttachmentCardNames.toString()})(selectedFileNames, cardDisplayNames);
        const logicalMappingResult = (${mapChatGPTAttachmentCardNames.toString()})(mappingSelectedFileNames, cardDisplayNames);
        const mappingResult = transportMappingResult.mappingComplete ? transportMappingResult : logicalMappingResult;
        const mappingErrors = Array.isArray(mappingResult.mappingErrors) ? [...mappingResult.mappingErrors] : [];
        if (!inputIsUnique) mappingErrors.push('upload_input_not_unique');
        if (!selectionMatchesExpected) mappingErrors.push('file_selection_mismatch');
        if (!countsMatch) mappingErrors.push('file_card_count_mismatch');
        const fileStates = selectedFiles.map((file, index) => {
          const mapped = mappingResult.mapping?.[index] || {};
          const card = mapped.cardIndex == null ? null : fileCards[mapped.cardIndex] || null;
          const displayName = String(mapped.displayName || (card?.getAttribute('aria-label') || '')).trim();
          return {
            sourceFileName: mappingSelectedFileNames[index] || file.name,
            displayName,
            matched: !!mapped.matched && !!card,
            matchKind: mapped.matchKind || null,
            pending: !!card && visiblePending(card),
            failed: !!card && visibleFailed(card)
          };
        });
        const mappingComplete = selectionMatchesExpected && countsMatch && !!mappingResult.mappingComplete && fileStates.every((state) => state.matched);
        const observedFileNames = fileStates.filter((state) => state.matched).map((state) => state.sourceFileName);
        const observedDisplayNames = fileStates.filter((state) => state.matched).map((state) => state.displayName);
        const missingFileNames = fileStates.filter((state) => !state.matched).map((state) => state.sourceFileName);
        const pendingFileNames = fileStates.filter((state) => state.pending).map((state) => state.sourceFileName);
        const failedFileNames = fileStates.filter((state) => state.failed).map((state) => state.sourceFileName);
        const attachmentReady = mappingComplete && fileStates.every((state) => state.matched && !state.pending && !state.failed) && !busy && !!send && !disabled(send);
        return {
          isChatGPT: true,
          conditionsReady: attachmentReady,
          expectedFileNames,
          selectedFiles,
          selectedFileNames,
          cardDisplayNames,
          composerInputCount: uploadInputs.length,
          pageUploadInputCount,
          selectionMatchesExpected,
          fileCount,
          cardCount,
          countsMatch,
          mappingComplete,
          mappingErrors,
          fileStates,
          attachmentStates: fileStates,
          observedFileNames,
          observedDisplayNames,
          missingFileNames,
          pendingFileNames,
          failedFileNames,
          promptTextLength: promptText.length,
          hasSendButton: !!send,
          sendVisible: !!send,
          sendDisabled: !!send && disabled(send),
          busy
        };
      })()`);

      if (!last?.isChatGPT) return;
      const diagnostics = await emitAttachmentProgress();
      if (Array.isArray(last?.failedFileNames) && last.failedFileNames.length > 0) {
        const err = new Error('attachment_upload_failed');
        err.data = diagnostics;
        throw err;
      }
      const missingFileNames = Array.isArray(last?.missingFileNames) ? last.missingFileNames : [];
      const pendingFileNames = Array.isArray(last?.pendingFileNames) ? last.pendingFileNames : [];
      const failedFileNames = Array.isArray(last?.failedFileNames) ? last.failedFileNames : [];
      const cardsReady = missingFileNames.length === 0 && pendingFileNames.length === 0 && failedFileNames.length === 0 && !!last?.mappingComplete;
      if (last?.conditionsReady && cardsReady) {
        consecutiveReadyPolls += 1;
        if (consecutiveReadyPolls >= 2) return;
      } else {
        consecutiveReadyPolls = 0;
      }
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) break;
      await sleep(Math.min(200, maxWaitMs - elapsed));
    }

    const err = new Error('attachment_upload_timeout');
    err.data = this.#attachmentReadinessErrorData(last, requiredFileNames, {
      elapsedMs: Date.now() - start,
      timeoutMs: maxWaitMs
    });
    throw err;
  }

  #attachmentReadinessErrorData(last, expectedFileNames, { elapsedMs = 0, timeoutMs = 0 } = {}) {
    const observedFileNames = Array.isArray(last?.observedFileNames) ? last.observedFileNames : [];
    const observedCounts = new Map();
    for (const fileName of observedFileNames) {
      const normalized = String(fileName || '').toLocaleLowerCase();
      observedCounts.set(normalized, (observedCounts.get(normalized) || 0) + 1);
    }
    const missingFileNames = Array.isArray(last?.missingFileNames)
      ? last.missingFileNames
      : expectedFileNames.filter((fileName) => {
          const normalized = String(fileName || '').toLocaleLowerCase();
          const observed = observedCounts.get(normalized) || 0;
          if (observed < 1) return true;
          observedCounts.set(normalized, observed - 1);
          return false;
        });
    const attachmentStates = boundedAttachmentStates(last?.attachmentStates || last?.fileStates);
    return {
      expectedFileNames: boundedAttachmentNameList(expectedFileNames),
      observedFileNames: boundedAttachmentNameList(observedFileNames),
      observedDisplayNames: boundedAttachmentNameList(last?.observedDisplayNames),
      selectedFileNames: boundedAttachmentNameList(last?.selectedFileNames),
      cardDisplayNames: boundedAttachmentNameList(last?.cardDisplayNames),
      fileCount: Number(last?.fileCount) || 0,
      cardCount: Number(last?.cardCount) || 0,
      countsMatch: !!last?.countsMatch,
      mappingComplete: !!last?.mappingComplete,
      mappingErrors: boundedAttachmentErrorList(last?.mappingErrors),
      attachmentStates,
      missingFileNames: boundedAttachmentNameList(missingFileNames),
      pendingFileNames: boundedAttachmentNameList(last?.pendingFileNames),
      failedFileNames: boundedAttachmentNameList(last?.failedFileNames),
      promptTextLength: Number(last?.promptTextLength) || 0,
      hasSendButton: !!last?.hasSendButton,
      sendDisabled: !!last?.sendDisabled,
      busy: !!last?.busy,
      elapsedMs: Math.max(0, Math.min(120_000, Number(elapsedMs) || 0)),
      timeoutMs: Math.max(0, Math.min(120_000, Number(timeoutMs) || 0))
    };
  }

  async cleanupUnsentDraft({ prompt, expectedFileNames = [], logicalFileNames = expectedFileNames, expectedAttachmentIdentities = [], userTurnBaseline = null, sentPromptDigest = '', postSend = false } = {}) {
    if (!userTurnBaseline || !Number.isFinite(Number(userTurnBaseline.count))) {
      return { status: 'skipped', reason: 'user_turn_baseline_unavailable' };
    }
    const normalizedUserTurnBaseline = normalizeUserTurnBaseline(userTurnBaseline);
    if (!normalizedUserTurnBaseline.lastId && !normalizedUserTurnBaseline.lastTextDigest) {
      return { status: 'skipped', reason: 'user_turn_baseline_unavailable' };
    }
    const promptJson = JSON.stringify(String(prompt || '').slice(0, 200_000));
    const expectedFileNamesJson = JSON.stringify(boundedAttachmentNameList(expectedFileNames));
    const logicalFileNamesJson = JSON.stringify(boundedAttachmentNameList(logicalFileNames));
    const expectedAttachmentIdentitiesJson = JSON.stringify(expectedAttachmentIdentities);
    const baselineJson = JSON.stringify({
      count: normalizedUserTurnBaseline.count,
      lastId: normalizedUserTurnBaseline.lastId,
      lastTextDigest: normalizedUserTurnBaseline.lastTextDigest
    });
    const sentPromptDigestJson = JSON.stringify(/^[0-9a-f]{64}$/u.test(String(sentPromptDigest || '').toLowerCase()) ? String(sentPromptDigest).toLowerCase() : '');
    const result = await this.#eval(`(async () => {
      const agentifyAttachmentCleanup = true;
      const expectedPrompt = ${promptJson};
      const expectedFileNames = ${expectedFileNamesJson};
      const logicalFileNames = ${logicalFileNamesJson};
      const expectedAttachmentIdentities = ${expectedAttachmentIdentitiesJson};
      const baseline = ${baselineJson};
      const sentPromptDigest = ${sentPromptDigestJson};
      const postSend = ${postSend === true ? 'true' : 'false'};
      const safeName = (value) => String(value || '').trim().replace(/^.*[\\\\/]/u, '').slice(0, 256);
      const names = (values) => (Array.isArray(values) ? values : []).map(safeName).filter(Boolean).slice(0, 50);
      const normalize = (value) => String(value || '').trim().toLocaleLowerCase();
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (node) => {
        if (!node || !visible(node)) return false;
        if (node.matches('textarea, input')) return !node.disabled && !node.readOnly;
        return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox';
      };
      const promptScore = (node) => {
        const rect = node.getBoundingClientRect();
        const label = [node.getAttribute('aria-label') || '', node.getAttribute('placeholder') || '', node.getAttribute('name') || '', node.getAttribute('id') || '', node.getAttribute('data-testid') || ''].join(' ').toLowerCase();
        let score = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
        if (node.matches('textarea')) score += 50;
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') score += 35;
        if (node.getAttribute('role') === 'textbox') score += 25;
        if (rect.width >= 260 && rect.height >= 26) score += 20;
        score += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
        score += Math.max(0, rect.y / 8);
        return score;
      };
      const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
      const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
      const candidates = [];
      const seen = new Set();
      for (const node of [...promptCandidates, ...fallback]) {
        if (!node || seen.has(node) || !editable(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
      if (candidates.length !== 1) return { ok: false, reason: 'active_composer_not_unique', promptCount: candidates.length };
      const promptNode = candidates[0];
      let composer = promptNode.closest('form') || null;
      const sendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
      const stopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="生成を停止する"], button[aria-label="生成を停止"], button[aria-label="停止"]';
      for (let node = promptNode.parentElement || null; !composer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (node.querySelector(sendSel) || node.querySelector(stopSel)) composer = node;
      }
      if (!composer) return { ok: false, reason: 'active_composer_not_found' };
      const promptText = promptNode.matches('textarea, input') ? String(promptNode.value || '') : String(promptNode.innerText || promptNode.textContent || '');
      if (promptText !== expectedPrompt) return { ok: false, reason: 'prompt_changed', promptTextLength: promptText.trim().length };
      const userTurns = Array.from(document.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]'));
      const lastUserTurn = userTurns[userTurns.length - 1] || null;
      const lastUserId = lastUserTurn
        ? [lastUserTurn.getAttribute('data-message-id'), lastUserTurn.id, lastUserTurn.getAttribute('data-testid')].map((value) => String(value || '').trim()).find(Boolean) || ''
        : '';
      const normalizeUserTurnText = ${normalizeUserTurnText.toString()};
      const lastUserText = String(lastUserTurn?.innerText || '');
      const lastUserTextDigest = await (async (value) => {
        const bytes = new TextEncoder().encode(normalizeUserTurnText(value));
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      })(lastUserText);
      const baselineChanged = userTurns.length !== baseline.count || (baseline.lastId ? baseline.lastId !== lastUserId : !baseline.lastTextDigest || baseline.lastTextDigest !== lastUserTextDigest);
      const sentTurnMatches = postSend && sentPromptDigest && userTurns.length === baseline.count + 1 &&
        (!baseline.lastId || !lastUserId || baseline.lastId !== lastUserId) && lastUserTextDigest === sentPromptDigest;
      if (baselineChanged && !sentTurnMatches) return { ok: false, reason: 'user_turn_added', userTurnCount: userTurns.length };
      const uploadInputs = Array.from(composer.querySelectorAll('input#upload-files[type="file"]'));
      const pageUploadInputs = Array.from(document.querySelectorAll('#upload-files'));
      const pageUploadInputsAreFiles = pageUploadInputs.every((input) => input.matches('input#upload-files[type="file"]'));
      const resolvedInput = uploadInputs.length === 0 && pageUploadInputs.length <= 1 && pageUploadInputsAreFiles
        ? pageUploadInputs[0] || null
        : uploadInputs.length === 1 && pageUploadInputs.length === 1 && pageUploadInputs[0] === uploadInputs[0] && pageUploadInputsAreFiles
          ? uploadInputs[0]
          : null;
      const ownershipKnown = uploadInputs.length <= 1 && pageUploadInputs.length <= 1 && pageUploadInputsAreFiles && (
        (uploadInputs.length === 0 && pageUploadInputs.length <= 1) ||
        (uploadInputs.length === 1 && pageUploadInputs.length === 1 && pageUploadInputs[0] === uploadInputs[0])
      );
      if (!ownershipKnown) return { ok: false, reason: 'attachment_ownership_unknown', composerInputCount: uploadInputs.length, pageInputCount: pageUploadInputs.length };
      const uploadInput = resolvedInput;
      const selectedFiles = Array.from(uploadInput?.files || []);
      const selectedFileNames = names(selectedFiles.map((file) => file.name));
      const digestFile = async (file) => {
        try {
          const bytes = await file.arrayBuffer();
          const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
          return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        } catch { return ''; }
      };
      const selectedIdentities = await Promise.all(selectedFiles.map(async (file) => ({
        transportName: safeName(file.name),
        logicalName: safeName(file.name),
        size: Number(file.size) || 0,
        sha256: await digestFile(file)
      })));
      const identityKey = (item) => normalize(item?.transportName) + '\\u0000' + Number(item?.size) + '\\u0000' + String(item?.sha256 || '').toLowerCase();
      const sameIdentitySet = (left, right) => {
        const a = (Array.isArray(left) ? left : []).map(identityKey).sort();
        const b = (Array.isArray(right) ? right : []).map(identityKey).sort();
        return a.length > 0 && a.length === b.length && a.every((item, index) => item === b[index]);
      };
      const inputValue = String(uploadInput?.value || '');
      const selectedIsEmpty = selectedIdentities.length === 0 && inputValue === '';
      if (expectedAttachmentIdentities.length > 0 && !sameIdentitySet(expectedAttachmentIdentities, selectedIdentities) && !(postSend && selectedIsEmpty)) {
        return { ok: false, reason: 'attachment_identity_mismatch', selectedFileNames, cardDisplayNames: [] };
      }
      const isFileCard = (card) => card.classList.contains('group/file-tile') || Array.from(card.querySelectorAll('button[aria-label]')).some((button) => /削除|remove|delete/i.test(String(button.getAttribute('aria-label') || '')));
      const isCurrentDraftFileCard = (${isChatGPTCurrentDraftAttachmentCard.toString()});
      const fileCards = Array.from(composer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard).filter(isCurrentDraftFileCard);
      const cardDisplayNames = names(fileCards.map((card) => card.getAttribute('aria-label') || ''));
      const mappingSelectedFileNames = selectedFileNames.map((fileName, index) => logicalFileNames[index] || fileName);
      const transportMappingResult = (${mapChatGPTAttachmentCardNames.toString()})(selectedFileNames, cardDisplayNames);
      const logicalMappingResult = (${mapChatGPTAttachmentCardNames.toString()})(mappingSelectedFileNames, cardDisplayNames);
      const mappingResult = transportMappingResult.mappingComplete ? transportMappingResult : logicalMappingResult;
      const selectedMatches = (${hasSameChatGPTAttachmentFileNameMultiset.toString()})(expectedFileNames, selectedFileNames) || (${hasSameChatGPTAttachmentFileNameMultiset.toString()})(logicalFileNames, selectedFileNames);
      if (expectedFileNames.length === 0) {
        if (selectedFileNames.length > 0 || inputValue !== '' || fileCards.length > 0) {
          return { ok: false, reason: 'attachment_set_changed', selectedFileNames, cardDisplayNames, inputCount: pageUploadInputs.length, inputValuePresent: inputValue !== '' };
        }
      } else {
        const cardAliasMatches = (sourceName, cardName) => {
          const source = safeName(sourceName);
          const card = safeName(cardName);
          if (!source || !card) return false;
          if (normalize(source) === normalize(card)) return true;
          const dot = source.lastIndexOf('.');
          const stem = dot <= 0 ? source : source.slice(0, dot);
          const extension = dot <= 0 ? '' : source.slice(dot);
          const lowerCard = normalize(card);
          const lowerStem = normalize(stem);
          const lowerExtension = normalize(extension);
          const prefix = lowerStem + '(';
          if (!lowerCard.startsWith(prefix) || !lowerCard.endsWith(lowerExtension) || !lowerCard.slice(0, lowerCard.length - lowerExtension.length).endsWith(')')) return false;
          const sequence = lowerCard.slice(prefix.length, lowerCard.length - lowerExtension.length - 1);
          return /^[0-9]+(?:-[0-9]+)*$/u.test(sequence) && sequence.split('-').some((part) => (part.replace(/^0+/u, '') || '0') !== '0');
        };
        const identityEvidenceAvailable = expectedAttachmentIdentities.length > 0;
        const selectedIdentityMatches = identityEvidenceAvailable && sameIdentitySet(expectedAttachmentIdentities, selectedIdentities);
        const cardsAreOwned = identityEvidenceAvailable
          ? (() => {
              const used = new Set();
              for (const card of fileCards) {
                const index = expectedAttachmentIdentities.findIndex((expected, expectedIndex) => {
                  if (used.has(expectedIndex)) return false;
                  return [expected.transportName, expected.logicalName].some((expectedName) => cardAliasMatches(expectedName, card.getAttribute('aria-label') || ''));
                });
                if (index < 0) return false;
                used.add(index);
              }
              return !postSend || fileCards.length === 0 || fileCards.length === expectedAttachmentIdentities.length;
            })()
          : false;
        if (uploadInputs.length !== 1 || pageUploadInputs.length !== 1 || pageUploadInputs[0] !== uploadInputs[0] || (!identityEvidenceAvailable && (!selectedMatches || !mappingResult.mappingComplete)) || (identityEvidenceAvailable && ((!selectedIdentityMatches && !(postSend && selectedIsEmpty)) || !cardsAreOwned))) {
          return { ok: false, reason: 'attachment_set_changed', selectedFileNames, cardDisplayNames, mappingErrors: mappingResult.mappingErrors || [] };
        }
        for (const card of fileCards) {
          const remove = Array.from(card.querySelectorAll('button[aria-label], [role="button"][aria-label]')).find((button) => /削除|remove|delete/i.test(String(button.getAttribute('aria-label') || '')) && visible(button));
          if (!remove) return { ok: false, reason: 'attachment_remove_button_missing', cardDisplayNames };
          try { remove.click(); } catch (error) { return { ok: false, reason: 'attachment_remove_failed', error: String(error?.message || error).slice(0, 160), cardDisplayNames }; }
        }
        const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!nativeValueSetter) return { ok: false, reason: 'missing_native_value_setter' };
        try {
          nativeValueSetter.call(uploadInput, '');
          uploadInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          uploadInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        } catch (error) {
          return { ok: false, reason: 'file_input_clear_failed', error: String(error?.message || error).slice(0, 160) };
        }
      }
      try {
        if (promptNode.matches('textarea, input')) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (!setter) return { ok: false, reason: 'prompt_clear_setter_missing' };
          setter.call(promptNode, '');
        } else {
          promptNode.textContent = '';
        }
        promptNode.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward', data: null }));
        promptNode.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } catch (error) {
        return { ok: false, reason: 'prompt_clear_failed', error: String(error?.message || error).slice(0, 160) };
      }
      const readSettledState = () => {
        const currentUploadInput = Array.from(composer.querySelectorAll('input#upload-files[type="file"]'))[0] || uploadInput;
        const selectedFileNames = names(Array.from(currentUploadInput?.files || []).map((file) => file.name));
        const cardCount = Array.from(composer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard).filter(isCurrentDraftFileCard).length;
        const promptText = promptNode.matches('textarea, input') ? String(promptNode.value || '') : String(promptNode.innerText || promptNode.textContent || '');
        const userTurnCount = Array.from(document.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]')).length;
        return {
          selectedFileNames,
          cardCount,
          promptTextLength: promptText.trim().length,
          userTurnCount,
          cleared: selectedFileNames.length === 0 && cardCount === 0 && promptText.trim() === '' && userTurnCount === (postSend ? baseline.count + 1 : baseline.count)
        };
      };
      const settleStartedAt = Date.now();
      let settled = readSettledState();
      while (!settled.cleared && Date.now() - settleStartedAt < ${UNSENT_DRAFT_CLEANUP_TIMEOUT_MS}) {
        await new Promise((resolve) => setTimeout(resolve, ${UNSENT_DRAFT_CLEANUP_POLL_MS}));
        settled = readSettledState();
      }
      const finalCardCount = settled.cardCount;
      return {
        ok: settled.cleared,
        reason: settled.cleared ? null : 'cleanup_settle_timeout',
        cleanupTimeoutMs: ${UNSENT_DRAFT_CLEANUP_TIMEOUT_MS},
        ...settled,
        cardCount: finalCardCount
      };
    })()`);
    if (result?.ok) return { status: 'cleared', selectedFileNames: [], cardCount: 0, promptTextLength: 0, userTurnCount: result.userTurnCount };
    return { status: 'failed', ...(result || { reason: 'cleanup_no_result' }) };
  }

  async #captureChatGPTAssistantBaseline() {
    return await this.#eval(`(() => {
      const host = location.hostname || '';
      const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
      if (!isChatGPT) {
        return { isChatGPT: false, assistantCount: 0, lastAssistantId: '', lastAssistantText: '' };
      }
      const assistantBaseline = '[data-message-author-role="assistant"], article[data-turn="assistant"]';
      const nodes = Array.from(document.querySelectorAll(assistantBaseline));
      const lastNode = nodes[nodes.length - 1] || null;
      const lastAssistantId = lastNode
        ? [
            lastNode.getAttribute('data-message-id'),
            lastNode.id,
            lastNode.getAttribute('data-testid')
          ].map((value) => String(value || '').trim()).find(Boolean) || ''
        : '';
      return {
        isChatGPT: true,
        assistantCount: nodes.length,
        lastAssistantId,
        lastAssistantText: String(lastNode?.innerText || '').trim()
      };
    })()`);
  }

  async #waitForAssistantStable({ timeoutMs = 5 * 60_000, stableMs = 1500, pollMs = 400, baseline = null } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_response', blocked: false, blockedKind: null, blockedTitle: null });
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const chatgptAssistantSel = JSON.stringify('[data-message-author-role="assistant"], article[data-turn="assistant"]');
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const now = this.responseClock;
    const wait = this.responseSleep;
    const start = now();
    const baselineAssistantCount = Math.max(0, Number(baseline?.assistantCount) || 0);
    const baselineAssistantId = String(baseline?.lastAssistantId || '').trim();
    let last = '';
    let lastChange = now();
    let stopGoneAt = null;
    let continueClicks = 0;
    let lastSnap = null;
    let lastNewChatGPTAssistant = false;
    let lastComposerIdle = false;

    while (now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const host = location.hostname || '';
        const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
        const visible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const disabled = (node) => !!node?.disabled || String(node?.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const chatgptSendSel = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="プロンプトを送信する"]';
        const chatgptStopSel = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="生成を停止する"], button[aria-label="生成を停止"], button[aria-label="停止"]';
        let stop = false;
        let sendPresent = false;
        let sendEnabled = true;
        let promptTextLength = -1;
        if (isChatGPT) {
          const editable = (node) => {
            if (!node || !visible(node)) return false;
            if (node.matches('textarea')) return !node.disabled && !node.readOnly;
            if (node.matches('input')) return !node.disabled && !node.readOnly && !/password|search|email|url|number|tel/i.test(String(node.type || 'text'));
            return !!node.isContentEditable || node.getAttribute('contenteditable') === 'true' || node.getAttribute('role') === 'textbox';
          };
          const promptScore = (node) => {
            const rect = node.getBoundingClientRect();
            const label = [
              node.getAttribute('aria-label') || '',
              node.getAttribute('placeholder') || '',
              node.getAttribute('name') || '',
              node.getAttribute('id') || '',
              node.getAttribute('data-testid') || ''
            ].join(' ').toLowerCase();
            let score = 0;
            if (/prompt|message|ask|chat|query|input/.test(label)) score += 80;
            if (node.matches('textarea')) score += 50;
            if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') score += 35;
            if (node.getAttribute('role') === 'textbox') score += 25;
            if (rect.width >= 260 && rect.height >= 26) score += 20;
            score += Math.min(180, Math.max(0, (rect.width * rect.height) / 2500));
            score += Math.max(0, rect.y / 8);
            return score;
          };
          const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
          const fallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
          const candidates = [];
          const seen = new Set();
          for (const node of [...promptCandidates, ...fallback]) {
            if (!node || seen.has(node)) continue;
            seen.add(node);
            candidates.push(node);
          }
          let prompt = null;
          let bestScore = -Infinity;
          for (const node of candidates) {
            if (!editable(node)) continue;
            const score = promptScore(node);
            if (score > bestScore) {
              bestScore = score;
              prompt = node;
            }
          }
          let composer = prompt?.closest('form') || null;
          for (let node = prompt?.parentElement || null; !composer && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            if (node.querySelector(chatgptSendSel) || node.querySelector(chatgptStopSel)) composer = node;
          }
          const send = composer ? Array.from(composer.querySelectorAll(chatgptSendSel)).find(visible) : null;
          stop = !!(composer && Array.from(composer.querySelectorAll(chatgptStopSel)).find(visible));
          sendPresent = !!send;
          sendEnabled = !!send && !disabled(send);
          const promptText = prompt?.matches('textarea, input')
            ? String(prompt.value || '')
            : String(prompt?.innerText || prompt?.textContent || '');
          promptTextLength = prompt ? promptText.trim().length : -1;
        } else {
          stop = !!document.querySelector(${stopSel});
          const send = Array.from(document.querySelectorAll(${sendSel})).find((n) => {
            const r = n.getBoundingClientRect();
            const style = window.getComputedStyle(n);
            return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          });
          sendPresent = !!send;
          sendEnabled = send ? !send.disabled && String(send.getAttribute('aria-disabled') || '').toLowerCase() !== 'true' : true;
        }
        const assistantCandidates = isChatGPT ? ${chatgptAssistantSel} : ${assistantSel};
        const nodes = Array.from(document.querySelectorAll(assistantCandidates));
        const lastNode = nodes[nodes.length - 1];
        const lastAssistantId = lastNode
          ? [
              lastNode.getAttribute('data-message-id'),
              lastNode.id,
              lastNode.getAttribute('data-testid')
            ].map((value) => String(value || '').trim()).find(Boolean) || ''
          : '';
        const fallbackMainText = isChatGPT ? '' : ((document.querySelector('main') || document.body)?.innerText || '').trim();
        const txt = (lastNode ? lastNode.innerText : fallbackMainText).trim();
        const hasContinue = Array.from(document.querySelectorAll('button, a')).some(b => /continue generating/i.test((b.textContent||'').trim()));
        const hasRegenerate = Array.from(document.querySelectorAll('button, a')).some(b => /regenerate/i.test((b.textContent||'').trim()));
        const hasError = /something went wrong|try again|error/i.test(txt) && txt.length < 500;
        const providerError = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error" i]')).some((node) => {
          if (!visible(node)) return false;
          const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          return text.length > 0 && text.length < 500 && /something went wrong|error generating|there was an error|try again/i.test(text);
        });
        const assistantTurn = lastNode?.closest('section, article, [data-testid*="conversation-turn" i], [data-turn-id-container]') || lastNode;
        const assistantTerminalSignal = isChatGPT && !!assistantTurn?.querySelector('button[data-testid="copy-turn-action-button"]');
        return { isChatGPT, stop, sendPresent, sendEnabled, promptTextLength, txt, count: nodes.length, lastAssistantId, usedFallback: !lastNode, hasError, providerError, hasContinue, hasRegenerate, assistantTerminalSignal };
      })()`);
      lastSnap = snap;

      if (snap?.isChatGPT && snap?.providerError) {
        const error = new Error('provider_response_error');
        error.data = {
          phase: 'waiting_for_response',
          lastLength: String(snap?.txt || '').trim().length,
          lastDigest: userTurnTextDigest(snap?.txt || ''),
          lastAssistantCount: Number(snap?.count) || 0,
          assistantTerminalSignal: false,
          reason: 'visible_provider_error'
        };
        throw error;
      }

      const txt = String(snap?.txt || '');
      if (txt !== last) {
        last = txt;
        lastChange = now();
      }

      // Some providers expose unrelated visible "stop/cancel" controls.
      // ChatGPT's normal stop control is authoritative even when its send control is absent.
      const generating = snap?.isChatGPT ? !!snap?.stop : !!snap?.stop && !snap?.sendEnabled;
      if (generating) stopGoneAt = null;
      else if (stopGoneAt == null) stopGoneAt = now();

      const dynamicStableMs = Math.max(stableMs, txt.length > 8000 ? 3000 : txt.length > 2000 ? 2200 : stableMs);
      const stable = now() - lastChange >= dynamicStableMs;
      const stopGoneLongEnough = stopGoneAt != null && now() - stopGoneAt >= 800;

      if (!snap?.stop && snap?.hasContinue && continueClicks < 3) {
        continueClicks += 1;
        await this.#eval(`(() => {
          const btn = Array.from(document.querySelectorAll('button, a')).find(b => /continue generating/i.test((b.textContent||'').trim()));
          if (btn) btn.click();
        })()`);
        await wait(250);
        continue;
      }

      const readyByNodes = (snap?.count || 0) > 0;
      const fallbackWaited = !snap?.isChatGPT && !!snap?.usedFallback && (now() - start >= 2500);
      const fallbackStableLongEnough = !snap?.isChatGPT && txt.length > 0 && (now() - lastChange >= Math.max(dynamicStableMs, 5000));
      const newChatGPTAssistant =
        (snap?.count || 0) > baselineAssistantCount ||
        (baselineAssistantId && snap?.lastAssistantId && baselineAssistantId !== snap.lastAssistantId) ||
        (baselineAssistantCount === 0 && (snap?.count || 0) >= 1);
      const composerIdle =
        snap?.promptTextLength === 0 &&
        (!snap?.stop || !!snap?.hasRegenerate) &&
        (!snap?.sendPresent || !!snap?.sendEnabled);
      lastNewChatGPTAssistant = !!newChatGPTAssistant;
      lastComposerIdle = !!composerIdle;
      const chatGPTDone =
        !!snap?.isChatGPT &&
        newChatGPTAssistant &&
        (!snap?.stop || !!snap?.hasRegenerate) &&
        composerIdle &&
        (stopGoneLongEnough || !!snap?.hasRegenerate) &&
        !!snap?.assistantTerminalSignal &&
        stable &&
        txt.length > 0;
      const otherProviderDone =
        !snap?.isChatGPT &&
        ((!generating && stopGoneLongEnough && snap?.sendEnabled && stable && txt.length > 0 && (readyByNodes || fallbackWaited)) ||
          (!generating && fallbackStableLongEnough && (readyByNodes || fallbackWaited)));
      const done = chatGPTDone || otherProviderDone;
      if (done) {
        const extra = await this.#eval(`(() => {
          const host = location.hostname || '';
          const isChatGPT = host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
          const assistantCandidates = isChatGPT ? ${chatgptAssistantSel} : ${assistantSel};
          const nodes = Array.from(document.querySelectorAll(assistantCandidates));
          const lastNode = nodes[nodes.length - 1];
          const codeBlocks = Array.from(lastNode?.querySelectorAll('pre code') || []).map(c => {
            const cls = String(c.className || '');
            const lang = (cls.match(/language-([a-z0-9_-]+)/i) || [])[1] || null;
            return { language: lang, text: (c.innerText || '').trim() };
          }).filter(c => c.text);
          return { codeBlocks };
        })()`);
        return { text: txt, codeBlocks: extra?.codeBlocks || [], meta: { count: snap?.count || 0, hasError: !!snap?.hasError } };
      }

      await wait(pollMs);
    }

    const responseStarted = !!lastSnap?.isChatGPT && lastNewChatGPTAssistant && last.length > 0;
    const err = new Error(responseStarted ? 'response_completion_unconfirmed' : 'timeout_waiting_for_response');
    err.data = {
      lastLength: last.length,
      lastDigest: userTurnTextDigest(last),
      lastAssistantCount: Number(lastSnap?.count) || 0,
      lastAssistantId: String(lastSnap?.lastAssistantId || ''),
      sendPresent: !!lastSnap?.sendPresent,
      sendEnabled: !!lastSnap?.sendEnabled,
      stop: !!lastSnap?.stop,
      promptTextLength: Number.isFinite(Number(lastSnap?.promptTextLength)) ? Number(lastSnap.promptTextLength) : -1,
      newChatGPTAssistant: lastNewChatGPTAssistant,
      composerIdle: lastComposerIdle,
      assistantTerminalSignal: !!lastSnap?.assistantTerminalSignal,
      completionReason: responseStarted ? 'terminal_signal_missing' : 'assistant_turn_missing'
    };
    throw err;
  }

  async query({ prompt, attachments = [], timeoutMs = 10 * 60_000, onProgress = null, signal = null, operationId = null } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');
    throwIfSignalAborted(signal);
    const expectedFileNames = (Array.isArray(attachments) ? attachments : []).map((file) => boundedAttachmentName(path.basename(String(file || '')))).filter(Boolean);
    const run = {
      kind: 'query',
      operationId: operationId ? String(operationId) : crypto.randomUUID(),
      providerStopGeneration: this.providerStopGeneration,
      providerStopSequence: 0,
      providerStopEpoch: 0,
      providerStopToken: this.#newProviderStopToken(),
      providerStopRetired: false,
      requested: false,
      requestedAt: null,
      reason: null,
      onProgress,
      prompt,
      expectedFileNames,
      logicalExpectedFileNames: expectedFileNames,
      promptTyped: false,
      messageDispatchStarted: false,
      dispatchState: null,
      dispatchStateUnknown: false,
      providerStopDispatchLease: false,
      providerStopInputStarted: false,
      sendAttemptCompleted: false,
      sendConfirmed: false,
      sendConfirmationTimedOut: false,
      attachmentOwnershipEstablished: false,
      userTurnBaseline: null,
      conversationDigest: null,
      promptDigest: '',
      promptLength: 0,
      expectedAttachmentIdentities: [],
      ownershipPhase: 'prepared',
      postSendSettled: false,
      ownershipPersisted: false,
      preflightConflict: false,
      signal
    };
    this.currentRun = run;
    const detachRunSignal = this.#bindRunSignal(run, signal);
    let uploadPlan = null;
    try {
      this.#throwIfStopRequested();
      await this.ensureReady({ timeoutMs });
      this.#throwIfStopRequested();
      await this.#activateProviderStopToken(run, signal);
      this.#throwIfStopRequested();
      try {
        await this.#preflightChatGPTAttachmentDraft();
      } catch (error) {
        run.preflightConflict = error?.message === 'chatgpt_file_input_state_conflict';
        if (error?.message !== 'chatgpt_file_input_state_conflict' || !(await this.#recoverOwnedDraftIfSafe(error))) throw error;
        await this.#preflightChatGPTAttachmentDraft();
      }
      this.#throwIfStopRequested();
      run.conversationDigest = await this.#conversationDigest();
      run.userTurnBaseline = await this.#captureUserTurnBaseline();
      run.expectedAttachmentIdentities = attachments?.length
        ? await describeAttachmentFiles(attachments.map((file) => path.resolve(file)))
        : [];
      await this.#persistDraftLease(run, 'prepared');
      if (attachments?.length) {
        uploadPlan = await this.#attachFiles(attachments, {
          onMutation: async (plan) => {
            run.attachmentOwnershipEstablished = true;
            run.expectedFileNames = plan.expectedFileNames;
            run.logicalExpectedFileNames = plan.logicalFileNames;
            run.expectedAttachmentIdentities = await describeAttachmentFiles(plan.files, plan.logicalFileNames);
            await this.#persistDraftLease(run, 'attachments-owned');
          }
        });
        run.attachmentOwnershipEstablished = true;
        run.expectedFileNames = uploadPlan.expectedFileNames;
        run.logicalExpectedFileNames = uploadPlan.logicalFileNames;
        await this.#waitForAttachmentsReady({
          timeoutMs,
          expectedFileNames: uploadPlan.expectedFileNames,
          logicalFileNames: uploadPlan.logicalFileNames
        });
      }
      const typed = await this.#typePrompt(prompt);
      run.promptTyped = true;
      run.userTurnBaseline = typed?.userTurnBaseline || run.userTurnBaseline || null;
      run.promptDigest = typed?.promptDigest || textDigest(prompt);
      run.promptLength = Number(typed?.promptLength) || prompt.length;
      await this.#persistDraftLease(run, 'prompt-owned');
      this.#throwIfStopRequested();
      const baseline = await this.#captureChatGPTAssistantBaseline();
      await this.#persistDraftLease(run, 'dispatch-started');
      await this.#clickSend({ timeoutMs });
      if (run.sendConfirmed) await this.#persistDraftLease(run, 'send-confirmed');
      const response = await this.#waitForAssistantStable({ timeoutMs: Math.min(timeoutMs, 8 * 60_000), baseline });
      const postSendDraft = await this.#settlePostSend(run);
      return { ...response, meta: { ...(response.meta || {}), postSendDraft } };
    } catch (error) {
      if (this.#canCleanupUnsentDraft(run) && (!attachments?.length || run.attachmentOwnershipEstablished)) {
        try {
          const cleanup = await this.cleanupUnsentDraft({
            prompt: run.promptTyped ? prompt : '',
            expectedFileNames: run.expectedFileNames,
            logicalFileNames: run.logicalExpectedFileNames,
            expectedAttachmentIdentities: this.draftOwnership.enabled ? run.expectedAttachmentIdentities : [],
            userTurnBaseline: run.userTurnBaseline
          });
          error.data = {
            ...(error?.data && typeof error.data === 'object' ? error.data : {}),
            cleanup
          };
          if (cleanup.status === 'cleared') await this.#clearDraftLease(run);
          else await this.#persistDraftLease(run, 'cleanup-required');
        } catch (cleanupError) {
          error.data = {
            ...(error?.data && typeof error.data === 'object' ? error.data : {}),
            cleanup: {
              status: 'failed',
              reason: boundedAttachmentError(cleanupError?.message || cleanupError),
              diagnostic: cleanupError?.data && typeof cleanupError.data === 'object' ? cleanupError.data : null
            }
          };
          await this.#persistDraftLease(run, 'cleanup-required');
        }
      } else if (run.sendConfirmed) {
        await this.#persistDraftLease(run, 'send-confirmed');
      } else if (run.attachmentOwnershipEstablished || run.promptTyped) {
        await this.#persistDraftLease(run, run.messageDispatchStarted || run.dispatchStateUnknown ? 'dispatch-started' : 'cleanup-required');
      }
      throw error;
    } finally {
      await uploadPlan?.cleanup?.().catch(() => {});
      if ((run.sendConfirmed && run.postSendSettled) || run.ownershipPhase === 'cleared' || (!run.attachmentOwnershipEstablished && !run.promptTyped && !run.preflightConflict)) await this.#clearDraftLease(run);
      this.#releaseProviderStopToken(run);
      detachRunSignal();
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  async send({ text, timeoutMs = 3 * 60_000, stopAfterSend = false, onProgress = null, signal = null, operationId = null } = {}) {
    const prompt = String(text || '');
    if (!prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');
    throwIfSignalAborted(signal);

    return await this.mutex.run(async () => {
      throwIfSignalAborted(signal);
      const run = {
        kind: 'send',
        operationId: operationId ? String(operationId) : crypto.randomUUID(),
        providerStopGeneration: this.providerStopGeneration,
        providerStopSequence: 0,
        providerStopEpoch: 0,
        providerStopToken: this.#newProviderStopToken(),
        providerStopRetired: false,
        requested: false,
        requestedAt: null,
        reason: null,
        onProgress,
        prompt,
        expectedFileNames: [],
        promptTyped: false,
        messageDispatchStarted: false,
        dispatchState: null,
        dispatchStateUnknown: false,
        providerStopDispatchLease: false,
        providerStopInputStarted: false,
        sendAttemptCompleted: false,
        sendConfirmed: false,
        sendConfirmationTimedOut: false,
        userTurnBaseline: null,
        conversationDigest: null,
        promptDigest: '',
        promptLength: 0,
        expectedAttachmentIdentities: [],
        ownershipPhase: 'prepared',
        postSendSettled: false,
        ownershipPersisted: false,
        preflightConflict: false,
        signal
      };
      this.currentRun = run;
      const detachRunSignal = this.#bindRunSignal(run, signal);
      try {
        this.#throwIfStopRequested();
        await this.ensureReady({ timeoutMs });
        this.#throwIfStopRequested();
        await this.#activateProviderStopToken(run, signal);
        this.#throwIfStopRequested();
        try {
          await this.#preflightChatGPTAttachmentDraft();
        } catch (error) {
          run.preflightConflict = error?.message === 'chatgpt_file_input_state_conflict';
          if (error?.message !== 'chatgpt_file_input_state_conflict' || !(await this.#recoverOwnedDraftIfSafe(error))) throw error;
          await this.#preflightChatGPTAttachmentDraft();
        }
        this.#throwIfStopRequested();
        run.conversationDigest = await this.#conversationDigest();
        run.userTurnBaseline = await this.#captureUserTurnBaseline();
        await this.#persistDraftLease(run, 'prepared');
        const typed = await this.#typePrompt(prompt);
        run.promptTyped = true;
        run.userTurnBaseline = typed?.userTurnBaseline || run.userTurnBaseline || null;
        run.promptDigest = typed?.promptDigest || textDigest(prompt);
        run.promptLength = Number(typed?.promptLength) || prompt.length;
        await this.#persistDraftLease(run, 'prompt-owned');
        this.#throwIfStopRequested();
        await this.#persistDraftLease(run, 'dispatch-started');
        await this.#clickSend({ timeoutMs });
        if (run.sendConfirmed) await this.#persistDraftLease(run, 'send-confirmed');

        if (stopAfterSend) {
          const start = Date.now();
          while (Date.now() - start < 2500) {
            this.#throwIfStopRequested();
            const stopResult = await this.#clickVisibleStop({ expectedToken: run.providerStopToken });
            const clicked = stopResult === true || stopResult?.clicked === true;
            if (clicked) break;
            await sleep(120);
          }
        }

        const postSendDraft = await this.#settlePostSend(run);
        return { ok: true };
      } catch (error) {
        if (this.#canCleanupUnsentDraft(run)) {
          try {
            const cleanup = await this.cleanupUnsentDraft({
              prompt: run.promptTyped ? prompt : '',
              expectedFileNames: run.expectedFileNames,
              userTurnBaseline: run.userTurnBaseline
            });
            error.data = {
              ...(error?.data && typeof error.data === 'object' ? error.data : {}),
              cleanup
            };
            if (cleanup.status === 'cleared') await this.#clearDraftLease(run);
            else await this.#persistDraftLease(run, 'cleanup-required');
          } catch (cleanupError) {
            error.data = {
              ...(error?.data && typeof error.data === 'object' ? error.data : {}),
              cleanup: {
                status: 'failed',
                reason: boundedAttachmentError(cleanupError?.message || cleanupError),
                diagnostic: cleanupError?.data && typeof cleanupError.data === 'object' ? cleanupError.data : null
              }
            };
            await this.#persistDraftLease(run, 'cleanup-required');
          }
        } else if (run.sendConfirmed) {
          await this.#persistDraftLease(run, 'send-confirmed');
        } else if (run.promptTyped) {
          await this.#persistDraftLease(run, run.messageDispatchStarted || run.dispatchStateUnknown ? 'dispatch-started' : 'cleanup-required');
        }
        throw error;
      } finally {
        if ((run.sendConfirmed && run.postSendSettled) || run.ownershipPhase === 'cleared' || !run.promptTyped) await this.#clearDraftLease(run);
        this.#releaseProviderStopToken(run);
        detachRunSignal();
        if (this.currentRun === run) this.currentRun = null;
      }
    });
  }

  async getLastAssistantImages({ maxImages = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1] || document.querySelector('main') || document.body;
      if (!last) return [];
      const results = [];
      const seen = new Set();
      const push = (item) => {
        const key = String(item.dataUrl || item.src || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        results.push(item);
      };
      const collectRoot = (root) => Array.from(root.querySelectorAll('img')).filter((img) => {
        const r = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || '';
        return src && r.width >= 64 && r.height >= 64;
      });
      const imgs = [...collectRoot(last), ...collectRoot(document.querySelector('main') || document.body)];
      for (const img of imgs) {
        if (results.length >= ${maxImages}) break;
        const src = img.currentSrc || img.src || '';
        const alt = img.alt || '';
        if (!src) continue;
        if (src.startsWith('blob:') || src.startsWith('https://') || src.startsWith('http://')) {
          try {
            const r = await fetch(src);
            const b = await r.blob();
            if (b.size > 15 * 1024 * 1024) { push({ src, alt }); continue; }
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onerror = () => reject(new Error('file_reader_error'));
              fr.onload = () => resolve(String(fr.result || ''));
              fr.readAsDataURL(b);
            });
            push({ src, alt, dataUrl });
            continue;
          } catch {}
        }
        push({ src, alt });
      }

      const canvases = Array.from(last.querySelectorAll('canvas'));
      for (let i = 0; i < canvases.length && results.length < ${maxImages}; i++) {
        const c = canvases[i];
        try {
          const dataUrl = c.toDataURL('image/png');
          if (dataUrl && dataUrl.startsWith('data:image/')) {
            push({ src: 'canvas:' + (i + 1), alt: 'canvas', dataUrl });
          }
        } catch {}
      }

      if (results.length < ${maxImages}) {
        const bgEls = Array.from((document.querySelector('main') || last).querySelectorAll('*')).filter(el => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s && s.backgroundImage && s.backgroundImage.includes('url(') && r.width >= 64 && r.height >= 64;
        }).slice(0, 50);
        for (const el of bgEls) {
          if (results.length >= ${maxImages}) break;
          const s = getComputedStyle(el).backgroundImage || '';
          const m = s.match(/url\\([\"']?([^\"')]+)[\"']?\\)/i);
          const src = m?.[1] || '';
          if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:'))) push({ src, alt: 'background-image' });
        }
      }

      if (results.length < ${maxImages}) {
        const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
          const href = String(a.href || '');
          return /\\.(png|jpe?g|webp)(\\?|#|$)/i.test(href) || /download|image|generated/i.test((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || ''));
        });
        for (const a of links) {
          if (results.length >= ${maxImages}) break;
          const src = String(a.href || '');
          if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:')) push({ src, alt: (a.textContent || '').trim() || 'link' });
        }
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async downloadLastAssistantImages({ maxImages = 6, outDir = path.join(this.stateDir, 'downloads') } = {}) {
    const imgs = await this.getLastAssistantImages({ maxImages });
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      let dataUrl = img.dataUrl || null;
      let mime = null;
      let buf = null;

      if (dataUrl && /^data:/i.test(dataUrl)) {
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && img.src && /^https?:\/\//i.test(img.src)) {
        const r = await fetch(img.src);
        if (!r.ok) continue;
        mime = r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const ext =
        mime?.includes('png') ? 'png' : mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' : mime?.includes('webp') ? 'webp' : 'bin';
      const name = `agentify-${Date.now()}-${String(i + 1).padStart(2, '0')}.${ext}`;
      const file = path.join(outDir, name);
      await fs.writeFile(file, buf);
      saved.push({ path: file, alt: img.alt || '', mime: mime || null, source: img.src || null });
    }

    return saved;
  }

  async getLastAssistantDownloads({ maxFiles = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1];
      if (!last) return [];
      const anchors = Array.from(last.querySelectorAll('a[href], a[download]'));
      const results = [];
      const seen = new Set();
      for (const a of anchors) {
        if (results.length >= ${maxFiles}) break;
        const href = String(a.href || a.getAttribute('href') || '').trim();
        const download = String(a.getAttribute('download') || '').trim();
        const text = String(a.textContent || '').trim();
        const title = String(a.getAttribute('title') || '').trim();
        const rawName = download || text || title || '';
        if (!href || seen.has(href)) continue;
        if (
          !/^blob:|^data:|^https?:/i.test(href) &&
          !/(download|export|attachment|file|csv|json|zip|pdf|doc|sheet|image)/i.test(rawName)
        ) {
          continue;
        }
        seen.add(href);
        const item = { href, name: rawName || null };
        if (/^blob:|^data:/i.test(href)) {
          try {
            const r = await fetch(href);
            const b = await r.blob();
            if (b.size <= 25 * 1024 * 1024) {
              const dataUrl = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onerror = () => reject(new Error('file_reader_error'));
                fr.onload = () => resolve(String(fr.result || ''));
                fr.readAsDataURL(b);
              });
              item.dataUrl = dataUrl;
            }
            item.mime = b.type || null;
            item.size = b.size || null;
          } catch {}
        }
        results.push(item);
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async downloadLastAssistantFiles({ maxFiles = 6, outDir = path.join(this.stateDir, 'downloads') } = {}) {
    const items = await this.getLastAssistantDownloads({ maxFiles });
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let mime = item.mime || null;
      let buf = null;

      if (item.dataUrl && /^data:/i.test(item.dataUrl)) {
        const m = String(item.dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = mime || m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && item.href && /^https?:\/\//i.test(item.href)) {
        const r = await fetch(item.href);
        if (!r.ok) continue;
        mime = mime || r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const nameHint = String(item.name || '').trim();
      const urlName = (() => {
        try {
          const u = new URL(String(item.href || ''));
          return path.basename(u.pathname || '');
        } catch {
          return '';
        }
      })();
      const extFromMime =
        mime?.includes('json') ? 'json' :
        mime?.includes('csv') ? 'csv' :
        mime?.includes('pdf') ? 'pdf' :
        mime?.includes('zip') ? 'zip' :
        mime?.includes('markdown') ? 'md' :
        mime?.includes('plain') ? 'txt' :
        mime?.includes('png') ? 'png' :
        mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' :
        mime?.includes('webp') ? 'webp' :
        'bin';
      const baseName = (nameHint || urlName || `chatgpt-file-${Date.now()}-${String(i + 1).padStart(2, '0')}`).replace(/[\\/:*?"<>|]+/g, '-');
      const nameWithExt = path.extname(baseName) ? baseName : `${baseName}.${extFromMime}`;
      const parsed = path.parse(nameWithExt);
      let finalName = nameWithExt;
      for (let suffix = 1; suffix < 1000; suffix++) {
        try {
          await fs.access(path.join(outDir, finalName));
          finalName = `${parsed.name}-${suffix}${parsed.ext}`;
        } catch {
          break;
        }
      }
      const file = path.join(outDir, finalName);
      await fs.writeFile(file, buf);
      saved.push({ path: file, name: finalName, mime: mime || null, source: item.href || null });
    }

    return saved;
  }
}

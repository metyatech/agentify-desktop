import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_CONVERSATION_TURNS = 200;
export const MAX_CONVERSATION_TURN_CHARS = 200_000;
export const MAX_CONVERSATION_TOTAL_CHARS = 2_000_000;
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
  constructor({ page, selectors, onBlocked, onUnblocked, stateDir, sendConfirmationTimeoutMs = MAX_SEND_CONFIRMATION_TIMEOUT_MS }) {
    this.page = page;
    this.selectors = selectors;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.stateDir = stateDir;
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

  async readConversationTurns({
    maxTurns = 100,
    maxCharsPerTurn = 100_000,
    maxTotalChars = 1_000_000
  } = {}) {
    const limits = {
      maxTurns: Number(maxTurns),
      maxCharsPerTurn: Number(maxCharsPerTurn),
      maxTotalChars: Number(maxTotalChars)
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

    return await this.runExclusive(async () => {
      const result = await this.#eval(`(() => {
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

      const turns = Array.isArray(result.turns)
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
      return { url: String(await this.getUrl()), turns };
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

      const looks403 = /\\b403\\b|access denied|forbidden|unusual traffic|verify/i.test(bodyText) && !/prompt/i.test(bodyText);
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
    this.#throwIfStopRequested();
    return ok;
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
    if (!run?.promptTyped || run.sendConfirmed) return false;
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
    const awaitSendStep = async (operation, step) => {
      assertSendBudget(step);
      const remainingMs = Math.max(1, sendDeadline - Date.now());
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
        timer = setTimeout(() => finish(reject, sendTimeoutError(step)), remainingMs);
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
    let domClickAttempted = false;
    let requestSubmitAttempted = false;
    let lastFallbackResult = null;
    if (res?.rect?.w > 0 && res?.rect?.h > 0) {
      assertSendBudget('coordinate_click');
      this.#throwIfStopRequested();
      const cx = Math.round(res.rect.x + res.rect.w / 2);
      const cy = Math.round(res.rect.y + res.rect.h / 2);
      await awaitSendStep(() => this.#clickAt(cx, cy, {
        onBeforeMouseDownAsync: async () => {
          const run = this.currentRun;
          await this.#claimProviderStopDispatch(run);
          await this.#beginProviderStopDispatch(run);
        },
        onBeforeMouseDown: () => {
          this.#commitProviderStopDispatchBeforeInput(this.currentRun);
        }
      }), 'coordinate_click');
      coordinateClickAttempted = true;
      assertSendBudget('coordinate_click');
      await this.#completeProviderStopDispatch(this.currentRun);
      assertSendBudget('dispatch_complete');
      this.#recordSendAttemptCompleted(true);
      sent = this.#recordSendConfirmation(await waitForSendConfirmation());
    }

    if (!sent && res?.isChatGPT && coordinateClickAttempted) {
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
            domClickAttempted,
            requestSubmitAttempted,
            lastFallbackResult,
            sendConfirmed: !!this.currentRun?.sendConfirmed
          }
        : { host: res?.host || null };
      throw err;
    }
  }

  async #attachFiles(files) {
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
      const fileCards = activeComposer
        ? Array.from(activeComposer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard)
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
        mappingErrors,
        fileStates,
        composerInputCount: chatgptUploadInputs.length,
        pageUploadInputCount: pageUploadInputs.length
      };
      if (inputReady) return inputState;
      if (chatgptUploadInputs.length > 0) {
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
      if (!attach) return { isChatGPT, opened: false };
      attach.click();
      return { isChatGPT, opened: true };
    })()`);

    if (opened?.isChatGPT && opened?.inputReady) {
      if (opened?.selectionMatchesExpected && opened?.mappingComplete) return uploadPlan;
      if (opened?.selectionMatchesExpected && Number(opened?.cardCount) > 0) {
        const err = new Error('chatgpt_file_input_state_conflict');
        err.data = {
          expectedFileNames: opened.expectedFileNames || expectedFileNames,
          selectedFileNames: opened.selectedFileNames || [],
          cardDisplayNames: opened.cardDisplayNames || [],
          fileCount: Number(opened.fileCount) || 0,
          cardCount: Number(opened.cardCount) || 0,
          mappingErrors: Array.isArray(opened.mappingErrors) ? opened.mappingErrors : []
        };
        throw err;
      }
      if (opened?.selectionMatchesExpected && Number(opened?.cardCount) === 0) {
        await this.#clearChatGPTFileInput({
          expectedFileNames: opened.expectedFileNames || expectedFileNames,
          selectedFileNames: opened.selectedFileNames || [],
          cardDisplayNames: opened.cardDisplayNames || [],
          composerInputCount: opened.composerInputCount,
          pageUploadInputCount: opened.pageUploadInputCount
        });
        await this.#waitForChatGPTFileInputCleared({
          expectedFileNames: opened.expectedFileNames || expectedFileNames,
          selectedFileNames: opened.selectedFileNames || [],
          cardDisplayNames: opened.cardDisplayNames || [],
          composerInputCount: opened.composerInputCount,
          pageUploadInputCount: opened.pageUploadInputCount
        });
      }
      await this.page.setFileInputFiles(uploadPlan.files, { selector: '#upload-files' });
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
    } else {
      await this.page.setFileInputFiles(uploadPlan.files);
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
      const fileCards = activeComposer ? Array.from(activeComposer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard) : [];
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
        const fileCards = activeComposer ? Array.from(activeComposer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard) : [];
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
    let menuSelected = false;

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
        const menuAlreadySelected = ${menuSelected};
        const visibleMenuRoots = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper]')).filter(visible);
        const fileMenuItems = visibleMenuRoots.flatMap((menu) => Array.from(menu.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a')));
        const fileMenuItem = fileMenuItems.find((node) => visible(node) && labelsOf(node).some((label) => fileLabels.has(label)));
        if (!fileMenuItem || menuAlreadySelected) return { inputAvailable: false, selected: false };
        fileMenuItem.click();
        return { inputAvailable: false, selected: true };
      })()`);

      if (last?.inputAvailable) return;
      if (last?.selected) menuSelected = true;
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
        const fileCards = composer ? Array.from(composer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard) : [];
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
        const attachmentReady = promptText.length > 0 && mappingComplete && fileStates.every((state) => state.matched && !state.pending && !state.failed) && !busy && !!send && !disabled(send);
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

  async #cleanupUnsentDraft({ prompt, expectedFileNames = [], logicalFileNames = expectedFileNames, userTurnBaseline = null } = {}) {
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
    const baselineJson = JSON.stringify({
      count: normalizedUserTurnBaseline.count,
      lastId: normalizedUserTurnBaseline.lastId,
      lastTextDigest: normalizedUserTurnBaseline.lastTextDigest
    });
    const result = await this.#eval(`(async () => {
      const agentifyAttachmentCleanup = true;
      const expectedPrompt = ${promptJson};
      const expectedFileNames = ${expectedFileNamesJson};
      const logicalFileNames = ${logicalFileNamesJson};
      const baseline = ${baselineJson};
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
      if (baselineChanged) return { ok: false, reason: 'user_turn_added', userTurnCount: userTurns.length };
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
      const selectedFileNames = names(Array.from(uploadInput?.files || []).map((file) => file.name));
      const inputValue = String(uploadInput?.value || '');
      const isFileCard = (card) => card.classList.contains('group/file-tile') || Array.from(card.querySelectorAll('button[aria-label]')).some((button) => /削除|remove|delete/i.test(String(button.getAttribute('aria-label') || '')));
      const fileCards = Array.from(composer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard);
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
        if (uploadInputs.length !== 1 || pageUploadInputs.length !== 1 || pageUploadInputs[0] !== uploadInputs[0] || !selectedMatches || !mappingResult.mappingComplete) {
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
        const cardCount = Array.from(composer.querySelectorAll('[role="group"][aria-label]')).filter(isFileCard).length;
        const promptText = promptNode.matches('textarea, input') ? String(promptNode.value || '') : String(promptNode.innerText || promptNode.textContent || '');
        const userTurnCount = Array.from(document.querySelectorAll('[data-message-author-role="user"], article[data-turn="user"]')).length;
        return {
          selectedFileNames,
          cardCount,
          promptTextLength: promptText.trim().length,
          userTurnCount,
          cleared: selectedFileNames.length === 0 && cardCount === 0 && promptText.trim() === '' && userTurnCount === baseline.count
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
    const start = Date.now();
    const baselineAssistantCount = Math.max(0, Number(baseline?.assistantCount) || 0);
    const baselineAssistantId = String(baseline?.lastAssistantId || '').trim();
    let last = '';
    let lastChange = Date.now();
    let stopGoneAt = null;
    let continueClicks = 0;
    let lastSnap = null;
    let lastNewChatGPTAssistant = false;
    let lastComposerIdle = false;

    while (Date.now() - start < timeoutMs) {
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
        return { isChatGPT, stop, sendPresent, sendEnabled, promptTextLength, txt, count: nodes.length, lastAssistantId, usedFallback: !lastNode, hasError, hasContinue, hasRegenerate };
      })()`);
      lastSnap = snap;

      const txt = String(snap?.txt || '');
      if (txt !== last) {
        last = txt;
        lastChange = Date.now();
      }

      // Some providers expose unrelated visible "stop/cancel" controls.
      // ChatGPT's normal stop control is authoritative even when its send control is absent.
      const generating = snap?.isChatGPT ? !!snap?.stop : !!snap?.stop && !snap?.sendEnabled;
      if (generating) stopGoneAt = null;
      else if (stopGoneAt == null) stopGoneAt = Date.now();

      const dynamicStableMs = Math.max(stableMs, txt.length > 8000 ? 3000 : txt.length > 2000 ? 2200 : stableMs);
      const stable = Date.now() - lastChange >= dynamicStableMs;
      const stopGoneLongEnough = stopGoneAt != null && Date.now() - stopGoneAt >= 800;

      if (!snap?.stop && snap?.hasContinue && continueClicks < 3) {
        continueClicks += 1;
        await this.#eval(`(() => {
          const btn = Array.from(document.querySelectorAll('button, a')).find(b => /continue generating/i.test((b.textContent||'').trim()));
          if (btn) btn.click();
        })()`);
        await sleep(250);
        continue;
      }

      const readyByNodes = (snap?.count || 0) > 0;
      const fallbackWaited = !snap?.isChatGPT && !!snap?.usedFallback && (Date.now() - start >= 2500);
      const fallbackStableLongEnough = !snap?.isChatGPT && txt.length > 0 && (Date.now() - lastChange >= Math.max(dynamicStableMs, 5000));
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

      await sleep(pollMs);
    }

    const err = new Error('timeout_waiting_for_response');
    err.data = {
      last,
      lastAssistantCount: Number(lastSnap?.count) || 0,
      lastAssistantId: String(lastSnap?.lastAssistantId || ''),
      sendPresent: !!lastSnap?.sendPresent,
      sendEnabled: !!lastSnap?.sendEnabled,
      stop: !!lastSnap?.stop,
      promptTextLength: Number.isFinite(Number(lastSnap?.promptTextLength)) ? Number(lastSnap.promptTextLength) : -1,
      newChatGPTAssistant: lastNewChatGPTAssistant,
      composerIdle: lastComposerIdle
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
      operationId: operationId ? String(operationId) : null,
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
      userTurnBaseline: null,
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
      run.promptTyped = true;
      const typed = await this.#typePrompt(prompt);
      run.userTurnBaseline = typed?.userTurnBaseline || null;
      this.#throwIfStopRequested();
      if (attachments?.length) {
        uploadPlan = await this.#attachFiles(attachments);
        run.expectedFileNames = uploadPlan.expectedFileNames;
        run.logicalExpectedFileNames = uploadPlan.logicalFileNames;
        await this.#waitForAttachmentsReady({
          timeoutMs,
          expectedFileNames: uploadPlan.expectedFileNames,
          logicalFileNames: uploadPlan.logicalFileNames
        });
      }
      const baseline = await this.#captureChatGPTAssistantBaseline();
      await this.#clickSend({ timeoutMs });
      return await this.#waitForAssistantStable({ timeoutMs: Math.min(timeoutMs, 8 * 60_000), baseline });
    } catch (error) {
      if (this.#canCleanupUnsentDraft(run)) {
        try {
          error.data = {
            ...(error?.data && typeof error.data === 'object' ? error.data : {}),
            cleanup: await this.#cleanupUnsentDraft({
              prompt,
              expectedFileNames: run.expectedFileNames,
              logicalFileNames: run.logicalExpectedFileNames,
              userTurnBaseline: run.userTurnBaseline
            })
          };
        } catch (cleanupError) {
          error.data = {
            ...(error?.data && typeof error.data === 'object' ? error.data : {}),
            cleanup: {
              status: 'failed',
              reason: boundedAttachmentError(cleanupError?.message || cleanupError),
              diagnostic: cleanupError?.data && typeof cleanupError.data === 'object' ? cleanupError.data : null
            }
          };
        }
      }
      throw error;
    } finally {
      await uploadPlan?.cleanup?.().catch(() => {});
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
        operationId: operationId ? String(operationId) : null,
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
        run.promptTyped = true;
        const typed = await this.#typePrompt(prompt);
        run.userTurnBaseline = typed?.userTurnBaseline || run.userTurnBaseline || null;
        this.#throwIfStopRequested();
        await this.#clickSend({ timeoutMs });

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

        return { ok: true };
      } catch (error) {
        if (this.#canCleanupUnsentDraft(run)) {
          try {
            error.data = {
              ...(error?.data && typeof error.data === 'object' ? error.data : {}),
              cleanup: await this.#cleanupUnsentDraft({
                prompt,
                expectedFileNames: run.expectedFileNames,
                userTurnBaseline: run.userTurnBaseline
              })
            };
          } catch (cleanupError) {
            error.data = {
              ...(error?.data && typeof error.data === 'object' ? error.data : {}),
              cleanup: {
                status: 'failed',
                reason: boundedAttachmentError(cleanupError?.message || cleanupError),
                diagnostic: cleanupError?.data && typeof cleanupError.data === 'object' ? cleanupError.data : null
              }
            };
          }
        }
        throw error;
      } finally {
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

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export async function atomicWriteFile(filePath, data, { mode } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(tmp, 'wx', mode || 0o600);
    await handle.writeFile(data, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, filePath);
    try {
      const directoryHandle = await fs.open(dir, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {}
  } catch (error) {
    try {
      await handle?.close?.();
    } catch {}
    try {
      await fs.rm(tmp, { force: true });
    } catch {}
    throw error;
  }
}

export function defaultStateDir() {
  return process.env.AGENTIFY_DESKTOP_STATE_DIR || path.join(os.homedir(), '.agentify-desktop');
}

export function tokenPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'token.txt');
}

export function statePath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'state.json');
}

export function settingsPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'settings.json');
}

export const WATCHER_REGISTRATION_SCHEMA_VERSION = 1;
export const WATCHER_REGISTRATION_FILE = 'autopilot-watcher-registration.json';

export function watcherRegistrationPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, WATCHER_REGISTRATION_FILE);
}

export function validateWatcherRegistration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== WATCHER_REGISTRATION_SCHEMA_VERSION ||
      typeof value.managementRoot !== 'string' || !path.isAbsolute(value.managementRoot) ||
      typeof value.controllerEntryPath !== 'string' || !path.isAbsolute(value.controllerEntryPath) ||
      typeof value.installedAt !== 'string' || !Number.isFinite(Date.parse(value.installedAt))) {
    throw new Error('invalid_watcher_registration');
  }
  return {
    schemaVersion: WATCHER_REGISTRATION_SCHEMA_VERSION,
    managementRoot: path.resolve(value.managementRoot),
    controllerEntryPath: path.resolve(value.controllerEntryPath),
    installedAt: new Date(value.installedAt).toISOString(),
  };
}

export async function readWatcherRegistration(stateDir = defaultStateDir()) {
  try {
    return validateWatcherRegistration(JSON.parse(await fs.readFile(watcherRegistrationPath(stateDir), 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeWatcherRegistration(value, stateDir = defaultStateDir()) {
  const registration = validateWatcherRegistration(value);
  await ensureStateDir(stateDir);
  await atomicWriteFile(watcherRegistrationPath(stateDir), `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  return registration;
}

export async function removeWatcherRegistration(value, stateDir = defaultStateDir()) {
  const current = await readWatcherRegistration(stateDir);
  if (!current) return false;
  const expected = validateWatcherRegistration(value);
  if (current.managementRoot !== expected.managementRoot || current.controllerEntryPath !== expected.controllerEntryPath) {
    throw new Error('watcher_registration_ownership_mismatch');
  }
  await fs.unlink(watcherRegistrationPath(stateDir));
  return true;
}

export function defaultSettings() {
  return {
    browserBackend: 'chrome-cdp',
    chromeDebugPort: 9222,
    chromeExecutablePath: null,
    chromeProfileMode: 'isolated',
    chromeProfileName: 'Default',
    codexModel: null,
    codexReasoningEffort: null,

    // Governor defaults (intentionally conservative).
    maxInflightQueries: 2,
    maxQueriesPerMinute: 12,
    minTabGapMs: 1200,
    minGlobalGapMs: 200,

    // UX defaults.
    showTabsByDefault: false,
    allowAuthPopups: true,

    // Acknowledgment for changing settings (UX only; not required for operation).
    acknowledgedAt: null
  };
}

export function normalizeSettings(input) {
  const d = defaultSettings();
  const s = input && typeof input === 'object' ? input : {};

  const clampInt = (v, { min, max, fallback }) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return Math.max(min, Math.min(max, i));
  };

  const clampMs = (v, { min, max, fallback }) => clampInt(v, { min, max, fallback });

  const out = {
    browserBackend: ['electron', 'chrome-cdp'].includes(String(s.browserBackend || '').trim().toLowerCase())
      ? String(s.browserBackend || '').trim().toLowerCase()
      : d.browserBackend,
    chromeDebugPort: clampInt(s.chromeDebugPort, { min: 1024, max: 65535, fallback: d.chromeDebugPort }),
    chromeExecutablePath:
      typeof s.chromeExecutablePath === 'string' && s.chromeExecutablePath.trim() ? s.chromeExecutablePath.trim() : null,
    chromeProfileMode: ['isolated', 'existing'].includes(String(s.chromeProfileMode || '').trim().toLowerCase())
      ? String(s.chromeProfileMode || '').trim().toLowerCase()
      : d.chromeProfileMode,
    chromeProfileName:
      typeof s.chromeProfileName === 'string' && s.chromeProfileName.trim() ? s.chromeProfileName.trim() : d.chromeProfileName,
    codexModel: typeof s.codexModel === 'string' && s.codexModel.trim() ? s.codexModel.trim() : null,
    codexReasoningEffort: typeof s.codexReasoningEffort === 'string' && s.codexReasoningEffort.trim() ? s.codexReasoningEffort.trim() : null,
    maxInflightQueries: clampInt(s.maxInflightQueries, { min: 1, max: 12, fallback: d.maxInflightQueries }),
    maxQueriesPerMinute: clampInt(s.maxQueriesPerMinute, { min: 1, max: 600, fallback: d.maxQueriesPerMinute }),
    minTabGapMs: clampMs(s.minTabGapMs, { min: 0, max: 60_000, fallback: d.minTabGapMs }),
    minGlobalGapMs: clampMs(s.minGlobalGapMs, { min: 0, max: 10_000, fallback: d.minGlobalGapMs }),
    showTabsByDefault: !!s.showTabsByDefault,
    allowAuthPopups: typeof s.allowAuthPopups === 'boolean' ? s.allowAuthPopups : d.allowAuthPopups,
    acknowledgedAt: typeof s.acknowledgedAt === 'string' && s.acknowledgedAt.trim() ? s.acknowledgedAt.trim() : null
  };
  return out;
}

export async function ensureStateDir(stateDir = defaultStateDir()) {
  await fs.mkdir(stateDir, { recursive: true });
}

export async function readToken(stateDir = defaultStateDir()) {
  const tokenFromEnv = (process.env.AGENTIFY_DESKTOP_TOKEN || '').trim();
  if (tokenFromEnv) return tokenFromEnv;
  try {
    return (await fs.readFile(tokenPath(stateDir), 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function writeToken(token, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(tokenPath(stateDir), `${token}\n`, { mode: 0o600 });
}

export async function ensureToken(stateDir = defaultStateDir()) {
  const existing = await readToken(stateDir);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  await writeToken(token, stateDir);
  return token;
}

export async function readState(stateDir = defaultStateDir()) {
  try {
    return JSON.parse(await fs.readFile(statePath(stateDir), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(state, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(statePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readSettings(stateDir = defaultStateDir()) {
  try {
    const raw = await fs.readFile(settingsPath(stateDir), 'utf8');
    return normalizeSettings(JSON.parse(raw || '{}'));
  } catch {
    return defaultSettings();
  }
}

export async function writeSettings(settings, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  const normalized = normalizeSettings(settings);
  await atomicWriteFile(settingsPath(stateDir), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

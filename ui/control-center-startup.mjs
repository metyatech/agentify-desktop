export const CONTROL_CENTER_IPC_TIMEOUT_MS = 15_000;

export async function callControlCenterApi(
  bridge,
  name,
  args,
  { fallback = null, required = false, timeoutMs = CONTROL_CENTER_IPC_TIMEOUT_MS } = {}
) {
  if (typeof bridge?.[name] !== 'function') {
    const error = new Error('control_center_bridge_api_unavailable');
    error.code = 'BRIDGE_API_UNAVAILABLE';
    if (required) throw error;
    return fallback;
  }
  try {
    const result = typeof args === 'undefined' ? bridge[name]() : bridge[name](args);
    return await withControlCenterTimeout(result, name, timeoutMs);
  } catch (error) {
    if (required) throw error;
    return fallback;
  }
}

export function safeControlCenterErrorCode(error, fallback = 'CONTROL_CENTER_STARTUP_FAILED') {
  const raw = typeof error?.code === 'string' ? error.code : fallback;
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64);
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(normalized) ? normalized : fallback;
}

async function withControlCenterTimeout(value, name, timeoutMs) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) return await value;
  let timerId = null;
  try {
    return await Promise.race([
      value,
      new Promise((_, reject) => {
        timerId = setTimeout(() => {
          const error = new Error('control_center_ipc_timeout');
          error.code = `IPC_TIMEOUT_${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 48)}`;
          reject(error);
        }, timeout);
      })
    ]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

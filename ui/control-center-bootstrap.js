const MODULE_LOAD_FAILURE_CODE = 'MODULE_LOAD_FAILED';

export async function startControlCenter(importer = (specifier) => import(specifier)) {
  try {
    await importer('./control-center.js');
    return { ok: true };
  } catch {
    showBootstrapFailure();
    return { ok: false, code: MODULE_LOAD_FAILURE_CODE };
  }
}

export function showBootstrapFailure() {
  try {
    const status = typeof document !== 'undefined' ? document.getElementById('statusLine') : null;
    if (status) {
      status.textContent = `Control Center failed to initialize: ${MODULE_LOAD_FAILURE_CODE}`;
      status.classList?.add?.('isError');
    }
    const message = typeof document !== 'undefined' ? document.getElementById('messageLine') : null;
    if (message) {
      message.textContent = '起動に失敗しました。Agentify Desktopを再起動してください。';
      message.classList?.add?.('isError');
    }
  } catch {
    // The bootstrap must remain safe even when the document is incomplete.
  }
  try {
    console.warn(`[control-center:${MODULE_LOAD_FAILURE_CODE}]`);
  } catch {}
}

if (typeof document !== 'undefined') void startControlCenter();

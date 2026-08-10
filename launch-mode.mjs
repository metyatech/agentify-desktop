export function hasStartMinimizedArg(commandLine) {
  if (!Array.isArray(commandLine)) return false;
  return commandLine.some((value) => String(value).trim().toLowerCase() === '--start-minimized');
}

export function createControlCenterShowGate(onShow) {
  if (typeof onShow !== 'function') throw new TypeError('onShow must be a function');

  let ready = false;
  let pending = false;

  const request = () => {
    if (!ready) {
      pending = true;
      return Promise.resolve(false);
    }
    return Promise.resolve(onShow()).then(() => true);
  };

  const markReady = () => {
    ready = true;
    if (!pending) return Promise.resolve(false);
    pending = false;
    return Promise.resolve(onShow()).then(() => true);
  };

  return {
    request,
    markReady,
    isReady: () => ready,
    isPending: () => pending
  };
}

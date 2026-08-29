import test from 'node:test';
import assert from 'node:assert/strict';

import { ElectronBrowserBackend } from '../electron-browser-backend.mjs';

class MockBrowserWindow {
  constructor() {
    this.destroyed = false;
    this.closed = false;
    this.minimized = false;
    this.visible = false;
    this.focused = false;
    this.listeners = new Map();
    this.webContentsListeners = new Map();
    this.webContents = {
      inputEvents: [],
      isDestroyed: () => this.destroyed,
      setUserAgent: () => {},
      insertText: async () => {},
      getURL: () => this.currentUrl || '',
      on: (event, handler) => {
        const list = this.webContentsListeners.get(event) || [];
        list.push(handler);
        this.webContentsListeners.set(event, list);
      },
      setWindowOpenHandler: () => {},
      sendInputEvent: (event) => { this.webContents.inputEvents.push(event); }
    };
  }

  on(event, handler) {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  async loadURL() {
    throw new Error('load_failed');
  }

  isDestroyed() {
    return this.destroyed;
  }

  isVisible() {
    return this.visible;
  }

  isFocused() {
    return this.focused;
  }

  destroy() {
    this.destroyed = true;
  }

  close() {
    const closeHandlers = this.listeners.get('close') || [];
    let prevented = false;
    const event = {
      preventDefault() {
        prevented = true;
      }
    };
    for (const handler of closeHandlers) handler(event);
    if (prevented) return;
    this.closed = true;
    this.destroyed = true;
    const closedHandlers = this.listeners.get('closed') || [];
    for (const handler of closedHandlers) handler();
  }

  isMinimized() {
    return this.minimized;
  }

  minimize() {
    this.minimized = true;
  }

  setTitle() {}

  emitWebContents(event, ...args) {
    const handlers = this.webContentsListeners.get(event) || [];
    for (const handler of handlers) handler(...args);
  }
}

test('electron-browser-backend: createSession destroys window if loadURL fails', async () => {
  let createdWindow = null;
  class TestBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: TestBrowserWindow
  });

  await assert.rejects(
    async () => await backend.createSession({ url: 'https://chatgpt.com/' }),
    /load_failed/
  );
  assert.equal(createdWindow?.destroyed, true);
});

test('electron-browser-backend: mouseWheel dispatches a bounded native mouseWheel event', async () => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {}
  }
  const backend = new ElectronBrowserBackend({ BrowserWindowClass: OkBrowserWindow });
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  await session.page.mouseWheel(320, 480, 0, -720);
  assert.deepEqual(createdWindow.webContents.inputEvents.at(-1), {
    type: 'mouseWheel', x: 320, y: 480, deltaX: 0, deltaY: -720
  });
  await assert.rejects(session.page.mouseWheel(10_001, 480, 0, -720), /mouse_wheel_input_invalid/u);
  await backend.dispose();
});

test('electron-browser-backend: native input diagnostics expose read-only window state', async () => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {}
  }
  const backend = new ElectronBrowserBackend({ BrowserWindowClass: OkBrowserWindow });
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  const initial = await session.page.getNativeInputDiagnostics();
  assert.deepEqual(initial, {
    backend: 'electron',
    windowDestroyed: false,
    webContentsDestroyed: false,
    windowVisible: false,
    windowFocused: false,
    windowMinimized: false
  });
  createdWindow.visible = true;
  createdWindow.focused = true;
  const focused = await session.page.getNativeInputDiagnostics();
  assert.equal(focused.windowVisible, true);
  assert.equal(focused.windowFocused, true);
  createdWindow.destroyed = true;
  const destroyed = await session.page.getNativeInputDiagnostics();
  assert.equal(destroyed.windowDestroyed, true);
  assert.equal(destroyed.webContentsDestroyed, true);
  await backend.dispose();
});

test('electron-browser-backend: native input dispatch failures are wrapped with bounded cause data', async () => {
  let createdWindow = null;
  class FailingBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {}
  }
  const backend = new ElectronBrowserBackend({ BrowserWindowClass: FailingBrowserWindow });
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  createdWindow.webContents.sendInputEvent = () => {
    throw Object.assign(new Error('C:\\Users\\secret\\token 123456789012345678901234567890'), { code: 'NATIVE_PRIVATE_CODE' });
  };
  await assert.rejects(
    session.page.mouseWheel(320, 480, 0, -720),
    (error) => {
      assert.equal(error.code, 'native_mouse_wheel_dispatch_failed');
      assert.equal(error.name, 'NativeInputError');
      assert.equal(error.data.cause.errorName, 'Error');
      assert.equal(error.data.cause.errorCode, 'NATIVE_PRIVATE_CODE');
      assert.doesNotMatch(error.data.cause.errorMessage, /C:\\Users\\secret/u);
      return true;
    }
  );
  await backend.dispose();
});

test('electron-browser-backend: dispose closes tracked windows', async () => {
  const created = [];
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      created.push(this);
    }

    async loadURL() {
      return true;
    }

    isMinimized() {
      return false;
    }

    minimize() {}
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  await backend.createSession({ url: 'https://chatgpt.com/' });
  await backend.createSession({ url: 'https://claude.ai/' });
  assert.equal(created.length, 2);

  await backend.dispose();

  assert.equal(created.every((win) => win.closed), true);
  assert.equal(backend.windows.size, 0);
});

test('electron-browser-backend: session.close closes protected tabs instead of minimizing them', async () => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/', protectedTab: true });
  await session.close();

  assert.equal(createdWindow?.closed, true);
  assert.equal(createdWindow?.destroyed, true);
  assert.equal(createdWindow?.minimized, false);
});

test('electron-browser-backend: dispose closes tracked auth popup child windows too', async () => {
  const created = [];
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      created.push(this);
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  await backend.createSession({ url: 'https://chatgpt.com/' });
  const parent = created[0];
  const child = new OkBrowserWindow();
  parent.emitWebContents('did-create-window', child);

  await backend.dispose();

  assert.equal(parent.closed, true);
  assert.equal(child.closed, true);
  assert.equal(backend.windows.size, 0);
});

test('electron-browser-backend: insertText uses native webContents.insertText when available', async () => {
  let inserted = '';
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      this.webContents.insertText = async (value) => {
        inserted += value;
      };
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  await session.page.insertText('hello');

  assert.equal(inserted, 'hello');
});

test('electron-browser-backend: reports top-level regular and in-page navigation URL changes', async () => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL(url) {
      this.currentUrl = url;
      return true;
    }
  }

  const urls = [];
  const backend = new ElectronBrowserBackend({ BrowserWindowClass: OkBrowserWindow });
  await backend.createSession({
    url: 'https://chatgpt.com/',
    onUrlChanged: (url) => urls.push(url)
  });

  createdWindow.emitWebContents('did-navigate', {}, 'https://chatgpt.com/c/regular');
  createdWindow.emitWebContents('did-navigate-in-page', {}, 'https://chatgpt.com/c/spa', true);
  createdWindow.emitWebContents('did-navigate-in-page', {}, 'https://example.com/subframe', false);

  assert.deepEqual(urls, ['https://chatgpt.com/c/regular', 'https://chatgpt.com/c/spa']);
});

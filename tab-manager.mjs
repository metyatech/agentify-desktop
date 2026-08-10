import crypto from 'node:crypto';

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

function normalizeVendorToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function tabMatchesVendor(tab, { vendorId = null, url = null } = {}) {
  if (!vendorId && !url) return true;
  const requestedId = normalizeVendorToken(vendorId);
  const currentId = normalizeVendorToken(tab?.vendorId || '');
  if (requestedId && currentId) return requestedId === currentId;
  const currentUrl = String(tab?.url || '').trim();
  const requestedUrl = String(url || '').trim();
  if (currentUrl && requestedUrl) return currentUrl.startsWith(requestedUrl) || requestedUrl.startsWith(currentUrl);
  return false;
}

export class TabManager {
  constructor({ browserBackend, createController, registry = null, maxTabs = 12, onNeedsAttention, onChanged, onPersistenceError }) {
    this.browserBackend = browserBackend;
    this.createController = createController;
    this.maxTabs = Math.max(1, Number(maxTabs) || 12);
    this.onNeedsAttention = onNeedsAttention;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.registry = registry;
    this.onPersistenceError = typeof onPersistenceError === 'function' ? onPersistenceError : null;

    this.tabs = new Map(); // tabId -> { id, key, name, vendorId, vendorName, url, session, presenter, controller, createdAt, lastUsedAt }
    this.keyToId = new Map();
    this.forcedFocusTabs = new Set();
    this.mutex = new Mutex();
    this.quitting = false;
  }

  setQuitting(v = true) {
    this.quitting = !!v;
    this.browserBackend?.setQuitting?.(this.quitting);
  }

  async createTab({ key = null, name = null, url = 'https://chatgpt.com/', show = false, protectedTab = false, vendorId = null, vendorName = null } = {}) {
    return await this.mutex.run(async () => {
      return await this.#createTabUnlocked({ key, name, url, show, protectedTab, vendorId, vendorName }, { persist: true });
    });
  }

  async #createTabUnlocked(
    { key = null, name = null, url = 'https://chatgpt.com/', show = false, protectedTab = false, vendorId = null, vendorName = null } = {},
    { persist = true } = {}
  ) {
    const normalizedKey = key ? String(key).trim() : null;
    if (normalizedKey && this.keyToId.has(normalizedKey)) return this.keyToId.get(normalizedKey);
    if (this.tabs.size >= this.maxTabs) throw new Error('max_tabs_reached');

    let persistent = null;
    if (this.registry && normalizedKey && normalizedKey !== 'default') {
      persistent = this.registry.normalize([
        {
          key: normalizedKey,
          name: name || normalizedKey,
          vendorId,
          vendorName,
          url,
          protectedTab: !!protectedTab
        }
      ])[0];
    }

    const id = crypto.randomUUID();
    let closeNotified = false;
    const notifyClosed = () => {
      if (closeNotified) return;
      closeNotified = true;
      void this.#handleSessionClosed(id);
    };
    const notifyUrlChanged = (nextUrl) => {
      void this.checkpointTabUrl(id, nextUrl).catch((error) => this.#reportPersistenceError(error));
    };
    const session = await this.browserBackend.createSession({
      tabId: id,
      url: persistent?.url || url,
      show,
      protectedTab,
      vendorId,
      vendorName,
      onClosed: notifyClosed,
      onUrlChanged: notifyUrlChanged
    });
    let controller = null;
    try {
      controller = await this.createController({ tabId: id, page: session.page, session });
    } catch (error) {
      try {
        await session?.close?.();
      } catch {}
      throw error;
    }

    const tab = {
      id,
      key: normalizedKey,
      name: persistent?.name || name || normalizedKey || `tab-${id.slice(0, 8)}`,
      vendorId: persistent?.vendorId || vendorId || null,
      vendorName: persistent?.vendorName || vendorName || null,
      url: persistent?.url || String(url || ''),
      session,
      presenter: session.presenter,
      controller,
      protectedTab: persistent?.protectedTab ?? !!protectedTab,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    };

    this.tabs.set(id, tab);
    if (normalizedKey) this.keyToId.set(normalizedKey, id);
    try {
      if (persist && persistent) await this.#writePersistentTabs();
    } catch (error) {
      this.tabs.delete(id);
      this.keyToId.delete(normalizedKey);
      try {
        await session?.close?.();
      } catch {}
      throw error;
    }
    this.onChanged?.();
    return id;
  }

  async restorePersistentTabs() {
    if (!this.registry) return [];
    return await this.mutex.run(async () => {
      const entries = await this.registry.read();
      if (this.tabs.size + entries.length > this.maxTabs) throw new Error('max_tabs_reached');
      const restored = [];
      for (const entry of entries) {
        if (this.keyToId.has(entry.key)) throw new Error('tab_registry_key_conflict');
        restored.push(await this.#createTabUnlocked({ ...entry, show: false }, { persist: false }));
      }
      return restored;
    });
  }

  async checkpointTabUrl(id, url = null) {
    if (!this.registry) return false;
    return await this.mutex.run(async () => {
      const tab = this.tabs.get(id);
      if (!tab || !this.#isPersistent(tab)) return false;
      const observed = url || (await tab.session?.page?.getUrl?.());
      const canonical = this.registry.canonicalizeUrl({ vendorId: tab.vendorId, url: observed });
      if (canonical === tab.url) return false;
      const previousUrl = tab.url;
      tab.url = canonical;
      try {
        await this.#writePersistentTabs();
      } catch (error) {
        tab.url = previousUrl;
        throw error;
      }
      this.onChanged?.();
      return true;
    });
  }

  async checkpointPersistentTabs() {
    if (!this.registry) return [];
    return await this.mutex.run(async () => {
      const previousUrls = new Map();
      for (const tab of this.tabs.values()) {
        if (!this.#isPersistent(tab)) continue;
        try {
          const observed = await tab.session?.page?.getUrl?.();
          const canonical = this.registry.canonicalizeUrl({ vendorId: tab.vendorId, url: observed });
          if (canonical !== tab.url) {
            previousUrls.set(tab.id, tab.url);
            tab.url = canonical;
          }
        } catch (error) {
          this.#reportPersistenceError(error);
        }
      }
      try {
        return await this.#writePersistentTabs();
      } catch (error) {
        for (const [id, previousUrl] of previousUrls) {
          const tab = this.tabs.get(id);
          if (tab) tab.url = previousUrl;
        }
        throw error;
      }
    });
  }

  async waitForPersistence() {
    return await this.mutex.run(async () => true);
  }

  async ensureTab({ key, name, url, vendorId, vendorName, show } = {}) {
    if (!key) throw new Error('missing_key');
    const existing = this.keyToId.get(key);
    if (existing) {
      const tab = this.tabs.get(existing);
      if (!tab) {
        this.keyToId.delete(key);
        return await this.createTab({ key, name, show: !!show, url, vendorId, vendorName });
      }
      if (!tabMatchesVendor(tab, { vendorId, url })) throw new Error('key_vendor_mismatch');
      return existing;
    }
    return await this.createTab({ key, name, show: !!show, url, vendorId, vendorName });
  }

  listTabs() {
    const out = [];
    for (const t of this.tabs.values()) {
      out.push({
        id: t.id,
        key: t.key || null,
        name: t.name,
        vendorId: t.vendorId || null,
        vendorName: t.vendorName || null,
        url: t.url || null,
        protectedTab: !!t.protectedTab,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt
      });
    }
    out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    return out;
  }

  getControllerById(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    if (tab.session?.isClosed?.()) throw new Error('tab_closed');
    tab.lastUsedAt = Date.now();
    return tab.controller;
  }

  getWindowById(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('tab_not_found');
    if (tab.session?.isClosed?.()) throw new Error('tab_closed');
    tab.lastUsedAt = Date.now();
    return tab.presenter;
  }

  async closeTab(id) {
    return await this.mutex.run(async () => {
      const tab = this.tabs.get(id);
      if (!tab) throw new Error('tab_not_found');
      if (this.#isPersistent(tab)) await this.#writePersistentTabs({ excludeId: id });
      if (tab.key) this.keyToId.delete(tab.key);
      this.tabs.delete(id);
      this.forcedFocusTabs.delete(id);
      try {
        await tab.session?.close?.();
      } catch {}
      this.onChanged?.();
      return true;
    });
  }

  async #handleSessionClosed(id) {
    return await this.mutex.run(async () => {
      const tab = this.tabs.get(id);
      if (!tab) return;
      if (!this.quitting && this.#isPersistent(tab)) {
        try {
          await this.#writePersistentTabs({ excludeId: id });
        } catch (error) {
          this.#reportPersistenceError(error);
        }
      }
      this.tabs.delete(id);
      if (tab.key) this.keyToId.delete(tab.key);
      this.forcedFocusTabs.delete(id);
      this.onChanged?.();
    });
  }

  #isPersistent(tab) {
    return !!(this.registry && tab?.key && tab.key !== 'default');
  }

  #persistentEntries({ excludeId = null } = {}) {
    return Array.from(this.tabs.values())
      .filter((tab) => tab.id !== excludeId && this.#isPersistent(tab))
      .map((tab) => ({
        key: tab.key,
        name: tab.name,
        vendorId: tab.vendorId,
        vendorName: tab.vendorName,
        url: tab.url,
        protectedTab: !!tab.protectedTab
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async #writePersistentTabs(options = {}) {
    if (!this.registry) return [];
    return await this.registry.write(this.#persistentEntries(options));
  }

  #reportPersistenceError(error) {
    try {
      this.onPersistenceError?.(error);
    } catch {}
  }

  async needsAttention(tabId, reason) {
    this.forcedFocusTabs.add(tabId);
    try {
      const presenter = this.getWindowById(tabId);
      if (presenter.isMinimized?.()) presenter.restore?.();
      presenter.show?.();
      presenter.focus?.();
    } catch {}
    await this.onNeedsAttention?.({ tabId, reason });
  }

  async resolvedAttention(tabId) {
    const wasForced = this.forcedFocusTabs.has(tabId);
    this.forcedFocusTabs.delete(tabId);
    if (wasForced) {
      try {
        const presenter = this.getWindowById(tabId);
        if (presenter.isVisible?.()) presenter.minimize?.();
      } catch {}
    }
    if (this.forcedFocusTabs.size === 0) {
      await this.onNeedsAttention?.({ tabId: null, reason: 'all_clear' });
    }
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile, ensureStateDir } from './state.mjs';

export const TAB_REGISTRY_SCHEMA_VERSION = 1;

export function tabRegistryPath(stateDir) {
  return path.join(stateDir, 'tabs.json');
}

function invalid(reason) {
  const error = new Error('tab_registry_invalid');
  error.data = { reason };
  return error;
}

function requireBoundedString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== 'string') throw invalid(`${field}_type`);
  const result = value.trim();
  if (result.length < min || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw invalid(`${field}_value`);
  }
  return result;
}

function canonicalVendorUrl(rawUrl, vendor) {
  let parsed;
  let base;
  try {
    parsed = new URL(requireBoundedString(rawUrl, 'url', { max: 2048 }));
    base = new URL(vendor.url);
  } catch {
    throw invalid('url_parse');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw invalid('url_protocol');
  if (parsed.username || parsed.password) throw invalid('url_credentials');
  if (parsed.origin !== base.origin) throw invalid('url_vendor_mismatch');
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

function normalizeEntry(entry, vendorById) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('tab_type');
  const allowed = new Set(['key', 'name', 'vendorId', 'vendorName', 'url', 'protectedTab']);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) throw invalid('tab_unknown_field');
  }
  const key = requireBoundedString(entry.key, 'key', { max: 128 });
  if (key === 'default') throw invalid('default_key_reserved');
  const vendorId = requireBoundedString(entry.vendorId, 'vendorId', { max: 80 });
  const vendor = vendorById.get(vendorId);
  if (!vendor) throw invalid('unsupported_vendor');
  if (typeof entry.protectedTab !== 'boolean') throw invalid('protectedTab_type');
  return {
    key,
    name: requireBoundedString(entry.name, 'name', { max: 200 }),
    vendorId,
    vendorName: requireBoundedString(entry.vendorName, 'vendorName', { max: 200 }),
    url: canonicalVendorUrl(entry.url, vendor),
    protectedTab: entry.protectedTab
  };
}

export class TabRegistry {
  constructor({ stateDir, vendors = [], atomicWrite = atomicWriteFile, readFile = fs.readFile } = {}) {
    if (!stateDir) throw new Error('missing_state_dir');
    this.stateDir = stateDir;
    this.filePath = tabRegistryPath(stateDir);
    this.atomicWrite = atomicWrite;
    this.readFile = readFile;
    this.vendorById = new Map(
      vendors
        .filter((vendor) => vendor && typeof vendor.id === 'string' && typeof vendor.url === 'string')
        .map((vendor) => [vendor.id.trim(), vendor])
    );
  }

  normalize(entries) {
    if (!Array.isArray(entries)) throw invalid('tabs_type');
    const seen = new Set();
    return entries.map((entry) => {
      const normalized = normalizeEntry(entry, this.vendorById);
      if (seen.has(normalized.key)) throw invalid('duplicate_key');
      seen.add(normalized.key);
      return normalized;
    });
  }

  canonicalizeUrl({ vendorId, url }) {
    const vendor = this.vendorById.get(String(vendorId || '').trim());
    if (!vendor) throw invalid('unsupported_vendor');
    return canonicalVendorUrl(url, vendor);
  }

  async read() {
    let raw;
    try {
      raw = await this.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid('json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('root_type');
    const rootFields = Object.keys(parsed);
    if (rootFields.length !== 2 || !rootFields.includes('schemaVersion') || !rootFields.includes('tabs')) {
      throw invalid('root_fields');
    }
    if (parsed.schemaVersion !== TAB_REGISTRY_SCHEMA_VERSION) throw invalid('schema_version');
    return this.normalize(parsed.tabs);
  }

  async write(entries) {
    const tabs = this.normalize(entries);
    await ensureStateDir(this.stateDir);
    const document = { schemaVersion: TAB_REGISTRY_SCHEMA_VERSION, tabs };
    await this.atomicWrite(this.filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    return tabs;
  }
}

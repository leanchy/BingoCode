import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ProvidersIndex, SavedProvider, CreateProviderInput, UpdateProviderInput } from '../types/provider.ts';
import { loadPresets, applyPreset } from '../config/providerPresets.ts';
import axios from 'axios';

const home = process.env.CLAUDE_CONFIG_DIR || os.homedir();
const PROVIDERS_PATH = path.resolve(home, '.claude', 'bingo', 'providers.json');

export class ProviderManager {
  static async load(): Promise<ProvidersIndex> {
    try {
      const raw = await fs.readFile(PROVIDERS_PATH, 'utf-8');
      return JSON.parse(raw) as ProvidersIndex;
    } catch (e: any) {
      if (e && e.code === 'ENOENT') {
        const init: ProvidersIndex = { activeId: null as any, providers: [] as any[] } as ProvidersIndex;
        await this.save(init);
        return init;
      }
      throw e;
    }
  }

  static async save(data: ProvidersIndex): Promise<void> {
    const tmpPath = PROVIDERS_PATH + '.tmp';
    await fs.mkdir(path.dirname(PROVIDERS_PATH), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
    await fs.rename(tmpPath, PROVIDERS_PATH);
  }

  static async listProviders(): Promise<SavedProvider[]> {
    const idx = await this.load();
    return idx.providers || [];
  }

  static async getCurrentProvider(): Promise<SavedProvider | undefined> {
    const idx = await this.load();
    if (!idx.activeId) return undefined;
    return idx.providers.find(p => p.id === idx.activeId);
  }

  static async setCurrentProvider(id: string): Promise<void> {
    const idx = await this.load();
    if (!idx.providers.find(p => p.id === id)) throw new Error('Provider not found');
    idx.activeId = id;
    await this.save(idx);
  }

  static async addProvider(input: CreateProviderInput & { id?: string }): Promise<SavedProvider> {
    const idx = await this.load();
    const id = input.id || input.presetId;
    if (!id) throw new Error('id/presetId is required');
    if (idx.providers.find(p => p.id === id)) throw new Error('Provider id already exists');
    const provider: SavedProvider = {
      id,
      presetId: input.presetId,
      name: input.name,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      apiFormat: input.apiFormat,
      models: input.models,
      notes: input.notes,
      extra: input.extra || {},
    };
    // 合并任意额外字段到 extra
    for (const [k, v] of Object.entries(input)) {
      if (!(k in provider)) (provider.extra ||= {})[k] = v as any;
    }
    idx.providers.push(provider);
    await this.save(idx);
    return provider;
  }

  static async removeProvider(id: string): Promise<void> {
    const idx = await this.load();
    idx.providers = idx.providers.filter(p => p.id !== id);
    if (idx.activeId === id) idx.activeId = null;
    await this.save(idx);
  }

  static async updateProvider(id: string, input: UpdateProviderInput): Promise<SavedProvider> {
    const idx = await this.load();
    const index = idx.providers.findIndex(p => p.id === id);
    if (index === -1) throw new Error('Provider not found');
    const base = idx.providers[index];
    const merged: SavedProvider = {
      ...base,
      ...input,
      models: input.models || base.models,
    };
    // 更新 extra 扩展
    if (input) {
      merged.extra = { ...(base.extra || {}) };
      for (const [k, v] of Object.entries(input)) {
        if (!(k in base)) merged.extra[k] = v as any;
      }
    }
    idx.providers[index] = merged;
    await this.save(idx);
    return merged;
  }

  static async getProvider(id: string): Promise<SavedProvider | undefined> {
    const idx = await this.load();
    return idx.providers.find(p => p.id === id);
  }

  static async upsertProvider(input: CreateProviderInput & { id?: string }): Promise<SavedProvider> {
    const idx = await this.load();
    const id = input.id || input.presetId;
    if (!id) throw new Error('id/presetId is required');
    const exists = idx.providers.find(p => p.id === id);
    return exists ? this.updateProvider(id, input) : this.addProvider(input);
  }

  static async listPresets() {
    return loadPresets();
  }

  static async applyPreset(presetId: string, overrides?: Partial<CreateProviderInput>) {
    return applyPreset(presetId, overrides);
  }

  static async testProvider(target: SavedProvider | string): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
    const p = typeof target === 'string' ? await this.getProvider(target) : target;
    if (!p) return { ok: false, message: 'Provider not found' };
    const base = (p.baseUrl || '').replace(/\/+$/, '');
    const start = Date.now();
    let url = base;
    if ((p.apiFormat || '').includes('openai')) url = base + '/v1/models';
    else if ((p.apiFormat || '').includes('anthropic')) url = base + '/v1/models';
    try {
      const res = await axios.get(url, {
        timeout: 8000,
        headers: {
          ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
        },
        validateStatus: () => true
      });
      if (res.status >= 200 && res.status < 400) {
        return { ok: true, latencyMs: Date.now() - start };
      }
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (e: any) {
      return { ok: false, message: e?.message || 'network error' };
    }
  }
}

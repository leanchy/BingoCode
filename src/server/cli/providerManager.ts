import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { ProvidersIndex, SavedProvider, CreateProviderInput, UpdateProviderInput } from '../types/provider.ts';

// 统一与服务端一致的 provider 存储路径
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

  static async addProvider(input: CreateProviderInput): Promise<SavedProvider> {
    const idx = await this.load();
    if (idx.providers.find(p => p.id === input.presetId)) throw new Error('Provider id already exists');
    const provider: SavedProvider = {
      id: input.presetId,
      presetId: input.presetId,
      name: input.name,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      apiFormat: input.apiFormat,
      models: input.models,
      notes: input.notes,
    };
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
    idx.providers[index] = {
      ...idx.providers[index],
      ...input,
      models: input.models || idx.providers[index].models,
    };
    await this.save(idx);
    return idx.providers[index];
  }

  // 读取单个
  static async getProvider(id: string): Promise<SavedProvider | undefined> {
    const idx = await this.load();
    return idx.providers.find(p => p.id === id);
  }

  // upsert：存在则更新，不存在则新增
  static async upsertProvider(input: CreateProviderInput & { id?: string }): Promise<SavedProvider> {
    const idx = await this.load();
    const id = input.presetId || input.id;
    if (!id) throw new Error('id/presetId is required');
    const exists = idx.providers.find(p => p.id === id);
    if (exists) {
      // 走 update 逻辑
      return this.updateProvider(id, {
        name: input.name,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        apiFormat: input.apiFormat,
        models: input.models,
        notes: input.notes
      } as UpdateProviderInput);
    } else {
      return this.addProvider({
        presetId: id,
        name: input.name || id,
        apiKey: input.apiKey || '',
        baseUrl: input.baseUrl,
        apiFormat: input.apiFormat,
        models: input.models,
        notes: input.notes
      } as CreateProviderInput);
    }
  }

  // 预设列表（可选，providerPresets 不存在则返回空）
  static async listPresets(): Promise<any[]> {
    try {
      // 相对 src/server/cli 到 config 的路径
      const mod = await import('../config/providerPresets.ts');
      const presets = (mod as any).presets || (mod as any).providerPresets || [];
      return presets;
    } catch {
      return [];
    }
  }

  // 应用预设并返回可写入的 Provider 草案（不会直接落盘）
  static async applyPreset(presetId: string, overrides?: Partial<CreateProviderInput>): Promise<CreateProviderInput> {
    const presets = await this.listPresets();
    const p = presets.find((x: any) => x.id === presetId);
    if (!p) throw new Error('Preset not found: ' + presetId);
    return {
      presetId: overrides?.presetId || p.id,
      name: overrides?.name ?? p.name ?? p.id,
      apiKey: overrides?.apiKey ?? '',
      baseUrl: overrides?.baseUrl ?? p.baseUrl ?? '',
      apiFormat: overrides?.apiFormat ?? p.apiFormat ?? 'openai_chat',
      models: overrides?.models ?? { main: p.defaultModel || '', haiku: '', sonnet: '', opus: '' },
      notes: overrides?.notes ?? p.notes ?? ''
    };
  }

  // 连通性测试：按 apiFormat 选择探测路径
  static async testProvider(target: SavedProvider | string): Promise<{ ok: boolean; latencyMs?: number; message?: string }> {
    const p = typeof target === 'string' ? await this.getProvider(target) : target;
    if (!p) return { ok: false, message: 'Provider not found' };
    const base = (p.baseUrl || '').replace(/\/+$/,'');
    const start = Date.now();
    // 简单路径推断
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
      // 2xx/3xx 都视为连通
      if (res.status >= 200 && res.status < 400) {
        return { ok: true, latencyMs: Date.now() - start };
      }
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (e: any) {
      return { ok: false, message: e?.message || 'network error' };
    }
  }
}


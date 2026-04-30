// Provider presets — loaded from providers.yaml at startup

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { parse } from 'yaml'
import path from 'path'
import type { ApiFormat } from '../types/provider.js'

export type ProviderField = {
  /** Field key: 'name' | 'apiKey' | 'baseUrl' map to top-level fields; others go into extra.<key> */
  key: string
  /** Human-readable label shown in the CLI form */
  label: string
  required?: boolean
  /** If true, input is masked in the terminal */
  secret?: boolean
  placeholder?: string
  /** Default value pre-filled in the form */
  default?: string
}

export type ProviderPreset = {
  id: string
  name: string
  /** Default base URL for this provider (can be overridden by user) */
  baseUrl: string
  apiFormat: ApiFormat
  needsApiKey: boolean
  websiteUrl: string
  /**
   * Relative path to the models list endpoint, e.g. '/v1/models'.
   * Empty string means dynamic model fetching is not supported.
   */
  modelsUrl: string
  /**
   * Auth header style for the models list request:
   *   'bearer'   → Authorization: Bearer <apiKey>
   *   'x-api-key' → x-api-key: <apiKey>  (+ anthropic-version header)
   */
  modelsAuthStyle: 'bearer' | 'x-api-key'
  /**
   * Field name in the response JSON that contains the model array.
   * Almost always 'data' (OpenAI-compatible standard).
   */
  modelsDataPath: string
  /** Ordered list of fields to render when adding a new provider from this preset */
  fields: ProviderField[]
}

function loadPresetsFromYaml(): ProviderPreset[] {
  try {
    const yamlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers.yaml')
    const raw = parse(readFileSync(yamlPath, 'utf-8')) as { presets?: ProviderPreset[] }
    const presets = raw?.presets
    if (!Array.isArray(presets) || presets.length === 0) {
      throw new Error('providers.yaml missing presets array')
    }
    // Ensure fields is always an array and apply defaults for optional fields
    return presets.map(p => ({
      modelsUrl: '',
      modelsAuthStyle: 'bearer' as const,
      modelsDataPath: 'data',
      ...p,
      fields: Array.isArray(p.fields) ? p.fields : [],
    }))
  } catch (err) {
    console.error('[providerPresets] Failed to load providers.yaml, falling back to defaults:', err)
    return [
      {
        id: 'official',
        name: 'Claude Official',
        baseUrl: '',
        apiFormat: 'anthropic',
        needsApiKey: false,
        websiteUrl: 'https://www.anthropic.com/claude-code',
        modelsUrl: '/v1/models',
        modelsAuthStyle: 'x-api-key',
        modelsDataPath: 'data',
        fields: [{ key: 'name', label: 'Provider 昵称', required: true }],
      },
      {
        id: 'custom',
        name: 'Custom',
        baseUrl: '',
        apiFormat: 'anthropic',
        needsApiKey: true,
        websiteUrl: '',
        modelsUrl: '/v1/models',
        modelsAuthStyle: 'bearer',
        modelsDataPath: 'data',
        fields: [
          { key: 'name', label: 'Provider 昵称', required: true },
          { key: 'baseUrl', label: 'Base URL', required: true },
          { key: 'apiKey', label: 'API Key', required: false, secret: true },
        ],
      },
    ]
  }
}

export const PROVIDER_PRESETS: ProviderPreset[] = loadPresetsFromYaml()

export async function loadProviderPresets(): Promise<ProviderPreset[]> {
  return PROVIDER_PRESETS
}

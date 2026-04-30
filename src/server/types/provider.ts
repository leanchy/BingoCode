/**
 * Provider types — preset-based provider configuration.
 *
 * Providers are stored in ~/.claude/bingo/providers.json as a lightweight index.
 * The active provider's env vars are written to ~/.claude/bingo/settings.json.
 */

import { z } from 'zod'

export const ApiFormatSchema = z.enum([
  'anthropic',         // Native Anthropic Messages API (passthrough, no proxy)
  'openai_chat',       // OpenAI Chat Completions /v1/chat/completions
  'openai_responses',  // OpenAI Responses API /v1/responses
])
export type ApiFormat = z.infer<typeof ApiFormatSchema>

export const ModelMappingSchema = z.object({
  main: z.string(),
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
})

export const SavedProviderSchema = z.object({
  id: z.string(),
  presetId: z.string(),
  name: z.string().min(1),
  apiKey: z.string(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  models: ModelMappingSchema,
  notes: z.string().optional(),
  extra: z.record(z.any()).optional(),
})

export const ProvidersIndexSchema = z.object({
  activeId: z.string().nullable(),
  providers: z.array(SavedProviderSchema),
})

export const CreateProviderSchema = z.object({
  presetId: z.string().min(1),
  name: z.string().min(1),
  apiKey: z.string(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  models: ModelMappingSchema.default({ main: '', haiku: '', sonnet: '', opus: '' }).optional(),
  notes: z.string().optional(),
  extra: z.record(z.any()).optional(),
}).catchall(z.any())

export const UpdateProviderSchema = z.object({
  name: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  apiFormat: ApiFormatSchema.optional(),
  models: ModelMappingSchema.optional(),
  notes: z.string().optional(),
  extra: z.record(z.any()).optional(),
}).catchall(z.any())

export const TestProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  modelId: z.string().min(1),
  apiFormat: ApiFormatSchema.default('anthropic'),
})

// TypeScript types
export type ModelMapping = z.infer<typeof ModelMappingSchema>
export type SavedProvider = z.infer<typeof SavedProviderSchema>
export type ProvidersIndex = z.infer<typeof ProvidersIndexSchema>
export type CreateProviderInput = z.infer<typeof CreateProviderSchema>
export type UpdateProviderInput = z.infer<typeof UpdateProviderSchema>
export type TestProviderInput = z.infer<typeof TestProviderSchema>

// --- Slot routing ---

export const SlotNameSchema = z.enum(['main', 'haiku', 'sonnet', 'opus'])
export type SlotName = z.infer<typeof SlotNameSchema>

export const SlotEntrySchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  label: z.string().nullable().optional(), // Display name for UI
}).nullable()
export type SlotEntry = z.infer<typeof SlotEntrySchema>

export const SlotTableSchema = z.object({
  main:   SlotEntrySchema.default(null),
  haiku:  SlotEntrySchema.default(null),
  sonnet: SlotEntrySchema.default(null),
  opus:   SlotEntrySchema.default(null),
})
export type SlotTable = z.infer<typeof SlotTableSchema>

export interface ProviderTestStepResult {
  success: boolean
  latencyMs: number
  error?: string
  modelUsed?: string
  httpStatus?: number
}

export interface ProviderTestResult {
  /** Step 1: Basic connectivity — API reachable, key valid, model exists */
  connectivity: ProviderTestStepResult
  /** Step 2: Proxy pipeline — full Anthropic→OpenAI→Anthropic round-trip (only for openai_* formats) */
  proxy?: ProviderTestStepResult
}

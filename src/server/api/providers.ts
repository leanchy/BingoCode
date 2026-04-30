/**
 * Providers REST API
 *
 * GET    /api/providers              — list all saved providers + activeId
 * GET    /api/providers/presets       — list available presets
 * GET    /api/providers/auth-status   — check whether any usable auth exists
 * POST   /api/providers              — add a provider
 * PUT    /api/providers/:id          — update a provider
 * DELETE /api/providers/:id          — delete a provider
 * POST   /api/providers/:id/activate — activate a saved provider
 * POST   /api/providers/official     — activate official (clear env)
 * POST   /api/providers/:id/test     — test a saved provider
 * POST   /api/providers/test         — test unsaved config
 */

import { z } from 'zod'
import { ProviderService } from '../services/providerService.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import {
  CreateProviderSchema,
  UpdateProviderSchema,
  TestProviderSchema,
  SlotNameSchema,
} from '../types/provider.js'
import type { SlotName } from '../types/provider.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const providerService = new ProviderService()

function maskApiKey(key: string): string {
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

function sanitizeProvider(provider: Record<string, unknown>): Record<string, unknown> {
  if (typeof provider.apiKey === 'string') {
    return { ...provider, apiKey: maskApiKey(provider.apiKey) }
  }
  return provider
}

export async function handleProvidersApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const id = segments[2]
    const action = segments[3]

    // POST /api/providers/test
    if (id === 'test' && req.method === 'POST') {
      return await handleTestUnsaved(req)
    }

    // GET /api/providers/presets
    if (id === 'presets' && req.method === 'GET') {
      return Response.json({ presets: PROVIDER_PRESETS })
    }

    // GET /api/providers/auth-status
    if (id === 'auth-status' && req.method === 'GET') {
      const status = await providerService.checkAuthStatus()
      return Response.json(status)
    }

    // POST /api/providers/official
    if (id === 'official' && req.method === 'POST') {
      await providerService.activateOfficial()
      return Response.json({ ok: true })
    }

    // GET /api/providers/slots  — read slot table
    if (id === 'slots' && !action && req.method === 'GET') {
      const slots = await providerService.readSlots()
      return Response.json(slots)
    }

    // PUT /api/providers/slots/:slotName  — set one slot
    if (id === 'slots' && action && req.method === 'PUT') {
      const parsed = SlotNameSchema.safeParse(action)
      if (!parsed.success) throw ApiError.badRequest(`Invalid slot name: ${action}. Must be one of main, haiku, sonnet, opus`)
      const body = await parseJsonBody(req)
      // body can be { providerId, modelId, label } or null
      const entry = body === null ? null : {
        providerId: String(body.providerId),
        modelId: String(body.modelId),
        label: body.label ? String(body.label) : null,
      }
      const result = await providerService.setSlot(parsed.data as SlotName, entry)
      return Response.json(result)
    }

    // /api/providers (no ID)
    if (!id) {
      if (req.method === 'GET') {
        const { providers, activeId } = await providerService.listProviders()
        return Response.json({ providers: providers.map(sanitizeProvider), activeId })
      }
      if (req.method === 'POST') {
        return await handleCreate(req)
      }
      throw methodNotAllowed(req.method)
    }

    // /api/providers/:id/activate
    if (action === 'activate') {
      if (req.method !== 'POST') throw methodNotAllowed(req.method)
      await providerService.activateProvider(id)
      return Response.json({ ok: true })
    }

    // /api/providers/:id/models
    if (action === 'models') {
      if (req.method !== 'GET') throw methodNotAllowed(req.method)
      const models = await providerService.fetchProviderModels(id)
      return Response.json({ models })
    }

    // /api/providers/:id/test
    if (action === 'test') {
      if (req.method !== 'POST') throw methodNotAllowed(req.method)
      let overrides: { baseUrl?: string; modelId?: string; apiFormat?: string } | undefined
      try {
        const body = await req.json()
        if (body && typeof body === 'object') overrides = body as typeof overrides
      } catch { /* no body is fine — uses saved values */ }
      const result = await providerService.testProvider(id, overrides)
      return Response.json({ result })
    }

    // /api/providers/:id
    if (req.method === 'GET') {
      const provider = await providerService.getProvider(id)
      return Response.json({ provider: sanitizeProvider(provider) })
    }
    if (req.method === 'PUT') {
      return await handleUpdate(req, id)
    }
    if (req.method === 'DELETE') {
      await providerService.deleteProvider(id)
      return Response.json({ ok: true })
    }

    throw methodNotAllowed(req.method)
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleCreate(req: Request): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = CreateProviderSchema.parse(body)
    const provider = await providerService.addProvider(input)
    return Response.json({ provider }, { status: 201 })
  } catch (err) {
    if (err instanceof z.ZodError) throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    throw err
  }
}

async function handleUpdate(req: Request, id: string): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = UpdateProviderSchema.parse(body)
    const provider = await providerService.updateProvider(id, input)
    return Response.json({ provider })
  } catch (err) {
    if (err instanceof z.ZodError) throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    throw err
  }
}

async function handleTestUnsaved(req: Request): Promise<Response> {
  const body = await parseJsonBody(req)
  try {
    const input = TestProviderSchema.parse(body)
    const result = await providerService.testProviderConfig(input)
    return Response.json({ result })
  } catch (err) {
    if (err instanceof z.ZodError) throw ApiError.badRequest(err.issues.map((i) => i.message).join('; '))
    throw err
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}

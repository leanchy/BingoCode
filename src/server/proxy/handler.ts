/**
 * Proxy Handler — protocol-translating reverse proxy for OpenAI-compatible APIs.
 *
 * Receives Anthropic Messages API requests from the CLI, transforms them to
 * OpenAI Chat Completions or Responses API format, forwards to the upstream
 * provider, and transforms the response back to Anthropic format.
 *
 * Supports slot-based routing: each request's model field is mapped to a slot
 * (main/haiku/sonnet/opus), and the corresponding configured provider is used.
 *
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import { ProviderService } from '../services/providerService.js'
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicRequest } from './transform/types.js'
import type { SlotName } from '../types/provider.js'
import { logForDebugging } from '../../utils/debug.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const providerService = new ProviderService()

// Stream timeout: configurable via BINGO_STREAM_TIMEOUT_MS, default 300s
const STREAM_TIMEOUT_MS = parseInt(process.env.BINGO_STREAM_TIMEOUT_MS ?? '300000', 10) || 300_000

async function logToFile(message: string) {
  // Disabled log output for production
}

function sendAnthropicError(message: string, _model: string | undefined, status = 502): Response {
  const fullMessage = `[Bingo Proxy] ${message}`
  void logToFile(`ERROR: ${fullMessage} (status: ${status})`)

  // 统一返回纯文本以规避 CLI 的 JSON 字符串打印行为，确保报错清晰且不带 JSON 外壳
  return new Response(fullMessage, {
    status: status,
    headers: { 'Content-Type': 'text/plain' }
  })
}

function buildUpstreamHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }

  if (process.env.X_API_KEY) {
    headers['x-api-key'] = process.env.X_API_KEY
  }

  if (process.env.APPLICATION_NAME) {
    headers['x-application-name'] = process.env.APPLICATION_NAME
  }

  return headers
}

/**
 * Identify which slot a model name belongs to.
 * Checks for exact matches in provider models first, then falls back to keyword matching.
 */
async function identifySlot(modelName: string): Promise<SlotName> {
  const m = modelName.toLowerCase()
  void logToFile(`Identifying slot. Input: "${modelName}"`)

  try {
    const { providers } = await providerService.listProviders()
    for (const config of providers) {
      if (config.models) {
        for (const [slot, id] of Object.entries(config.models)) {
          if (id && id.toLowerCase() === m) {
            void logToFile(`Match found in config! Slot: ${slot} (ID: ${id})`)
            return slot as SlotName
          }
        }
      }
    }
  } catch (e) {
    void logToFile(`Error reading providers for identification: ${e}`)
  }

  let result: SlotName = 'main'
  if (m.includes('opus')) result = 'opus'
  else if (m.includes('sonnet')) result = 'sonnet'
  else if (m.includes('haiku')) result = 'haiku'

  void logToFile(`Fallback identification result: ${result}`)
  return result
}

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  // Only handle POST /proxy/v1/messages
  if (req.method !== 'POST' || url.pathname !== '/proxy/v1/messages') {
    return sendAnthropicError('Not Found: Proxy only handles POST /proxy/v1/messages', undefined, 404)
  }

  // Parse request body
  let body: AnthropicRequest
  try {
    body = (await req.json()) as AnthropicRequest
  } catch {
    return sendAnthropicError('Invalid JSON in request body', undefined, 400)
  }

  const isStream = body.stream === true
  const betaHeader = req.headers.get('anthropic-beta')

  // --- Slot-based routing ---
  const slot = await identifySlot(body.model ?? '')
  const reqId = Math.random().toString(36).substring(7)
  void logToFile(`[${reqId}] Body Model: "${body.model}". Decided Slot: "${slot}"`)

  const slotConfig = await providerService.getProviderForSlot(slot)

  if (slotConfig) {
    const proxiedBody: AnthropicRequest = { ...body, model: slotConfig.modelId }
    const baseUrl = slotConfig.baseUrl.replace(/\/+$/, '')
    const uiLabel = slotConfig.label || null

    try {
      if (slotConfig.apiFormat === 'anthropic') {
        return await handleAnthropicPassthrough(proxiedBody, baseUrl, slotConfig.apiKey, isStream, uiLabel, betaHeader)
      } else if (slotConfig.apiFormat === 'openai_chat') {
        return await handleOpenaiChat(proxiedBody, baseUrl, slotConfig.apiKey, isStream, uiLabel)
      } else {
        return await handleOpenaiResponses(proxiedBody, baseUrl, slotConfig.apiKey, isStream, uiLabel)
      }
    } catch (err) {
      logForDebugging(`[HANDLER][${reqId}] Slot "${slot}" upstream connection failed: ${err}`, { level: 'error' })
      return sendAnthropicError(`API Connection Failed: Ensure baseUrl is correct. Error: ${err instanceof Error ? err.message : String(err)}`, body.model, 502)
    }
  }

  // --- Fallback: legacy single-activeId routing ---
  const config = await providerService.getActiveProviderForProxy()
  if (!config) {
    logForDebugging(`[HANDLER][${reqId}] No provider configured for slot "${slot}"`, { level: 'warn' })
    return sendAnthropicError(`No provider configured for slot "${slot}". Please configure slots in the Provider panel.`, body.model)
  }

  if (config.apiFormat === 'anthropic') {
    return sendAnthropicError('Active provider uses anthropic format — proxy not needed', body.model)
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, '')

  try {
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream)
    } else {
      return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream)
    }
  } catch (err) {
    logForDebugging(`[HANDLER][${reqId}] Upstream connection failed: ${err}`, { level: 'error' })
    return sendAnthropicError(`API Connection Failed: Ensure baseUrl is correct. Error: ${err instanceof Error ? err.message : String(err)}`, body.model, 502)
  }
}

/**
 * Pass through to an Anthropic-compatible upstream without format transformation.
 * Used when the slot provider uses apiFormat 'anthropic'.
 */
async function handleAnthropicPassthrough(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  uiLabel: string | null = null,
  betaHeader: string | null = null,
): Promise<Response> {
  const url = `${baseUrl}/v1/messages`
  const upstreamHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
  if (betaHeader) upstreamHeaders['anthropic-beta'] = betaHeader

  const upstream = await fetch(url, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(body),
    signal: isStream ? AbortSignal.timeout(STREAM_TIMEOUT_MS) : AbortSignal.timeout(300_000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    const errorMessage = `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`
    return sendAnthropicError(errorMessage, body.model, 502)
  }

  if (isStream) {
    if (!upstream.body) {
      return sendAnthropicError('Upstream returned no body for stream', body.model)
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  const responseBody = await upstream.json()
  if (uiLabel) {
    (responseBody as any).model = uiLabel
  }
  return Response.json(responseBody)
}

async function handleOpenaiChat(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  uiLabel: string | null = null,
): Promise<Response> {
  const transformed = anthropicToOpenaiChat(body)
  const url = `${baseUrl}/v1/chat/completions`

  const upstream = await fetch(url, {
    method: 'POST',
    headers: buildUpstreamHeaders(apiKey),
    body: JSON.stringify(transformed),
    signal: isStream ? AbortSignal.timeout(STREAM_TIMEOUT_MS) : AbortSignal.timeout(300_000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    let errorMessage = `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`
    let status = upstream.status

    if (upstream.status === 404) {
      status = 502
      errorMessage = `API Connection Failed: The baseUrl path might be incorrect (404 Not Found). Detail: ${errText}`
    }

    return sendAnthropicError(errorMessage, body.model, status)
  }

  if (isStream) {
    if (!upstream.body) {
      return sendAnthropicError('Upstream returned no body for stream', body.model)
    }
    const anthropicStream = openaiChatStreamToAnthropic(upstream.body, uiLabel || body.model)
    return new Response(anthropicStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const anthropicResponse = openaiChatToAnthropic(responseBody, uiLabel || body.model)
  return Response.json(anthropicResponse)
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  uiLabel: string | null = null,
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body)
  const url = `${baseUrl}/v1/responses`

  const upstream = await fetch(url, {
    method: 'POST',
    headers: buildUpstreamHeaders(apiKey),
    body: JSON.stringify(transformed),
    signal: isStream ? AbortSignal.timeout(STREAM_TIMEOUT_MS) : AbortSignal.timeout(300_000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    let errorMessage = `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`
    let status = upstream.status

    if (upstream.status === 404) {
      status = 502
      errorMessage = `API Connection Failed: The baseUrl path might be incorrect (404 Not Found). Detail: ${errText}`
    }

    return sendAnthropicError(errorMessage, body.model, status)
  }

  if (isStream) {
    if (!upstream.body) {
      return sendAnthropicError('Upstream returned no body for stream', body.model)
    }
    const anthropicStream = openaiResponsesStreamToAnthropic(upstream.body, uiLabel || body.model)
    return new Response(anthropicStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const anthropicResponse = openaiResponsesToAnthropic(responseBody, uiLabel || body.model)
  return Response.json(anthropicResponse)
}

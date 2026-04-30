/**
 * Adapters API — IM Adapter 配置读写
 *
 * GET  /api/adapters  → 返回配置（敏感字段脱敏）
 * PUT  /api/adapters  → 更新配置（浅合并），返回更新后的脱敏配置
 */

//@C:ID=M.AA.adaptersAPI;K=M;V=1.0;P=Import dependencies;D=API;M=Adapters;S=Configuration
import { adapterService } from '../services/adapterService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const ALLOWED_TOP_KEYS = new Set(['serverUrl', 'defaultProjectDir', 'telegram', 'feishu', 'pairing'])

//@C:ID=E.AA.handleAdaptersApi;K=E;V=1.0;P=Handle adapter configuration requests;D=API;M=Adapters;S=Configuration;Provider=AdaptersAPI;Consumer=Frontend;In=Request;Out=Response
export async function handleAdaptersApi(
  req: Request,
  _url: URL,
  _segments: string[],
): Promise<Response> {
  console.log("E.AA.handleAdaptersApi");
  
  try {
    ///@C:AA.GetConfiguration
    if (req.method === 'GET') {
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    ///@C:AA.UpdateConfiguration
    if (req.method === 'PUT') {
      const body = (await req.json()) as Record<string, unknown>
      // Basic validation: only allow known top-level keys
      for (const key of Object.keys(body)) {
        if (!ALLOWED_TOP_KEYS.has(key)) {
          throw ApiError.badRequest(`Unknown config key: ${key}`)
        }
      }
      await adapterService.updateConfig(body)
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    ///@C:AA.RejectUnsupportedMethod
    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    ///@C:AA.HandleErrors
    return errorResponse(error)
  }
}
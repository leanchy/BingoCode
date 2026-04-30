// AI结构化API /api/ai-structure
import type { BunRequestHandler } from '../types.js';
import { ProviderManager } from '../cli/providerManager';
import { callLLMStructureAPI } from '../services/aiStructureService';

/**
 * POST /api/ai-structure
 * body: { input: string, domain?: string, context?: object, providerId?: string }
 * 返回：{ yaml: string, parsed: object, errors?: any[] }
 */
export const aiStructureHandler: BunRequestHandler = async (req) => {
  try {
    const body = await req.json();
    const { input, domain, context, providerId } = body;
    // 选择Provider
    const provider = providerId ? await ProviderManager.getProvider(providerId)
                               : await ProviderManager.getCurrentProvider();
    if (!provider) {
      return Response.json({ error: 'No provider found or configured.' }, { status: 400 });
    }
    // 结构化处理
    const aiRet = await callLLMStructureAPI(input, {
      provider,
      domain,
      context
    });
    if (!aiRet?.yaml) {
      return Response.json({ error: 'LLM未返回结构化YAML', aiRet }, { status: 500 });
    }
    // 校验解析
    let parsed: any = null, errors: any[] = [];
    try {
      parsed = aiRet.yaml ? (await import('yaml')).parse(aiRet.yaml) : null;
    } catch (e) {
      errors.push({ parse: e.message });
    }
    // 返回
    return Response.json({ yaml: aiRet.yaml, parsed, errors }, { status: 200 });
  } catch (e) {
    return Response.json({ error: (e as any).message || e }, { status: 500 });
  }
};

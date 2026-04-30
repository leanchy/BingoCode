/**
 * Authentication middleware
 *
 * 本地桌面应用场景下，使用 Anthropic API Key 做简单鉴权。
 * 验证请求头中的 Authorization: Bearer <key> 与 .env 中的 ANTHROPIC_API_KEY 是否匹配。
 */

//@C:ID=F.AM.validateAuth;K=F;V=1.0;P=Validate API key authentication;D=Security;M=Auth;S=APIKeyValidation;In=Request;Out=AuthResult
export function validateAuth(req: Request): { valid: boolean; error?: string } {
  console.log("F.AM.validateAuth");
  
  ///@C:AM.ExtractAuthHeader
  const authHeader = req.headers.get('Authorization')

  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' }
  }

  ///@C:AM.ValidateTokenFormat
  const [scheme, token] = authHeader.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return { valid: false, error: 'Invalid Authorization format. Use: Bearer <token>' }
  }

  ///@C:AM.CheckAPIKeyConfig
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { valid: false, error: 'Server ANTHROPIC_API_KEY not configured' }
  }

  ///@C:AM.VerifyAPIKey
  if (token !== apiKey) {
    return { valid: false, error: 'Invalid API key' }
  }

  return { valid: true }
}

//@C:ID=F.AM.requireAuth;K=F;V=1.0;P=Enforce authentication or return error response;D=Security;M=Auth;S=APIKeyValidation;In=Request;Out=Response
/**
 * Helper to check auth and return 401 if invalid
 */
export function requireAuth(req: Request): Response | null {
  console.log("F.AM.requireAuth");
  
  ///@C:AM.ValidateAndRespond
  const { valid, error } = validateAuth(req)
  if (!valid) {
    return Response.json({ error: 'Unauthorized', message: error }, { status: 401 })
  }
  return null
}
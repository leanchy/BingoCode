/**
 * CORS middleware for local desktop app communication
 */

//@C:ID=M.CM.corsMiddleware;K=M;V=1.0;P=CORS constants;D=API;M=CORS;S=Security
const ALLOWED_ORIGIN_RE =
  /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|tauri\.localhost)(?::\d+)?|tauri:\/\/localhost|asset:\/\/localhost)$/

//@C:ID=F.CM.corsHeaders;K=F;V=1.0;P=Generate CORS headers based on request origin;D=API;M=CORS;S=Security;In=string|null;Out=Record<string,string>
export function corsHeaders(origin?: string | null): Record<string, string> {

  
  ///@C:CM.ValidateOrigin
  // Allow localhost origins (http/https) and Tauri WebView origins
  const allowedOrigin =
    origin && ALLOWED_ORIGIN_RE.test(origin) ? origin : 'http://localhost:3000'
  
  ///@C:CM.BuildHeaders
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}
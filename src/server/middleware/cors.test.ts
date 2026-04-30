//@C:ID=M.CT.corsTest;K=M;V=1.0;P=Import test dependencies;D=API;M=CORS;S=Testing
import { describe, expect, it } from 'bun:test'
import { corsHeaders } from './cors'

//@C:ID=F.CT.testCorsHeaders;K=F;V=1.0;P=Test CORS header generation functionality;D=API;M=CORS;S=Testing;In=void;Out=void
describe('corsHeaders', () => {
  console.log("F.CT.testCorsHeaders");
  
  ///@C:CT.TestLocalhostOrigins
  it('allows localhost browser origins', () => {
    expect(corsHeaders('http://127.0.0.1:1420')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:1420')
    expect(corsHeaders('http://localhost:3000')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })

  ///@C:CT.TestTauriOrigins
  it('allows tauri webview origins used in production builds', () => {
    expect(corsHeaders('http://tauri.localhost')['Access-Control-Allow-Origin']).toBe('http://tauri.localhost')
    expect(corsHeaders('https://tauri.localhost')['Access-Control-Allow-Origin']).toBe('https://tauri.localhost')
    expect(corsHeaders('tauri://localhost')['Access-Control-Allow-Origin']).toBe('tauri://localhost')
  })

  ///@C:CT.TestFallbackOrigins
  it('falls back for unknown origins', () => {
    expect(corsHeaders('https://example.com')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
    expect(corsHeaders(null)['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
  })
})
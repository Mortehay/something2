import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

// Tunnels are same-origin: the remote browser loads the page, /api and
// /authority from one public host, and vite proxies the last two to the
// backend. These pin the parts of vite.config.js that make that safe.
describe('vite.config.js tunnel behaviour', () => {
  let server
  beforeAll(async () => {
    vi.stubEnv('NGROK_DOMAIN', 'x.ngrok-free.app')
    vi.stubEnv('TUNNEL_HOST', '')
    vi.resetModules()
    const mod = await import('../../vite.config.js')
    const cfg = typeof mod.default === 'function' ? await mod.default({ command: 'serve', mode: 'development' }) : mod.default
    server = cfg.server
  })

  afterAll(() => vi.unstubAllEnvs())

  it('keeps the Host header on /api and /authority (no changeOrigin)', () => {
    expect(server.proxy['/api'].changeOrigin).not.toBe(true)
    expect(server.proxy['/authority'].changeOrigin).not.toBe(true)
    expect(server.proxy['/authority'].ws).toBe(true)
  })

  it('allows cloudflare quick tunnels and the reserved ngrok domain', () => {
    expect(server.allowedHosts).toContain('.trycloudflare.com')
    expect(server.allowedHosts).toContain('x.ngrok-free.app')
  })

  it('never bakes a tunnel host into HMR', () => {
    expect(JSON.stringify(server.hmr ?? {})).not.toMatch(/ngrok|trycloudflare/)
    expect(server.hmr?.clientPort).toBeUndefined()
  })
})

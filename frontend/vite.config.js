import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SOMET-369 -- the game needs three surfaces from what a remote player sees as
// one origin: the dev server itself, the REST API (/api/*) and the authority
// websocket (/authority). The last two both live on backend :3101 (the WS is
// attached to the same http server -- backend/src/authority/server.js), so
// proxying them through vite means ONE ngrok tunnel pointed at :5173 is enough
// to log in and play. Without this the tunnel would only ever serve the page.
//
// `backend` is the compose service name, not localhost: vite only ever runs
// inside the frontend container in this project (`make dev` execs into it).
const BACKEND = 'http://backend:3101'

// Set by `make tunnel` only, passed through by compose. Empty for ordinary
// local dev -- everything keyed off it below is spread in conditionally so a
// non-tunnelled run gets exactly the config it had before, rather than relying
// on an empty value happening to behave like the default.
//
// Deliberately NOT read from NGROK_DOMAIN: that lives permanently in .env, so
// keying off it would silently put every local `make dev` into tunnel mode.
const TUNNEL_HOST = process.env.TUNNEL_HOST || ''

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      // ws: true is what makes vite forward the HTTP Upgrade rather than
      // answering it as a normal request. The authority authenticates from a
      // ?token= query param and does not check Origin, so a proxied upgrade
      // arrives valid.
      '/authority': { target: BACKEND, ws: true, changeOrigin: true },
    },
    // Vite refuses requests whose Host header it does not recognise, which is
    // the very first thing a tunnelled request trips over -- the public URL
    // would serve a "blocked host" page instead of the game.
    ...(TUNNEL_HOST ? { allowedHosts: [TUNNEL_HOST] } : {}),
    // Through the tunnel the page is served over :443, but the HMR client
    // defaults to reconnecting on the dev server's own port. Left alone it
    // retries a dead ws://host:5173 forever and floods every remote player's
    // console.
    ...(TUNNEL_HOST
      ? { hmr: { protocol: 'wss', host: TUNNEL_HOST, clientPort: 443 } }
      : {}),
  },
})

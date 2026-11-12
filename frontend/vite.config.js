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

// Tunnels are SAME-ORIGIN: the remote browser loads the page, /api and
// /authority from one public host, and the client calls relative URLs
// (frontend/src/config.js leaves API_URL empty). So nothing here depends on
// which tunnel is up, and starting or stopping one never recreates this
// container. The only per-host input is the reserved ngrok domain, which lives
// permanently in .env and is passed through by compose; it is an allowlist
// entry, not a mode switch.
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || ''

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The source is bind-mounted from a Windows (or macOS) host. Change events from
    // the host side do not reach inotify inside the container there, so without
    // polling Vite keeps serving a stale transform until it is restarted (an
    // import fix in App.jsx was invisible for exactly that reason). Polling is
    // cheap at this size; set CHOKIDAR_USEPOLLING=false to turn it off.
    watch: { usePolling: process.env.CHOKIDAR_USEPOLLING !== 'false', interval: 400 },
    proxy: {
      // No changeOrigin: the original Host must reach the backend. It builds
      // emailed links (verify, reset, invite) only when Origin's host equals the
      // Host it received (backend/src/email/linkOrigin.js), and attributes
      // tunnel players from it. Rewriting Host to backend:3101 mailed localhost links.
      '/api': { target: BACKEND },
      // ws: true is what makes vite forward the HTTP Upgrade rather than
      // answering it as a normal request. The authority authenticates from a
      // ?token= query param and does not check Origin, so a proxied upgrade
      // arrives valid.
      '/authority': { target: BACKEND, ws: true },
    },
    // Vite refuses requests whose Host header it does not recognise, which is
    // the very first thing a tunnelled request trips over. Quick-tunnel
    // addresses are random per start, so the whole trycloudflare.com suffix is
    // allowed (leading dot = the domain and any subdomain); ngrok's is the one
    // reserved domain.
    allowedHosts: ['.trycloudflare.com', ...(NGROK_DOMAIN ? [NGROK_DOMAIN] : [])],
    // HMR is deliberately left unconfigured. The vite client then connects to
    // the page's OWN origin (same protocol, host and port as the page), so
    // through a tunnel it is wss://<tunnel-host>:443 -> vite's upgrade handler,
    // and locally ws://localhost:15173. Pinning host/clientPort to a tunnel (the
    // old behaviour) breaks the moment that tunnel is a different one, and
    // pinning it to localhost would make every remote page retry a socket on
    // its own machine forever.
  },
})

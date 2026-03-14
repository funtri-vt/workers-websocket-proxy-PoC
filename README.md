# Serverless WebSocket Proxy (Proof of Concept)

## Overview
This project is an advanced, serverless web proxy built entirely on Cloudflare Workers. It is designed to bypass strict network filters by intercepting web traffic client-side and tunneling it through custom WebSocket streams. 

Unlike traditional HTTP proxies, this architecture relies on a Service Worker to hijack native browser requests and a Cloudflare Durable Object to maintain persistent, long-lived TCP connections for multiplayer browser games (like Eaglercraft).

## WARNING: DO <u>NOT</u> RELY ON THIS PROJECT OR USE IT IN PRODUCTION. THIS IS A PoC!!!!!!!!!!!

---

## 🏗️ Architecture Map

The proxy is broken down into three distinct layers. For deep dives into how each layer works, see the linked documentation.

### 1. The Client UI (`index.html`)
**[➔ Read the Frontend Docs](docs/frontend.md)**
The entry point. It registers the Service Worker, provides the URL navigation bar, and isolates the target website inside a full-screen iframe. 
* **Key Features:** Custom debug logging engine, Eruda DevTools injector, and game-ready iframe permissions (`pointer-lock`, `keyboard-map`).

### 2. The Interceptor (`sw.js`)
**[➔ Read the Service Worker Docs](docs/sw.md)**
The client-side engine. Because modern web apps make background API requests that bypass standard HTML rewriting, this Service Worker catches *everything*.
* **Key Features:** Intercepts `fetch` events, blocks known ad/tracking domains, manages persistent sessions via an IndexedDB cookie store, and pipes HTTP requests over a custom WebSocket tunnel to bypass browser CORS restrictions.

### 3. The Backend Engine (`index.js`)
**[➔ Read the Backend Docs](docs/backend.md)**
The Cloudflare Worker. It receives the tunneled requests, fetches the actual data, strips hostile security headers, and streams the binary data back to the browser.
* **Key Features:** `HTMLRewriter` DOM manipulation, strict security policy stripping (CSP, X-Frame-Options, SRI hashes), iframe CORS sandbox escapes, and a **Durable Object** router for persistent multiplayer game WebSockets.

---

## 🚀 How the Data Flows

### Standard Web Traffic (HTML/CSS/JS)
1. User enters `wikipedia.org` in the UI.
2. The UI sets the iframe `src` to `/service/wikipedia.org`.
3. The request hits the **Backend**, which fetches the site, strips security headers, and rewrites the HTML links.
4. The page loads in the iframe. Any subsequent background requests (like fetching images or JSON) are caught by the **Service Worker**.
5. The Service Worker packs those requests into a JSON payload and sends them to the Backend via a WebSocket `/ws/`.
6. The Backend executes the request and streams the binary response back through the WebSocket.

### Multiplayer Gaming (Persistent WebSockets)
1. User loads a browser game (e.g., Eaglercraft).
2. The game attempts to open a native WebSocket to a multiplayer server (`wss://mc.example.com`).
3. The **Injected Interceptor Script** (added by the Backend's `HTMLRewriter`) hijacks the `new window.WebSocket` call.
4. The connection is rerouted to `/durable-ws/?target=mc.example.com`.
5. The **Durable Object** on Cloudflare accepts the connection, spoofs the `Origin` header to bypass bot protection, mimics the game's `Sec-WebSocket-Protocol`, and pipes the binary game data continuously between the client and the server.

---

## 🛠️ Deployment

This project requires a Cloudflare account with the **Paid Plan** (or a legacy grandfathered free plan) due to the use of Durable Objects for the persistent WebSocket router.

1. Install Wrangler: `npm install -g wrangler`
2. Login to Cloudflare: `wrangler login`
3. Deploy the worker: `npm run deploy` (or `wrangler deploy`)

---

## ⚠️ Known Limitations (PoC Scope)
* **Aggressive Web Apps:** Heavily obfuscated React/Angular apps that rely on strict Subresource Integrity (SRI) or complex relative routing may break.
* **Cross-Origin Iframes:** Browsers enforce strict Same-Origin Policies (SOP). The proxy cannot intercept network traffic originating from deeply nested, cross-origin iframes on the target page unless those iframes are also successfully rewritten to use the `/service/` prefix.
* **Websockets don't work properly:** Was unable to fix during development.
# Proxy Backend Architecture (`index.js`)

## Overview
This file contains the Cloudflare Worker that acts as the central nervous system of the proxy. It serves three main purposes:
1. Serving the initial frontend assets (`index.html` and `sw.js`).
2. Acting as an **HTTP-over-WebSocket Tunnel** to execute network requests on behalf of the Service Worker, stripping aggressive security policies along the way.
3. Hosting a **Durable Object** to maintain persistent, long-lived WebSocket connections for multiplayer games like Eaglercraft.

---

## 1. Static Asset Delivery
The router intercepts the root paths:
* `/`: Serves the main UI and HTML structure.
* `/sw.js`: Serves the Service Worker script with aggressive `no-store` cache control so updates apply immediately.

---

## 2. The HTTP-over-WebSocket Tunnel (`/ws/`)
Because Service Workers are heavily restricted by browser CORS and Fetch API rules, this backend receives proxy requests via a custom WebSocket payload.

### The Lifecycle of a Tunneled Request
1. **Receive Payload**: The server receives a JSON string from the Service Worker containing the target URL, method, headers, and (optional) Base64 encoded body.
2. **CORS Preflight Bypass**: If the request is an `OPTIONS` request, the server immediately responds with wildly permissive `Access-Control-Allow-*` headers without even hitting the target server.
3. **Execution**: The server executes the actual `fetch()` request from Cloudflare's IP.
4. **Header Stripping**: Security headers like `Content-Security-Policy`, `X-Frame-Options`, and `Accept-Encoding` are violently stripped out. 
5. **Redirection Rewriting**: If the server returns a `Location` header (a redirect), the backend wraps it in the `/service/` prefix so the proxy doesn't lose control of the navigation.
6. **Binary Streaming**: The `res.body` is read continuously, and raw chunks are piped straight back down the WebSocket to the client.

---

## 3. The HTML Rewriter Engine
If the target server returns a `text/html` document, the proxy intercepts the stream and pipes it through Cloudflare's blazing-fast `HTMLRewriter` API.

It utilizes three main classes:

### `AttributeRewriter`
Scans the page for `<a>`, `<img>`, `<link>`, and `<form>` tags. It takes the `href`, `src`, or `action` attributes, resolves relative URLs into absolute ones, and prepends `/service/` to force all navigation through the proxy.

### `SecurityStripper`
Scans for `<script>` and `<link>` tags and removes `integrity` and `nonce` attributes. Because the proxy alters the files/headers, Subresource Integrity (SRI) hashes will fail. Removing them forces the browser to blindly trust the loaded files.

### `ScriptInjector`
Injects a massive, critical `<script>` block directly into the `<head>` of the target page:
* **Storage Spoofing**: Overrides `window.localStorage` and `window.sessionStorage` with a `Proxy` object. It prefixes all storage keys with the target domain (e.g., `wikipedia.org:theme_pref`), isolating cookies and storage so different proxied sites don't overwrite each other.
* **Iframe Sandbox Escapes**: Overrides `window.top` and `window.parent` to point to `window.self`. This stops games (like Eaglercraft) from throwing Cross-Origin errors when they try to attach keyboard event listeners inside a proxied iframe.
* **WebSocket Hijacker**: Monkey-patches the native `window.WebSocket` API. When the game tries to connect to a multiplayer server, the script transparently routes the connection to the Durable Object (`/durable-ws/`).

---

## 4. The Persistent WebSocket Router (Durable Object)
Standard Cloudflare Workers are stateless and shut down after a few seconds—terrible for multiplayer gaming. The `WebSocketProxy` class extends `DurableObject`, ensuring a persistent, stateful TCP connection between the browser and the target server.

### Bypassing Anti-Bot Protections
When Eaglercraft connects, the Durable Object acts as a middleman:
1. **Target Decoding**: Extracts the actual game server URL from the `?target=` query string.
2. **Protocol Mirroring**: Copies the `Sec-WebSocket-Protocol` from the client and forwards it to the game server (crucial for Eaglercraft handshakes).
3. **Origin Spoofing**: Fakes the `Origin` header to match the target server. This tricks public game servers into thinking the connection is coming from their own official website, bypassing bot/scraper protections.
4. **Binary Pipe**: Accepts both the client and server sockets and blindly pipes the binary gaming data back and forth.
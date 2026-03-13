# Proxy Service Worker Architecture (`sw.js`)

## Overview
This Service Worker acts as the client-side engine of the web proxy. Because modern web applications make background requests (fetch, XHR, image loads, CSS imports) that bypass the main HTML rewriting engine, this Service Worker intercepts **all** network traffic originating from the proxy page. 

It repackages these HTTP requests, tunnels them through a custom WebSocket connection to the Cloudflare Worker backend, and streams the binary responses back to the browser as if they were native HTTP responses.

---

## 1. Persistent Cookie Storage (IndexedDB)
Service Workers do not have access to `window.localStorage` or `document.cookie`. To maintain user sessions across proxied websites (like logging into a website), the proxy implements a custom cookie engine using IndexedDB.

* **`dbPromise`**: Initializes an IndexedDB database named `ProxyStorage` with a `cookies` object store.
* **`saveCookies(domain, newCookies)`**: Merges and saves incoming `Set-Cookie` headers mapped to their specific target domain.
* **`getCookies(domain)`**: Retrieves saved cookies for a domain to attach to outgoing requests, ensuring persistent sessions.

---

## 2. Lifecycle & Remote Logging
* **Install & Activate**: Uses `self.skipWaiting()` and `clients.claim()` to ensure the Service Worker takes control of the page immediately upon loading, without requiring a second refresh.
* **`remoteLog(msg)`**: A custom logging bridge. Since Service Worker logs are hidden in a separate DevTools context, this function uses `postMessage` to broadcast logs to the main `index.html` window, where they can be displayed via Eruda or captured by the custom log downloader.

---

## 3. URL Resolution & Routing (`handleProxyRequest`)
The core routing logic that calculates where a request *actually* needs to go. 

* **The `/service/` Unwrapper**: If a URL starts with `/service/`, the worker strips the prefix and decodes the inner URL. 
* **The `&amp;` Entity Fix**: HTMLRewriter sometimes catches raw HTML entities (`&amp;`) inside URLs before the browser parses them. The SW safely replaces these with `&` *after* decoding the URL to prevent backend routing failures.
* **Referer Fallback (`activeProxyOrigin`)**: If a script makes a relative request (e.g., `/api/data`) that bypasses the HTML rewriter, the SW uses the `request.referrer` or the last known `activeProxyOrigin` to construct the absolute URL.

---

## 4. The Ad Blocker
A lightweight interception array (`blockList`). If the calculated target URL contains known tracking or advertising domains (e.g., `doubleclick.net`), the Service Worker immediately short-circuits the request and returns a `204 No Content` response. This saves bandwidth and prevents trackers from loading via the proxy.

---

## 5. The WebSocket Tunnel (The Core Engine)
Browsers do not allow Service Workers to modify the `Host` or `Origin` headers of a standard `fetch()` request. To bypass this, the Service Worker discards standard HTTP fetching entirely and builds a custom WebSocket bridge to the Cloudflare backend (`/ws/`).

### Phase A: Request Serialization
1. The SW extracts the method, headers, and target URL.
2. It fetches the persistent cookies from IndexedDB and attaches them.
3. If the request is a `POST`, `PUT`, or `PATCH`, it clones the request, reads the binary body, encodes it to Base64, and packs it into a JSON payload.
4. It sends the JSON payload to the Cloudflare Worker over the WebSocket.

### Phase B: Response Streaming
The SW creates a `ReadableStream` and immediately returns a pending `Response` to the browser, tied to this stream.

1. **Headers Phase (`type: 'response'`)**: When the backend replies with the HTTP status and headers, the SW applies them to the pending `Response`. It also intercepts any `setCookies` arrays and routes them to IndexedDB.
2. **Streaming Phase**: Any raw binary data received over the WebSocket is immediately enqueued into the `ReadableStream`. The browser receives this data exactly like a native HTTP file download.
3. **End/Error Phase (`type: 'end'`)**: Closes the stream gracefully, completing the browser's fetch promise.

---

## Known Limitations (PoC Scope)
* **WebSocket Interception**: Service Workers cannot intercept native `ws://` connections. These are handled separately via DOM injection in the main page.
* **Cross-Origin Iframes**: Strict browser security prevents intercepting traffic inside deeply nested cross-origin iframes.
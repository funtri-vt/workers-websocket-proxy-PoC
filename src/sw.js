const SW_VERSION = 'v2.0.2';

// --- Aggressive Takeover ---
self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

// --- Main Router ---
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // 1. SYSTEM BYPASS (Let native UI and WS connections pass)
    if (
        url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname === '/sw.js' ||
        url.pathname.startsWith('/ws/') ||
        url.pathname.startsWith('/proxy-ws/')
    ) {
        return;
    }

    // 2. LEAK RECOVERY (Fixes DuckDuckGo, root-relative CSS/images, etc.)
    if (!url.pathname.startsWith('/service/')) {
        const referer = event.request.referrer;
        if (referer && referer.includes('/service/')) {
            try {
                const parts = referer.split('/service/');
                const proxiedOrigin = new URL(decodeURIComponent(parts[1])).origin;
                const intendedTarget = new URL(url.pathname + url.search, proxiedOrigin).toString();
                const safeProxyUrl = `${self.location.origin}/service/${encodeURIComponent(intendedTarget)}`;
                
                console.log(`[SW] 🩹 Rescuing leaked asset: ${url.pathname} -> ${intendedTarget}`);

                if (event.request.mode === 'navigate') {
                    return event.respondWith(Response.redirect(safeProxyUrl, 301));
                } else {
                    const proxyReq = new Request(safeProxyUrl, event.request);
                    return event.respondWith(handleProxyRequest(proxyReq));
                }
            } catch (e) {
                console.error('[SW] Leak recovery failed:', e);
            }
        }
    }

    // 3. STANDARD PROXY PASS
    if (url.pathname.startsWith('/service/')) {
        event.respondWith(handleProxyRequest(event.request));
    }
});

// --- The WebSocket Courier ---
async function handleProxyRequest(request) {
    // 1. Extract the raw URL intent safely
    const requestUrl = new URL(request.url);
        
    // Extract whatever comes after /service/
    let targetUrlStr = decodeURIComponent(requestUrl.pathname.substring(requestUrl.pathname.indexOf('/service/') + 9)) + requestUrl.search;

    // --- 🚑 URL SANITIZER ---
    // 1. Fix protocol-relative URLs (e.g., //en.wikipedia.org/style.css)
    if (targetUrlStr.startsWith('//')) {
        targetUrlStr = 'https:' + targetUrlStr;
    } 
    // 2. Fix missing protocols AND Internal Relative Leaks
    else if (!targetUrlStr.startsWith('http')) {
        const referer = request.referrer;
        
        // If it's a relative path that got appended directly inside /service/
        if (referer && referer.includes('/service/')) {
            try {
                const parts = referer.split('/service/');
                const refererTargetUrl = decodeURIComponent(parts[1]);
                // Resolve the relative path against the parent file's true URL
                targetUrlStr = new URL(targetUrlStr, refererTargetUrl).toString();
                console.log(`[SW] 🩹 Rescued internal relative asset: -> ${targetUrlStr}`);
            } catch(e) {
                targetUrlStr = 'https://' + targetUrlStr;
            }
        } else {
            if (targetUrlStr.startsWith('/')) {
                console.warn(`[SW] ⚠️ Orphaned relative path detected: ${targetUrlStr}`);
            }
            targetUrlStr = 'https://' + targetUrlStr;
        }
    }

    // 3. Final validation check before hitting the Worker
    try {
        new URL(targetUrlStr);
    } catch (e) {
        console.error(`[SW] ❌ FATAL URL ERROR: Cannot parse [${targetUrlStr}]`);
        return new Response("Invalid URL format", { status: 400 });
    }
        
    console.log(`[SW] 🚀 Proxying Sanitized URL: ${targetUrlStr}`);
    
    return new Promise(async (resolve) => {
        try {
            // Safely encode the body to Base64 (if it's a POST/PUT request)
            let bodyBase64 = null;
            if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
                const buffer = await request.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                bodyBase64 = btoa(binary);
            }

            // Extract Headers
            const headers = {};
            request.headers.forEach((val, key) => { headers[key] = val; });

            // Establish WS connection to our Cloudflare Worker
            const wsUrl = new URL('/ws/', self.location.origin);
            wsUrl.protocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(wsUrl.toString());

            ws.binaryType = 'arraybuffer';

            let streamController = null;
            const stream = new ReadableStream({
                start(controller) { streamController = controller; },
                cancel() { ws.close(); }
            });

            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: 'request',
                    url: targetUrlStr,
                    method: request.method,
                    headers: headers,
                    body: bodyBase64
                }));
            };

            ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    const msg = JSON.parse(event.data);
                    
                    if (msg.type === 'response') {
                        // --- 🧹 HEADER SANITIZATION ---
                        const cleanHeaders = new Headers(msg.headers);
                        
                        cleanHeaders.delete('content-encoding');
                        cleanHeaders.delete('content-length');
                        cleanHeaders.delete('transfer-encoding');
                        cleanHeaders.delete('content-security-policy');
                        cleanHeaders.delete('content-security-policy-report-only');
                        cleanHeaders.delete('cross-origin-embedder-policy');
                        cleanHeaders.delete('cross-origin-opener-policy');
                        cleanHeaders.delete('x-frame-options');

                        const locationHeader = cleanHeaders.get('location');

                        if (msg.status >= 300 && msg.status < 400 && locationHeader) {
                            ws.close();
                            const redirectUrl = new URL(locationHeader, self.location.origin).toString();
                            resolve(Response.redirect(redirectUrl, msg.status));
                        } else {
                            resolve(new Response(stream, {
                                status: msg.status,
                                headers: cleanHeaders
                            }));
                        }
                    } else if (msg.type === 'end') {
                        if (streamController) {
                            try { streamController.close(); } catch(e) {}
                        }
                        ws.close();
                    } else if (msg.type === 'error') {
                        console.error(`[SW] ❌ Backend Error: ${msg.message}`);
                        if (streamController) {
                            try { streamController.close(); } catch(e) {}
                        }
                        ws.close();
                    }
                } else {
                    // Binary payload handler
                    if (streamController) {
                        try {
                            streamController.enqueue(new Uint8Array(event.data));
                        } catch (e) {
                            console.error(`[SW] 💥 Failed to enqueue chunk:`, e);
                        }
                    }
                }
            };

            ws.onerror = (e) => {
                if (!streamController) resolve(new Response("WebSocket Proxy Error", { status: 502 }));
            };
            
            ws.onclose = (e) => {
                if (streamController) {
                    try { streamController.close(); } catch(err) {}
                }
            };

        } catch (err) {
            resolve(new Response(`Service Worker Error: ${err.message}`, { status: 500 }));
        }
    });
}
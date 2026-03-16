const SW_VERSION = 'v2.0.3';

// --- Remote Logger ---
function remoteLog(msg) {
    console.log(msg); // Keep standard logging
    self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(client => client.postMessage({ type: 'sw-log', message: msg }));
    });
}

// --------------------------------------------------------
// Persistent Cookie Storage (IndexedDB)
// --------------------------------------------------------
const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('ProxyStorage', 1);
    request.onupgradeneeded = (e) => {
        e.target.result.createObjectStore('cookies');
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = () => reject('IDB Error');
});

async function saveCookies(domain, newCookies) {
    try {
        const db = await dbPromise;
        const tx = db.transaction('cookies', 'readwrite');
        const store = tx.objectStore('cookies');
        
        const existingReq = store.get(domain);
        existingReq.onsuccess = () => {
            let current = existingReq.result || [];
            const merged = [...current, ...newCookies.map(c => c.split(';')[0])];
            store.put([...new Set(merged)], domain);
        };
    } catch (e) { remoteLog(`[SW] IDB Save Error: ${e}`); }
}

async function getCookies(domain) {
    try {
        const db = await dbPromise;
        return new Promise((resolve) => {
            const tx = db.transaction('cookies', 'readonly');
            const req = tx.objectStore('cookies').get(domain);
            req.onsuccess = () => resolve(req.result || []);
        });
    } catch (e) { return []; }
}

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
                
                remoteLog(`[SW] 🩹 Rescuing leaked asset: ${url.pathname} -> ${intendedTarget}`);

                if (event.request.mode === 'navigate') {
                    return event.respondWith(Response.redirect(safeProxyUrl, 301));
                } else {
                    const proxyReq = new Request(safeProxyUrl, event.request);
                    return event.respondWith(handleProxyRequest(proxyReq));
                }
            } catch (e) {
                remoteLog('[SW] Leak recovery failed:', e);
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
        
        if (referer && referer.includes('/service/')) {
            try {
                const parts = referer.split('/service/');
                const refererTargetUrl = decodeURIComponent(parts[1]);
                targetUrlStr = new URL(targetUrlStr, refererTargetUrl).toString();
                remoteLog(`[SW] 🩹 Rescued internal relative asset: -> ${targetUrlStr}`);
            } catch(e) {
                targetUrlStr = 'https://' + targetUrlStr;
            }
        } else {
            if (targetUrlStr.startsWith('/')) {
                remoteLog(`[SW] ⚠️ Orphaned relative path detected: ${targetUrlStr}`);
            }
            targetUrlStr = 'https://' + targetUrlStr;
        }
    }

    // 3. Final validation check before hitting the Worker
    try {
        new URL(targetUrlStr);
    } catch (e) {
        remoteLog(`[SW] ❌ FATAL URL ERROR: Cannot parse [${targetUrlStr}]`);
        return new Response("Invalid URL format", { status: 400 });
    }

    // --- 🛡️ AD/TRACKER BLOCKER ---
    const blockList = [
        'doubleclick.net',
        'google-analytics.com',
        'googlesyndication.com',
        'amazon-adsystem.com',
        'trackersimulator.org'
    ];
    
    try {
        const targetHost = new URL(targetUrlStr).hostname;
        if (blockList.some(domain => targetHost.includes(domain))) {
            remoteLog(`[SW] 🛑 Blocked Ad/Tracker: ${targetHost}`);
            return new Response(null, { status: 204 }); 
        }
    } catch(e) {
        // Let malformed URLs fail naturally later
    }
        
    remoteLog(`[SW] 🚀 Proxying Sanitized URL: ${targetUrlStr}`);
    
    return new Promise(async (resolve) => {
        try {
            // --- 📦 PAYLOAD CHUNKER (Thread-Locker Fix) ---
            let bodyBase64 = null;
            if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
                const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB limit
                const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
                
                if (contentLength > MAX_PAYLOAD_SIZE) {
                    return resolve(new Response("Payload too large. Maximum size is 5MB.", { status: 413 }));
                }

                const buffer = await request.clone().arrayBuffer();
                
                if (buffer.byteLength > MAX_PAYLOAD_SIZE) {
                    return resolve(new Response("Payload too large. Maximum size is 5MB.", { status: 413 }));
                }

                if (buffer.byteLength > 0) {
                    const bytes = new Uint8Array(buffer);
                    let binary = '';
                    const chunksize = 0xFFFF;
                    for (let i = 0; i < bytes.length; i += chunksize) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunksize));
                    }
                    bodyBase64 = btoa(binary);
                }
            }

            // --- 📨 EXTRACT HEADERS & INJECT COOKIES ---
            const headers = {};
            request.headers.forEach((val, key) => { headers[key] = val; });

            let requestDomain = "";
            try { requestDomain = new URL(targetUrlStr).hostname; } catch(e) {}

            const savedCookies = await getCookies(requestDomain);
            if (savedCookies && savedCookies.length > 0) {
                headers['Cookie'] = savedCookies.join('; ');
                remoteLog(`[SW] 🍪 Attached persistent cookies for ${requestDomain}`);
            }

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
                        // --- 💾 EXTRACT AND SAVE INCOMING COOKIES ---
                        if (msg.setCookies && msg.setCookies.length > 0 && msg.targetDomain) {
                            try {
                                const expectedDomain = new URL(targetUrlStr).hostname;
                                const cookieDomain = msg.targetDomain.replace(/^\./, '');
                                const isSafeDomain = cookieDomain.includes('.') && expectedDomain.endsWith(cookieDomain);
                                
                                if (isSafeDomain) {
                                    saveCookies(msg.targetDomain, msg.setCookies);
                                    remoteLog(`[SW] 💾 Saved ${msg.setCookies.length} persistent cookies for ${msg.targetDomain}`);
                                } else {
                                    remoteLog(`[SW] ⚠️ Blocked suspicious cookie domain: ${msg.targetDomain}`);
                                }
                            } catch(e) {}
                        }

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
                        remoteLog(`[SW] ❌ Backend Error: ${msg.message}`);
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
                            remoteLog(`[SW] 💥 Failed to enqueue chunk:`, e);
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
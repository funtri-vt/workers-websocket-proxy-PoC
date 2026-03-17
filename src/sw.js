const SW_VERSION = 'v2.0.9'; // Bumped version to force cache update

// --- Remote Logger ---
function remoteLog(msg) {
    console.log(msg);
    self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(client => client.postMessage({ type: 'sw-log', message: msg }));
    });
}

// --------------------------------------------------------
// Persistent Storage (IndexedDB) - v2
// --------------------------------------------------------
const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('ProxyStorage', 2); // Bumped to v2
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('cookies')) db.createObjectStore('cookies');
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = () => reject('IDB Error');
});

// --- Settings Memory Cache ---
let adBlockCache = null; // Memory variable so we don't spam the database

async function isAdBlockEnabled() {
    if (adBlockCache !== null) return adBlockCache; // Return instantly if already loaded
    
    try {
        const db = await dbPromise;
        return new Promise((resolve) => {
            const tx = db.transaction('settings', 'readonly');
            const req = tx.objectStore('settings').get('adblock');
            req.onsuccess = () => {
                adBlockCache = req.result !== undefined ? req.result : true; // Default to true
                resolve(adBlockCache);
            };
            req.onerror = () => resolve(true);
        });
    } catch (e) { return true; }
}

// Listen for live UI updates
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'update-setting') {
        if (event.data.key === 'adblock') {
            adBlockCache = event.data.value; // Instantly update memory
            remoteLog(`[SW] ⚙️ AdBlock set to: ${adBlockCache}`);
        }
    }
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
self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// --- Main Router ---
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // 1. SYSTEM BYPASS (Let native UI, WS, and our CDNs pass directly)
    if (
        url.hostname === 'cdn.jsdelivr.net' || // Allow Eruda to bypass the proxy entirely
        (url.origin === self.location.origin && (
            url.pathname === '/' ||
            url.pathname === '/index.html' ||
            url.pathname === '/sw.js' ||
            url.pathname.startsWith('/ws/') ||
            url.pathname.startsWith('/proxy-ws/')
        ))
    ) {
        return; // Fallback to normal browser fetch
    }

    event.respondWith((async () => {
        // --- DEEP REFERER RESOLUTION ---
        // --- SAFE EXTRACTION HELPER ---
        // This prevents the browser from collapsing 'https://' into 'https:/'
        function extractTarget(urlString) {
            if (!urlString) return null;
            const marker = '/service/';
            const idx = urlString.indexOf(marker);
            if (idx === -1) return null;
            return decodeURIComponent(urlString.substring(idx + marker.length));
        }

        // --- DEEP REFERER RESOLUTION ---
        let targetBaseStr = extractTarget(event.request.referrer);
        
        if (!targetBaseStr && event.clientId) {
            const client = await self.clients.get(event.clientId);
            if (client) targetBaseStr = extractTarget(client.url);
        }

        // --- STRICT ROUTING LOGIC ---

        // Case A: External Leak (Different Domain)
        if (url.origin !== self.location.origin) {
            let intendedTarget = url.href;

            // 🩹 MANGLED URL RESCUE (The Invidious Fix)
            // If the browser accidentally glued our prefix to their domain:
            const marker = '/service/';
            if (intendedTarget.includes(marker)) {
                const extracted = decodeURIComponent(intendedTarget.substring(intendedTarget.indexOf(marker) + marker.length));
                if (extracted.startsWith('http')) {
                    intendedTarget = extracted; // Rescued the real target!
                }
            }

            const safeProxyUrl = `${self.location.origin}/service/${encodeURIComponent(intendedTarget)}`;
            remoteLog(`[SW] 🩹 External Rescue: ${url.href} -> ${safeProxyUrl}`);

            if (event.request.mode === 'navigate') {
                return Response.redirect(safeProxyUrl, 301);
            } else {
                const proxyReq = new Request(safeProxyUrl, event.request);
                return await handleProxyRequest(proxyReq, intendedTarget);
            }
        }

        // Case B: Internal Request (Our Domain)
        if (url.pathname.startsWith('/service/')) {
            // Use the raw url.href instead of url.pathname to prevent // collapsing!
            let extractedTarget = extractTarget(url.href) || '';
            
            // Cleanup missing protocols
            if (!extractedTarget.startsWith('http')) {
                if (extractedTarget.startsWith('//')) {
                    extractedTarget = 'https:' + extractedTarget;
                } else if (targetBaseStr) {
                    try {
                        extractedTarget = new URL(extractedTarget, targetBaseStr).toString();
                    } catch(e) {
                        extractedTarget = 'https://' + extractedTarget.replace(/^\/+/, '');
                    }
                } else {
                    extractedTarget = 'https://' + extractedTarget.replace(/^\/+/, '');
                }
            }
            
            // 4. STANDARD PROXY PASS
            return await handleProxyRequest(event.request, extractedTarget);
            
        } else {
            // Case C: Internal Leak (Our domain, missing /service/)
            let intendedTarget = null;
            if (targetBaseStr) {
                try {
                    // targetBaseStr is now safely guaranteed to have both slashes
                    const proxiedOrigin = new URL(targetBaseStr).origin;
                    intendedTarget = new URL(url.pathname + url.search, proxiedOrigin).toString();
                } catch (e) {
                    remoteLog(`[SW] Leak resolution failed: ${e}`);
                }
            }

            if (intendedTarget) {
                const safeProxyUrl = `${self.location.origin}/service/${encodeURIComponent(intendedTarget)}`;
                remoteLog(`[SW] 🩹 Internal Rescue: ${url.pathname} -> ${intendedTarget}`);

                if (event.request.mode === 'navigate') {
                    return Response.redirect(safeProxyUrl, 301);
                } else {
                    const proxyReq = new Request(safeProxyUrl, event.request);
                    return await handleProxyRequest(proxyReq, intendedTarget);
                }
            }
            
            return new Response("Not Found - Proxy Leak", { status: 404 });
        }
        // 4. STANDARD PROXY PASS
        return await handleProxyRequest(event.request, extractedTarget);
    })());
});

// --- The WebSocket Courier ---
async function handleProxyRequest(request, targetUrlStr) {
    // 1. Final validation check
    try {
        new URL(targetUrlStr);
    } catch (e) {
        remoteLog(`[SW] ❌ FATAL URL ERROR: Cannot parse [${targetUrlStr}]`);
        return new Response("Invalid URL format", { status: 400 });
    }

    // --- 🛡️ AD/TRACKER BLOCKER ---
    const blockAds = await isAdBlockEnabled();
    if (blockAds) {
        const blockList = [
            'doubleclick.net', 'google-analytics.com', 'googlesyndication.com',
            'amazon-adsystem.com', 'trackersimulator.org'
        ];
        try {
            const targetHost = new URL(targetUrlStr).hostname;
            if (blockList.some(domain => targetHost.includes(domain))) {
                remoteLog(`[SW] 🛑 Blocked Ad/Tracker: ${targetHost}`);
                return new Response(null, { status: 204 }); 
            }
        } catch(e) {}
    }

    // --- 🗄️ STATIC ASSET BROWSER CACHE ---
    // Identify static files that are safe to cache
    const isStaticAsset = /\.(css|js|png|jpg|jpeg|gif|webp|svg|woff|woff2|ttf|ico)(\?.*)?$/i.test(targetUrlStr);
    let assetCache = null;

    if (isStaticAsset && request.method === 'GET') {
        try {
            assetCache = await caches.open('v2-engine-cache');
            const cachedResponse = await assetCache.match(targetUrlStr);
            if (cachedResponse) {
                remoteLog(`[SW] ⚡ Cache Hit: ${targetUrlStr}`);
                return cachedResponse; // Return instantly from local storage!
            }
        } catch (e) {
            remoteLog(`[SW] Cache read error: ${e}`);
        }
    }
        
    remoteLog(`[SW] 🚀 Proxying: ${targetUrlStr}`);

    try {
        // --- 📦 PAYLOAD CHUNKER ---
        let bodyBase64 = null;
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
            const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024;
            const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
            
            if (contentLength > MAX_PAYLOAD_SIZE) return new Response("Payload too large.", { status: 413 });

            const buffer = await request.clone().arrayBuffer();
            if (buffer.byteLength > MAX_PAYLOAD_SIZE) return new Response("Payload too large.", { status: 413 });

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
        }

        // Establish WS connection to Cloudflare Worker
        const wsUrl = new URL('/ws/', self.location.origin);
        wsUrl.protocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
        
        return new Promise((resolve) => {
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
                        // --- 💾 EXTRACT AND SAVE COOKIES ---
                        if (msg.setCookies && msg.setCookies.length > 0 && msg.targetDomain) {
                            try {
                                const expectedDomain = new URL(targetUrlStr).hostname;
                                const cookieDomain = msg.targetDomain.replace(/^\./, '');
                                if (cookieDomain.includes('.') && expectedDomain.endsWith(cookieDomain)) {
                                    saveCookies(msg.targetDomain, msg.setCookies);
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
                            const absoluteRedirect = new URL(locationHeader, targetUrlStr).toString();
                            const safeRedirectUrl = `${self.location.origin}/service/${encodeURIComponent(absoluteRedirect)}`;
                            resolve(Response.redirect(safeRedirectUrl, msg.status));
                        } else {
                            const finalResponse = new Response(stream, {
                                status: msg.status,
                                headers: cleanHeaders
                            });

                            // --- 💾 SAVE TO CACHE ON SUCCESS ---
                            if (isStaticAsset && msg.status === 200 && assetCache) {
                                // Clone the response stream before returning it to the browser
                                const cacheCopy = finalResponse.clone();
                                assetCache.put(targetUrlStr, cacheCopy).catch(err => {
                                    remoteLog(`[SW] Cache write error: ${err}`);
                                });
                            }

                            resolve(finalResponse);
                        }
                    } else if (msg.type === 'end') {
                        if (streamController) try { streamController.close(); } catch(e) {}
                        ws.close();
                    } else if (msg.type === 'error') {
                        remoteLog(`[SW] ❌ Backend Error: ${msg.message}`);
                        if (streamController) try { streamController.close(); } catch(e) {}
                        ws.close();
                    }
                } else {
                    if (streamController) {
                        try { streamController.enqueue(new Uint8Array(event.data)); } catch (e) {}
                    }
                }
            };

            ws.onerror = () => {
                if (!streamController) resolve(new Response("WebSocket Proxy Error", { status: 502 }));
            };
            
            ws.onclose = () => {
                if (streamController) try { streamController.close(); } catch(e) {}
            };
        });
    } catch (err) {
        return new Response(`Service Worker Error: ${err.message}`, { status: 500 });
    }
}
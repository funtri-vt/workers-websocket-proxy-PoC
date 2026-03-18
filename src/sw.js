const SW_VERSION = 'v3.0.0'; // Fresh slate for V3
const CACHE_NAME = 'v3-engine-cache';

// =========================================================
// 1. Utilities & Storage (IndexedDB)
// =========================================================

function remoteLog(msg) {
    console.log(msg);
    self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(client => client.postMessage({ type: 'sw-log', message: msg }));
    });
}

const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('ProxyStorageV3', 1);
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('cookies')) db.createObjectStore('cookies');
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = () => reject('IDB Error');
});

let adBlockCache = null;

async function isAdBlockEnabled() {
    if (adBlockCache !== null) return adBlockCache;
    try {
        const db = await dbPromise;
        return new Promise((resolve) => {
            const req = db.transaction('settings', 'readonly').objectStore('settings').get('adblock');
            req.onsuccess = () => {
                adBlockCache = req.result !== undefined ? req.result : true;
                resolve(adBlockCache);
            };
            req.onerror = () => resolve(true);
        });
    } catch (e) { return true; }
}

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'update-setting' && event.data.key === 'adblock') {
        adBlockCache = event.data.value;
        remoteLog(`[SW V3] ⚙️ AdBlock set to: ${adBlockCache}`);
    }
});

async function saveCookies(domain, newCookies) {
    try {
        const db = await dbPromise;
        const store = db.transaction('cookies', 'readwrite').objectStore('cookies');
        const existingReq = store.get(domain);
        existingReq.onsuccess = () => {
            let current = existingReq.result || [];
            const merged = [...current, ...newCookies.map(c => c.split(';')[0])];
            store.put([...new Set(merged)], domain);
        };
    } catch (e) {}
}

async function getCookies(domain) {
    try {
        const db = await dbPromise;
        return new Promise((resolve) => {
            const req = db.transaction('cookies', 'readonly').objectStore('cookies').get(domain);
            req.onsuccess = () => resolve(req.result || []);
        });
    } catch (e) { return []; }
}

// =========================================================
// 2. Lifecycle & Routing
// =========================================================

self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
        )).then(() => self.clients.claim())
    );
});

// --- SAFE EXTRACTION HELPER ---
function extractTarget(urlString) {
    if (!urlString) return null;
    const marker = '/service/';
    const idx = urlString.indexOf(marker);
    if (idx === -1) return null;
    
    let extracted = decodeURIComponent(urlString.substring(idx + marker.length));
    
    // Deep Un-glue: Strip accidental double-proxied layers
    const doubleGlueMarker = '/service/http';
    let glueIdx = extracted.indexOf(doubleGlueMarker);
    while (glueIdx !== -1) {
        let peeled = extracted.substring(glueIdx + marker.length);
        if (peeled.startsWith('s%3A') || peeled.startsWith('%3A')) {
            try { peeled = decodeURIComponent(peeled); } catch(e) {}
        }
        extracted = peeled;
        glueIdx = extracted.indexOf(doubleGlueMarker);
    }
    return extracted;
}

self.addEventListener('fetch', event => {
    let requestUrlStr = event.request.url;
    const url = new URL(requestUrlStr);

    // 1. SYSTEM BYPASS
    if (
        url.hostname === 'cdn.jsdelivr.net' || 
        (url.origin === self.location.origin && (
            url.pathname === '/' || url.pathname === '/index.html' || 
            url.pathname === '/sw.js' || url.pathname.startsWith('/ws/') || 
            url.pathname.startsWith('/proxy-ws/')
        ))
    ) {
        return; 
    }

    event.respondWith((async () => {
        // --- 2. GLOBAL UN-GLUE ---
        const marker = '/service/';
        if (requestUrlStr.includes(marker) && !requestUrlStr.startsWith(self.location.origin + marker)) {
            const extracted = extractTarget(requestUrlStr);
            if (extracted && extracted.startsWith('http')) {
                requestUrlStr = self.location.origin + marker + encodeURIComponent(extracted);
            }
        }

        // --- 3. REFERER FALLBACK (Catching Leaks) ---
        let targetBaseStr = extractTarget(event.request.referrer);
        if (!targetBaseStr && event.clientId) {
            const client = await self.clients.get(event.clientId);
            if (client) targetBaseStr = extractTarget(client.url);
        }

        // --- 4. DETERMINE INTENDED TARGET ---
        let intendedTarget = null;
        
        if (requestUrlStr.startsWith(self.location.origin + marker)) {
            // It's already cleanly formatted
            intendedTarget = extractTarget(requestUrlStr);
        } else if (targetBaseStr) {
            // It leaked out without /service/, reconstruct it
            try {
                intendedTarget = new URL(url.pathname + url.search, new URL(targetBaseStr).origin).toString();
            } catch (e) {}
        } else if (url.origin !== self.location.origin) {
            // Direct external fetch from a proxied script
            intendedTarget = url.href;
        }

        // Cleanup missing protocols
        if (intendedTarget && !intendedTarget.startsWith('http')) {
            intendedTarget = intendedTarget.startsWith('//') ? 'https:' + intendedTarget : 'https://' + intendedTarget.replace(/^\/+/, '');
        }

        // --- 5. EXECUTE ---
        if (intendedTarget) {
            const safeProxyUrl = `${self.location.origin}/service/${encodeURIComponent(intendedTarget)}`;
            
            // If it's a top-level document navigation that leaked, bounce it to the clean URL
            if (event.request.mode === 'navigate' && requestUrlStr !== safeProxyUrl) {
                remoteLog(`[SW V3] 🩹 Navigation Rescue: Redirecting to ${safeProxyUrl}`);
                return Response.redirect(safeProxyUrl, 301);
            }

            return await handleProxyRequest(new Request(safeProxyUrl, event.request), intendedTarget);
        }
        
        return new Response("V3 Proxy: Target Not Found", { status: 404 });
    })());
});

// =========================================================
// 3. The V3 WebSocket Courier
// =========================================================

async function handleProxyRequest(request, targetUrlStr) {
    try { new URL(targetUrlStr); } catch (e) {
        return new Response("Invalid URL format", { status: 400 });
    }

    // 🛑 AdBlocker
    if (await isAdBlockEnabled()) {
        const blockList = ['doubleclick.net', 'google-analytics.com', 'googlesyndication.com', 'amazon-adsystem.com'];
        try {
            const targetHost = new URL(targetUrlStr).hostname;
            if (blockList.some(domain => targetHost.includes(domain))) {
                return new Response(null, { status: 204 }); 
            }
        } catch(e) {}
    }

    // ⚡ Static Cache
    const isStaticAsset = /\.(css|js|png|jpg|jpeg|gif|webp|svg|woff|woff2|ttf|ico)(\?.*)?$/i.test(targetUrlStr);
    let assetCache = null;
    if (isStaticAsset && request.method === 'GET') {
        try {
            assetCache = await caches.open(CACHE_NAME);
            const cachedResponse = await assetCache.match(targetUrlStr);
            if (cachedResponse) return cachedResponse;
        } catch (e) {}
    }
        
    try {
        // 📦 Payload Extraction
        let bodyBase64 = null;
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
            const buffer = await request.clone().arrayBuffer();
            if (buffer.byteLength > 0 && buffer.byteLength <= 5 * 1024 * 1024) {
                const bytes = new Uint8Array(buffer);
                let binary = '';
                for (let i = 0; i < bytes.length; i += 0xFFFF) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0xFFFF));
                }
                bodyBase64 = btoa(binary);
            }
        }

        const headers = {};
        request.headers.forEach((val, key) => { headers[key] = val; });

        let requestDomain = "";
        try { requestDomain = new URL(targetUrlStr).hostname; } catch(e) {}
        const savedCookies = await getCookies(requestDomain);
        if (savedCookies.length > 0) headers['Cookie'] = savedCookies.join('; ');

        // 🌉 WebSocket Bridge
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
                        // Save Cookies
                        if (msg.setCookies && msg.setCookies.length > 0 && msg.targetDomain) {
                            try {
                                const expectedDomain = new URL(targetUrlStr).hostname;
                                const cookieDomain = msg.targetDomain.replace(/^\./, '');
                                if (cookieDomain.includes('.') && expectedDomain.endsWith(cookieDomain)) {
                                    saveCookies(msg.targetDomain, msg.setCookies);
                                }
                            } catch(e) {}
                        }

                        // Sanitize Headers
                        const cleanHeaders = new Headers(msg.headers);
                        ['content-encoding', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'cross-origin-embedder-policy'].forEach(h => cleanHeaders.delete(h));

                        // 🛑 V3 ARCHITECTURE: Intercept Redirects and wrap them cleanly
                        const locationHeader = cleanHeaders.get('location');
                        if (msg.status >= 300 && msg.status < 400 && locationHeader) {
                            ws.close();
                            // Because V3 backend returns absolute URLs, we just encode it directly.
                            const safeRedirectUrl = `${self.location.origin}/service/${encodeURIComponent(locationHeader)}`;
                            resolve(Response.redirect(safeRedirectUrl, msg.status));
                        } else {
                            const finalResponse = new Response(stream, { status: msg.status, headers: cleanHeaders });
                            
                            if (isStaticAsset && msg.status === 200 && assetCache) {
                                assetCache.put(targetUrlStr, finalResponse.clone()).catch(() => {});
                            }
                            resolve(finalResponse);
                        }
                    } else if (msg.type === 'end' || msg.type === 'error') {
                        if (streamController) try { streamController.close(); } catch(e) {}
                        ws.close();
                    }
                } else {
                    if (streamController) {
                        try { streamController.enqueue(new Uint8Array(event.data)); } catch (e) {}
                    }
                }
            };

            ws.onerror = () => { if (!streamController) resolve(new Response("V3 WS Error", { status: 502 })); };
            ws.onclose = () => { if (streamController) try { streamController.close(); } catch(e) {} };
        });
    } catch (err) {
        return new Response(`V3 SW Error: ${err.message}`, { status: 500 });
    }
}
// Default settings inside the SW
let config = {
  debugLogs: true,
  backendUrl: self.location.origin,
};

// Force SW to take control immediately
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Listen for settings updates from the UI
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'UPDATE_SETTINGS') {
    config = { ...config, ...event.data.payload };
    console.log("[SW] ⚙️ Internal config updated:", config);
  }
});



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



// --- SECURITY FIX 1: HTML Sanitizer Helper ---
const escapeHTML = (str) => {
  return String(str).replace(/[&<>'"]/g, 
    tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
  );
};

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

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

function remoteLog(msg) {
  if (!config.debugLogs) return; // Mute logs if disabled!
  
  console.log(msg); 
  self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
    clients.forEach(client => client.postMessage({ type: 'sw-log', message: msg }));
  });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const referrer = event.request.referrer;
  const dest = event.request.destination;

  // Identify assets that "leaked" (trying to hit root domain instead of /service/)
  // We check if it's an asset (image/script/css) OR if the referrer is already in the tunnel
  const isProxiedReferrer = referrer && referrer.includes('/service/');
  const isLeakedAsset = !url.pathname.startsWith('/service/') && 
                        !url.pathname.startsWith('/ws/') && 
                        url.pathname !== '/sw.js' &&
                        (isProxiedReferrer || ['image', 'script', 'style', 'font', 'manifest'].includes(dest));

  const currentOrigin = getBaseOrigin(event);
  if (isLeakedAsset && currentOrigin) {
    try {
      let baseDomain = currentOrigin;
      
      if (isProxiedReferrer) {
        const refUrl = new URL(referrer);
        const path = refUrl.pathname;
        const serviceIdx = path.indexOf('/service/');
        const rawTarget = path.substring(serviceIdx + 9);
        baseDomain = new URL(decodeURIComponent(rawTarget)).origin;
      }

      const targetUrlStr = baseDomain + url.pathname + url.search;
      const proxyUrl = new URL(url.origin + '/service/' + encodeURIComponent(targetUrlStr));
      
      console.log(`[SW Detective] Re-routing ${dest || 'asset'}: ${url.pathname} -> ${targetUrlStr}`);
      return event.respondWith(handleProxyRequest(event, event.request, proxyUrl));
    } catch (e) {
      console.warn("[SW Detective] Resolution failed, falling through...");
    }
  }

  // System Bypass
  if (url.pathname === '/' || url.pathname === '/sw.js' || url.pathname.startsWith('/ws/') || url.pathname.startsWith('/proxy-ws/')) {
    return; 
  }

  event.respondWith(handleProxyRequest(event, event.request, url));
});

async function handleProxyRequest(event, request, url) {
  let targetUrl = url.pathname + url.search;
  const isDocument = request.destination === 'document' || request.destination === 'iframe';

  if (targetUrl.startsWith('/service/')) {
    let innerUrl = decodeURIComponent(targetUrl.replace('/service/', '')).replace(/&amp;/g, '&');    
    if (!/^https?:\/\//i.test(innerUrl)) {
      const referer = request.referrer;
      if (referer && referer.includes('/service/') && !isDocument) {
        try {
          const refUrl = new URL(referer);
          let baseTarget = decodeURIComponent(refUrl.pathname.replace('/service/', ''));
          baseTarget = baseTarget.replace(/&amp;/g, '&'); 
          
          if (!/^https?:\/\//i.test(baseTarget)) baseTarget = 'https://' + baseTarget;
          targetUrl = new URL(innerUrl, baseTarget).toString();
        } catch(e) {
          targetUrl = 'https://' + innerUrl;
        }
      } else {
        targetUrl = 'https://' + innerUrl;
      }
    } else {
      targetUrl = innerUrl;
    }
    
  } 
  else {
    targetUrl = targetUrl.replace(/&amp;/g, '&');
    
    // If the URL is relative (e.g., /wiki/Internet)
    if (!/^https?:\/\//i.test(targetUrl)) {
      const referer = request.referrer;
      let resolved = false;

      // 1. Primary Source of Truth: The Referrer
      if (referer) {
        try {
          const refUrl = new URL(referer);
          let baseTarget = '';

          if (refUrl.pathname.includes('/service/')) {
            // Extract the actual proxied site from the referrer's proxy path
            const serviceIdx = refUrl.pathname.indexOf('/service/');
            baseTarget = decodeURIComponent(refUrl.pathname.substring(serviceIdx + 9));
          } else {
            // If the referrer is already a direct site (e.g., caught during a redirect)
            baseTarget = refUrl.toString();
          }

          baseTarget = baseTarget.replace(/&amp;/g, '&');
          if (!/^https?:\/\//i.test(baseTarget)) baseTarget = 'https://' + baseTarget;

          targetUrl = new URL(targetUrl, baseTarget).toString();
          resolved = true;
        } catch (e) {
          remoteLog(`[SW] Warning: Failed to parse referrer for context: ${referer}`);
        }
      } 
      
      // 2. Absolute Fallback (If no referrer exists, do NOT guess the origin)
      if (!resolved) {
        remoteLog(`[SW] ⚠️ Orphaned relative request: ${targetUrl}. Defaulting to https.`);
        // Strip leading slashes to prevent malformed URLs
        targetUrl = 'https://' + targetUrl.replace(/^\/+/, '');
      }
    }
  }

  // --- STRICT LOOPBACK PREVENTION ---
  // If the resolution accidentally resulted in the proxy's own domain, kill it immediately.
  try {
    const parsedTarget = new URL(targetUrl);
    if (parsedTarget.hostname === self.location.hostname) {
      remoteLog(`[SW] 🛑 CRITICAL LOOP DETECTED: Aborting fetch to own domain -> ${targetUrl}`);
      // Return a safe 204 No Content to instantly kill the looping request 
      // without triggering a Cloudflare Access wall or breaking the page load.
      return new Response(null, { status: 204 }); 
    }
  } catch(e) {}

  remoteLog(`[SW] Intercepted Fetch for: ${targetUrl}`);

  // Prevent the proxy from ever trying to proxy its own host domain
  try {
    const parsedTarget = new URL(targetUrl);
    if (parsedTarget.hostname === self.location.hostname) {
      remoteLog(`[SW] 🛑 LOOP PREVENTED: Attempted to proxy own domain! URL: ${targetUrl}`);
      
      // The relative URL resolution failed and defaulted to the proxy's domain.
      // Force it back to the last known safe proxied origin.
      targetUrl = new URL(parsedTarget.pathname + parsedTarget.search, activeProxyOrigin).toString();
      
      remoteLog(`[SW] 🔄 Rerouted loopback to: ${targetUrl}`);
    }
  } catch(e) {
    // Malformed URL, let it fall through
  }

  // --- SECURITY FIX 3: Hostname-specific Ad Blocking ---
  const blockList = [
    'doubleclick.net',
    'google-analytics.com',
    'googlesyndication.com',
    'amazon-adsystem.com',
    'trackersimulator.org'
  ];

  try {
    const targetHost = new URL(targetUrl).hostname;
    if (blockList.some(domain => targetHost.includes(domain))) {
      remoteLog(`[SW] 🛑 Blocked Ad/Tracker: ${targetHost}`);
      return new Response(null, { status: 204 }); 
    }
  } catch(e) {
    // If it fails to parse, it might be a malformed URL, we can let it proceed to error out natively
  }

  return new Promise((resolve) => {
    try {
      // 2. Open WebSocket to the Worker
      const wsUrl = new URL('/ws/', config.backendUrl);
      wsUrl.protocol = wsUrl.protocol === 'http:' ? 'ws:' : 'wss:';
      
      remoteLog(`[SW] Opening WebSocket to Backend at ${wsUrl.origin}...`);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      
      let responseStatus = 200;
      let responseHeaders = new Headers();
      let streamController;
      let headersResolved = false;

      const stream = new ReadableStream({
        start(controller) { streamController = controller; },
        cancel(reason) {
          remoteLog(`[SW] Browser canceled stream. Terminating WS.`);
          try { ws.close(); } catch(e) {}
        }
      });

      const sendErrorToScreen = (errorMsg) => {
        remoteLog(`[SW] Sending error screen: ${errorMsg}`);
        if (!headersResolved) {
          headersResolved = true;
          // --- SECURITY FIX 1 (Applied): Escaping dynamic variables ---
          const errorHtml = `
            <div style="font-family: monospace; padding: 20px; color: #d8000c; background: #ffbaba; border: 1px solid #d8000c; border-radius: 5px;">
              <h2>Proxy Error</h2>
              <p><strong>Target:</strong> ${escapeHTML(targetUrl)}</p>
              <p><strong>Details:</strong> ${escapeHTML(errorMsg)}</p>
            </div>
          `;
          resolve(new Response(errorHtml, {
            status: 502,
            headers: { 'Content-Type': 'text/html' }
          }));
        }
      };

      ws.onopen = async () => {
        remoteLog(`[SW] WebSocket Open. Sending metadata.`);
        const headers = {};
        request.headers.forEach((value, key) => headers[key] = value);
        
        let requestDomain = "";
        try {
          requestDomain = new URL(targetUrl).hostname;
        } catch(e) {}

        const savedCookies = await getCookies(requestDomain);
        if (savedCookies && savedCookies.length > 0) {
            headers['Cookie'] = savedCookies.join('; ');
            remoteLog(`[SW] Attached persistent cookies for ${requestDomain}`);
        }

        let encodedBody = null;
        if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
          try {
            // --- SECURITY FIX 2: Prevent memory crashes with a 5MB payload limit ---
            const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
            const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB limit
            
            if (contentLength > MAX_PAYLOAD_SIZE) {
               throw new Error("Payload too large. Maximum size is 5MB.");
            }

            const buffer = await request.clone().arrayBuffer();
            
            if (buffer.byteLength > MAX_PAYLOAD_SIZE) {
               throw new Error("Payload too large. Maximum size is 5MB.");
            }

            if (buffer.byteLength > 0) {
              const bytes = new Uint8Array(buffer);
              // Use a more performant way to convert chunks if payload is large
              let binary = "";
              const chunksize = 0xFFFF;
              for (let i = 0; i < bytes.length; i += chunksize) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunksize));
              }
              encodedBody = btoa(binary);
            }
          } catch (e) {
            remoteLog(`[SW] Failed to read request body: ${e.message}`);
          }
        }
        
        ws.send(JSON.stringify({
          type: 'request',
          url: targetUrl,
          method: request.method,
          headers: headers,
          body: encodedBody 
        }));
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data);
          
          if (msg.type === 'info') {
            remoteLog(`[Server] ${msg.message}`);
          } else if (msg.type === 'response') {
            remoteLog(`[SW] Received Response Headers (Status: ${msg.status})`);
            responseStatus = msg.status;
            for (const [key, value] of Object.entries(msg.headers)) {
              responseHeaders.set(key, value);
            }

            // --- SECURITY FIX 4: Prevent Cross-Origin Cookie Forgery ---
            if (msg.setCookies && msg.setCookies.length > 0 && msg.targetDomain) {
              try {
                const expectedDomain = new URL(targetUrl).hostname;
                const cookieDomain = msg.targetDomain.replace(/^\./, '');

                // VALIDATION: Must have at least one dot (not a TLD) 
                // AND must be a suffix of the actual site we are visiting
                const isSafeDomain = cookieDomain.includes('.') && expectedDomain.endsWith(cookieDomain);
              
                if (isSafeDomain) {
                  saveCookies(msg.targetDomain, msg.setCookies);
                  remoteLog(`[SW] Saved ${msg.setCookies.length} persistent cookies for ${msg.targetDomain}`);
                } else {
                  remoteLog(`[SW] ⚠️ Blocked suspicious cookie domain: ${msg.targetDomain}`);
                }
              } catch(e) {}
            }

            headersResolved = true;
            resolve(new Response(stream, {
              status: responseStatus,
              headers: responseHeaders
            }));
          } else if (msg.type === 'error') {
            remoteLog(`[SW] Received Error: ${msg.message}`);
            sendErrorToScreen(msg.message);
          } else if (msg.type === 'end') {
            remoteLog(`[SW] Stream End signal received.`);
            try { streamController.close(); } catch(e) {}
            ws.close();
          }
        } else {
          try { 
            streamController.enqueue(new Uint8Array(event.data)); 
          } catch(e) {
            remoteLog(`[SW] Enqueue failed: ${e.message}. Closing WS.`);
            try { ws.close(); } catch(err) {}
          }
        }
      };

      ws.onerror = (err) => {
        remoteLog(`[SW] WebSocket Error.`);
        sendErrorToScreen("WebSocket connection failed.");
      };

      ws.onclose = (e) => {
        if (!headersResolved) {
          sendErrorToScreen(`WebSocket closed before headers arrived.`);
        } else {
          try { streamController.close(); } catch(e) {}
        }
      };

    } catch (err) {
      // --- SECURITY FIX 1 (Applied): Escaping dynamic variables ---
      resolve(new Response(`<h2>Internal SW Error</h2><pre>${escapeHTML(err.message)}</pre>`, {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      }));
    }
  });
}
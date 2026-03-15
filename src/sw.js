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

  // 1. --- NAVIGATION GUARD (Fixes "Clicking Links" returning 404s) ---
  if (event.request.mode === 'navigate' && !url.pathname.startsWith('/service/')) {
    const referer = event.request.referrer;
    if (referer && referer.includes('/service/')) {
      try {
        const parts = referer.split('/service/');
        const proxiedOrigin = new URL(decodeURIComponent(parts[1])).origin;
        // Rewrite the destination to stay inside the proxy tunnel
        const newDestination = `${self.location.origin}/service/${encodeURIComponent(proxiedOrigin + url.pathname + url.search)}`;
        return event.respondWith(Response.redirect(newDestination, 301));
      } catch (e) {
        remoteLog(`[SW] Navigation rewrite failed: ${e.message}`);
      }
    }
  }

  // 2. --- SYSTEM BYPASS ---
  // Let the main UI and WebSockets load normally
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js' || url.pathname.startsWith('/ws/') || url.pathname.startsWith('/proxy-ws/')) {
    return; 
  }

  // 3. Pass everything else to the proxy handler
  event.respondWith(handleProxyRequest(event, event.request, url));
});

async function handleProxyRequest(event, request, url) {
  let targetUrl = url.pathname + url.search;

  // 1. Resolve the Target URL
  if (targetUrl.startsWith('/service/')) {
    // Direct proxy requests from the address bar
    targetUrl = decodeURIComponent(targetUrl.substring(9)).replace(/&amp;/g, '&');
  } else {
    // Relative assets (images, scripts) that leaked out
    targetUrl = targetUrl.replace(/&amp;/g, '&');
    
    if (!/^https?:\/\//i.test(targetUrl)) {
      const referer = request.referrer;
      let resolved = false;

      if (referer && referer.includes('/service/')) {
        try {
          // Extract origin from the proxied referrer and glue the path to it
          const parts = referer.split('/service/');
          const proxiedOrigin = new URL(decodeURIComponent(parts[1])).origin;
          targetUrl = new URL(url.pathname + url.search, proxiedOrigin).toString();
          resolved = true;
        } catch (e) {
          remoteLog(`[SW] Asset Resolver Error: ${e.message}`);
        }
      }

      if (!resolved) {
        targetUrl = 'https://' + targetUrl.replace(/^\/+/, '');
      }
    }
  }

  remoteLog(`[SW] Intercepted Fetch for: ${targetUrl}`);

  // 2. --- STRICT LOOPBACK PREVENTION (Relaxed) ---
  try {
    const parsedTarget = new URL(targetUrl);
    // If it hits our own domain AND doesn't have the /service/ prefix
    if (parsedTarget.hostname === self.location.hostname && !parsedTarget.pathname.startsWith('/service/')) {
      const bypassList = ['/', '/index.html', '/sw.js', '/style.css']; 
      if (!bypassList.includes(parsedTarget.pathname)) {
        remoteLog(`[SW] 🛑 Blocked phantom loopback to: ${targetUrl}`);
        return new Response(null, { status: 204 }); 
      }
    }
  } catch(e) {
    // Malformed URL, allow it to fall through to a natural error
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
// Default settings inside the SW
let config = {
  debugLogs: true,
  backendUrl: self.location.origin,
  password: ""
};

// Force SW to take control immediately
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Listen for settings updates from the UI
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'UPDATE_SETTINGS') {
    config = { ...config, ...event.data.payload };
    remoteLog("[SW] ⚙️ Internal config updated:", config);
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

// A fallback origin in case requests are missing referers
let activeProxyOrigin = 'https://wikipedia.org'; 

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
  
  if (url.pathname === '/' || url.pathname === '/sw.js' || url.pathname === '/ws/') {
    return;
  }

  event.respondWith(handleProxyRequest(event.request, url));
});

async function handleProxyRequest(request, url) {
  let targetUrl = url.pathname + url.search;
  const isDocument = request.destination === 'document' || request.destination === 'iframe';

  if (targetUrl.startsWith('/service/')) {
    let innerUrl = decodeURIComponent(targetUrl.replace('/service/', ''));
    innerUrl = innerUrl.replace(/&amp;/g, '&');
    
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
    
    if (isDocument) {
      try { 
          activeProxyOrigin = new URL(targetUrl).origin; 
      } catch(e) {}
    }
  } 
  else {
    targetUrl = targetUrl.replace(/&amp;/g, '&');
    
    if (!/^https?:\/\//i.test(targetUrl)) {
      const referer = request.referrer;
      let resolved = false;

      if (referer && referer.includes('/service/')) {
        try {
          const refUrl = new URL(referer);
          let baseTarget = decodeURIComponent(refUrl.pathname.replace('/service/', ''));
          baseTarget = baseTarget.replace(/&amp;/g, '&');
          if (!/^https?:\/\//i.test(baseTarget)) baseTarget = 'https://' + baseTarget;
          
          targetUrl = new URL(targetUrl, baseTarget).toString();
          resolved = true;
        } catch (e) {}
      } 
      
      if (!resolved) {
        try { targetUrl = new URL(targetUrl, activeProxyOrigin).toString(); } 
        catch(e) { targetUrl = 'https://' + targetUrl.replace(/^\//, ''); }
      }
    }
  }

  remoteLog(`[SW] Intercepted Fetch for: ${targetUrl}`);

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
      const wsUrl = new URL('/ws/', config.backendUrl);
      
      // Attach the password!
      if (config.password) {
        wsUrl.searchParams.set("token", config.password);
      }
      
      wsUrl.protocol = wsUrl.protocol === 'http:' ? 'ws:' : 'wss:';
      
      remoteLog(`[SW] Opening WebSocket to Backend at ${wsUrl.href}...`);
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
              let binary = '';
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
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
                 // Ensure the requested cookie domain is a substring of the actual target URL
                 // e.g., msg.targetDomain ".google.com" is valid for "accounts.google.com"
                 if (expectedDomain.endsWith(msg.targetDomain.replace(/^\./, ''))) {
                   saveCookies(msg.targetDomain, msg.setCookies);
                   remoteLog(`[SW] Saved ${msg.setCookies.length} persistent cookies for ${msg.targetDomain}`);
                 } else {
                   remoteLog(`[SW] ⚠️ Blocked cross-origin cookie set attempt for ${msg.targetDomain}`);
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
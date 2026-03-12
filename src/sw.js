// A simple in-memory cookie jar (Note: resets if the SW goes to sleep)
const cookieJar = {};

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

// Helper to send logs to the main window (Eruda)
function remoteLog(msg) {
  console.log(msg); 
  self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
    clients.forEach(client => client.postMessage({ type: 'sw-log', message: msg }));
  });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Let the browser handle the root UI, the SW script, and the websocket path
  if (url.pathname === '/' || url.pathname === '/sw.js' || url.pathname === '/ws/') {
    return;
  }

  event.respondWith(handleProxyRequest(event.request, url));
});

async function handleProxyRequest(request, url) {
  let targetUrl = url.pathname + url.search;

  // 1. If it's the main frame request, strip the /service/ prefix
  if (targetUrl.startsWith('/service/')) {
    targetUrl = decodeURIComponent(targetUrl.replace('/service/', ''));
  }

  // 2. If the URL doesn't have http:// or https://, it's a subresource
  // ESCAPED REGEX: // prevents the string from turning into a JS comment
  if (!/^https?:\/\//i.test(targetUrl)) {
    const referer = request.referrer;
    
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const baseTarget = decodeURIComponent(refUrl.pathname.replace('/service/', ''));
        const baseUrl = new URL(baseTarget.startsWith('http') ? baseTarget : 'https://' + baseTarget);
        
        targetUrl = new URL(targetUrl, baseUrl.origin).toString();
        remoteLog(`[SW] Reconstructed relative URL via Referer: ${targetUrl}`);
      } catch (e) {
        // ESCAPED REGEX: ^/
        targetUrl = 'https://' + targetUrl.replace(/^\//, ''); 
      }
    } else {
      targetUrl = 'https://' + targetUrl.replace(/^\//, ''); 
    }
  }

  remoteLog(`[SW] Intercepted Fetch for: ${targetUrl}`);

  // 3. The Ad Blocker
  const blockList = [
    'doubleclick.net',
    'google-analytics.com',
    'googlesyndication.com',
    'amazon-adsystem.com',
    'trackersimulator.org'
  ];

  if (blockList.some(domain => targetUrl.includes(domain))) {
    remoteLog(`[SW] 🛑 Blocked Ad/Tracker: ${targetUrl}`);
    // Return an empty, successful response immediately
    return new Response(null, { status: 204 }); 
  }

  return new Promise((resolve) => {
    try {
      const wsUrl = new URL('/ws/', location.origin);
      wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      
      remoteLog(`[SW] Opening WebSocket to Backend...`);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      
      let responseStatus = 200;
      let responseHeaders = new Headers();
      let streamController;
      let headersResolved = false;

      const stream = new ReadableStream({
        start(controller) { streamController = controller; }
      });

      const sendErrorToScreen = (errorMsg) => {
        remoteLog(`[SW] Sending error screen: ${errorMsg}`);
        if (!headersResolved) {
          headersResolved = true;
          const errorHtml = `
            <div style="font-family: monospace; padding: 20px; color: #d8000c; background: #ffbaba; border: 1px solid #d8000c; border-radius: 5px;">
              <h2>Proxy Error</h2>
              <p><strong>Target:</strong> ${targetUrl}</p>
              <p><strong>Details:</strong> ${errorMsg}</p>
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
        
        // NEW: Look up cookies for the domain we are about to fetch
        const requestDomain = new URL(targetUrl).hostname;
        if (cookieJar[requestDomain] && cookieJar[requestDomain].length > 0) {
            // Join them with a semicolon as per the HTTP spec
            headers['Cookie'] = cookieJar[requestDomain].join('; ');
            remoteLog(`[SW] Attached cookies for ${requestDomain}`);
        }

        // NEW: Read the request body if it's a POST/PUT/PATCH
        let encodedBody = null;
        if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
          try {
            const buffer = await request.clone().arrayBuffer();
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
          body: encodedBody // NEW: Send the body to the backend
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

            // NEW: Save the intercepted cookies for this domain
            if (msg.setCookies && msg.setCookies.length > 0) {
               if (!cookieJar[msg.targetDomain]) {
                   cookieJar[msg.targetDomain] = [];
               }
               // In a real app, you'd parse the cookie string to handle expires/path/overwrites
               // For now, we just push the raw string
               msg.setCookies.forEach(cookieStr => {
                   cookieJar[msg.targetDomain].push(cookieStr.split(';')[0]); // Keep just the Key=Value part
               });
               remoteLog(`[SW] Saved ${msg.setCookies.length} cookies for ${msg.targetDomain}`);
            }

            headersResolved = true;

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
          remoteLog(`[SW] Enqueuing ${event.data.byteLength} bytes.`);
          try { 
            streamController.enqueue(new Uint8Array(event.data)); 
          } catch(e) {
            remoteLog(`[SW] Enqueue failed: ${e.message}`);
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
      resolve(new Response(`<h2>Internal SW Error</h2><pre>${err.message}</pre>`, {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      }));
    }
  });
}

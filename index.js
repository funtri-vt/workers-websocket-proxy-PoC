/**
 * @typedef {Object} Env
 */

// --------------------------------------------------------
// 1. The Main User Interface (index.html)
// --------------------------------------------------------
const indexHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Custom WS Proxy</title>
  <style>
    body { margin: 0; font-family: sans-serif; display: flex; flex-direction: column; height: 100vh; }
    #bar { padding: 10px; background: #222; color: #fff; display: flex; gap: 10px; align-items: center; }
    #url-input { flex-grow: 1; padding: 8px; font-size: 16px; border-radius: 4px; border: none; }
    button { padding: 8px 15px; font-size: 16px; cursor: pointer; border-radius: 4px; border: none; background: #007bff; color: white; }
    #frame { flex-grow: 1; border: none; width: 100%; background: #fff; }
  </style>
</head>
<body>
  <div id="bar">
    <strong>SW Proxy</strong>
    <input type="text" id="url-input" placeholder="wikipedia.org" value="wikipedia.org" />
    <button onclick="loadUrl()">Go</button>
  </div>
  <iframe id="frame"></iframe>
  <script>
  ;(function () {
    var src = '//cdn.jsdelivr.net/npm/eruda';
    if (!/eruda=true/.test(window.location) && localStorage.getItem('active-eruda') != 'true') return;
    document.write('<scr' + 'ipt src="' + src + '"></scr' + 'ipt>');
    document.write('<scr' + 'ipt>eruda.init();</scr' + 'ipt>');
  })();
  </script>
  <script>
    // LISTEN FOR LOGS FROM THE SERVICE WORKER AND PIPE TO ERUDA
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data && event.data.type === 'sw-log') {
        console.log(event.data.message);
      }
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(() => console.log('[Client] Service Worker registered.'))
        .catch(err => console.error('[Client] SW Error:', err));
    }

    function loadUrl() {
      const input = document.getElementById('url-input').value;
      const frame = document.getElementById('frame');
      console.log('[Client] Loading iframe with target:', input);
      frame.src = '/service/' + encodeURIComponent(input); 
    }
  </script>
</body>
</html>
`;

// --------------------------------------------------------
// 2. The Service Worker Script (sw.js)
// --------------------------------------------------------
const swJs = `
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
  // ESCAPED REGEX: \\/\\/ prevents the string from turning into a JS comment
  if (!/^https?:\\/\\//i.test(targetUrl)) {
    const referer = request.referrer;
    
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const baseTarget = decodeURIComponent(refUrl.pathname.replace('/service/', ''));
        const baseUrl = new URL(baseTarget.startsWith('http') ? baseTarget : 'https://' + baseTarget);
        
        targetUrl = new URL(targetUrl, baseUrl.origin).toString();
        remoteLog(\`[SW] Reconstructed relative URL via Referer: \${targetUrl}\`);
      } catch (e) {
        // ESCAPED REGEX: ^\\/
        targetUrl = 'https://' + targetUrl.replace(/^\\//, ''); 
      }
    } else {
      targetUrl = 'https://' + targetUrl.replace(/^\\//, ''); 
    }
  }

  remoteLog(\`[SW] Intercepted Fetch for: \${targetUrl}\`);

  return new Promise((resolve) => {
    try {
      const wsUrl = new URL('/ws/', location.origin);
      wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      
      remoteLog(\`[SW] Opening WebSocket to Backend...\`);
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
        remoteLog(\`[SW] Sending error screen: \${errorMsg}\`);
        if (!headersResolved) {
          headersResolved = true;
          const errorHtml = \`
            <div style="font-family: monospace; padding: 20px; color: #d8000c; background: #ffbaba; border: 1px solid #d8000c; border-radius: 5px;">
              <h2>Proxy Error</h2>
              <p><strong>Target:</strong> \${targetUrl}</p>
              <p><strong>Details:</strong> \${errorMsg}</p>
            </div>
          \`;
          resolve(new Response(errorHtml, {
            status: 502,
            headers: { 'Content-Type': 'text/html' }
          }));
        }
      };

      ws.onopen = async () => {
        remoteLog(\`[SW] WebSocket Open. Sending metadata.\`);
        const headers = {};
        request.headers.forEach((value, key) => headers[key] = value);
        
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
            remoteLog(\`[SW] Failed to read request body: \${e.message}\`);
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
            remoteLog(\`[Server] \${msg.message}\`);
          } else if (msg.type === 'response') {
            remoteLog(\`[SW] Received Response Headers (Status: \${msg.status})\`);
            responseStatus = msg.status;
            for (const [key, value] of Object.entries(msg.headers)) {
              responseHeaders.set(key, value);
            }
            headersResolved = true;
            resolve(new Response(stream, {
              status: responseStatus,
              headers: responseHeaders
            }));
          } else if (msg.type === 'error') {
            remoteLog(\`[SW] Received Error: \${msg.message}\`);
            sendErrorToScreen(msg.message);
          } else if (msg.type === 'end') {
            remoteLog(\`[SW] Stream End signal received.\`);
            try { streamController.close(); } catch(e) {}
            ws.close();
          }
        } else {
          remoteLog(\`[SW] Enqueuing \${event.data.byteLength} bytes.\`);
          try { 
            streamController.enqueue(new Uint8Array(event.data)); 
          } catch(e) {
            remoteLog(\`[SW] Enqueue failed: \${e.message}\`);
          }
        }
      };

      ws.onerror = (err) => {
        remoteLog(\`[SW] WebSocket Error.\`);
        sendErrorToScreen("WebSocket connection failed.");
      };

      ws.onclose = (e) => {
        if (!headersResolved) {
          sendErrorToScreen(\`WebSocket closed before headers arrived.\`);
        } else {
          try { streamController.close(); } catch(e) {}
        }
      };

    } catch (err) {
      resolve(new Response(\`<h2>Internal SW Error</h2><pre>\${err.message}</pre>\`, {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      }));
    }
  });
}
`;

// --------------------------------------------------------
// 3. The Cloudflare Worker Backend
// --------------------------------------------------------
export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === "/sw.js") {
			return new Response(swJs, {
				headers: { "content-type": "application/javascript", "cache-control": "no-store" },
			});
		}

		if (url.pathname === "/") {
			return new Response(indexHtml, {
				headers: { "content-type": "text/html" },
			});
		}

		if (url.pathname === "/ws/") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket", { status: 426 });
			}

			const { 0: client, 1: server } = new WebSocketPair();
			server.accept();

			server.addEventListener("message", async (event) => {
				if (typeof event.data === "string") {
					try {
						const msg = JSON.parse(event.data);
						
						if (msg.type === "request") {
                            server.send(JSON.stringify({ type: "info", message: `Preparing fetch for: \${msg.url}` }));

							// Clean and reconstruct headers
              // Clean and reconstruct headers
                            const proxyHeaders = new Headers(msg.headers);
                            proxyHeaders.delete("accept-encoding");
                            proxyHeaders.set("Host", new URL(msg.url).host);
                            proxyHeaders.set("Origin", new URL(msg.url).origin);
                            
                            // NEW: Spoof a modern Chrome User-Agent
                            proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

                            const fetchOptions = {
                                method: msg.method,
                                headers: proxyHeaders,
                                redirect: "manual" // Crucial for forms/logins that trigger redirects
                            };

                            // NEW: Decode the body if one was sent
                            if (msg.body) {
                                const binaryString = atob(msg.body);
                                const bytes = new Uint8Array(binaryString.length);
                                for (let i = 0; i < binaryString.length; i++) {
                                    bytes[i] = binaryString.charCodeAt(i);
                                }
                                fetchOptions.body = bytes;
                            }

                            const targetRequest = new Request(msg.url, fetchOptions);

							try {
                                server.send(JSON.stringify({ type: "info", message: `Executing fetch()` }));
								const res = await fetch(targetRequest);

                                server.send(JSON.stringify({ type: "info", message: `Fetch complete. Status: \${res.status}` }));

								const headersOut = {};
								res.headers.forEach((value, key) => {
									const lowerKey = key.toLowerCase();
									if (!["content-encoding", "transfer-encoding", "x-frame-options", "content-security-policy"].includes(lowerKey)) {
										headersOut[key] = value;
									}
								});

								server.send(JSON.stringify({
									type: "response",
									status: res.status,
									headers: headersOut
								}));

								if (res.body) {
									const reader = res.body.getReader();
									while (true) {
										const { done, value } = await reader.read();
										if (done) break;
										server.send(value); 
									}
								}
								
								server.send(JSON.stringify({ type: "end" }));

							} catch (fetchError) {
								server.send(JSON.stringify({ 
									type: "error", 
									message: `Backend fetch failed: \${fetchError.message}` 
								}));
								server.send(JSON.stringify({ type: "end" }));
							}
						}
					} catch (e) {
						server.send(JSON.stringify({ type: "error", message: `Worker error: \${e.message}` }));
						server.send(JSON.stringify({ type: "end" }));
					}
				}
			});

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

		return new Response("Not Found", { status: 404 });
	},
};

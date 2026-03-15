/**
 * @typedef {Object} Env
 */

import { Buffer } from "node:buffer";

import indexHtml from "./index.html";
import swJs from "./sw.js";

// --------------------------------------------------------
// The Cloudflare Worker Backend (Stateless & Free)
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
				headers: { 
					"content-type": "text/html",
					"cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
					"pragma": "no-cache",
					"expires": "0"
				},
			});
		}

		// --------------------------------------------------------
		// Phase 1: Service Worker to Backend Bridge
		// --------------------------------------------------------
		if (url.pathname === "/ws/") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket", { status: 426 });
			}

			// Token authentication completely removed. Open door policy.

			const { 0: client, 1: server } = new WebSocketPair();
			server.accept();

			const safeSend = (data) => {
				if (server.readyState === 1) {
					try {
						server.send(data);
					} catch (e) {}
				}
			};

			server.addEventListener("message", async (event) => {
				if (typeof event.data === "string") {
					try {
						const msg = JSON.parse(event.data);
						
						if (msg.type === "request") {
							safeSend(JSON.stringify({ type: "info", message: `Preparing fetch for: ${msg.url}` }));

							const proxyHeaders = new Headers(msg.headers);
							proxyHeaders.delete("accept-encoding");
							proxyHeaders.set("Host", new URL(msg.url).host);
							proxyHeaders.set("Origin", new URL(msg.url).origin);
							proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
							// ADD THIS LINE TO FIX SEARCH ENGINES:
							proxyHeaders.set("Referer", new URL(msg.url).origin + "/");
							const fetchOptions = {
								method: msg.method,
								headers: proxyHeaders,
								redirect: "manual"
							};

							if (msg.body) {
  							try {
  							   // This executes entirely in C++, consuming virtually zero JS CPU time.
  							   fetchOptions.body = Buffer.from(msg.body, "base64");
  							} catch (e) {
   							 	safeSend(JSON.stringify({ type: "error", message: "Failed to decode request body." }));
    							return;
							  }
							}

							if (msg.method.toUpperCase() === "OPTIONS") {
								safeSend(JSON.stringify({
									type: "response",
									status: 200,
									headers: {
										"Access-Control-Allow-Origin": "*",
										"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
										"Access-Control-Allow-Headers": "*",
										"Access-Control-Max-Age": "86400"
									},
									setCookies: [], 
									targetDomain: new URL(msg.url).hostname
								}));
								safeSend(JSON.stringify({ type: "end" }));
								return; 
							}

							const targetRequest = new Request(msg.url, fetchOptions);

							try {
								const res = await fetch(targetRequest);

								const headersOut = {};
								let contentType = "";
								
								const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];

								res.headers.forEach((value, key) => {
									const lowerKey = key.toLowerCase();
									if (lowerKey === "content-type") contentType = value;
									
									if (lowerKey === "location") {
										try {
											const absoluteLocation = new URL(value, msg.url).toString();
											headersOut[key] = "/service/" + encodeURIComponent(absoluteLocation);
										} catch (e) {
											headersOut[key] = value;
										}
									} else if (!["content-encoding", "transfer-encoding", "x-frame-options", "content-security-policy", "set-cookie", "access-control-allow-origin"].includes(lowerKey)) {
										headersOut[key] = value;
									}
								});

								if (contentType.includes("text/html")) {
									delete headersOut["content-length"];
									delete headersOut["Content-Length"];
								}

								headersOut["Access-Control-Allow-Origin"] = "*";
								headersOut["Access-Control-Allow-Methods"] = "*";
								headersOut["Access-Control-Allow-Headers"] = "*";
								headersOut["Access-Control-Expose-Headers"] = "*";

								safeSend(JSON.stringify({
									type: "response",
									status: res.status,
									headers: headersOut,
									setCookies: setCookies, 
									targetDomain: new URL(msg.url).hostname
								}));

								let streamResponse = res;

								if (contentType.includes("text/html")) {
									const targetDomain = new URL(msg.url).hostname;
									const baseUrl = msg.url; 


									// Quick Sanity Check
    								try {
    								    new URL(baseUrl);
    								} catch (e) {
    								    safeSend(JSON.stringify({ type: "error", message: "Invalid Target URL" }));
    								    return;
    								}

									class ScriptInjector {
									  element(element) {
										const configObj = {
      										targetDomain: new URL(baseUrl).hostname,
										    targetBase: baseUrl,
										    targetOrigin: new URL(baseUrl).origin
    									};
									    const script = `
									    <script>
									      (function() {
									        // --- 0. Configuration (Injected Safely via JSON) ---
        									const config = ${JSON.stringify(configObj)};
    									    const prefix = config.targetDomain + ":";
									        const PROXY_BASE = window.location.origin + '/service/';
									        const TARGET_BASE = config.targetBase;
									        const TARGET_ORIGIN = config.targetOrigin;
									
									        // URL Traffic Controller: The brain of the proxy
									        function resolveUrl(url) {
									          if (!url || typeof url !== 'string') return url;
									          if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(PROXY_BASE)) return url;
											  
											  if (url.startsWith('/service/')) return url;
											  
									          let finalUrl = url;
									          if (url.startsWith('//')) finalUrl = window.location.protocol + url;
									
									          try {
									            const absolute = new URL(finalUrl, TARGET_BASE).toString();
									            return PROXY_BASE + encodeURIComponent(absolute);
									          } catch (e) {
									            return url;
									          }
									        }
									
									        // --- 1. Advanced Storage Spoofing ---
									        const makeProxy = (real) => new Proxy(real, {
									          get(target, prop) {
									            if (prop === 'getItem') return (k) => target.getItem(prefix + k);
									            if (prop === 'setItem') return (k, v) => target.setItem(prefix + k, v);
									            if (prop === 'removeItem') return (k) => target.removeItem(prefix + k);
									            if (prop === 'clear') return () => {
									              for (let i = target.length - 1; i >= 0; i--) {
									                const key = target.key(i);
									                if (key && key.startsWith(prefix)) target.removeItem(key);
									              }
									            };
									            return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
									          }
									        });
									
									        try { Object.defineProperty(window, 'localStorage', { value: makeProxy(window.localStorage) }); } catch(e) {}
									        try { Object.defineProperty(window, 'sessionStorage', { value: makeProxy(window.sessionStorage) }); } catch(e) {}
									
									        // --- 2. Focus & Frame Escape Prevention ---
									        try { Object.defineProperty(window, 'top', { value: window.self }); } catch(e) {}
									        try { Object.defineProperty(window, 'parent', { value: window.self }); } catch(e) {}
									
									        // --- 3. Active Interception (New: Fixes dynamic SPAs like DuckDuckGo) ---
									
									        // Hook setAttribute for dynamic elements
									        const orgSetAttribute = Element.prototype.setAttribute;
									        Element.prototype.setAttribute = function(name, value) {
									          if (['src', 'href', 'action'].includes(name.toLowerCase())) {
									            value = resolveUrl(value);
									          }
									          return orgSetAttribute.apply(this, [name, value]);
									        };
									
									        // Hook property setters (e.g., img.src = "/path")
									        const hookProp = (proto, prop) => {
									          const desc = Object.getOwnPropertyDescriptor(proto, prop);
									          if (desc && desc.set) {
									            const orgSet = desc.set;
									            Object.defineProperty(proto, prop, {
									              set: function(v) { return orgSet.apply(this, [resolveUrl(v)]); }
									            });
									          }
									        };
									        if (window.HTMLImageElement) hookProp(HTMLImageElement.prototype, 'src');
									        if (window.HTMLAnchorElement) hookProp(HTMLAnchorElement.prototype, 'href');
									        if (window.HTMLFormElement) hookProp(HTMLFormElement.prototype, 'action');
									        if (window.HTMLScriptElement) hookProp(HTMLScriptElement.prototype, 'src');
									
									        // --- 4. API Hooking (Fetch/XHR/Window) ---
									        const oldFetch = window.fetch;
									        window.fetch = function(input, init) {
									          if (typeof input === 'string') input = resolveUrl(input);
									          else if (input instanceof Request) {
									            return oldFetch(new Request(resolveUrl(input.url), input), init);
									          }
									          return oldFetch(input, init);
									        };
									
									        const oldOpen = XMLHttpRequest.prototype.open;
									        XMLHttpRequest.prototype.open = function(method, url, ...args) {
									          return oldOpen.apply(this, [method, resolveUrl(url), ...args]);
									        };
									
									        const oldWindowOpen = window.open;
									        window.open = function(url, ...args) {
									          return oldWindowOpen.apply(window, [resolveUrl(url), ...args]);
									        };
									
									        // --- 5. Stateless WebSocket Interceptor ---
									        const OriginalWebSocket = window.WebSocket;
									        window.WebSocket = function(url, protocols) {
									          if (typeof url === 'string' && url.includes('/ws/')) {
									            return new OriginalWebSocket(url, protocols);
									          }
									          const absoluteTarget = new URL(url, TARGET_BASE).toString();
									          const targetUrl = encodeURIComponent(absoluteTarget);
									          const proxyUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/proxy-ws/?target=' + targetUrl;
									
									          return protocols ? new OriginalWebSocket(proxyUrl, protocols) : new OriginalWebSocket(proxyUrl);
									        };
									        window.WebSocket.prototype = OriginalWebSocket.prototype;
									        Object.assign(window.WebSocket, OriginalWebSocket);
									
									        // --- 6. History API Hooking (The Cage) ---
									        const oldPushState = window.history.pushState;
									        window.history.pushState = function(state, title, url) {
									            return oldPushState.apply(window.history, [state, title, resolveUrl(url)]);
									        };
									        const oldReplaceState = window.history.replaceState;
									        window.history.replaceState = function(state, title, url) {
									            return oldReplaceState.apply(window.history, [state, title, resolveUrl(url)]);
									        };
									
									        // --- 7. Location Guarding ---
									        try {
									            Object.defineProperty(window, '__proxyLocation', { value: new URL(TARGET_BASE) });
									        } catch(e) {}
									      })();
									    </script>`;
									    element.prepend(script, { html: true });
									  }
									}
									class AttributeRewriter {
										constructor(attributeName) {
											this.attributeName = attributeName;
										}
										element(element) {
											const attribute = element.getAttribute(this.attributeName);
											if (attribute && !attribute.startsWith('data:') && !attribute.startsWith('#')) {
												try {
													const absoluteUrl = new URL(attribute, baseUrl).toString();
													element.setAttribute(this.attributeName, "/service/" + encodeURIComponent(absoluteUrl));
												} catch (e) {}
											}
										}
									}

									class SecurityStripper {
										element(element) {
											element.removeAttribute("integrity");
											element.removeAttribute("nonce");
										}
									}

									// Stream directly from the live response! No buffering needed.
								const rewrittenRes = new HTMLRewriter()
								    .on("head", new ScriptInjector())
								    .on("a", new AttributeRewriter("href"))
								    .on("img", new AttributeRewriter("src"))
								    .on("link", new AttributeRewriter("href"))
								    .on("form", new AttributeRewriter("action"))
								    .on("script", new AttributeRewriter("src"))
								    .on("script, link", new SecurityStripper()) 
								    .transform(res);

								// Read the rewritten HTML in chunks and stream it over the WebSocket
								if (rewrittenRes.body) {
								    const reader = rewrittenRes.body.getReader();
								    try {
								        while (true) {
								            if (server.readyState !== 1) {
								                try { await reader.cancel("Client disconnected"); } catch(e) {}
								                break;
								            }
										
								            const { done, value } = await reader.read();
								            if (done) break;
										
								            try {
								                server.send(value); // value is already a Uint8Array chunk!
								            } catch (err) {
								                try { await reader.cancel("Socket send failed"); } catch(e) {}
								                break;
								            }
								        }
								    } catch (streamErr) {
								        try { await reader.cancel("Stream error"); } catch(e) {}
								    } finally {
								        reader.releaseLock();
								    }
								}

								} else if (res.body) {
									const reader = res.body.getReader();
									try {
										while (true) {
											if (server.readyState !== 1) {
												try { await reader.cancel("Client disconnected"); } catch(e) {}
												break;
											}

											const { done, value } = await reader.read();
											if (done) break;

											try {
												server.send(value);
											} catch (err) {
												try { await reader.cancel("Socket send failed"); } catch(e) {}
												break;
											}
										}
									} catch (streamErr) {
										try { await reader.cancel("Stream error"); } catch(e) {}
									} finally {
										reader.releaseLock();
									}
								}
								
								safeSend(JSON.stringify({ type: "end" }));
							} catch (fetchError) {
								safeSend(JSON.stringify({ 
									type: "error", 
									message: `Backend fetch failed: ${fetchError.message}` 
								}));
								safeSend(JSON.stringify({ type: "end" }));
							}
						}
					} catch (e) {
						safeSend(JSON.stringify({ type: "error", message: `Worker error: ${e.message}` }));
						safeSend(JSON.stringify({ type: "end" }));
					}
				}
			});

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

		// --------------------------------------------------------
		// Phase 2: Native Stateless WebSocket Proxy
		// --------------------------------------------------------
		if (url.pathname.startsWith("/proxy-ws/")) {
			const targetUrlParam = url.searchParams.get("target");
			if (!targetUrlParam) return new Response("Missing Target", { status: 400 });
			
			let targetUrl = decodeURIComponent(targetUrlParam);

			targetUrl = targetUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
			const requestedProtocols = request.headers.get("Sec-WebSocket-Protocol");
			
			const proxyHeaders = new Headers();
			proxyHeaders.set("Upgrade", "websocket");
			if (requestedProtocols) {
				proxyHeaders.set("Sec-WebSocket-Protocol", requestedProtocols);
			}
			
			try { 
				proxyHeaders.set("Origin", new URL(targetUrl).origin); 
			} catch(e) {}
			
			proxyHeaders.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0");

			let targetResponse;
			try {
				targetResponse = await fetch(targetUrl, { headers: proxyHeaders });
			} catch (fetchErr) {
				return new Response(`WebSocket upstream fetch failed: ${fetchErr.message}`, { status: 502 });
			}

			if (targetResponse.status !== 101 || !targetResponse.webSocket) {
				if (targetResponse.body) {
					try { await targetResponse.body.cancel(); } catch (e) {}
				}
				return new Response("Backend refused connection", { status: 502 });
			}
			
			const targetSocket = targetResponse.webSocket;
			const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
			serverSocket.accept();
			targetSocket.accept();
			
			serverSocket.addEventListener("message", event => {
				try { targetSocket.send(event.data); } catch (e) {}
			});
			
			targetSocket.addEventListener("message", event => {
				try { serverSocket.send(event.data); } catch (e) {}
			});

			const closeBoth = () => {
				try { serverSocket.close(); } catch(e){}
				try { targetSocket.close(); } catch(e){}
			};
			
			serverSocket.addEventListener("close", closeBoth);
			targetSocket.addEventListener("close", closeBoth);
			serverSocket.addEventListener("error", closeBoth);
			targetSocket.addEventListener("error", closeBoth);

			const responseHeaders = new Headers();
			const acceptedProtocol = targetResponse.headers.get("Sec-WebSocket-Protocol");
			if (acceptedProtocol) {
				responseHeaders.set("Sec-WebSocket-Protocol", acceptedProtocol);
			}

			return new Response(null, {
				status: 101,
				webSocket: clientSocket,
				headers: responseHeaders
			});
		}

		return new Response("Not Found", { status: 404 });
	},
};
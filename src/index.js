/**
 * @typedef {Object} Env
 */

import { Buffer } from "node:buffer";
import indexHtml from "./index.html";
import swJs from "./sw.js";

// =========================================================
// 1. HTML Rewriter Classes
// =========================================================

class AttributeRewriter {
	constructor(attributeName, baseUrl) {
		this.attributeName = attributeName;
		this.baseUrl = baseUrl;
	}
	element(element) {
		const attribute = element.getAttribute(this.attributeName);
		if (attribute && !attribute.startsWith('data:') && !attribute.startsWith('#')) {
			try {
				const absoluteUrl = new URL(attribute, this.baseUrl).toString();
				element.setAttribute(this.attributeName, "/service/" + encodeURIComponent(absoluteUrl));
			} catch (e) {}
		}
	}
}

class SrcsetRewriter {
	constructor(baseUrl) {
		this.baseUrl = baseUrl;
	}
	element(element) {
		const srcset = element.getAttribute('srcset');
		if (srcset) {
			try {
				const parts = srcset.split(',').map(part => {
					const [url, size] = part.trim().split(/\s+/);
					if (!url || url.startsWith('data:')) return part;
					const absoluteUrl = new URL(url, this.baseUrl).toString();
					const proxiedUrl = "/service/" + encodeURIComponent(absoluteUrl);
					return size ? `${proxiedUrl} ${size}` : proxiedUrl;
				});
				element.setAttribute('srcset', parts.join(', '));
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

class ScriptInjector {
	constructor(baseUrl) {
		this.baseUrl = baseUrl;
	}
	element(element) {
		const configObj = {
			targetDomain: new URL(this.baseUrl).hostname,
			targetBase: this.baseUrl,
			targetOrigin: new URL(this.baseUrl).origin
		};

		const script = `
		<script src="https://cdn.jsdelivr.net/npm/eruda/eruda.min.js"></script>
		<script>
			// FIX: Wait for Eruda to download before initializing, preventing ReferenceErrors
			let eTimer = setInterval(() => {
				if (window.eruda) {
					clearInterval(eTimer);
					eruda.init(); 
					console.log("[V2 Proxy] Eruda Initialized for: ${this.baseUrl}");
				}
			}, 50);

			(function() {
				const config = ${JSON.stringify(configObj)};
				const prefix = config.targetDomain + ":";
				const PROXY_BASE = window.location.origin + '/service/';
				const TARGET_BASE = config.targetBase;
				const TARGET_ORIGIN = config.targetOrigin;

				function resolveUrl(url) {
					if (!url || typeof url !== 'string') return url;
					if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(PROXY_BASE)) return url;
					if (url.startsWith('/service/')) return url;
					
					// 🩹 CLIENT-SIDE GLUED URL RESCUE
					// If Wikipedia's JS accidentally prepended its own domain to our proxy path
					const marker = '/service/';
					const idx = url.indexOf(marker);
					if (idx !== -1) {
						try {
							const extracted = decodeURIComponent(url.substring(idx + marker.length));
							if (extracted.startsWith('http')) {
								return PROXY_BASE + encodeURIComponent(extracted);
							}
						} catch(e) {}
					}
					
					let finalUrl = url;
					if (url.startsWith('//')) finalUrl = window.location.protocol + url;

					try {
						const absolute = new URL(finalUrl, TARGET_BASE).toString();
						return PROXY_BASE + encodeURIComponent(absolute);
					} catch (e) {
						return url;
					}
				}

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

				try { Object.defineProperty(window, 'top', { value: window.self }); } catch(e) {}
				try { Object.defineProperty(window, 'parent', { value: window.self }); } catch(e) {}

				const orgSetAttribute = Element.prototype.setAttribute;
				Element.prototype.setAttribute = function(name, value) {
					if (['src', 'href', 'action'].includes(name.toLowerCase())) {
						value = resolveUrl(value);
					}
					return orgSetAttribute.apply(this, [name, value]);
				};

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
				
				// CRITICAL FIX: Catches Webpack/Vite dynamic CSS and Iframe chunks
				if (window.HTMLLinkElement) hookProp(HTMLLinkElement.prototype, 'href');
				if (window.HTMLIFrameElement) hookProp(HTMLIFrameElement.prototype, 'src');
				if (window.HTMLSourceElement) hookProp(HTMLSourceElement.prototype, 'src');

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

				const oldPushState = window.history.pushState;
				window.history.pushState = function(state, title, url) {
					return oldPushState.apply(window.history, [state, title, resolveUrl(url)]);
				};
				const oldReplaceState = window.history.replaceState;
				window.history.replaceState = function(state, title, url) {
					return oldReplaceState.apply(window.history, [state, title, resolveUrl(url)]);
				};

				try { Object.defineProperty(window, '__proxyLocation', { value: new URL(TARGET_BASE) }); } catch(e) {}
			})();
		</script>`;
		
		element.prepend(script, { html: true });
	}
}

// =========================================================
// 2. The Cloudflare Worker Router
// =========================================================

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === "/sw.js") {
			return new Response(swJs, {
				headers: { "content-type": "application/javascript", "cache-control": "no-store" },
			});
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			return new Response(indexHtml, {
				headers: { 
					"content-type": "text/html",
					"cache-control": "no-store, no-cache, must-revalidate",
				},
			});
		}

		if (url.pathname === "/ws/") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket", { status: 426 });
			}

			const { 0: client, 1: server } = new WebSocketPair();
			server.accept();

			const safeSend = (data) => {
				if (server.readyState === 1) {
					try { server.send(data); } catch (e) {}
				}
			};

			// 🛡️ THE PAYLOAD SLICER: Prevents Cloudflare from crashing the WS on large assets
			const sendChunked = (data) => {
				if (server.readyState !== 1) return;
				const CHUNK_SIZE = 64 * 1024; // 64KB safe slices
				
				if (data.byteLength > CHUNK_SIZE) {
					for (let i = 0; i < data.byteLength; i += CHUNK_SIZE) {
						if (server.readyState !== 1) break;
						try {
							// Subarray is zero-copy and highly performant
							server.send(data.subarray(i, i + CHUNK_SIZE)); 
						} catch(e) {}
					}
				} else {
					try { server.send(data); } catch(e) {}
				}
			};

			server.addEventListener("message", async (event) => {
				if (typeof event.data !== "string") return;

				try {
					const msg = JSON.parse(event.data);
					
					if (msg.type === "request") {
						const targetUrl = msg.url;
						const targetUrlObj = new URL(targetUrl);
						
						safeSend(JSON.stringify({ type: "info", message: `V2 Fetching: ${targetUrl}` }));

						const proxyHeaders = new Headers(msg.headers);
											
						proxyHeaders.delete("accept-encoding"); 
						proxyHeaders.delete("if-none-match");
						proxyHeaders.delete("if-modified-since");
											
						proxyHeaders.set("Host", targetUrlObj.host);
						proxyHeaders.set("Referer", targetUrlObj.origin + "/");
						proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
											
						if (msg.method.toUpperCase() !== "GET" && msg.method.toUpperCase() !== "HEAD") {
							proxyHeaders.set("Origin", targetUrlObj.origin);
						} else {
							proxyHeaders.delete("Origin");
						}

						const fetchOptions = {
							method: msg.method,
							headers: proxyHeaders,
							redirect: "manual"
						};

						if (msg.body) {
							fetchOptions.body = Buffer.from(msg.body, "base64");
						}

						if (msg.method.toUpperCase() === "OPTIONS") {
							safeSend(JSON.stringify({
								type: "response",
								status: 200,
								headers: {
									"Access-Control-Allow-Origin": "*",
									"Access-Control-Allow-Methods": "*",
									"Access-Control-Allow-Headers": "*"
								},
								setCookies: [],
								targetDomain: targetUrlObj.hostname
							}));
							safeSend(JSON.stringify({ type: "end" }));
							return;
						}

						const res = await fetch(new Request(targetUrl, fetchOptions));

						const headersOut = {};
						let contentType = "";
						const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];

						res.headers.forEach((value, key) => {
							const lowerKey = key.toLowerCase();
							if (lowerKey === "content-type") contentType = value;
							
							if (lowerKey === "location") {
								try {
        							// Just resolve the absolute path. The Service Worker will wrap it!
        							headersOut[key] = new URL(value, targetUrl).toString();
    							} catch (e) {
        							headersOut[key] = value;
    							}
							} else if (!["content-encoding", "transfer-encoding", "x-frame-options", "content-security-policy", "set-cookie", "access-control-allow-origin"].includes(lowerKey)) {
								headersOut[key] = value;
							}
						});

						if (contentType.includes("text/html")) {
							delete headersOut["content-length"];
						}
						
						headersOut["Access-Control-Allow-Origin"] = "*";
						headersOut["Access-Control-Allow-Methods"] = "*";
						headersOut["Access-Control-Allow-Headers"] = "*";

						safeSend(JSON.stringify({
							type: "response",
							status: res.status,
							headers: headersOut,
							setCookies: setCookies,
							targetDomain: targetUrlObj.hostname
						}));

						// --- 4. Stream & Rewrite the Body (With Safe Chunking) ---
						if (contentType.includes("text/html")) {
							const rewriter = new HTMLRewriter()
								.on("head", new ScriptInjector(targetUrl))
								.on("a", new AttributeRewriter("href", targetUrl))
								.on("img", new AttributeRewriter("src", targetUrl))
								.on("link", new AttributeRewriter("href", targetUrl))
								.on("form", new AttributeRewriter("action", targetUrl))
								.on("script", new AttributeRewriter("src", targetUrl))
								// ADDED: Catch iframe and source tags
								.on("iframe", new AttributeRewriter("src", targetUrl))
								.on("source", new AttributeRewriter("src", targetUrl)) 
								.on("img, source", new SrcsetRewriter(targetUrl))
								.on("script, link", new SecurityStripper());

							const rewrittenRes = rewriter.transform(res);
							
							if (rewrittenRes.body) {
								const reader = rewrittenRes.body.getReader();
								try {
									while (true) {
										if (server.readyState !== 1) break;
										const { done, value } = await reader.read();
										if (done) break;
										sendChunked(value); // Safe Slicer
									}
								} finally {
									reader.releaseLock();
								}
							}
						} else if (res.body) {
							const reader = res.body.getReader();
							try {
								while (true) {
									if (server.readyState !== 1) break;
									const { done, value } = await reader.read();
									if (done) break;
									sendChunked(value); // Safe Slicer
								}
							} finally {
								reader.releaseLock();
							}
						}

						safeSend(JSON.stringify({ type: "end" }));
					}
				} catch (e) {
					safeSend(JSON.stringify({ type: "error", message: `V2 Fetch Error: ${e.message}` }));
					safeSend(JSON.stringify({ type: "end" }));
				}
			});

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

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
			
			try { proxyHeaders.set("Origin", new URL(targetUrl).origin); } catch(e) {}
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

		return new Response("V2: 404 Not Found", { status: 404 });
	},
};
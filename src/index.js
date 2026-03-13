/**
 * @typedef {Object} Env
 */

import { DurableObject } from "cloudflare:workers";

import indexHtml from "./index.html";
import swJs from "./sw.js";

// --------------------------------------------------------
// The Cloudflare Worker Backend
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

			// A helper to ensure we never write to a dead socket
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

							const fetchOptions = {
								method: msg.method,
								headers: proxyHeaders,
								redirect: "manual"
							};

							if (msg.body) {
								const binaryString = atob(msg.body);
								const bytes = new Uint8Array(binaryString.length);
								for (let i = 0; i < binaryString.length; i++) {
									bytes[i] = binaryString.charCodeAt(i);
								}
								fetchOptions.body = bytes;
							}

							// 1. Short-circuit CORS preflight requests (OPTIONS)
							if (msg.method.toUpperCase() === "OPTIONS") {
								safeSend(JSON.stringify({ type: "info", message: `Auto-answering CORS preflight for: ${msg.url}` }));
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
								safeSend(JSON.stringify({ type: "info", message: `Executing fetch()` }));
								const res = await fetch(targetRequest);

								safeSend(JSON.stringify({ type: "info", message: `Fetch complete. Status: ${res.status}` }));

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
									} else if (!["content-length", "content-encoding", "transfer-encoding", "x-frame-options", "content-security-policy", "set-cookie", "access-control-allow-origin"].includes(lowerKey)) {
										headersOut[key] = value;
									}
								});

								// 2. Inject permissive CORS headers into all real responses
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

									class ScriptInjector {
										element(element) {
											const script = `
											<script>
												(function() {
													// 1. Advanced Storage Spoofing
													const prefix = "${targetDomain}:";
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

													// 2. Fix Keyboard Focus / Event Listener Crashes
													try { Object.defineProperty(window, 'top', { value: window.self }); } catch(e) {}
													try { Object.defineProperty(window, 'parent', { value: window.self }); } catch(e) {}
													
													// 3. WebSocket Interceptor
													const OriginalWebSocket = window.WebSocket;
													window.WebSocket = function(url, protocols) {
														if (typeof url === 'string' && url.includes('/ws/')) {
															return new OriginalWebSocket(url, protocols);
														}
														
														console.log('[Interceptor] Hijacking WebSocket to:', url);
														const targetUrl = encodeURIComponent(url);
														const proxyUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/durable-ws/?target=' + targetUrl;
														
														return protocols ? new OriginalWebSocket(proxyUrl, protocols) : new OriginalWebSocket(proxyUrl);
													};
													
													window.WebSocket.prototype = OriginalWebSocket.prototype;
													Object.assign(window.WebSocket, OriginalWebSocket);
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

									// NEW: Strip security hashes so the browser accepts our proxied files
									class SecurityStripper {
										element(element) {
											element.removeAttribute("integrity");
											element.removeAttribute("nonce");
										}
									}

									streamResponse = new HTMLRewriter()
										.on("head", new ScriptInjector())
										.on("a", new AttributeRewriter("href"))
										.on("img", new AttributeRewriter("src"))
										.on("link", new AttributeRewriter("href"))
										.on("form", new AttributeRewriter("action"))
										.on("script", new AttributeRewriter("src")) // Catch JS files!
										.on("script, link", new SecurityStripper()) // Strip integrity hashes
										.transform(res);
								}

								if (streamResponse.body) {
									const reader = streamResponse.body.getReader();
									while (true) {
										const { done, value } = await reader.read();
										if (done) break;
										safeSend(value); 
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
		// Phase 3: Route to Durable Object WebSocket Proxy
		// --------------------------------------------------------
		if (url.pathname.startsWith("/durable-ws/")) {
			const id = env.WSPROXY.idFromName("global-game-router");
			const stub = env.WSPROXY.get(id);
			return stub.fetch(request);
		}

		return new Response("Not Found", { status: 404 });
	},
};

// --------------------------------------------------------
// Persistent WebSocket Router (Durable Object)
// --------------------------------------------------------
export class WebSocketProxy extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
	}

	async fetch(request) {
		const url = new URL(request.url);
		const targetUrlParam = url.searchParams.get("target");
		if (!targetUrlParam) return new Response("Missing Target", { status: 400 });
		
		const targetUrl = decodeURIComponent(targetUrlParam);
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

		const targetResponse = await fetch(targetUrl, { headers: proxyHeaders });

		if (targetResponse.status !== 101 || !targetResponse.webSocket) {
			return new Response("Backend refused connection", { status: 502 });
		}
		
		const targetSocket = targetResponse.webSocket;
		const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
		serverSocket.accept();
		targetSocket.accept();

		serverSocket.addEventListener("message", event => targetSocket.send(event.data));
		targetSocket.addEventListener("message", event => serverSocket.send(event.data));

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
}
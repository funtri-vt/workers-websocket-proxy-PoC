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
				headers: { "content-type": "text/html" },
			});
		}

		// --------------------------------------------------------
		// Phase 1: Service Worker to Backend Bridge
		// --------------------------------------------------------
		if (url.pathname === "/ws/") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket", { status: 426 });
			}

			// Token-based Security Lock-down
			const clientToken = url.searchParams.get("token");
			const EXPECTED_TOKEN = env.PROXY_PASSWORD; 

			if (!EXPECTED_TOKEN || clientToken !== EXPECTED_TOKEN) {
				console.warn(`[Security] WebSocket rejected. Token mismatch or missing secret.`);
				
				// Trick the browser: Accept the WS just long enough to send the exact error text!
				const { 0: client, 1: server } = new WebSocketPair();
				server.accept();
				
				const errorMsg = !EXPECTED_TOKEN 
					? "Cloudflare Error: PROXY_PASSWORD secret was not set via Wrangler." 
					: `Access Denied: Client sent "${clientToken}", but Server expected "${EXPECTED_TOKEN}".`;;
					
				server.send(JSON.stringify({ type: "error", message: errorMsg }));
				server.close(1008, "Security Violation");
				
				return new Response(null, { status: 101, webSocket: client });
			}

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
													
													// 3. Stateless WebSocket Interceptor
													const OriginalWebSocket = window.WebSocket;
													window.WebSocket = function(url, protocols) {
														if (typeof url === 'string' && url.includes('/ws/')) {
															return new OriginalWebSocket(url, protocols);
														}
														
														const targetUrl = encodeURIComponent(url);
														// UPDATED: Now points to the native Worker proxy route
														const proxyUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/proxy-ws/?target=' + targetUrl;
														
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

									class SecurityStripper {
										element(element) {
											element.removeAttribute("integrity");
											element.removeAttribute("nonce");
										}
									}

									// 1. Buffer the raw HTML into memory to prevent stream deadlocks
									const rawHtml = await res.text();
									const dummyRes = new Response(rawHtml, { headers: res.headers });

									// 2. Pass it through HTMLRewriter
									const rewrittenRes = new HTMLRewriter()
										.on("head", new ScriptInjector())
										.on("a", new AttributeRewriter("href"))
										.on("img", new AttributeRewriter("src"))
										.on("link", new AttributeRewriter("href"))
										.on("form", new AttributeRewriter("action"))
										.on("script", new AttributeRewriter("src"))
										.on("script, link", new SecurityStripper()) 
										.transform(dummyRes);

									// 3. Extract finalized text, encode to BINARY, and send safely
									const finalHtml = await rewrittenRes.text();
									const binaryHtml = new TextEncoder().encode(finalHtml);
									safeSend(binaryHtml);

								} else if (res.body) {
									// Reverted to original max-speed pump. 
									// Backpressure artificially kills large game assets in Workers!
									const reader = res.body.getReader();
									try {
										while (true) {
											// 1. Check if client disconnected
											if (server.readyState !== 1) {
												try { await reader.cancel("Client disconnected"); } catch(e) {}
												break;
											}

											// 2. Read next chunk
											const { done, value } = await reader.read();
											if (done) break;

											// 3. Send over WS immediately
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
				// If the target server drops the connection, catch the error and return a safe 502 Bad Gateway
				return new Response(`WebSocket upstream fetch failed: ${fetchErr.message}`, { status: 502 });
			}

			if (targetResponse.status !== 101 || !targetResponse.webSocket) {
				// FIX: Cancel the unread body to prevent the Worker from hanging!
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
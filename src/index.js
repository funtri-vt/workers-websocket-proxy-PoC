/**
 * @typedef {Object} Env
 */

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

			// NEW: A helper to ensure we never write to a dead socket
			const safeSend = (data) => {
				// readyState 1 means OPEN
				if (server.readyState === 1) {
					try {
						server.send(data);
					} catch (e) {
						// Socket closed mid-send, swallow the error
					}
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

							const targetRequest = new Request(msg.url, fetchOptions);

							try {
								safeSend(JSON.stringify({ type: "info", message: `Executing fetch()` }));
								const res = await fetch(targetRequest);

								safeSend(JSON.stringify({ type: "info", message: `Fetch complete. Status: ${res.status}` }));

								const headersOut = {};
								res.headers.forEach((value, key) => {
									const lowerKey = key.toLowerCase();
									if (!["content-encoding", "transfer-encoding", "x-frame-options", "content-security-policy"].includes(lowerKey)) {
										headersOut[key] = value;
									}
								});

								safeSend(JSON.stringify({
									type: "response",
									status: res.status,
									headers: headersOut
								}));

								if (res.body) {
									const reader = res.body.getReader();
									while (true) {
										const { done, value } = await reader.read();
										if (done) break;
										// If the socket dies during the stream, safeSend prevents a crash
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

		return new Response("Not Found", { status: 404 });
	},
};
/**
 * @typedef {Object} Env
 */

// --------------------------------------------------------
// 1. The Main User Interface (index.html)
// --------------------------------------------------------
// Import the files as raw text strings!
import indexHtml from "./index.html";

// --------------------------------------------------------
// 2. The Service Worker Script (sw.js)
// --------------------------------------------------------
import swJs from "./sw.js";


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
                            server.send(JSON.stringify({ type: "info", message: `Preparing fetch for: ${msg.url}` }));

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

                                server.send(JSON.stringify({ type: "info", message: `Fetch complete. Status: ${res.status}` }));

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
									message: `Backend fetch failed: ${fetchError.message}` 
								}));
								server.send(JSON.stringify({ type: "end" }));
							}
						}
					} catch (e) {
						server.send(JSON.stringify({ type: "error", message: `Worker error: ${e.message}` }));
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

/**
 * @typedef {Object} Env
 */

import { Buffer } from "node:buffer";
import indexHtml from "./index.html";
import swJs from "./sw.js";

// =========================================================
// 1. HTML Rewriter Classes (The Heavy Lifters)
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

// NEW: Specifically handles responsive images (Fixes the Wikipedia globe)
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
		// We will put our new, cleaner SPA-taming script here later.
		// For now, just a placeholder to keep the skeleton clean.
		element.prepend(`<script>/* V2 Client Injector Placeholder */</script>`, { html: true });
	}
}

// =========================================================
// 2. The Cloudflare Worker Router
// =========================================================

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// --- Route A: Static Assets (UI & SW) ---
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

		// --- Route B: The Core Proxy Engine (WebSocket Bridge) ---
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

			server.addEventListener("message", async (event) => {
				if (typeof event.data !== "string") return;

				try {
					const msg = JSON.parse(event.data);
					
					if (msg.type === "request") {
						const targetUrl = msg.url;
						const targetUrlObj = new URL(targetUrl);
						
						safeSend(JSON.stringify({ type: "info", message: `V2 Fetching: ${targetUrl}` }));

						// --- 1. Sanitize Incoming Headers ---
						const proxyHeaders = new Headers(msg.headers);
						// Force uncompressed text so HTMLRewriter can read it natively
						proxyHeaders.delete("accept-encoding"); 
						proxyHeaders.set("Host", targetUrlObj.host);
						proxyHeaders.set("Origin", targetUrlObj.origin);
						proxyHeaders.set("Referer", targetUrlObj.origin + "/");
						proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

						const fetchOptions = {
							method: msg.method,
							headers: proxyHeaders,
							redirect: "manual" // We must catch and rewrite redirects manually
						};

						if (msg.body) {
							fetchOptions.body = Buffer.from(msg.body, "base64");
						}

						// Handle Preflight OPTIONS instantly
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

						// --- 2. Perform the Target Fetch ---
						const res = await fetch(new Request(targetUrl, fetchOptions));

						// --- 3. Sanitize Outgoing Headers ---
						const headersOut = {};
						let contentType = "";
						const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];

						res.headers.forEach((value, key) => {
							const lowerKey = key.toLowerCase();
							if (lowerKey === "content-type") contentType = value;
							
							if (lowerKey === "location") {
								// Rewrite Redirects (e.g., http://site.com -> https://site.com)
								try {
									const absoluteLocation = new URL(value, targetUrl).toString();
									headersOut[key] = "/service/" + encodeURIComponent(absoluteLocation);
								} catch (e) {
									headersOut[key] = value;
								}
							} else if (!["content-encoding", "transfer-encoding", "x-frame-options", "content-security-policy", "set-cookie"].includes(lowerKey)) {
								// Strip security and encoding headers
								headersOut[key] = value;
							}
						});

						// If HTML, we stream dynamically, so drop the fixed content-length
						if (contentType.includes("text/html")) {
							delete headersOut["content-length"];
						}
						
						headersOut["Access-Control-Allow-Origin"] = "*";

						safeSend(JSON.stringify({
							type: "response",
							status: res.status,
							headers: headersOut,
							setCookies: setCookies,
							targetDomain: targetUrlObj.hostname
						}));

						// --- 4. Stream & Rewrite the Body ---
						if (contentType.includes("text/html")) {
							// Pipeline HTML through our modular rewriters
							const rewriter = new HTMLRewriter()
								.on("head", new ScriptInjector(targetUrl))
								.on("a", new AttributeRewriter("href", targetUrl))
								.on("img", new AttributeRewriter("src", targetUrl))
								.on("link", new AttributeRewriter("href", targetUrl))
								.on("form", new AttributeRewriter("action", targetUrl))
								.on("script", new AttributeRewriter("src", targetUrl))
								.on("img, source", new SrcsetRewriter(targetUrl)) // Fixes the Wikipedia Globe
								.on("script, link", new SecurityStripper());

							const rewrittenRes = rewriter.transform(res);
							
							if (rewrittenRes.body) {
								const reader = rewrittenRes.body.getReader();
								try {
									while (true) {
										if (server.readyState !== 1) break; // Drop if client disconnects
										const { done, value } = await reader.read();
										if (done) break;
										safeSend(value);
									}
								} finally {
									reader.releaseLock();
								}
							}
						} else if (res.body) {
							// Pass-through non-HTML assets (images, JS, CSS) directly
							const reader = res.body.getReader();
							try {
								while (true) {
									if (server.readyState !== 1) break;
									const { done, value } = await reader.read();
									if (done) break;
									safeSend(value);
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

		// --- Route C: Native WebSocket Proxy ---
		if (url.pathname.startsWith("/proxy-ws/")) {
			// Placeholder for the target WebSocket passthrough
			return new Response("V2 Native WS Proxy Ready", { status: 200 });
		}

		// --- Route D: The Catch-All ---
		return new Response("V2: 404 Not Found", { status: 404 });
	},
};
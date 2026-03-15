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

			server.addEventListener("message", async (event) => {
				// This is where we will put our streamlined fetch() and 
				// HTMLRewriter stream logic in the next step.
				if (typeof event.data === "string") {
					try {
						const msg = JSON.parse(event.data);
						if (msg.type === "request") {
							// Placeholder for the V2 backend fetch engine
							server.send(JSON.stringify({ type: "info", message: "V2 Engine Ready" }));
						}
					} catch (e) {
						server.send(JSON.stringify({ type: "error", message: `V2 Routing Error: ${e.message}` }));
					}
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
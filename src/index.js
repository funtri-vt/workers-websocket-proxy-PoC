import { Buffer } from "node:buffer";
import indexHtml from "./index.html";
import swJs from "./sw.js";

// =========================================================
// 1. V3 HTML Rewriter Classes
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
				// V3 ARCHITECTURE: Only resolve absolute URLs here. 
				// The Service Worker or client script will handle the proxy prefix.
				const absoluteUrl = new URL(attribute, this.baseUrl).toString();
				element.setAttribute(this.attributeName, absoluteUrl);
			} catch (e) {}
		}
	}
}

class ScriptInjector {
	constructor(baseUrl) {
		this.baseUrl = baseUrl;
	}
	element(element) {
		// V3 ARCHITECTURE: Placeholder for our bulletproof DOM hook script.
		// We will build this out cleanly once the backend routing is solid.
		const script = `
		<script>
			window.__V3_TARGET_BASE = "${this.baseUrl}";
			console.log("[V3 Proxy] Foundation initialized for: " + window.__V3_TARGET_BASE);
		</script>`;
		
		element.prepend(script, { html: true });
	}
}

// =========================================================
// 2. V3 Cloudflare Worker Router
// =========================================================

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// --- Static Asset Routing ---
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

		// --- V3 Core Proxy WebSocket ---
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

			// 🛡️ V3 ARCHITECTURE: Async Slicer with Backpressure Yielding
			const sendChunked = async (data) => {
				if (server.readyState !== 1) return;
				const CHUNK_SIZE = 32 * 1024; // Safe 32KB slices
				
				if (data.byteLength > CHUNK_SIZE) {
					for (let i = 0; i < data.byteLength; i += CHUNK_SIZE) {
						if (server.readyState !== 1) break;
						try {
							server.send(data.subarray(i, i + CHUNK_SIZE)); 
							await new Promise(resolve => setTimeout(resolve, 2)); // Let CF buffer drain
						} catch(e) {}
					}
				} else {
					try { 
						server.send(data); 
						await new Promise(resolve => setTimeout(resolve, 1));
					} catch(e) {}
				}
			};

			server.addEventListener("message", async (event) => {
				if (typeof event.data !== "string") return;

				try {
					const msg = JSON.parse(event.data);
					
					if (msg.type === "request") {
						const targetUrl = msg.url;
						const targetUrlObj = new URL(targetUrl);
						
						safeSend(JSON.stringify({ type: "info", message: `V3 Fetching: ${targetUrl}` }));

						// --- TODO: V3 Header Sanitization & Fetch ---
						// We will drop our streamlined proxy fetch and header parsing logic here
						
						safeSend(JSON.stringify({ type: "end" }));
					}
				} catch (e) {
					safeSend(JSON.stringify({ type: "error", message: `V3 Fatal Error: ${e.message}` }));
					safeSend(JSON.stringify({ type: "end" }));
				}
			});

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

		// --- Websocket Proxying ---
		if (url.pathname.startsWith("/proxy-ws/")) {
			// TODO: Add back if needed
		}

		return new Response("V3: 404 Not Found", { status: 404 });
	},
};
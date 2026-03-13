# Proxy Frontend Architecture (`index.html`)

## Overview
This file serves as the main user interface and the "host" environment for the proxy. It provides the navigation bar, registers the Service Worker, manages the central logging system, and isolates the proxied content inside a full-page iframe.

---

## 1. The UI & Iframe Sandbox
The layout is a simple flexbox design splitting the screen between a top control bar and a maximized iframe (`#frame`).

### Game-Ready Iframe Attributes
The iframe includes specific attributes to ensure web-based games (like Eaglercraft) function correctly:
* **`allow="pointer-lock; keyboard-map;"`**: Crucial for First-Person Shooters or 3D games. It allows the game to hide the mouse cursor and capture raw keyboard inputs without the browser interfering.
* **`tabindex="0"`**: Ensures the iframe can receive direct keyboard focus immediately upon clicking.

---

## 2. Navigation & Routing (`loadUrl`)
When the user clicks "Go", the `loadUrl()` function fires. 
1. It grabs the user's input (e.g., `wikipedia.org`).
2. It fully URL-encodes the input.
3. It prepends the `/service/` prefix to trigger the Cloudflare Worker's routing logic.
4. It sets the iframe's `src` attribute, kicking off the interception chain.

---

## 3. The Central Logging Engine
Because the Service Worker runs in a separate background thread, its console logs are usually hidden from the main page. This file bridges that gap to make debugging possible.

### Capturing Logs
* **Service Worker Bridge**: Listens for the `message` event. When the SW broadcasts a log (using the custom `sw-log` type), the frontend catches it and appends it to a global `window.appLogs` array.
* **Console Hijacker**: Monkey-patches the native `console.log` function. It passes the original log through to the browser console but also stringifies the output and saves it to `window.appLogs`.

### Exporting Logs
The **Download Debug Logs** button takes the entire `window.appLogs` array, formats it with timestamps, and converts it into a raw text `Blob`. It then creates a temporary, invisible `<a>` tag to force the browser to download the file (`proxy-logs-[timestamp].txt`) to the user's local machine.

---

## 4. Service Worker Initialization
Checks if the browser supports Service Workers (`'serviceWorker' in navigator`) and registers `/sw.js` with the maximum scope (`'/'`). This guarantees that as soon as the iframe makes a request, the SW is already active and listening.

---

## 5. Eruda DevTools Integration
A conditional injector for [Eruda](https://github.com/liriliri/eruda), a console designed for mobile browsers or locked-down environments. 
* If the URL contains `?eruda=true` or if `active-eruda` is set in `localStorage`, it dynamically injects the script into the page. This provides an on-screen DOM inspector, network tab, and console without needing to open the browser's native developer tools.
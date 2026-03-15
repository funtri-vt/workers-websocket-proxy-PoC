# Serverless WebSocket Proxy (Proof of Concept)

## Overview
This project is an advanced, serverless web proxy built entirely on Cloudflare Workers. It is designed to bypass strict network filters by intercepting web traffic client-side and tunneling it through custom WebSocket streams. 

Unlike traditional HTTP proxies, this architecture relies on a Service Worker to hijack native browser requests and a Cloudflare Durable Object to maintain persistent, long-lived TCP connections for multiplayer browser games (like Eaglercraft).

## WARNING: DO <u>NOT</u> RELY ON THIS PROJECT OR USE IT IN PRODUCTION. THIS IS A PoC!!!!!!!!!!!


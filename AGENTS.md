# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. It records the architectural decisions made so far for a **browser-based, full-3D virtual tabletop (VTT)**, along with the reasoning behind them, so later work stays consistent with them.

> Status: **pre-implementation.** The decisions below are settled; anything under "Open questions" is not. Don't treat open items as decided. Ask, or propose options.

---

## 1. Project goals

- A virtual tabletop that runs **in full 3D in the browser**.
- **Performs well on a wide range of devices**, including phones, tablets, and older or low-end laptops, not just gaming PCs.
- Lightweight: small download, fast first load, low battery and memory use.
- Built "close to the metal": we write our own systems instead of adopting a game engine's framework.
- Expected scale: up to **hundreds of concurrent active sessions** (a few players each).

---

## 2. Decision: Graphics, Three.js

**Chosen:** [Three.js](https://threejs.org/) (MIT license) as the rendering library.

### Why Three.js
- It is a **rendering library, not a game engine**: a scene graph, materials, loaders, and renderers, with very little else. That fits the "close to the metal, no engine-level features" goal.
- Small bundle footprint compared with full engines.
- Gives direct access to the lower layers: custom shaders, `BufferGeometry`, instancing, and the newer **WebGPURenderer** with TSL (Three Shading Language, its node-based shading system).
- Largest ecosystem of examples, add-ons, and community knowledge.
- Gives us the **WebGPU-with-WebGL2-fallback** path without building it ourselves.

### Alternatives considered and rejected
| Option | Why not |
|---|---|
| **Babylon.js** (Apache 2.0) | Closer to a game engine (built-in physics, GUI, inspector, input). Excellent backward compatibility and TypeScript-native, but much of it would go unused, and the footprint is larger. |
| **PlayCanvas** | The engine is open source (MIT), but it's designed as a full engine and centers on a hosted editor (the paid part). Not "close to the metal." |
| **Unity web export** | Large downloads and extra memory overhead that cause trouble in mobile browsers. WebGPU is officially supported as of Unity 6.6, but WebGL 2 remains the default. |
| **Godot web export** | Web export targets WebGL 2.0 only (Compatibility renderer). Not the forward path. |
| **Raw WebGPU / minimal wrappers (OGL, twgl)** | Even lower level, but we would have to build the WebGL2 fallback and the loaders ourselves. Not worth it for broad device support. |

### Platform context (as of late 2026)
- WebGPU ships by default in Chrome, Edge, Firefox, and Safari (Safari 26+ on macOS, iOS, iPadOS, and visionOS).
- Gaps remain: Firefox on Linux and Android is still rolling out, and older devices lack WebGPU.
- **Therefore: prefer WebGPU, and always keep a WebGL2 fallback.** Test on at least one Chromium browser and one non-Chromium browser (Safari or Firefox), and on a real phone.

### Known cost to manage
- Three.js uses numbered releases (`r1xx`) **without semantic versioning**, and breaking changes are routine.
  - Pin the exact version.
  - Upgrade deliberately, reading the migration notes for every release in between.
  - Keep Three.js usage behind our own thin modules where practical, so API churn stays local.

### Rendering performance rules
A tabletop scene is mostly static. Design for that:
1. **Render on demand, not every frame.** Redraw only when the camera moves, an object changes, or an animation is running. This is the single biggest battery and thermal win on mobile.
2. **Instance repeated objects** (minis, terrain tiles, props) with `InstancedMesh`, to keep draw calls low.
3. **Use compressed assets:** glTF/GLB models with **KTX2/Basis** textures. Mobile GPU memory is usually the first thing to run out.
4. Dispose of geometries, materials, and textures explicitly when they are removed, to avoid GPU memory leaks.
5. Budget for low-end devices first, and treat higher-quality options as optional upgrades.

---

## 3. Decision: Networking, HTTP polling over an event log

**Chosen:** **client-pull HTTP polling** against a server-side **append-only event log**.

### Latency requirement
- The VTT exchanges **the outcomes of player actions** (a token moved, a die rolled, a card revealed), **not per-frame state**.
- **A delay of 1–5 seconds is acceptable.** Real-time (millisecond) sync is explicitly *not* a requirement.

### Core model: append-only event log (the most important design choice)
- Clients **POST actions** to the server.
- The server **validates** each action, assigns it a **per-session, monotonically increasing sequence number**, and appends it to the log.
- Clients **GET "events for session X with seq > N"** on a timer and apply them in order.
- Clients **rebuild table state by replaying events**. Reconnecting or catching up is just "give me everything after N."
- Benefits: undo and history for free, simple recovery after a disconnect, and **the transport can be swapped later without touching game logic.**
- The server is **authoritative** for ordering and validation. Clients must not assume their own actions are applied until the events come back from the log.

### Why polling (over SSE and WebSockets)
At roughly 300 sessions × 5 players ≈ 1,500 clients polling every 2 seconds ≈ **750 req/s**, mostly empty responses served by an indexed query. A modest server handles this easily.

| | Polling (chosen) | SSE (Server-Sent Events) |
|---|---|---|
| Horizontal scaling | **Stateless**: any instance answers any request from the database. Just add instances. | Each connection is tied to one instance. Needs cross-instance fan-out (e.g., Redis pub/sub). |
| Serverless / cheap hosting | **Works well** | Poor fit (connection timeouts, per-duration billing) |
| Cost driver | clients × poll rate (even when idle) | actual events (more efficient when quiet) |
| Update delay | up to one poll interval (within budget) | near-instant |
| Infrastructure friction | none | proxy and load-balancer idle timeouts; HTTP/1.1 limit of 6 connections per domain |

Summary: **polling scales more simply; SSE scales more efficiently.** At hundreds of sessions, simplicity wins. WebSockets were rejected as unnecessary, since we don't need two-way real-time messaging.

### Keeping polling cheap
1. **Adaptive poll interval:** poll faster right after activity, back off when the session is idle, and drop to a very slow rate when the tab is hidden (Page Visibility API).
2. **Cheap "anything new?" check:** keep the latest sequence number per session in a fast cache (e.g., Redis) or use ETags / `If-None-Match`, so empty polls never touch the primary database.
3. **The poll endpoint must be idempotent and cache-friendly.**

### Upgrade path (only if metrics demand it)
- **Long polling:** the server holds the request open (around 20 s) and responds as soon as an event arrives. Same endpoint shape, close to SSE's responsiveness, but gives up some statelessness.
- **SSE:** swap the GET loop for an event stream, and keep POST for actions.
- Either change should affect **only the transport layer**, not game logic, because of the event-log design.

---

## 4. Architectural boundaries (keep these separate)

- **Rendering layer (Three.js):** draws the current table state and knows nothing about networking.
- **State layer:** holds the table state and applies events from the log deterministically. Contains no Three.js or transport code.
- **Transport layer:** polling client and action POSTs. Swappable.
- **Server:** action validation, sequence assignment, event storage, and the poll endpoint.

---

## 5. Open questions (NOT yet decided)

- Language and tooling: TypeScript vs. JavaScript, bundler (e.g., Vite), test framework.
- Server runtime and hosting (Node, Go, serverless, containers/Kubernetes, etc.).
- Datastore for the event log, and the cache for latest sequence numbers.
- Event schema and versioning; whether to take periodic **snapshots** so long sessions don't require full replay.
- Authentication, session/room creation, and roles (GM vs. player permissions, hidden information).
- Asset pipeline: where models and textures are stored and how they're served (CDN), and whether players can upload their own.
- UI approach for non-3D interface elements (HTML overlay vs. in-canvas).
- Starting poll interval values and backoff curve.
- Rule system support: system-agnostic vs. specific game systems.

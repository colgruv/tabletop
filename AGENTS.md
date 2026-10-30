# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. It records the architectural decisions made so far for a **browser-based, full-3D virtual tabletop (VTT)**, along with the reasoning behind them, so later work stays consistent with them.

> Status: **early prototype.** Tokens can be added, dragged, and removed, and dice rolled, all synced through the event log. The decisions below are settled; anything under "Open questions" is not. Don't treat open items as decided. Ask, or propose options.

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

## 5. Decision: Tooling and repo layout

**Chosen:** TypeScript everywhere, npm workspaces, Vite (client), Vitest (tests), Node 24 + [Hono](https://hono.dev/) (server), SQLite via Node's built-in `node:sqlite` (prototype event store), and a plain HTML overlay for non-3D UI.

- **TypeScript:** the event schema is shared by client and server, so type errors appear at compile time instead of as replay bugs.
- **Hono:** small, standards-based (`fetch`-style handlers), and portable to serverless or edge hosting later.
- **`node:sqlite`:** no native build step and no setup. The event log needs only an indexed `(session_id, seq)` lookup. Move to Postgres when we need more than one server instance.
- **HTML overlay:** accessible, cheap on mobile, and keeps the canvas purely 3D.

### Layout
| Folder | Layer | Contents |
|---|---|---|
| `shared/` | State | Event/action types (`events.ts`), the pure reducer (`state.ts`), and action validation (`validate.ts`). No DOM, Three.js, or I/O. |
| `server/` | Server | `store.ts` (SQLite event log, seq assignment), `app.ts` (HTTP routes), `index.ts` (entry point). |
| `client/src/transport/` | Transport | `api.ts` (fetch calls) and `poller.ts` (adaptive polling with ETags). |
| `client/src/render/` | Rendering | All Three.js code. Nothing else imports `three`. |
| `client/src/ui/` | UI | HTML overlay. Reads state, sends actions. |

### Conventions
- **Actions vs. events:** clients send an `Action` (an intent). The server validates it with `validateAction`, which returns an `EventData` (a fact), then adds `seq`, `v` (schema version), `actor`, and `at`. Anything the server must decide (ids, dice results) is created during validation, through the injected `ServerContext`.
- **Adding a new kind of change:** add an `Action` variant and an `EventData` variant in `shared/src/events.ts`, handle it in `validateAction` and `applyEvent`, and add tests. `applyEvent` must stay pure and deterministic.
- **Drag preview:** while a drag is in flight, the renderer shows the token at its *pending* position, but table state only changes when the event comes back from the log.
- **API:** `POST /api/sessions` → `{id}`; `POST /api/auth/guest` → `{userId, token}`; `POST /api/sessions/:id/actions` `{action}` with `Authorization: Bearer <token>` → `{ok, seq}` or `{ok: false, error}` (the event's `actor` is the token's user id); `GET /api/me` → `{userId, claimed, credentials, providers}`; `POST /api/auth/oauth/:provider/start` `{returnTo}` → `{url}`; `GET /api/auth/oauth/:provider/callback` (provider redirect target); `POST /api/auth/login-code` `{code}` → `{userId, token}`; `GET /api/sessions/:id/events?after=N` → `{events, latestSeq}`, with `ETag` = latest seq (sends 304 when unchanged).
- **Single-instance caches:** the server's in-memory latest-seq and state caches are correct only while one instance runs. They stand in for Redis.
- **Starting poll values** are in `client/src/transport/poller.ts` (`POLL`): 1 s after activity, backing off ×1.5 to 5 s, and 30 s when the tab is hidden. Tune these against real metrics.

### Commands
- `npm run dev`: server on :8787 and client on :5173 (Vite proxies `/api`, and listens on the LAN for phone testing).
- `npm test` · `npm run typecheck` · `npm run build`
- `?webgl` in the URL forces the WebGL2 fallback.

### Test deployment (AWS, `infra/`)
For playtesting only, not the production decision. Defined in CDK (`infra/lib/tabletop-stack.ts`), us-east-1:
- **Client:** GitHub Pages, built by `.github/workflows/pages.yml` on every push to `main`. `client/.env.production` holds `VITE_API_URL`.
- **Server:** one `t4g.micro` EC2 instance (Amazon Linux 2023, Node from nodejs.org) running `server/` under systemd, with SQLite at `/var/lib/tabletop/tabletop.db`. Elastic IP; no SSH (use SSM Session Manager). Its security group allows **only CloudFront's origin-facing IPs**.
- **HTTPS:** a CloudFront distribution in front of the instance, with caching disabled so the server's own ETag/304 handling still applies.
- **Safety nets:** a $15/month account-wide budget alert, and daily disk snapshots kept for 7 days.
- **Deploy server code:** push to `main`, then `npm run update-server -w @tabletop/infra` (runs `tabletop-update` over SSM). **Deploy infra:** `npm run deploy -w @tabletop/infra` with `TABLETOP_ALERT_EMAIL` set.
- The AMI is pinned in code (`SERVER_AMI` in `infra/lib/tabletop-stack.ts`), so deploys from any machine match. Changing it **replaces the instance and loses the event log**, unless you restore a snapshot. Run `cdk diff` before every deploy and look for "replace" on the instance. (`cdk.context.json` is gitignored because it contains account and VPC IDs. Its other lookups resolve the same way on any machine.)
- Cost note for the hosting decision: polling is billed per request on API Gateway/Lambda, so ~750 req/s (≈2B requests/month) would cost on the order of $2k/month there, versus a few dollars for an always-on instance.

---

## 6. Decision: Accounts, auth, and game membership

**Chosen:** guest-first accounts with bearer tokens, claimable with Discord or Google OAuth. Games belong to claimed accounts. Players join by invite link and can rejoin later without one.

> Status: **step 1 of the rollout below is done** (guest accounts, bearer tokens, server-set `actor`, `server/src/migrations.ts`). **Step 3 is built for Discord** (`server/src/oauth.ts`, `config.ts`); Google is decided but waiting on a Google OAuth client. Steps 2, 4 and 5 are not implemented. Until step 2, the events route is still open to anyone with the session id, and creating a game does not yet require a claimed account.

- **Guest accounts:** on first visit the server creates a user and returns an opaque token. The client keeps it in `localStorage` and sends `Authorization: Bearer <token>`. Tokens are random and stored **hashed** (not JWTs), so they can be revoked.
- **Bearer tokens, not cookies:** the client (GitHub Pages) and API (CloudFront) are on different origins, so cookies would be third-party and blocked by Safari and others. Bearer tokens also remove CSRF concerns.
- **Claiming:** a user attaches a **Discord or Google** login to their existing user id (same id, so memberships carry over). Both providers are supported. OAuth sign-in on a new browser resolves to the claimed user.
- **Creating a game requires a claimed account**, so a game is never bound to a browser-cached guest. Players may stay guests.
- **Membership:** `memberships(session_id, user_id, role)` with role `gm` or `player`. Events and actions routes require membership. A session id alone no longer grants access.
- **Invites:** the GM creates a link such as `<client>/#/join/<code>`. The code is in the URL fragment, so it never reaches server logs or referrers. Invites **expire after 7 days, have unlimited uses, and can be revoked** by the GM. Accepting is idempotent. Members rejoin from `GET /api/me/games` with no invite.
- **`actor` is server-set** from the authenticated user id. The client's self-reported `actor` is ignored. Display names live on the user or membership, not in events.
- **Roles:** `validateAction` receives the caller's role. At first all members can do everything. GM-only actions and token ownership come later.
- **OAuth flow:** the client calls `start` (with its bearer token); the server stores a hashed, single-use `state` tied to that user and returns the provider URL; the provider redirects the browser to the server's `callback` (so redirect URIs are on the **API** origin, `<public-api-url>/api/auth/oauth/<provider>/callback`); the server exchanges the code, then either attaches the identity to the current user or, if it already belongs to a claimed user, signs in as that user; finally it redirects to the client with a single-use login code in the URL fragment, which the client trades at `login-code` for a bearer token. Tokens never appear in URLs. Known gap: a guest who signs into an existing claimed account is left behind; merge their memberships once step 2 exists.
- **OAuth config** lives in SSM Parameter Store under `/tabletop/` (`discord-client-id`, `discord-client-secret` as SecureString, `public-api-url`, `client-url`; later `google-client-id`/`google-client-secret`). In production the server reads them at startup through the `aws` CLI (instance role policy in `infra/`); env vars (`DISCORD_CLIENT_ID`, etc.) override for dev. Adding a provider is a new `OAuthProvider` in `oauth.ts` plus a line in `config.ts`.
- **Saving state** needs nothing new: the event log is already persistent. A game just needs an owner, a name, and a listing.
- **Rollout:** (1) guest accounts, bearer tokens, server-set `actor`, and a schema migration mechanism (`PRAGMA user_version`); (2) game ownership, memberships, "my games", invites and join; (3) OAuth claiming; (4) roles and permissions; (5) hardening and Postgres.
- **Legacy test sessions** have no owner and stay open until deleted.

---

## 7. Open questions (NOT yet decided)

- Production hosting (the test setup above is a single instance), the production datastore (likely Postgres), and the latest-seq cache (likely Redis).
- Whether to take periodic **snapshots** so long sessions don't require full replay, and how to migrate events when `v` changes.
- Fine-grained roles: which actions are GM-only, token ownership, and hidden information (see section 6 for the account model).
- Asset pipeline: where models and textures are stored and how they're served (CDN), and whether players can upload their own.
- Bundle size: `three/webgpu` is about 220 KB gzipped. Consider code-splitting, or a WebGL-only build for low-end devices.
- Rule system support: system-agnostic vs. specific game systems.

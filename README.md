# Tabletop

A lightweight, browser-based 3D virtual tabletop. Three.js for rendering; HTTP polling over an append-only event log for sync. See [AGENTS.md](AGENTS.md) for the architecture and the reasons behind it.

## Run it

Requires Node 24+.

```sh
npm install
npm run dev
```

Open http://localhost:5173. A new session is created and its id is put in the URL. Copy the invite link (or the URL) into another tab or device to join the same table. On a phone on the same Wi-Fi, use the "Network" address Vite prints.

- Drag a token to move it; drag empty space to orbit; scroll or pinch to zoom.
- Click a token to select it, then **Remove** to delete it.
- Dice formulas look like `1d20`, `3d6+2`, `2d8-1`.

## Other commands

```sh
npm test          # Vitest
npm run typecheck # tsc for all packages
npm run build     # production client build into client/dist
```

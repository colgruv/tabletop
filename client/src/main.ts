import { emptyState, replay, type Action, type TableState } from "@tabletop/shared";
import { createSession, postAction } from "./transport/api";
import { Poller } from "./transport/poller";
import { TableScene } from "./render/scene";
import { Overlay } from "./ui/overlay";
import "./style.css";

/** Stable per-browser id. Falls back to a per-tab id if storage is blocked. */
function getActorId(): string {
  const fresh = crypto.randomUUID();
  try {
    const saved = localStorage.getItem("tabletop.actor");
    if (saved) return saved;
    localStorage.setItem("tabletop.actor", fresh);
  } catch {
    /* private mode etc. */
  }
  return fresh;
}

/** Session id lives in the URL hash, so the URL is the invite link. */
async function getSessionId(): Promise<string> {
  const fromHash = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{8,32}$/.test(fromHash)) return fromHash;
  const id = await createSession();
  history.replaceState(null, "", `${location.pathname}${location.search}#${id}`);
  return id;
}

async function main() {
  const actor = getActorId();
  const session = await getSessionId();
  let state: TableState = emptyState();
  let poller: Poller;

  // Send an action. Local state is NOT changed here: we wait for the event to come back from the log.
  async function send(action: Action) {
    const res = await postAction(session, actor, action);
    poller.nudge();
    return res;
  }

  const overlay = new Overlay(actor, {
    send: async (action) => {
      const res = await send(action);
      return res.ok ? null : res.error;
    },
  });

  const scene = await TableScene.create(
    document.querySelector<HTMLCanvasElement>("#view")!,
    document.querySelector<HTMLElement>("#labels")!,
    {
      onMove: async (id, x, z) => {
        const res = await send({ type: "token.move", id, x, z });
        return res.ok ? res.seq : null;
      },
      onSelect: (id) => overlay.setSelected(id),
    },
  );
  overlay.setBackend(scene.backend);

  poller = new Poller({
    session,
    getSeq: () => state.seq,
    onEvents: (events) => {
      state = replay(events, state);
      scene.sync(state);
      overlay.render(state);
    },
    onStatus: (s) => overlay.setStatus(s),
  });
  scene.sync(state);
  poller.start();
}

main().catch((err) => {
  console.error(err);
  const el = document.querySelector<HTMLElement>("#fatal");
  if (el) {
    el.hidden = false;
    el.textContent = `Couldn't start the table: ${err instanceof Error ? err.message : String(err)}`;
  }
});

import { emptyState, replay, type Action, type TableState } from "@tabletop/shared";
import { completeLogin, createSession, ensureAccount, fetchMe, postAction, startOAuth } from "./transport/api";
import { Poller } from "./transport/poller";
import { TableScene } from "./render/scene";
import { Overlay } from "./ui/overlay";
import "./style.css";

/**
 * After signing in at a provider the server sends the browser back with the
 * outcome in the URL fragment. Consume it, then restore the table's own hash.
 * Returns a message to show if sign-in failed.
 */
async function finishSignIn(): Promise<string | null> {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get("login");
  const failed = params.get("login-error");
  if (!code && !failed) return null;

  const table = params.get("return") ?? "";
  history.replaceState(null, "", `${location.pathname}${location.search}${table ? `#${table}` : ""}`);
  if (failed) return failed === "denied" ? "Sign-in was cancelled." : "Sign-in failed. Please try again.";
  try {
    await completeLogin(code!);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Sign-in failed.";
  }
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
  const signInError = await finishSignIn();
  const { userId: actor } = await ensureAccount();
  const session = await getSessionId();
  let state: TableState = emptyState();
  let poller: Poller;

  // Send an action. Local state is NOT changed here: we wait for the event to come back from the log.
  async function send(action: Action) {
    const res = await postAction(session, action);
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
  if (signInError) overlay.showError(signInError);

  // Sign-in is optional, so a failure here must not stop the table from loading.
  fetchMe()
    .then((me) =>
      overlay.setAccount(me, (provider) => {
        startOAuth(provider, session)
          .then((url) => location.assign(url))
          .catch((err) => overlay.showError(err instanceof Error ? err.message : "Sign-in failed."));
      }),
    )
    .catch((err) => console.warn("could not load profile", err));

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

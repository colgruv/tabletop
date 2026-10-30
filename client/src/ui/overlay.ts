import type { Action, MeResponse, TableState } from "@tabletop/shared";
import type { PollStatus } from "../transport/poller";

export interface OverlayCallbacks {
  send(action: Action): Promise<string | null>; // resolves with an error message, or null on success
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const PALETTE = ["#e63946", "#f4a261", "#2a9d8f", "#457b9d", "#9b5de5", "#f15bb5", "#ffd166", "#06d6a0"];

/** Plain-DOM interface around the 3D view. Reads state, sends actions. */
export class Overlay {
  private selected: string | null = null;
  private state: TableState | null = null;
  private renderedRolls = 0;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private actor: string,
    private cb: OverlayCallbacks,
  ) {
    const color = $<HTMLInputElement>("#token-color");
    color.value = PALETTE[Math.floor(Math.random() * PALETTE.length)]!;

    $<HTMLFormElement>("#add-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $<HTMLInputElement>("#token-name");
      // Drop new tokens near the middle, a little apart.
      const x = Math.round((Math.random() * 6 - 3) * 100) / 100;
      const z = Math.round((Math.random() * 6 - 3) * 100) / 100;
      void this.run({ type: "token.add", name: name.value || "Token", color: color.value, x, z }).then((ok) => {
        if (ok) {
          name.value = "";
          color.value = PALETTE[Math.floor(Math.random() * PALETTE.length)]!;
        }
      });
    });

    $<HTMLFormElement>("#dice-form").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.run({ type: "dice.roll", formula: $<HTMLInputElement>("#dice-formula").value });
    });

    $<HTMLButtonElement>("#remove-token").addEventListener("click", () => {
      if (this.selected) void this.run({ type: "token.remove", id: this.selected });
    });

    $<HTMLButtonElement>("#copy-link").addEventListener("click", async () => {
      const btn = $<HTMLButtonElement>("#copy-link");
      try {
        await navigator.clipboard.writeText(location.href);
        btn.textContent = "Link copied";
      } catch {
        prompt("Share this link:", location.href);
      }
      setTimeout(() => (btn.textContent = "Copy invite link"), 1500);
    });
  }

  /** Show who is signed in, or a sign-in button per configured provider while still a guest. */
  setAccount(me: MeResponse, signIn: (provider: string) => void): void {
    const el = $("#account");
    el.replaceChildren();
    const linked = me.credentials[0];
    if (linked) {
      el.textContent = `Signed in as ${linked.displayName}`;
      return;
    }
    el.textContent = "Guest";
    for (const provider of me.providers) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `Sign in with ${provider[0]!.toUpperCase()}${provider.slice(1)}`;
      btn.addEventListener("click", () => signIn(provider));
      el.append(" ", btn);
    }
  }

  setBackend(name: string): void {
    $("#backend").textContent = name;
  }

  setStatus(status: PollStatus): void {
    const el = $("#status");
    el.dataset.status = status;
    el.textContent = status === "ok" ? "Connected" : "Reconnecting…";
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.renderSelection();
  }

  render(state: TableState): void {
    this.state = state;
    this.renderSelection();

    // Append only rolls we haven't shown yet. The list is newest first.
    const log = $<HTMLOListElement>("#roll-log");
    const fresh = state.rolls.filter((r) => r.seq > this.renderedRolls);
    for (const r of fresh) {
      const li = document.createElement("li");
      const who = r.actor === this.actor ? "You" : `Player ${r.actor.slice(0, 4)}`;
      const mod = r.modifier ? ` ${r.modifier > 0 ? "+" : "−"} ${Math.abs(r.modifier)}` : "";
      li.innerHTML = `<span class="who"></span> rolled <b></b> <span class="detail"></span> = <strong></strong>`;
      li.querySelector(".who")!.textContent = who;
      li.querySelector("b")!.textContent = r.formula;
      li.querySelector(".detail")!.textContent = `[${r.rolls.join(", ")}]${mod}`;
      li.querySelector("strong")!.textContent = String(r.total);
      log.prepend(li);
      this.renderedRolls = r.seq;
    }
    while (log.children.length > 50) log.lastElementChild!.remove();
    $("#roll-empty").hidden = log.children.length > 0;
  }

  private renderSelection(): void {
    const token = this.selected ? this.state?.tokens[this.selected] : undefined;
    $("#selection").hidden = !token;
    if (token) $("#selected-name").textContent = token.name;
  }

  /** Show a message for a few seconds. */
  showError(message: string | null): void {
    const el = $("#error");
    clearTimeout(this.errorTimer);
    el.textContent = message ?? "";
    el.hidden = !message;
    if (message) this.errorTimer = setTimeout(() => (el.hidden = true), 4000);
  }

  /** Send an action; show the server's error if it was rejected. */
  private async run(action: Action): Promise<boolean> {
    const error = await this.cb.send(action);
    this.showError(error);
    return !error;
  }
}

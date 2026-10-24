import { describe, expect, it } from "vitest";
import { EVENT_VERSION, type EventData, type TableEvent } from "./events";
import { applyEvent, emptyState, replay } from "./state";
import { validateAction, type ServerContext } from "./validate";

let seq = 0;
const ev = (data: EventData): TableEvent => ({ ...data, seq: ++seq, v: EVENT_VERSION, actor: "a", at: 0 });

const ctx: ServerContext = { newId: () => "t1", rollDie: (sides) => sides };

describe("applyEvent", () => {
  it("adds, moves, and removes tokens", () => {
    seq = 0;
    const s = replay([
      ev({ type: "token.added", id: "t1", name: "Goblin", color: "#00ff00", x: 0, z: 0 }),
      ev({ type: "token.moved", id: "t1", x: 3, z: -2 }),
    ]);
    expect(s.seq).toBe(2);
    expect(s.tokens.t1).toMatchObject({ x: 3, z: -2, name: "Goblin" });

    const removed = applyEvent(s, ev({ type: "token.removed", id: "t1" }));
    expect(removed.tokens.t1).toBeUndefined();
  });

  it("ignores events it has already applied", () => {
    seq = 0;
    const e = ev({ type: "token.added", id: "t1", name: "A", color: "#000000", x: 0, z: 0 });
    const once = applyEvent(emptyState(), e);
    expect(applyEvent(once, e)).toBe(once);
  });

  it("does not mutate the previous state", () => {
    seq = 0;
    const before = emptyState();
    applyEvent(before, ev({ type: "token.added", id: "t1", name: "A", color: "#000000", x: 0, z: 0 }));
    expect(before.tokens).toEqual({});
  });
});

describe("validateAction", () => {
  it("assigns ids for new tokens on the server", () => {
    const r = validateAction(emptyState(), { type: "token.add", name: " Orc ", color: "#aabbcc", x: 1, z: 1 }, ctx);
    expect(r).toEqual({ ok: true, event: { type: "token.added", id: "t1", name: "Orc", color: "#aabbcc", x: 1, z: 1 } });
  });

  it("rejects moves of unknown tokens and moves off the table", () => {
    expect(validateAction(emptyState(), { type: "token.move", id: "nope", x: 0, z: 0 }, ctx).ok).toBe(false);
    seq = 0;
    const s = replay([ev({ type: "token.added", id: "t1", name: "A", color: "#000000", x: 0, z: 0 })]);
    expect(validateAction(s, { type: "token.move", id: "t1", x: 99, z: 0 }, ctx).ok).toBe(false);
    expect(validateAction(s, { type: "token.move", id: "t1", x: NaN, z: 0 }, ctx).ok).toBe(false);
  });

  it("rolls dice with the injected die", () => {
    const r = validateAction(emptyState(), { type: "dice.roll", formula: "3d6 + 2" }, ctx);
    expect(r).toEqual({
      ok: true,
      event: { type: "dice.rolled", formula: "3d6+2", rolls: [6, 6, 6], modifier: 2, total: 20 },
    });
  });

  it("rejects bad dice formulas", () => {
    for (const formula of ["", "d6", "0d6", "21d6", "2d1", "2d6*3", "abc"]) {
      expect(validateAction(emptyState(), { type: "dice.roll", formula }, ctx).ok, formula).toBe(false);
    }
  });

  it("rejects unknown action types from the wire", () => {
    const bogus = { type: "table.flip" } as unknown as Parameters<typeof validateAction>[1];
    expect(validateAction(emptyState(), bogus, ctx).ok).toBe(false);
  });
});

import { TABLE_HALF_SIZE, type Action, type EventData } from "./events";
import type { TableState } from "./state";

/** Things only the server should decide, injected so validation stays testable. */
export interface ServerContext {
  newId(): string;
  /** Uniform integer in [1, sides]. */
  rollDie(sides: number): number;
}

export type ValidationResult = { ok: true; event: EventData } | { ok: false; error: string };

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DICE_RE = /^(\d{1,2})d(\d{1,3})([+-]\d{1,3})?$/i;
const MAX_TOKENS = 200;

const fail = (error: string): ValidationResult => ({ ok: false, error });

function onTable(x: unknown, z: unknown): boolean {
  return (
    typeof x === "number" &&
    typeof z === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(z) &&
    Math.abs(x) <= TABLE_HALF_SIZE &&
    Math.abs(z) <= TABLE_HALF_SIZE
  );
}

/**
 * Check an untrusted action against the current state and turn it into an event.
 * `action` comes straight off the wire, so every field is checked.
 */
export function validateAction(state: TableState, action: Action, ctx: ServerContext): ValidationResult {
  if (typeof action !== "object" || action === null) return fail("action must be an object");

  switch (action.type) {
    case "token.add": {
      const { name, color, x, z } = action;
      if (typeof name !== "string" || name.trim().length < 1 || name.length > 32)
        return fail("name must be 1-32 characters");
      if (typeof color !== "string" || !COLOR_RE.test(color)) return fail("color must be #rrggbb");
      if (!onTable(x, z)) return fail("position is off the table");
      if (Object.keys(state.tokens).length >= MAX_TOKENS) return fail("too many tokens");
      return { ok: true, event: { type: "token.added", id: ctx.newId(), name: name.trim(), color, x, z } };
    }

    case "token.move": {
      const { id, x, z } = action;
      if (typeof id !== "string" || !state.tokens[id]) return fail("unknown token");
      if (!onTable(x, z)) return fail("position is off the table");
      return { ok: true, event: { type: "token.moved", id, x, z } };
    }

    case "token.remove": {
      const { id } = action;
      if (typeof id !== "string" || !state.tokens[id]) return fail("unknown token");
      return { ok: true, event: { type: "token.removed", id } };
    }

    case "dice.roll": {
      const formula = typeof action.formula === "string" ? action.formula.replace(/\s+/g, "") : "";
      const m = DICE_RE.exec(formula);
      if (!m) return fail("formula must look like 2d6+1");
      const count = Number(m[1]);
      const sides = Number(m[2]);
      const modifier = m[3] ? Number(m[3]) : 0;
      if (count < 1 || count > 20) return fail("roll 1-20 dice");
      if (sides < 2 || sides > 100) return fail("dice need 2-100 sides");
      const rolls = Array.from({ length: count }, () => ctx.rollDie(sides));
      const total = rolls.reduce((a, b) => a + b, 0) + modifier;
      return { ok: true, event: { type: "dice.rolled", formula: formula.toLowerCase(), rolls, modifier, total } };
    }

    default:
      return fail("unknown action type");
  }
}

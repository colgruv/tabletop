import type { TableEvent } from "./events";

export interface Token {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
}

export interface RollRecord {
  seq: number;
  actor: string;
  formula: string;
  rolls: number[];
  modifier: number;
  total: number;
}

export interface TableState {
  /** Seq of the last event applied. */
  seq: number;
  tokens: Readonly<Record<string, Token>>;
  /** Most recent rolls, oldest first. */
  rolls: readonly RollRecord[];
}

export const MAX_ROLL_HISTORY = 50;

export const emptyState = (): TableState => ({ seq: 0, tokens: {}, rolls: [] });

/**
 * Pure and deterministic: same state + same event always gives the same result.
 * Events must be applied in seq order; out-of-order or repeated events are ignored.
 */
export function applyEvent(state: TableState, event: TableEvent): TableState {
  if (event.seq <= state.seq) return state;

  const next: TableState = { ...state, seq: event.seq };

  switch (event.type) {
    case "token.added":
      next.tokens = {
        ...state.tokens,
        [event.id]: { id: event.id, name: event.name, color: event.color, x: event.x, z: event.z },
      };
      break;

    case "token.moved": {
      const token = state.tokens[event.id];
      if (token) next.tokens = { ...state.tokens, [event.id]: { ...token, x: event.x, z: event.z } };
      break;
    }

    case "token.removed": {
      const { [event.id]: _removed, ...rest } = state.tokens;
      next.tokens = rest;
      break;
    }

    case "dice.rolled": {
      const record: RollRecord = {
        seq: event.seq,
        actor: event.actor,
        formula: event.formula,
        rolls: event.rolls,
        modifier: event.modifier,
        total: event.total,
      };
      next.rolls = [...state.rolls, record].slice(-MAX_ROLL_HISTORY);
      break;
    }
  }

  return next;
}

export function replay(events: readonly TableEvent[], from: TableState = emptyState()): TableState {
  return events.reduce(applyEvent, from);
}

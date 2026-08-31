// Single source of truth for all WebSocket message shapes between
// controller <-> server <-> game. Filled in fully in Phase 1 (§2.4, §3.6).

export interface HelloMessage {
  type: 'hello';
}

export type AnyMessage = HelloMessage;

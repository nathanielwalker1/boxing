/**
 * rig/index.ts — the rig's public surface. RIG workstream owns this folder.
 * Stage-1 STUB: a view that draws nothing (the hitbox debug view in
 * render/stage.ts shows where the sim says the body is). RIG replaces the body
 * of createFighterView; the signature is the contract.
 */
import type { Object3D } from 'three';
import type { Config, FighterSpec, FighterState, FighterView, Side, SimEvent } from '../core';

export function createFighterView(side: Side, _spec: FighterSpec, _cfg: Config, _parent: Object3D): FighterView {
  return {
    side,
    apply(_prev: FighterState, _next: FighterState, _alpha: number, _dt: number, _events: readonly SimEvent[]): void {},
    dispose(): void {},
  };
}

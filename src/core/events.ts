/**
 * core/events.ts — a tiny typed bus. The sim RETURNS events from step(); the
 * host (UI/main.ts) pushes them through here so RENDER, AUDIO and UI can
 * subscribe by type instead of polling sim internals (CONTRACT §4).
 */
import type { SimEvent, SimEventType } from './types';

type Handler<T extends SimEventType> = (e: Extract<SimEvent, { type: T }>) => void;

export class EventBus {
  private handlers = new Map<SimEventType, Set<(e: SimEvent) => void>>();
  private any = new Set<(e: SimEvent) => void>();

  on<T extends SimEventType>(type: T, fn: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    const h = fn as (e: SimEvent) => void;
    set.add(h);
    return () => { set!.delete(h); };
  }

  onAny(fn: (e: SimEvent) => void): () => void {
    this.any.add(fn);
    return () => { this.any.delete(fn); };
  }

  emit(events: readonly SimEvent[]): void {
    for (const e of events) {
      const set = this.handlers.get(e.type);
      if (set) for (const h of set) h(e);
      for (const h of this.any) h(e);
    }
  }
}

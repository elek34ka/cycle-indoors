/** Minimal typed event bus. Every module talks through this so the mock
 *  devices of phase 1 and the real BLE devices of phase 2 are interchangeable. */
export type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<any>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try { h(payload); } catch (err) { console.error(`handler for "${String(event)}" threw`, err); }
    }
  }

  clear(): void { this.handlers.clear(); }
}

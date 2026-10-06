import { useEffect, useMemo, useRef, useState } from "react";
import { groupOf, type GroupId, type Groupable } from "@/lib/outbox-groups";

/** how long a card that changed group counts as "moving": its glide plus a little */
const MOVING_MS = 1000;

/**
 * The ids of the items that changed group a moment ago. A card in this set arrives by gliding from its old place (so it
 * skips the entrance animation of a brand-new card) and is lifted above its neighbours while it travels.
 *
 * The first render that sees the change must already know about it (that is the render that mounts the arriving card),
 * so the comparison with where each item was drawn last time happens during render; the effect then remembers the move
 * for a second, because the REST answer to the click re-renders the list right after the websocket update did.
 */
export function useRecentMoves(items: readonly Groupable[]): ReadonlySet<string> {
  const placed = useRef(new Map<string, GroupId>());
  const until = useRef(new Map<string, number>());
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [tick, setTick] = useState(0);

  const fresh = useMemo(() => {
    const out = new Set<string>();
    for (const it of items) {
      const before = placed.current.get(it.id);
      if (before !== undefined && before !== groupOf(it.status)) out.add(it.id);
    }
    return out;
  }, [items]);

  useEffect(() => {
    placed.current = new Map(items.map((it) => [it.id, groupOf(it.status)] as const));
    if (fresh.size === 0) return;
    const expires = Date.now() + MOVING_MS;
    for (const id of fresh) until.current.set(id, expires);
    timers.current.push(setTimeout(() => setTick((n) => n + 1), MOVING_MS + 60));
  }, [items, fresh]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  // `tick` re-evaluates the expiry once the glide is over
  return useMemo(() => {
    const t = Date.now();
    const out = new Set(fresh);
    for (const [id, expires] of until.current) {
      if (expires > t) out.add(id);
      else until.current.delete(id);
    }
    return out;
  }, [fresh, tick]);
}

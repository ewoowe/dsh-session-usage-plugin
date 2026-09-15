/**
 * What this view remembers about its reader.
 *
 * Five facts, and they are the same kind of fact: which leaf the reader was on,
 * how they last ordered the per-message table, how far down the page they had
 * read, which time range they had narrowed it to, and — when that range is the
 * custom one — the two instants it spans. All five were component state once,
 * and all five reset silently.
 *
 * The leaves are conditionally rendered, so switching leaves unmounts the table
 * and its sort went back to the window's own order; leaving the view entirely did
 * the same to the leaf. The scroll is the third case and the worst: the shell
 * parks a conversation area at the bottom, so coming back to the usage page did
 * not merely forget the position, it showed a different part of a long table —
 * the reader who had paged down to a turn had to find it again every visit.
 *
 * One store for all five, rather than five files: the remembering is identical
 * and only the key and the guard differ, and keeping the guard beside the store
 * is what stops the next preference from being added with none at all. A sixth
 * belongs here only if it is the same kind of fact — this view's own reader
 * state. Session data does not.
 *
 * Two layers, and both are load-bearing:
 *
 * - A module-level value covers the unmount. Remounting reads it back.
 * - `localStorage` covers a reload. Every access is guarded because a host
 *   profile can run without web storage, and the value above still covers that
 *   host — a forgotten preference there is a missing nicety, never a broken view.
 *
 * Not the settings scope. That seam is for a namespace the host validates and
 * shows in the settings UI, and neither which tab a reader was on, nor a table's
 * sort column, nor a scroll offset, nor a time range is something they would go
 * looking for there; binding it would also make this view wait on a service
 * several hosts do not load.
 */
import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import { parseRange, type CustomRange, type RangeKey } from './time-range.ts'

/** The leaves of the usage view. */
export type Leaf = 'models' | 'messages'

/** The columns a reader can order by. */
export type SortKey = 'when' | 'input' | 'output' | 'busy' | 'cache'

/** Which way a column is ordered. */
export type Direction = 'asc' | 'desc'

/** The table's ordering: a column and a direction, or null for the window's own. */
export interface Sort {
  readonly key: SortKey
  readonly direction: Direction
}

/** Every sortable column, for validating what was read back. */
const KEYS: readonly SortKey[] = ['when', 'input', 'output', 'busy', 'cache']

/** Namespaced, so one plugin's preference cannot collide with the shell's. */
const SORT_KEY = 'dsh-session-usage.message-sort'
const LEAF_KEY = 'dsh-session-usage.leaf'
const SCROLL_KEY = 'dsh-session-usage.scroll'
const RANGE_KEY = 'dsh-session-usage.range'
const CUSTOM_KEY = 'dsh-session-usage.custom-range'

/**
 * Read a stored string, or null.
 *
 * The one place a host without web storage is handled: every preference above
 * goes through here, so there is exactly one access to guard rather than three.
 * @param key - the storage key.
 * @returns the stored text, or null when nothing is stored or storage is absent.
 */
function readText(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Store a string, or remove the key with null. Best effort: web storage is
 * optional in some host profiles, and every caller has an in-memory value that
 * already covers the page either way.
 * @param key - the storage key.
 * @param text - the text to store, or null to remove.
 */
function writeText(key: string, text: string | null): void {
  try {
    if (text === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, text)
  } catch {
    // Nothing to do: the caller's own value stands for this page.
  }
}

/**
 * Read a stored sort back, rejecting anything this version cannot order by.
 *
 * The guard is not defensive habit: a stored value is attacker-adjacent input —
 * hand-edited, or written by a version whose columns differ — and an unknown key
 * would reach `sortValue`'s switch, return `undefined`, and turn every comparison
 * into `NaN`. The rows would come back in an arbitrary order that looks like a
 * sorting bug and is not one. A value this version cannot honour is treated as no
 * preference at all.
 * @param text - the raw stored string, or null when nothing is stored.
 * @returns the parsed sort, or null.
 */
export function parseSort(text: string | null): Sort | null {
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { key, direction } = raw as { key?: unknown; direction?: unknown }
  if (!KEYS.includes(key as SortKey)) return null
  if (direction !== 'asc' && direction !== 'desc') return null
  return { key: key as SortKey, direction }
}

/**
 * Read a stored leaf back.
 * @param text - the raw stored string, or null when nothing is stored.
 * @returns the leaf, defaulting to the first one — including for a value this
 * version does not have, which is what an older or newer build would leave.
 */
export function parseLeaf(text: string | null): Leaf {
  if (text === null) return 'models'
  try {
    return JSON.parse(text) === 'messages' ? 'messages' : 'models'
  } catch {
    return 'models'
  }
}

/**
 * Read a stored scroll offset back.
 *
 * A negative or non-finite offset is not a position: it would either be clamped
 * to zero on assignment or, worse, be NaN, which sets `scrollTop` to zero on some
 * engines and to the bottom on others. Anything that is not a real offset counts
 * as not having one.
 * @param text - the raw stored string, or null when nothing is stored.
 * @returns the offset in pixels, or null.
 */
export function parseScroll(text: string | null): number | null {
  if (text === null) return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** One remembered value: its current state, and its subscribers. */
interface Store<T> {
  get(): T
  set(value: T): void
  subscribe(listener: () => void): () => void
}

/**
 * Build a store for one stored preference.
 *
 * Seeded lazily rather than at module scope so that importing this file never
 * touches the DOM — a spec can import the parsers in Node without a `window`, and
 * a write that happens before the first read wins over what was stored.
 * @param storageKey - the `localStorage` key this preference owns.
 * @param parse - turns stored text into a value. It is also what supplies the
 * default, so it must return one for null rather than a null of its own.
 * @returns the store.
 */
function remember<T>(storageKey: string, parse: (text: string | null) => T): Store<T> {
  let current = parse(null)
  let seeded = false
  const listeners = new Set<() => void>()
  const get = (): T => {
    if (!seeded) {
      seeded = true
      current = parse(readText(storageKey))
    }
    return current
  }
  const set = (value: T): void => {
    current = value
    seeded = true
    const text = JSON.stringify(value)
    // `null` is the absence of a preference, so it is removed rather than stored
    // as the string "null" — every parser here reads both back the same way, but
    // leaving it behind would outlive the preference it describes.
    writeText(storageKey, text === 'null' ? null : text)
    for (const listener of [...listeners]) listener()
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  return { get, set, subscribe }
}

/**
 * Read a store as React state.
 *
 * `useSyncExternalStore` rather than `useState`: the value lives outside React
 * now, and reading it through the store's own snapshot is what keeps a remount
 * and a live component agreeing about the same preference. The snapshot is also
 * passed as the server one — this view is client-only, but a future hydration
 * would otherwise throw rather than render the default.
 * @param store - the store to read.
 * @returns the remembered value.
 */
function useRemembered<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** The per-message table's sort, remembered across mounts and reloads. */
const sortStore = remember<Sort | null>(SORT_KEY, parseSort)

/** Which leaf the view was last on. */
const leafStore = remember<Leaf>(LEAF_KEY, parseLeaf)

/** The time range the view was last narrowed to. */
const rangeStore = remember<RangeKey>(RANGE_KEY, parseRange)

/**
 * Read a stored custom span back.
 *
 * Both ends are numbers or nothing: a value that is not a finite instant cannot
 * bound anything, and would compare as `NaN` — which filters nothing out rather
 * than everything. A start is required (a span with only an end is not a span
 * this view can show), while a missing end means "until now", the same open end
 * every other range uses.
 * @param text - the raw stored string, or null when nothing is stored.
 * @returns the span, or null when nothing usable is stored.
 */
export function parseCustomRange(text: string | null): CustomRange | null {
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { from, to } = raw as { from?: unknown; to?: unknown }
  if (typeof from !== 'number' || !Number.isFinite(from)) return null
  if (to !== null && (typeof to !== 'number' || !Number.isFinite(to))) return null
  return { from, to: to as number | null }
}

/** The reader's own span, when the custom range is the one showing. */
const customStore = remember<CustomRange | null>(CUSTOM_KEY, parseCustomRange)

/**
 * The sort to order the table by.
 * @returns the remembered sort, or null for the window's own order.
 */
export function getSort(): Sort | null {
  return sortStore.get()
}

/**
 * Remember a sort — or, with null, that the window's own order is wanted.
 * @param next - the sort to keep.
 */
export function writeSort(next: Sort | null): void {
  sortStore.set(next)
}

/**
 * The remembered sort, as React state.
 * @returns the sort to order the table by.
 */
export function useSort(): Sort | null {
  return useRemembered(sortStore)
}

/**
 * The leaf the view should open on.
 * @returns the remembered leaf.
 */
export function getLeaf(): Leaf {
  return leafStore.get()
}

/**
 * Remember which leaf is showing.
 * @param next - the leaf to keep.
 */
export function writeLeaf(next: Leaf): void {
  leafStore.set(next)
}

/**
 * The remembered leaf, as React state.
 * @returns the leaf to show.
 */
export function useLeaf(): Leaf {
  return useRemembered(leafStore)
}

/**
 * The time range the view is narrowed to.
 * @returns the remembered range.
 */
export function getRange(): RangeKey {
  return rangeStore.get()
}

/**
 * Remember which time range is showing.
 * @param next - the range to keep.
 */
export function writeRange(next: RangeKey): void {
  rangeStore.set(next)
}

/**
 * The remembered range, as React state.
 * @returns the range to narrow the tables to.
 */
export function useRange(): RangeKey {
  return useRemembered(rangeStore)
}

/**
 * The span the custom range is showing, or null while none is set.
 * @returns the remembered span.
 */
export function getCustomRange(): CustomRange | null {
  return customStore.get()
}

/**
 * Remember the custom span — or, with null, that none is set.
 *
 * The null reaches storage as a removal rather than as the string `"null"`; the
 * store handles that for every preference alike.
 * @param next - the span to keep, or null to clear it.
 */
export function writeCustomRange(next: CustomRange | null): void {
  customStore.set(next)
}

/**
 * The remembered custom span, as React state.
 * @returns the span, or null while none is set.
 */
export function useCustomRange(): CustomRange | null {
  return useRemembered(customStore)
}

/**
 * The nearest element that can actually scroll, `node` included.
 *
 * Judged by outcome — `scrollHeight` over `clientHeight`, and an overflow that
 * permits scrolling — rather than by one or the other alone. `overflow-y: auto`
 * that happens to fit its content is not a scrollport: choosing it would mean
 * saving and restoring a `scrollTop` that can only ever be zero, while the real
 * scrollport one level up kept landing wherever the shell left it. That is the
 * whole reason this walks ancestors: this view's own root declares
 * `overflow-y: auto`, but on a host that gives the conversation area its own
 * fixed height, the scrolling happens above us.
 * @param node - the view's root element.
 * @returns the scrollport, or null while nothing is scrollable yet.
 */
export function scrollportOf(node: HTMLElement | null): HTMLElement | null {
  for (let el = node; el !== null; el = el.parentElement) {
    const overflow = window.getComputedStyle(el).overflowY
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    // One pixel of slack: fractional row heights can leave the two within a
    // rounding error of each other on an element that cannot actually scroll.
    if (el.scrollHeight > el.clientHeight + 1) return el
  }
  return null
}

/**
 * Where the view was left scrolled, in pixels.
 * @returns the remembered offset, or null.
 */
function readScroll(): number | null {
  return parseScroll(readText(SCROLL_KEY))
}

/**
 * Keep the view's scroll position across mounts.
 *
 * Restores on the next frame rather than immediately: the tables are laid out
 * during the same commit, and an assignment made before that is clamped against
 * a `scrollHeight` that does not exist yet. The second, delayed attempt covers
 * the shell's own scrolling of the conversation area — it parks that area at the
 * bottom when a session view mounts, and that happens after ours. Restoring is
 * idempotent, so the extra attempt costs a comparison and only ever matters when
 * the first one was overridden.
 *
 * Saving listens on the scrollport found above and not on the root: when the
 * scrolling happens on an ancestor, a listener on the root never fires at all —
 * scroll events do not bubble from an ancestor down to a descendant. The last
 * known offset is also written on the way out, because a mount that is torn down
 * mid-scroll is exactly the case this exists for.
 * @param ref - the view's root element.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (root === null) return
    const remembered = readScroll()
    let port: HTMLElement | null = null
    const save = (): void => {
      if (port !== null) writeText(SCROLL_KEY, String(port.scrollTop))
    }
    const attach = (): void => {
      const found = scrollportOf(root)
      if (found !== port) {
        port?.removeEventListener('scroll', save)
        port = found
        port?.addEventListener('scroll', save, { passive: true })
      }
      // The listener goes on even when there is nothing to restore: from here on
      // this is what remembers the reader's own scrolling.
      if (port === null || remembered === null) return
      port.scrollTop = remembered
    }
    const frame = window.requestAnimationFrame(attach)
    // The shell may park the area at the bottom AFTER its own first frame; this
    // re-applies the same value once that has had its chance to happen.
    const settle = window.setTimeout(attach, 120)
    return () => {
      save()
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settle)
      port?.removeEventListener('scroll', save)
    }
  }, [ref])
}

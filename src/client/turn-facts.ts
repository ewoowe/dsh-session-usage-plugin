/**
 * What one turn was: which model ran it, how much it used, how long it took, and
 * how much of its prompt came from cache — all folded from the session's own event
 * window.
 *
 * Every figure the strip prints beside a message has to belong to THAT message.
 * The session-wide `modelSelection.lastUsed` and the session-wide `tokenUsage`
 * cache share are both facts about the newest state of the session, so printing
 * them next to an older message states something false with the same confidence
 * as the truth. The honest source is the turn itself.
 *
 * Those facts reach a plugin without touching the DOM: a Session binding exposes
 * its loaded event window (`binding.eventSource`), the same contiguous history the
 * conversation is assembled from, and each turn's `assistant/message` events carry
 * both the model that served the request and the usage it billed.
 *
 * When that window does not reach a turn there is no answer to give, and callers
 * say so rather than substituting a session-wide figure.
 */
import { deriveTurnTokenUsage, type TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry, SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { turnCacheHitOf } from './format.ts'

/** The route one request went out on: which provider served it, and which model. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** The strip's per-turn facts; either may be unknown. */
export interface TurnFacts {
  /**
   * The seq of the turn's own `turn/start`: its identity, and the only stable key
   * a view can use once it reorders rows.
   */
  readonly seq: number
  /**
   * Where {@link route} came from: the turn's own assistant message, or the route
   * metadata logged before it. Surfaced so a disagreement between the model column
   * and the composer's picker can be traced to one of the two sources instead of
   * argued about.
   */
  readonly routeSource: 'usage' | 'message' | null
  /** The last model to serve this turn, or null when its events are outside the window. */
  readonly route: ModelRoute | null
  /** The turn's cache-hit share as display text, or null when it cannot be known. */
  readonly cacheHit: string | null
  /**
   * The turn's folded usage, straight from the host's fold, or null while the turn
   * is incomplete. Kept whole rather than reduced to a percentage so a caller can
   * sum it per model without re-deriving any counting rule.
   */
  readonly usage: TurnTokenUsage | null
  /**
   * The turn's wall span in milliseconds — `turn/end.time − turn/start.time`, the
   * very expression the host's own turn tail computes, so a dashboard and a tail
   * clock cannot disagree. Null while the turn is open or outside the window.
   */
  readonly busyMs: number | null
  /** When the turn started, epoch ms, or null when the window does not carry it. */
  readonly startedAt: number | null
  /**
   * The prompt that started this turn, collapsed to one truncated line, or null.
   *
   * It is NOT part of the turn's own slice: a prompt is appended to the log BEFORE
   * the `turn/start` that answers it, and the usage fold fails closed for anything
   * after `turn/end`. The fold therefore carries it across the boundary on its way
   * from one slice to the next.
   */
  readonly prompt: string | null
}

/** The `user/message` payload fields this module reads. */
interface UserMessageData {
  readonly content?: readonly { readonly text?: unknown }[]
  readonly source?: { readonly kind?: unknown }
}

/**
 * One line of a USER message's text, or null when the event is not one the reader
 * typed.
 *
 * The log carries more user-role messages than the reader wrote: injected context
 * arrives the same way — `<system-reminder>` notes, `[model changed: …]` markers,
 * the skill catalogue — and those normally come AFTER the prompt they accompany,
 * so a "last one wins" rule describes the injection instead of the prompt.
 * `MessageSourceMap.user` is exactly `{ kind: 'user' }`, so the source is the
 * discriminator; the text is not.
 *
 * Blocks without a `text` string (images, files) contribute nothing, so a prompt
 * made only of those reads as null rather than as an empty string.
 *
 * The text is kept WHOLE, line breaks and all: collapsing and truncating belong to
 * whatever renders it, because the whole point of keeping it here is to have
 * something to show when a row is too narrow — a preview that had already been cut
 * to one line could only ever repeat itself on hover.
 * @param data - a `user/message` event's payload.
 * @returns the prompt's text, trimmed.
 */
function promptOf(data: unknown): string | null {
  const payload = data as UserMessageData
  if (payload.source?.kind !== 'user') return null
  const blocks = payload.content
  if (!Array.isArray(blocks)) return null
  let text = ''
  for (const block of blocks) {
    if (typeof block?.text === 'string') text += block.text
  }
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/** The `assistant/message` payload fields this module reads. */
interface AssistantMessageData {
  readonly message?: { readonly source?: { readonly provider?: unknown; readonly model?: unknown } }
}

/**
 * The model a turn ran, from that turn's own events.
 *
 * The LAST assistant message wins, because a turn can carry several (tool steps,
 * a retry) and the model that produced the reply on screen is the one from the
 * final message — the same message the tail treats as the turn's closing one.
 * @param events - one turn's events, in order.
 * @returns the route, or null when none of them names a model.
 */
/**
 * The last route the host's own fold attributes to a turn, or null.
 *
 * `TurnTokenUsage.routes` lists the attempts a turn made, and it is what the turn's
 * usage dialog displays — so reading it here is what keeps the two surfaces
 * agreeing. The turn's own messages are NOT an equivalent source: a retry's message
 * can be logged before the retry, which is how a turn that finished on Flash read
 * as Pro.
 * @param usage - the turn's folded usage, or null while it is incomplete.
 * @returns the final route, or null when the fold named none.
 */
function lastRouteOf(usage: TurnTokenUsage | null): ModelRoute | null {
  const route = usage?.routes?.at(-1)
  if (route === undefined) return null
  return {
    provider: typeof route.provider === 'string' ? route.provider : '',
    model: route.model,
  }
}

function routeFromMessage(events: readonly SessionEvent[]): ModelRoute | null {
  let route: ModelRoute | null = null
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const source = (event.data as AssistantMessageData).message?.source
    const model = source?.model
    if (typeof model !== 'string' || model === '') continue
    route = { provider: typeof source?.provider === 'string' ? source.provider : '', model }
  }
  return route
}

/**
 * Group one loaded event window into per-turn slices, prompts included.
 *
 * (The type above and the function below are one idea; the doc lives here so it
 * sits next to the rules it explains.)
 *
 * The usage half is NOT folded here. It comes from `deriveTurnTokenUsage`, the
 * host's own browser-safe fold (`@deepseek-ai/dsh-token-meter/client`), which is
 * the exact function ui-chat builds a turn's tail with — so a turn's cache share
 * follows the rules the host already settled: which events count, that a final
 * message's usage supersedes a streaming sample, that retries add, and that an
 * incomplete turn yields NOTHING rather than a partial sum. Re-deriving that here
 * would be a second implementation of a subtle rule set whose first divergence
 * would stay invisible until two surfaces were compared.
 *
 * Events are grouped by the turn they belong to before either fold runs, because
 * the usage fold is defined over one turn's whole window: it fails closed for a
 * slice missing the turn's own start or end, AND for one that carries anything
 * past `turn/end`. The slice therefore runs `turn/start` → `turn/end` inclusive
 * and no further — the next prompt is appended before the next `turn/start`, so a
 * slice that ran to that boundary would break every turn's figure.
 *
 * A slice is identified by its `turn/start` event's SEQ, not by the turn number it
 * carries: numbers repeat across segments of one log, and keying by one merges two
 * turns into a single invalid slice.
 * @param entries - one `SessionEventWindow['entries']`.
 * @returns the facts per slice, keyed by the turn's start seq; slices with no
 *   evidence of their own are absent.
 */
/** One pass over the window: each turn's events, and the prompt that opened it. */
interface Scan {
  /** The turns' slices, keyed by the `turn/start` seq that identifies them. */
  readonly slices: ReadonlyMap<number, SessionEvent[]>
  /** Each slice's prompt, or null when it never carried one. */
  readonly prompts: ReadonlyMap<number, string | null>
}

/**
 * Group a window into per-turn slices, claiming each prompt for its own turn.
 *
 * Split out of {@link foldTurnFacts} when export arrived and needed the same two
 * things: the export path asks for a turn's raw events and its full prompt, which
 * the facts themselves deliberately do not carry. One implementation, two
 * consumers — the alternative is the exact drift this project keeps finding in
 * hindsight, where a grouping rule exists twice and only one of them was updated.
 *
 * The rules below are the load-bearing part, and they were each measured; see
 * {@link foldTurnFacts} for why the prompt is claimed rather than pushed, and why
 * slices are keyed by seq.
 * @param entries - one `SessionEventWindow['entries']`.
 * @returns the slices and their prompts.
 */
function scan(entries: readonly SessionEventLikeEntry[]): Scan {
  const slices = new Map<number, SessionEvent[]>()
  const prompts = new Map<number, string | null>()
  let pendingPrompt: string | null = null
  let current: number | null = null
  for (const entry of entries) {
    // Client-only live chunks interleave with the durable events and carry no
    // part of a turn's evidence.
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'user/message') {
      // Held here, not pushed into a slice: a prompt is appended to the log BEFORE
      // the `turn/start` that answers it, and both folds below would reject a slice
      // carrying events of the previous turn.
      //
      // Only a message the reader typed may SET the prompt, and none may clear it:
      // injected context usually follows the prompt, so overwriting with its null
      // would leave every row labelled with a system reminder.
      const typed = promptOf(event.data)
      if (typed !== null) {
        // An open slice claims it: the prompt sits INSIDE the turn it belongs to
        // (measured — with the buffer-only rule every row showed the PREVIOUS
        // turn's prompt while the times were right), and only a prompt seen between
        // turns is held for the next start.
        if (current !== null) prompts.set(current, typed)
        else pendingPrompt = typed
      }
      continue
    }
    if (event.type === 'turn/start') {
      // Keyed by the START EVENT'S SEQ, never by its turn number.
      //
      // A log can carry turns whose numbers repeat — a spliced-in segment, a fork, a
      // nested run — and a number-keyed map does not merely lose one of them: the
      // second start's events are appended to the FIRST one's slice, the usage fold
      // then sees events after `turn/end`, fails closed, and takes BOTH turns down
      // with it. Half a session's turns can vanish that way, which is what a table
      // reporting 11 of 22 looked like while the window held all 22.
      current = event.seq
      // The turn's own start belongs IN its slice: the usage fold validates the
      // lifecycle and fails closed for a window that does not open with it, so
      // dropping this event would make every turn's usage silently unknown.
      slices.set(current, [event])
      prompts.set(current, pendingPrompt)
      pendingPrompt = null
      continue
    }
    if (current === null) continue
    slices.get(current)?.push(event)
    // The turn's window CLOSES at its own end. The usage fold fails closed for
    // anything it sees after `turn/end`, and what follows belongs to the next turn
    // anyway — a prompt is appended BEFORE that turn's `turn/start`, so a slice
    // that ran until the next start would swallow it and invalidate the turn.
    if (event.type === 'turn/end') current = null
  }
  return { slices, prompts }
}

/**
 * Fold one loaded event window into per-turn facts.
 *
 * Everything about a slice's boundaries, identity and prompt is settled by
 * {@link scan}; this half adds the usage fold, the route, the wall span and the
 * prompt. It deliberately does NOT carry the raw events or the reply texts: those
 * are what the export path reads, and keeping them here would hold the whole
 * transcript in memory for a table that never shows a word of it.
 * @param entries - one `SessionEventWindow['entries']`.
 * @returns the facts per slice, keyed by the turn's start seq; slices with no
 *   evidence of their own are absent.
 */
export function foldTurnFacts(entries: readonly SessionEventLikeEntry[]): ReadonlyMap<number, TurnFacts> {
  const { slices, prompts } = scan(entries)
  const facts = new Map<number, TurnFacts>()
  for (const [key, events] of slices) {
    const usage = deriveTurnTokenUsage(events) ?? null
    // The slice opens with `turn/start` and closes with `turn/end`, so the span is
    // the two ends' own timestamps — no clock is read here.
    const started = events[0]?.time
    const closed = events.at(-1)
    // Two sources, in the order that keeps this plugin agreeing with the rest of
    // the product:
    //
    //   1. the host's own fold, `usage.routes` — what the turn's usage dialog shows;
    //   2. the turn's assistant message, for a turn the fold cannot finish yet.
    //
    // There used to be a third: the `request/context` metadata logged before a turn.
    // It was wrong often enough to remove — it is written only when a ROUTE CHANGES,
    // so a turn that reused the previous route showed that route, and one that
    // switched showed the route it had switched AWAY from (measured: a turn running
    // on `deepseek-flash` reported `deepseek-v4-pro`, the route of the turn before
    // it). A turn still in flight now reads as unknown, which is what it is.
    const folded = lastRouteOf(usage)
    const fromMessage = routeFromMessage(events)
    facts.set(key, {
      seq: key,
      route: folded ?? fromMessage,
      routeSource: folded !== null ? 'usage' : (fromMessage === null ? null : 'message'),
      cacheHit: turnCacheHitOf(usage),
      usage,
      busyMs: started === undefined || closed?.type !== 'turn/end'
        ? null
        : Math.max(0, closed.time - started),
      startedAt: started ?? null,
      prompt: prompts.get(key) ?? null,
    })
  }
  return facts
}

/** One turn's own material, for export: what it said, and what was said back. */
export interface TurnSource {
  /** The turn's identity: the seq of its own `turn/start`. */
  readonly seq: number
  /** The turn's raw events, `turn/start` to `turn/end` inclusive. */
  readonly events: readonly SessionEvent[]
  /** The prompt that opened it, whole, or null when it never carried one. */
  readonly prompt: string | null
  /** Every assistant message's text, in order — one per step of the turn. */
  readonly responses: readonly string[]
}

/**
 * The turns' own material, for export.
 *
 * A separate read from {@link foldTurnFacts} on purpose. The table wants numbers
 * and never a word of prose; the export wants the prose and, for its raw form,
 * the events themselves. Folding them into one structure would make every render
 * pay for data only a click ever reads.
 *
 * The prompt here is the WHOLE prompt — the table's row shows a truncated preview,
 * and truncation is a view concern that lives in the table, so a reader who asks
 * for the conversation gets the conversation rather than what fitted in a cell.
 * @param entries - one `SessionEventWindow['entries']`.
 * @returns the sources per turn, keyed by the turn's start seq.
 */
export function turnSourcesOf(entries: readonly SessionEventLikeEntry[]): ReadonlyMap<number, TurnSource> {
  const { slices, prompts } = scan(entries)
  const sources = new Map<number, TurnSource>()
  for (const [key, events] of slices) {
    sources.set(key, {
      seq: key,
      events,
      prompt: prompts.get(key) ?? null,
      responses: responsesOf(events),
    })
  }
  return sources
}

/** Every assistant reply in one slice, in order; non-text blocks are skipped. */
function responsesOf(events: readonly SessionEvent[]): readonly string[] {
  const responses: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const text = assistantTextOf(event.data)
    if (text !== '') responses.push(text)
  }
  return responses
}

/**
 * The text one assistant message carries, its text blocks concatenated in order.
 *
 * Narrowed by hand rather than through `AssistantMessageData`: that type declares
 * only the `source` this module reads elsewhere, and the message body is wire
 * data here — the same treatment `ui-chat` gives the same payload.
 */
function assistantTextOf(data: unknown): string {
  const content = (data as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type !== 'text' || typeof typed.text !== 'string') continue
    // Streamed fragments arrive as separate blocks and are meant to be read as
    // one string; inserting anything between them would invent spacing the model
    // never sent.
    text += typed.text
  }
  return text
}

/**
 * Build the whole-map fold over one event source, re-running it only when the
 * window actually moved.
 *
 * A dashboard reads every turn at once, and the fold is O(events) plus a usage
 * aggregation per turn — far too much to redo on every redraw. `revision` is the
 * window's own change counter, so one integer comparison answers "has anything
 * moved", and because `entries` is a lazily materialised getter an unchanged
 * revision does not even pay for the list.
 * @param source - the binding's event source.
 * @returns a function yielding every turn's facts, valid until the window moves.
 */
function memoisedFold(source: SessionEventSource): () => ReadonlyMap<number, TurnFacts> {
  let revision = -1
  let byTurn: ReadonlyMap<number, TurnFacts> = new Map()
  return () => {
    const window = source.getSnapshot()
    if (window.revision !== revision) {
      revision = window.revision
      byTurn = foldTurnFacts(window.entries)
    }
    return byTurn
  }
}

/**
 * One fold per event source.
 *
 * Keyed weakly by the source rather than held in a field, so a binding that goes
 * away takes its fold with it.
 */
const folds = new WeakMap<SessionEventSource, () => ReadonlyMap<number, TurnFacts>>()

/**
 * Every turn's facts for one session binding.
 * @param source - the binding's event source.
 * @returns a lookup, reused across calls for the same source.
 */
export function turnFactsOf(source: SessionEventSource): () => ReadonlyMap<number, TurnFacts> {
  const existing = folds.get(source)
  if (existing !== undefined) return existing
  const fold = memoisedFold(source)
  folds.set(source, fold)
  return fold
}

/**
 * Every turn's own material for one session binding — the export path's read.
 *
 * Deliberately NOT memoised, unlike {@link turnFactsOf}. This is read only when a
 * reader exports, and caching a transcript's worth of events for the life of a
 * binding would trade real memory for a cost no render ever pays; re-scanning on
 * the click is the cheap side of that trade.
 * @param source - the binding's event source.
 * @returns the sources per turn, keyed by the turn's start seq.
 */
export function turnSourcesFor(source: SessionEventSource): ReadonlyMap<number, TurnSource> {
  return turnSourcesOf(source.getSnapshot().entries)
}

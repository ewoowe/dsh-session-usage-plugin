/**
 * Session-wide facts for the overlay's header and the viewport strip: the totals,
 * and the cache-hit share.
 *
 * They ride the client session's own projection faces rather than the rendered
 * transcript. That is the same reason the message list reads the DOM and this
 * does not: a third-party plugin cannot reach `ui-chat`'s node store, but
 * `ISession.projections` is a public read face, and these projections are
 * Host-computed over the WHOLE log — paging the window in or compacting it
 * cannot change them. Reading numbers also avoids parsing formatted text
 * (a compact `1.2K`) back into the value it was printed from.
 *
 * The MODEL is not here: a strip readout belongs to a turn rather than to the
 * session, and it comes from the session's event window instead (`turn-models.ts`).
 *
 * Granularity is worth stating plainly, because the strip mixes two: a turn's
 * usage and duration come from that turn's own tail pills, while everything
 * here is SESSION-wide.
 *
 * Those two numbers ARE reachable over a public API — a `conversation.chat.node`
 * occupant is handed its `ChatNode` plus a `useTurnData` hook, enough to read
 * that Turn's `TurnTokenUsage` and derive its wall time from
 * `node.location.turn.start/end`. But the hook is scoped to the ONE turn that
 * node renders, and this plugin cannot take such a seat: the slot's keys are
 * ui-chat's own `ChatNodeKind`s, and occupying one REPLACES ui-chat's renderer.
 * The list needs EVERY turn and the strip needs whichever turn sits under the
 * fold, so the tail pills stay the only source that answers "any turn, both
 * numbers" — at the price of reading formatted text rather than numbers.
 *
 * Formatting follows the host's own conventions so these figures read like the
 * rest of the product: the same compact token count, the same `45.2s` / `2m42s`
 * duration, and the host's own cache-hit format — reproduced rather than
 * re-derived, so the strip and the composer's session pills cannot print two
 * different numbers for one projection (see {@link formatCacheHitPercent}).
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessagesKey } from './locales.ts'

/** The projection read face this module needs; see `ISession['projections']`. */
export interface ProjectionsFaceLike {
  /** The identity-stable bare observable for one projection key. */
  faceOf(key: string): { getSnapshot(): unknown }
}

/** Session totals the header renders. */
export interface SessionTotals {
  /** Summed model request plus tool wall time, in milliseconds. */
  readonly busyMs: number
  /** Billed input (uncached + cache read + cache write) plus output tokens. */
  readonly totalTokens: number
  /** Cache reads as a share of billed input, as display text; null when nothing was billed. */
  readonly cacheHitPercent: string | null
  /**
   * Completed turns the host counted for the whole session.
   *
   * The per-model table can only cover the session's LOADED event window, so this
   * is what turns a partial table into a stated one: the view reports how many of
   * these turns it actually folded.
   */
  readonly turns: number
}

/** The `sessionStats` projection's view fields this module reads. */
interface SessionStatsView {
  llmMs?: number
  toolMs?: number
  turns?: number
}

/** The `tokenUsage` projection's view fields this module reads. */
interface TokenUsageView {
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Display-ready cache-hit share, reproduced from the host.
 *
 * This is `formatCacheHitPercent` from ui-chat's `token-format.ts`, ported rather
 * than re-derived: the strip and the composer's session pills print this same
 * figure from this same projection, so a second implementation that rounds
 * differently makes the product look like it disagrees with itself — `99.8%`
 * above `99%`, both claiming to be the session's cache hit.
 *
 * What the host's rule buys is honesty about a near-full hit. The session prints
 * whole percents, which would round a partial hit up to `100%`; instead of
 * clamping the value the host spends extra decimals on it, yielding the `99.6` /
 * `99.95` shape — a number that is both true and visibly short of a full hit.
 * The units arithmetic is integer-only, so a tie rounds up the way a reader
 * expects without float drift on large token counts.
 *
 * `displayPercentUnits` keeps the trailing `.0` off: `99` reads as a whole
 * percent, never as `99.0`.
 * @param cacheReadTokens - prompt tokens served from cache.
 * @param promptTokens - billed prompt tokens (the three input buckets summed).
 * @param decimalPlaces - ordinary precision; a near-full hit earns more.
 * @returns the percentage text, or null when nothing was billed.
 */
function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens <= 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'

  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces)

  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
}

/** Percentage units (hundredths or tenths of a percent) with ties rounded up. */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
  const scale = unitsPerPercent * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil(factor * denominatorRemainder / doubledScale)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

/** Units as text, with the decimal part dropped when it is zero. */
function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`
}

/**
 * Read the session's totals from its projections.
 * @param projections - the owning session's projection read face.
 * @returns the totals, or null when the host served neither projection.
 */
export function readSessionTotals(projections: ProjectionsFaceLike): SessionTotals | null {
  const stats = projections.faceOf('sessionStats').getSnapshot() as SessionStatsView | undefined
  const usage = projections.faceOf('tokenUsage').getSnapshot() as TokenUsageView | undefined
  if (stats === undefined && usage === undefined) return null
  return {
    busyMs: (stats?.llmMs ?? 0) + (stats?.toolMs ?? 0),
    totalTokens: billedInputOf(usage) + (usage?.outputTokens ?? 0),
    cacheHitPercent: cacheHitOfUsage(usage),
    turns: stats?.turns ?? 0,
  }
}

/** Billed prompt tokens: the three disjoint input buckets, summed. */
function billedInputOf(usage: TokenUsageView | undefined): number {
  return (usage?.uncachedInputTokens ?? 0)
    + (usage?.cacheReadTokens ?? 0)
    + (usage?.cacheWriteTokens ?? 0)
}

/**
 * Cache-hit share of one `tokenUsage` view, or null when nothing was billed.
 *
 * Exposed over the raw view, not over a face, because the viewport strip reads
 * its projections through the slot's standard `useProjection` seat: that read is
 * reactive, so the field appears the moment the Host publishes it instead of
 * waiting for the next poll, and it cannot come back empty just because the
 * frame loop happened to run before the session binding existed.
 * @param value - the projection's view, or undefined while the unit is absent.
 * @returns the share to print, or null.
 */
export function cacheHitOfUsage(value: unknown): string | null {
  const usage = value as TokenUsageView | undefined
  return formatCacheHitPercent(usage?.cacheReadTokens ?? 0, billedInputOf(usage))
}

/** The `TurnTokenUsage` fields this module reads. */
interface TurnUsageView {
  readonly cacheReadTokens?: number
  readonly outputTokens: number
  readonly totalTokens: number
}

/**
 * Cache-hit share of ONE turn, at the precision the host's own turn dialog uses.
 *
 * Same formatter as the session figure, and the same expression `TurnUsagePanel`
 * builds it from — `totalTokens - outputTokens` is the billed prompt side — but
 * one decimal rather than the session's none, because that is the precision the
 * host itself chose for a single turn. Matching both the algorithm and the
 * precision is what lets the strip and that dialog agree character for character.
 * @param usage - a turn's folded `TurnTokenUsage`, or undefined when the turn is
 *   still running or its evidence is incomplete.
 * @returns the percentage text, or null when the turn carries no cache evidence.
 */
export function turnCacheHitOf(usage: unknown): string | null {
  // A turn with no usable usage arrives as null as often as undefined — the fold
  // that calls this normalises "absent" to null — so both have to be rejected
  // here. Guarding only `undefined` turns an unfinished turn into a crash inside
  // the table's own render.
  const view = usage as TurnUsageView | null | undefined
  if (view === null || view === undefined || view.cacheReadTokens === undefined) return null
  return formatCacheHitPercent(view.cacheReadTokens, view.totalTokens - view.outputTokens, 1)
}

/** One decimal below a hundred, whole numbers from there, as the host scales them. */
function scaled(candidate: number): string {
  return candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
}

/**
 * Compact token count: `517` / `12.2K` / `517K` / `1.2M`.
 * @param value - non-negative token count.
 * @param t - this plugin's locale seat.
 * @returns the display string.
 */
export function formatCompactTokens(value: number, t: Translate<MessagesKey>): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('numberThousand', { value: scaled(value / 1_000) })
  return t('numberMillion', { value: scaled(value / 1_000_000) })
}

/**
 * Compact duration: `45.2s` under a minute, `2m42s` from there on.
 * @param ms - duration in milliseconds.
 * @param t - this plugin's locale seat.
 * @returns the display string.
 */
export function formatCompactDuration(ms: number, t: Translate<MessagesKey>): string {
  const seconds = ms / 1_000
  if (seconds < 60) return t('durationSeconds', { seconds: Math.round(seconds * 10) / 10 })
  const whole = Math.round(seconds)
  return t('durationMinutes', { minutes: Math.floor(whole / 60), seconds: whole % 60 })
}

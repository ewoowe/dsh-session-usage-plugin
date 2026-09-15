/**
 * Per-model usage for one session, folded from its loaded event window.
 *
 * The projections answer usage questions only at SESSION scope (`tokenUsage`,
 * `sessionStats`), and per-turn data has no projection at all, so the grouping
 * happens here — over each turn's facts, which carry that turn's own model and the
 * usage the host itself folded for it (`deriveTurnTokenUsage`). The counting rules
 * therefore stay the host's, exactly as they do in the strip of
 * `session-messages-plugin`: which events count, when a final message supersedes a
 * streaming sample, and that an incomplete turn yields nothing.
 *
 * Attribution is per TURN, not per attempt. A turn that retried across models is
 * credited wholly to the model that produced the reply, because splitting a turn's
 * totals across its routes would need per-attempt accounting the host's fold does
 * not expose — and inventing a second set of counting rules is how two surfaces end
 * up disagreeing.
 */
import { turnCacheHitOf, type SessionTotals } from './format.ts'
import type { ModelRoute, TurnFacts } from './turn-facts.ts'

/** One model's share of a session's usage. */
export interface ModelUsage {
  /** The model's own route; `provider` is empty when the turn did not name one. */
  readonly route: ModelRoute
  /** Completed turns attributed to this model. */
  readonly turns: number
  /** Summed wall span of those turns, in milliseconds. */
  readonly busyMs: number
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  /** Cache-hit share of this model's billed input, formatted as the host formats it. */
  readonly cacheHit: string | null
}

/** A mutable accumulator, so the fold stays one pass without rebuilding objects. */
interface Bucket {
  route: ModelRoute
  turns: number
  busyMs: number
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  totalTokens: number
}

/** The fields of a turn's usage this module sums. */
interface UsageView {
  readonly uncachedInputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

/** The route a turn is attributed to; turns with no readable model share one bucket. */
function routeOfFacts(facts: TurnFacts): ModelRoute {
  return facts.route ?? { provider: '', model: '' }
}

/** Identity of a route, for grouping. */
function routeKey(route: ModelRoute): string {
  return `${route.provider}\u0000${route.model}`
}

/**
 * Fold per-turn facts into one row per model, largest first.
 *
 * Turns whose facts carry no usage are counted nowhere: they are still running, or
 * their events sit outside the loaded window, and a partial sum presented as a
 * total is the failure this whole arrangement exists to avoid.
 * @param byTurn - the session's per-turn facts, as `foldTurnFacts` produced them.
 * @returns one row per model, ordered by total tokens descending.
 */
export function foldUsageByModel(byTurn: ReadonlyMap<number, TurnFacts>): readonly ModelUsage[] {
  const buckets = new Map<string, Bucket>()
  for (const facts of byTurn.values()) {
    const usage = facts.usage as UsageView | null
    if (usage === null) continue
    const route = routeOfFacts(facts)
    const key = routeKey(route)
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = {
        route,
        turns: 0,
        busyMs: 0,
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }
      buckets.set(key, bucket)
    }
    bucket.turns += 1
    bucket.busyMs += facts.busyMs ?? 0
    bucket.uncachedInputTokens += usage.uncachedInputTokens ?? 0
    bucket.cacheReadTokens += usage.cacheReadTokens ?? 0
    bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    bucket.outputTokens += usage.outputTokens ?? 0
    bucket.totalTokens += usage.totalTokens ?? 0
  }

  return [...buckets.values()]
    .map((bucket): ModelUsage => ({
      ...bucket,
      // The same expression the host's turn dialog uses: the billed prompt side is
      // `total − output`, and the precision is the per-turn one.
      cacheHit: turnCacheHitOf({
        cacheReadTokens: bucket.cacheReadTokens,
        outputTokens: bucket.outputTokens,
        totalTokens: bucket.totalTokens,
      }),
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens)
}

/**
 * The session totals, folded from a set of turns rather than read from the
 * projection.
 *
 * A time range needs this. The projection answers "what has this session spent"
 * over the WHOLE log, and no projection carries a time dimension, so "this
 * session, today" has no source but the turns themselves. The three figures are
 * the same three the projection sums — billed input, output, wall time — and the
 * cache share is derived from the SUMS through the same expression the per-model
 * rows and the host's own turn dialog use.
 *
 * **The share of a sum is not the average of shares.** Averaging per-turn
 * percentages would let a turn with 3 tokens weigh as much as one with 300k, and
 * the figure would disagree with the host's own arithmetic on the same data.
 *
 * `turns` counts the turns that actually carry usage, matching what the
 * projection means by its own `turns` field: a turn the host's fold refuses to
 * compute is not one of them, which is also what makes the coverage line's
 * arithmetic work out.
 * @param turns - the turns inside the range, as the view's fold produced them.
 * @returns the same shape the view renders for the whole session.
 */
export function totalsOf(turns: readonly TurnFacts[]): SessionTotals {
  let cacheRead = 0
  let output = 0
  let total = 0
  let busyMs = 0
  let counted = 0
  for (const turn of turns) {
    const usage = turn.usage
    if (usage !== null) {
      cacheRead += usage.cacheReadTokens ?? 0
      output += usage.outputTokens ?? 0
      total += usage.totalTokens ?? 0
      counted += 1
    }
    if (turn.busyMs !== null) busyMs += turn.busyMs
  }
  return {
    busyMs,
    totalTokens: total,
    cacheHitPercent: turnCacheHitOf({ cacheReadTokens: cacheRead, outputTokens: output, totalTokens: total }),
    turns: counted,
  }
}

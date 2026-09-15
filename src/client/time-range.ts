/**
 * The time ranges the usage view can be narrowed to.
 *
 * A range is a question about THIS session's turns, not about the tool's whole
 * history. The view already reads one session's projections and one event
 * window, and a client plugin cannot reach the rest — the host-side session
 * query has no remote endpoint — so "today" here means "how much of this
 * conversation was spent today", which is the question a reader looking at one
 * session can act on.
 *
 * The bounds are deliberately not the same shape, and each shape is the reader's
 * own words:
 *
 * - Today starts at local midnight: a calendar day, because that is what "today"
 *   names.
 * - The last day is a ROLLING 24 hours, not yesterday's midnight. It answers
 *   "how much has this just cost me", and the reader spells it out as "from this
 *   time yesterday".
 * - Yesterday is the ONE closed range: local midnight to local midnight, both
 *   ends. It has an upper bound because it is the one range that does not run to
 *   now — "the last three days" includes today, while "yesterday" must not, and a
 *   lower bound alone would quietly swallow everything since.
 * - Three and seven days start at local midnight that many days back — calendar
 *   days again, which is how a reader parses "the last three days".
 *
 * Local midnight comes from the platform's own calendar (`setHours`/`setDate`),
 * never from arithmetic on the epoch: month and year lengths, and zones that
 * shift their offset, are the platform's problem, and subtracting
 * `n * 86_400_000` gets both of them wrong twice a year.
 */

/** The ranges a reader can pick, in the order they are offered. */
export type RangeKey = FixedRangeKey | 'custom'

/**
 * The ranges this module can compute on its own.
 *
 * `custom` is deliberately NOT one of them: its ends come from the reader, so
 * there is no function of `now` that yields them. Keeping it out of this type is
 * what makes passing it to {@link rangeWindow} a compile error rather than a
 * silently empty window.
 */
export type FixedRangeKey = 'session' | 'today' | 'day' | 'yesterday' | 'days3' | 'days7'

/** Every range, in presentation order: yesterday after the last day, custom last. */
export const RANGE_KEYS: readonly RangeKey[] = [
  'session', 'today', 'day', 'yesterday', 'days3', 'days7', 'custom',
]

/** A span the reader chose: the two ends a custom range was set to. */
export interface CustomRange {
  /** Inclusive start, epoch milliseconds. */
  readonly from: number
  /** Exclusive end, epoch milliseconds, or null for "until now". */
  readonly to: number | null
}

/** A range's two ends, either of which may be open. */
export interface RangeWindow {
  /** Inclusive lower bound, or null for the whole session. */
  readonly from: number | null
  /**
   * EXCLUSIVE upper bound, or null when the range runs to now.
   *
   * Exclusive so that "yesterday" and "today" meet without overlapping: the
   * instant that opens today is the instant that closes yesterday, and a turn
   * starting exactly at midnight belongs to today alone.
   */
  readonly to: number | null
}

/** Milliseconds in a day, for the one rolling bound. */
const DAY_MS = 86_400_000

/**
 * Local midnight at the start of the day `now` falls in.
 * @param now - epoch milliseconds to place on the calendar.
 * @returns epoch milliseconds of that day's 00:00 local.
 */
function startOfDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Local midnight `days` calendar days before the day `now` falls in.
 *
 * `setDate` with a negative offset rolls the month and year over by itself, so
 * "three days before the 2nd of March" lands on the 27th of February without
 * this module knowing anything about February.
 * @param now - epoch milliseconds to place on the calendar.
 * @param days - how many days back to step.
 * @returns epoch milliseconds of that day's 00:00 local.
 */
function startOfDaysAgo(now: number, days: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - days)
  return date.getTime()
}

/**
 * The two instants a range spans.
 *
 * `now` is a parameter rather than read from the clock inside, so the bounds can
 * be pinned without waiting for a particular minute of a particular day.
 * @param key - the range to resolve.
 * @param now - the current instant, in epoch milliseconds.
 * @returns the bounds; both null for the whole session, `to` null for every
 * range that runs to the present.
 */
export function rangeWindow(key: FixedRangeKey, now: number): RangeWindow {
  switch (key) {
    case 'session': return { from: null, to: null }
    case 'today': return { from: startOfDay(now), to: null }
    case 'day': return { from: now - DAY_MS, to: null }
    // The one closed range: local midnight yesterday up to local midnight today.
    case 'yesterday': return { from: startOfDaysAgo(now, 1), to: startOfDay(now) }
    case 'days3': return { from: startOfDaysAgo(now, 3), to: null }
    case 'days7': return { from: startOfDaysAgo(now, 7), to: null }
  }
}

/**
 * An epoch instant as the text a `datetime-local` input holds, in the BROWSER's
 * own zone.
 *
 * Not `toISOString().slice(0, 16)`: that prints UTC, so a reader anywhere else
 * would see the field jump hours away from the time they picked — and pressing
 * the field again would move the range a second time. The `get*` accessors are
 * local by definition, which is the zone every other bound in this module is
 * built in.
 * @param at - epoch milliseconds.
 * @returns `YYYY-MM-DDTHH:mm`, the one form the input accepts.
 */
export function toLocalInput(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The instant a `datetime-local` value names, or null when it names none.
 *
 * `new Date('2026-03-02T15:30')` carries no zone designator, and that form is
 * DEFINED to be local time — the one parsing rule this function rests on. A
 * cleared field arrives as `''`, which `Date` reads as an invalid date rather
 * than as midnight, so the empty case is handled rather than left to fall out.
 * @param text - the input's raw value.
 * @returns epoch milliseconds, or null for an empty or unparsable field.
 */
export function parseLocalInput(text: string): number | null {
  if (text === '') return null
  const at = new Date(text).getTime()
  return Number.isFinite(at) ? at : null
}

/**
 * Read a stored range back.
 *
 * A value this version does not have — an older or newer build, or a hand-edited
 * entry — falls back to the whole session, which is the view's own default and
 * the only range that is always meaningful.
 * @param text - the raw stored string, or null when nothing is stored.
 * @returns the range, defaulting to the whole session.
 */
export function parseRange(text: string | null): RangeKey {
  if (text === null) return 'session'
  try {
    const raw: unknown = JSON.parse(text)
    return RANGE_KEYS.includes(raw as RangeKey) ? (raw as RangeKey) : 'session'
  } catch {
    return 'session'
  }
}

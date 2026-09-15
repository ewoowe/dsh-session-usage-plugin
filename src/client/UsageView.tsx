/**
 * The usage view: what this session has spent, read two ways.
 *
 * One tab, two leaves — per model and per message — because they answer the same
 * question at two resolutions, and a reader comparing them should not have to
 * remember which of two sibling tabs they were just in. The container owns the
 * fold, the coverage, the polling and the shared totals; the tables are
 * presentational, so nothing here can drift from nothing there.
 *
 * Two sources, and the split is the point. The totals come from the client
 * session's projections — Host-computed over the WHOLE log, so paging the window
 * in or compacting it cannot move them. The per-turn detail cannot come from
 * there, because no projection carries a model or turn dimension; it is folded
 * from the session's own event window, with the usage counting left to the host's
 * own fold so these figures cannot drift from a tail clock or a turn dialog.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { Coverage } from './Coverage.tsx'
import {
  downloadText, exportFileName, transcriptJsonl, transcriptMarkdown, usageCsv, usageJson,
  type ExportInput, type ExportTurn,
} from './export.ts'
import { formatCompactDuration, formatCompactTokens, type SessionTotals } from './format.ts'
import { NS, type MessagesKey } from './locales.ts'
import { MessageUsageTable } from './MessageUsageTable.tsx'
import { ModelUsageTable } from './ModelUsageTable.tsx'
import { useModelNameLookup } from './model-names.ts'
import {
  getCustomRange, useCustomRange, useLeaf, useRange, useScrollMemory, writeCustomRange, writeLeaf, writeRange,
} from './preferences.ts'
import { EMPTY_STYLE, ROOT_STYLE } from './table-styles.ts'
import {
  parseLocalInput, rangeWindow, RANGE_KEYS, toLocalInput, type RangeKey,
} from './time-range.ts'
import type { TurnFacts, TurnSource } from './turn-facts.ts'
import { foldUsageByModel, totalsOf } from './usage-by-model.ts'

/** The face this plugin injects into its own view registration. */
export interface UsageViewInjected {
  /** The session this view is showing; every export names itself after it. */
  readonly sessionId: string
  /** Every turn's facts for the viewing session, or null when no binding exists. */
  readonly turnFacts: () => ReadonlyMap<number, TurnFacts> | null
  /**
   * Every turn's own events, prompt and replies — what the exports read.
   *
   * A separate face from `turnFacts` on purpose: the table wants figures, the
   * export wants the prose and, for its raw form, the events themselves. Holding
   * both for every render would pay for one of them always and use it never.
   */
  readonly turnSources: () => ReadonlyMap<number, TurnSource> | null
  /** The session's own totals, or null while the projections are absent. */
  readonly sessionTotals: () => SessionTotals | null
  /**
   * Whether the session holds older events this window has not materialised.
   *
   * The per-turn detail can only fold what the window carries, so this is what
   * separates "this session used one model" from "one page of it did".
   */
  readonly hasOlder: () => boolean
  /**
   * Pull ONE page of older history in — the Session Controller's own pager.
   *
   * Used by the auto-load behind a time range, which can stop as soon as the
   * range is covered instead of loading history the range will then filter out.
   */
  readonly loadPage: () => Promise<void>
  /** Pull the REST of the session in, in one call: the coverage line's button. */
  readonly loadAll: () => Promise<void>
  /**
   * Make the composer inert with a reason, or clear it.
   *
   * The composer belongs to the shell, not to this view — a view cannot hide it,
   * and this is the only lever the contract offers. It is a SINGLE slot that other
   * plugins raise reasons in too (model selection blocks it when no route is
   * available), so this view raises its reason on the way in and clears it on the
   * way out, the same contract those plugins follow.
   */
  readonly blockComposer: (reason: string | null) => void
}

/** Full view props, as the registration supplies them. */
export type UsageViewProps =
  PropsRuntime<'conversation.view'> & PropsLocale<typeof NS> & UsageViewInjected

/**
 * How often the tables are re-read.
 *
 * A poll, because the fold behind these figures is memoised on the event window's
 * own revision: over an idle session one tick costs a single integer comparison,
 * and a dashboard has no interaction that a live push would improve.
 */
const REFRESH_MS = 2_000

/**
 * How many pages the range loader may pull before leaving the rest to the button.
 *
 * `loadOlder` brings 50 messages per call, so this is a 2000-message reach —
 * enough to cover any of the ranges on offer in a realistic session, and a hard
 * stop so that one click cannot start an unbounded run of round trips on a
 * session whose history is enormous. The one-shot full load sits beside it for
 * exactly that case.
 */
const MAX_RANGE_PAGES = 40

/** The copy key for each range, so the buttons can be built from `RANGE_KEYS`. */
const RANGE_LABEL: Record<RangeKey, MessagesKey> = {
  session: 'rangeSession',
  today: 'rangeToday',
  day: 'rangeDay',
  yesterday: 'rangeYesterday',
  days3: 'rangeDays3',
  days7: 'rangeDays7',
  custom: 'rangeCustom',
}

export function UsageView({
  sessionId, turnFacts, turnSources, sessionTotals, hasOlder, loadPage, loadAll, blockComposer, t,
}: UsageViewProps): ReactNode {
  const [, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  // Remembered, not merely held: both leaves are conditionally rendered, so a
  // reader coming back to the per-message table would otherwise have to find the
  // leaf again on every visit.
  const leaf = useLeaf()
  // Remembered for the same reason, and it is the one preference whose meaning
  // moves: it is relative to NOW, so "today" answers for today whenever the view
  // is opened rather than for the day it was picked.
  const range = useRange()
  const custom = useCustomRange()
  // Opening "custom" with an empty form would show an empty table until both
  // fields are filled, so it starts on today and the reader moves whichever end
  // they came to change.
  const selectRange = (key: RangeKey): void => {
    writeRange(key)
    if (key === 'custom' && getCustomRange() === null) {
      writeCustomRange({ from: rangeWindow('today', Date.now()).from ?? Date.now(), to: null })
    }
  }
  // Same reason as the leaf above, one dimension further: the shell parks a
  // conversation area at the bottom, so a reader returning to a long table was
  // shown a different part of it every time.
  const root = useRef<HTMLDivElement>(null)
  useScrollMemory(root)
  useEffect(() => {
    const timer = window.setInterval(() => { setTick(value => value + 1) }, REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [])
  // There is nothing to type here, so the composer is made inert rather than left
  // inviting input that this view cannot show. It is not hidden — that is the
  // shell's chrome, and no view option reaches it — but a reader who lands here
  // and starts typing gets the reason instead of a silently ignored draft.
  useEffect(() => {
    blockComposer(t('composerBlocked'))
    return () => { blockComposer(null) }
  }, [blockComposer, t])
  // Nothing here loads on the reader's behalf any more. A range says what the
  // figure covers, and a gap says what it cannot cover; paging MESSAGES in is a
  // decision with a cost the host cannot undo, so it is the reader's to make —
  // through the button the coverage line offers (see `fillRange`).

  const nameOf = useModelNameLookup()
  const facts = turnFacts()
  // Resolved per render, and this view re-renders on its own poll — so a range
  // moves without any subscription to the clock: "today" rolls over at local
  // midnight, and "24 hours" slides forward, both within one tick of happening.
  // A custom span comes from the reader, so no function of `now` yields it; the
  // fixed ranges resolve as before. While NO start is chosen the span is EMPTY
  // rather than open: showing the whole session halfway through filling the form
  // would read as the custom range being ignored.
  const { from, to } = range === 'custom'
    ? { from: custom?.from ?? Number.POSITIVE_INFINITY, to: custom?.to ?? null }
    : rangeWindow(range, Date.now())
  // The WINDOW's turns, unfiltered, in the fold's own order (oldest first).
  // Nothing renders this list: it is what a range narrows (`scoped` below), and
  // what the auto-load measures the window's oldest turn from. The name is load
  // bearing — handing this to a table instead of `scoped` has the same type and
  // reads as the range applying to everything except the rows.
  const windowTurns = facts === null ? [] : [...facts.values()]
  // The range narrows the TURNS, and everything downstream — both leaves, the
  // totals and the coverage — is computed from what is left, so no two surfaces
  // can end up describing different slices. A turn whose start is unknown is
  // outside every bounded range: it cannot be shown to be inside one.
  //
  // `to` is exclusive and open for every range but one: "yesterday" ends at the
  // midnight that begins today, so a turn starting exactly then is today's — the
  // two ranges meet without either claiming that instant twice.
  const scoped = from === null ? windowTurns : windowTurns.filter(turn => turn.startedAt !== null
    && turn.startedAt >= from && (to === null || turn.startedAt < to))
  const scopedFacts = from === null ? facts : new Map(scoped.map(turn => [turn.seq, turn]))
  // The whole session reads the projection, which the Host computes over the
  // WHOLE log — paging the window cannot move it. A range cannot use that: no
  // projection carries a time dimension, so it sums the same three figures from
  // its own turns instead, and is exact about the slice it describes rather
  // than right about a session it is not showing.
  const totals = from === null ? sessionTotals() : totalsOf(scoped)
  const models = scopedFacts === null || leaf !== 'models' ? [] : foldUsageByModel(scopedFacts)
  // Coverage is the same question for both leaves — one window, one answer — so it
  // is computed once here rather than inside each table. Under a range everything
  // counted is loaded by definition, so the "outside the window" part of the gap
  // falls to zero and that clause simply stops appearing.
  const covered = scoped.filter(turn => turn.usage !== null).length
  const total = from === null ? (totals?.turns ?? 0) : scoped.length
  const outside = Math.max(0, total - scoped.length)
  const withoutUsage = Math.max(0, scoped.length - covered)
  // The oldest turn in the window is the first one the fold produced: the map is
  // keyed by seq and filled in event order, so its first entry is the earliest.
  const oldest = windowTurns[0]?.startedAt ?? null
  // Under a range the counts above cannot see past the window — `total` IS the
  // window — so a range reaching back further than the loaded history has to
  // report that itself, or a reader narrowing to "7 days" would see a short table
  // and no sign that it is short. This is also the signal the auto-load reads.
  const olderUnloaded = from !== null && hasOlder() && (oldest === null || oldest > from)
  // An empty table has two causes and they need different words: a session with
  // no turns, and a range — or a half-filled custom form — that simply holds
  // none. "This session has no turns yet" is false in the second case.
  const emptyText = from === null && to === null ? t('empty') : t('rangeEmpty')

  /**
   * Everything the exports need, assembled from what is on screen.
   *
   * Built at click time rather than held: the turns' own events and prose are not
   * what a render wants, and asking for them only here means the table never pays
   * for them. What it exports is exactly what it shows — same range, same order,
   * same turns — because a file that disagrees with the view it came from is worse
   * than no file.
   */
  const exportInput = (): ExportInput | null => {
    const sources = turnSources()
    if (sources === null) return null
    const turns: ExportTurn[] = []
    for (const facts of scoped) {
      const source = sources.get(facts.seq)
      if (source !== undefined) turns.push({ facts, source })
    }
    return { sessionId, range, from, to, turns, totals, t, now: Date.now() }
  }

  /**
   * Write one of the four files out.
   *
   * The three parts of each format — text, extension, media type — are decided
   * together, because they have to agree: a JSON body under a `.csv` name is a
   * file that opens in the wrong program with a confusing error.
   */
  const onExport = (kind: 'csv' | 'json' | 'md' | 'jsonl'): void => {
    const input = exportInput()
    if (input === null) return
    const [text, extension, mime] = kind === 'csv'
      ? [usageCsv(input), 'csv', 'text/csv']
      : kind === 'json'
        ? [usageJson(input), 'json', 'application/json']
        : kind === 'md'
          ? [transcriptMarkdown(input), 'md', 'text/markdown']
          : [transcriptJsonl(input), 'jsonl', 'application/x-ndjson']
    downloadText(exportFileName(input, extension), text, mime)
  }

  /**
   * Page older history in until the window covers the range's start.
   *
   * Runs only when the reader asks, because what a page brings is MESSAGE BODIES
   * and the host cannot take them back: the window only ever grows, and the real
   * cost of "show me 7 days" is the loading it triggers, not the tables it draws.
   * One page is 50 messages — the smallest step the Session Controller offers —
   * and this is the exact loop: it stops the moment the oldest loaded turn is
   * older than the range, rather than overshooting to the session's beginning.
   *
   * Each round re-reads the window instead of trusting a captured snapshot (the
   * previous page has just changed it), and the loop is bounded by
   * {@link MAX_RANGE_PAGES}; the one-shot full load stays next to it for the
   * sessions that need more than one click's worth.
   */
  const fillRange = (): void => {
    // No lower bound — the whole session is already the span — so there is no gap
    // to close. Narrowing here also lets the loop below compare against a number.
    if (from === null) return
    void (async () => {
      setLoading(true)
      try {
        for (let page = 0; page < MAX_RANGE_PAGES; page += 1) {
          const facts = turnFacts()
          const windowOldest = facts === null ? null : (facts.values().next().value?.startedAt ?? null)
          // `from` is Infinity while a custom span has no start, which makes this
          // true and stops the loop: an unfinished form asks for nothing.
          if (!hasOlder() || windowOldest === null || windowOldest <= from) return
          await loadPage()
          setTick(value => value + 1)
        }
      } catch {
        // A page that fails leaves the table as it was and the button available;
        // there is nothing useful to add to whatever the host already reported.
      } finally {
        setLoading(false)
      }
    })()
  }
  const canLoad = hasOlder() && (from === null ? outside > 0 : olderUnloaded)

  return (
    // `data-conversation-composer-overlay` is the shell's own switch for "this
    // view is a full-bleed surface that scrolls itself": it hides the transcript
    // width handles (whose 40px strips were landing on this table's right-hand
    // figures and offering a drag nobody aimed at), lifts the composer into a
    // floating overlay, and hands the scrolling to this element — which is what
    // `ROOT_STYLE` is shaped for. Declared here rather than patched onto the
    // frame's DOM: the shell renders the whole mode off this one attribute, and
    // it goes away by itself when this view does.
    <div ref={root} style={ROOT_STYLE} data-conversation-composer-overlay="">
      {/* One row across the top: what slice to look at on the left, what to take
          away on the right. The range leads because the pills below it report that
          range — the other order reads as if the session's own figures were being
          filtered after the fact, which is the one thing they must not look like:
          under a range they are a different computation, not the same one
          narrowed. */}
      <div style={TOPBAR_STYLE}>
        <div style={SEGMENTS_STYLE}>
          {RANGE_KEYS.map(key => (
            <SegmentButton
              key={key}
              active={range === key}
              label={t(RANGE_LABEL[key])}
              onSelect={() => { selectRange(key) }}
            />
          ))}
        </div>
        {/* Two pairs rather than four buttons in a row: the first two hand back the
            FIGURES, the second two the CONVERSATION, and the gap between the groups
            is the only thing that says so. Disabled on an empty range, because a
            file with a header and nothing else is a worse answer than a button that
            says it has nothing to write. */}
        <div style={EXPORTS_STYLE}>
          <div style={SEGMENTS_STYLE}>
            <SegmentButton
              active={false}
              disabled={scoped.length === 0}
              label={t('exportCsv')}
              onSelect={() => { onExport('csv') }}
            />
            <SegmentButton
              active={false}
              disabled={scoped.length === 0}
              label={t('exportJson')}
              onSelect={() => { onExport('json') }}
            />
          </div>
          <div style={SEGMENTS_STYLE}>
            <SegmentButton
              active={false}
              disabled={scoped.length === 0}
              label={t('exportMd')}
              onSelect={() => { onExport('md') }}
            />
            <SegmentButton
              active={false}
              disabled={scoped.length === 0}
              label={t('exportJsonl')}
              onSelect={() => { onExport('jsonl') }}
            />
          </div>
        </div>
      </div>
      {/* Two `datetime-local` fields, so every instant is read and written in the
          reader's own zone — the same zone every fixed bound in the time-range
          module is built in. The end may be left empty, which means "until now",
          the open end the other ranges use. No clamping between them: a start
          after the end is an empty span, and the empty state says so. */}
      {range === 'custom' && (
        <div style={CUSTOM_STYLE}>
          <input
            type="datetime-local"
            aria-label={t('rangeFrom')}
            style={INPUT_STYLE}
            value={custom === null ? '' : toLocalInput(custom.from)}
            onChange={(event) => {
              const at = parseLocalInput(event.target.value)
              writeCustomRange(at === null ? null : { from: at, to: custom?.to ?? null })
            }}
          />
          <span>{t('rangeTo')}</span>
          <input
            type="datetime-local"
            aria-label={t('rangeUntil')}
            style={INPUT_STYLE}
            value={custom === null || custom.to === null ? '' : toLocalInput(custom.to)}
            onChange={(event) => {
              if (custom === null) return
              writeCustomRange({ from: custom.from, to: parseLocalInput(event.target.value) })
            }}
          />
        </div>
      )}
      {totals !== null && (
        <div style={CHIPS_STYLE}>
          <span style={CHIP_STYLE}>{t('tokensLabel', { value: formatCompactTokens(totals.totalTokens, t) })}</span>
          <span style={CHIP_STYLE}>{t('busyLabel', { value: formatCompactDuration(totals.busyMs, t) })}</span>
          {totals.cacheHitPercent !== null && (
            <span style={CHIP_STYLE}>{t('cacheLabel', { percent: totals.cacheHitPercent })}</span>
          )}
        </div>
      )}
      <div style={SEGMENTS_STYLE}>
        <SegmentButton active={leaf === 'models'} label={t('modelTitle')} onSelect={() => { writeLeaf('models') }} />
        <SegmentButton active={leaf === 'messages'} label={t('messageTitle')} onSelect={() => { writeLeaf('messages') }} />
      </div>
      {/* `scoped`, never `turns`: a range narrows the table as well as the figures
          above it. Passing the window's own list here is a mistake that cannot be
          caught by types — both are the same shape — and it reads as the range
          applying to everything except the rows. */}
      {leaf === 'models'
        ? (models.length === 0
            ? <div style={EMPTY_STYLE}>{emptyText}</div>
            : <ModelUsageTable models={models} nameOf={nameOf} t={t} />)
        : (scoped.length === 0
            ? <div style={EMPTY_STYLE}>{emptyText}</div>
            : <MessageUsageTable turns={scoped} nameOf={nameOf} t={t} />)}
      <Coverage
        covered={covered}
        total={total}
        outside={outside}
        withoutUsage={withoutUsage}
        olderUnloaded={olderUnloaded}
        onLoadRange={olderUnloaded ? fillRange : undefined}
        canLoad={canLoad}
        loading={loading}
        onLoad={() => {
          setLoading(true)
          void loadAll()
            .then(() => { setTick(value => value + 1) })
            .catch(() => undefined)
            .finally(() => { setLoading(false) })
        }}
        t={t}
      />
    </div>
  )
}

/** One choice in a segmented control: a leaf, a time range, or an export. */
function SegmentButton({ active, label, onSelect, disabled = false }: {
  readonly active: boolean
  readonly label: string
  readonly onSelect: () => void
  readonly disabled?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onSelect}
      style={{ ...SEGMENT_STYLE(active), ...(disabled ? DISABLED_STYLE : {}) }}
    >
      {label}
    </button>
  )
}

/** The custom range's two fields, on a line of their own under the buttons. */
const CUSTOM_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
}

/**
 * A native date-time field, coloured from the shell's own tokens.
 *
 * Deliberately no `color-scheme` override: the browser draws the picker and its
 * icon, and forcing a scheme would fight a reader who runs the other one. The
 * tokens above are what every other surface here uses, so the field matches the
 * page in either.
 */
const INPUT_STYLE: CSSProperties = {
  padding: '3px 6px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 12,
}

/**
 * The view's top row: the range on the left, the exports on the right.
 *
 * The right alignment is `margin-left: auto` on the exports rather than
 * `justify-content` on the row. On a narrow column the groups wrap, and
 * space-between would then leave the second line flush LEFT — which is the one
 * place a reader does not look for "take this away". An auto margin keeps them
 * right whatever the column does.
 */
const TOPBAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 8,
}

/** The two export groups: a wider gap than inside a group, so they read as pairs. */
const EXPORTS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
  marginLeft: 'auto',
}

/** A segment with nothing to do: dimmed, and the pointer says so too. */
const DISABLED_STYLE: CSSProperties = {
  opacity: 0.45,
  cursor: 'default',
}

const CHIPS_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 }

const CHIP_STYLE: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2)',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

/**
 * One segmented control. `flexWrap` is here for the range row: five labels, two
 * of them spelled out ("24 hours"), do not fit a narrow column on one line, and
 * a wrapped row is legible where a clipped one is not.
 */
const SEGMENTS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  alignSelf: 'flex-start',
}

/**
 * The active leaf inverts, the way this plugin's primary buttons do everywhere
 * else; the inactive one keeps the strip's own background so the pair reads as one
 * control rather than as two buttons.
 */
function SEGMENT_STYLE(active: boolean): CSSProperties {
  return {
    padding: '3px 10px',
    border: 'none',
    borderRadius: 6,
    background: active ? 'var(--dsw-alias-label-primary)' : 'transparent',
    color: active ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    cursor: 'pointer',
  }
}

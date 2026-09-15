/**
 * The per-message table: one row per TURN, in the order they happened.
 *
 * A row is a turn, not a message in the transcript sense. An assistant reply
 * belongs to the same turn as the prompt that asked for it and shares its usage,
 * so listing messages individually would count every token once per message in the
 * exchange — the one arithmetic mistake a usage table cannot afford. The row is
 * therefore identified by the prompt that started the turn.
 *
 * A turn the host's fold refuses to compute still gets a row, with dashes: hiding
 * it would make the row count disagree with the turn count the coverage line
 * reports.
 *
 * The rule for ordering is a view concern and lives here — the container's list
 * stays in the window's own order, which is the order the session actually ran
 * in. WHICH rule is in force is the reader's preference and lives in
 * `sort-preference.ts`, so leaving the view and coming back does not reset it.
 */
import { useMemo, type CSSProperties, type ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { formatCompactDuration, formatCompactTokens } from './format.ts'
import type { MessagesKey } from './locales.ts'
import { nameFor } from './ModelUsageTable.tsx'
import type { ModelNameLookup } from './model-names.ts'
import { getSort, useSort, writeSort, type Sort, type SortKey } from './preferences.ts'
import {
  CELL_LEFT_STYLE, CELL_NUM_STYLE, CELL_TEXT_STYLE, HEAD_LEFT_STYLE, HEAD_NUM_STYLE, TABLE_STYLE,
} from './table-styles.ts'
import type { TurnFacts } from './turn-facts.ts'

export interface MessageUsageTableProps {
  /** In the order the window produced them, which is chronological. */
  readonly turns: readonly TurnFacts[]
  readonly nameOf: ModelNameLookup
  readonly t: Translate<MessagesKey>
}

export function MessageUsageTable({ turns, nameOf, t }: MessageUsageTableProps): ReactNode {
  // Remembered, not merely held: a reader who sorted by cost keeps that order
  // after leaving the view, which is what makes the choice feel like a setting
  // rather than like something the table forgot.
  const sort = useSort()

  const rows = useMemo(() => sortTurns(turns, sort), [turns, sort])

  const onSort = (key: SortKey): void => {
    const current = getSort()
    if (current?.key !== key) {
      // First click: figures biggest-first (that is what a reader is looking
      // for), time earliest-first (that is how a log reads).
      writeSort({ key, direction: key === 'when' ? 'asc' : 'desc' })
      return
    }
    writeSort({ key, direction: current.direction === 'asc' ? 'desc' : 'asc' })
  }

  return (
    <table style={TABLE_STYLE}>
      <thead>
        <tr>
          <SortHeader label={t('colTime')} sortKey="when" sort={sort} onSort={onSort} />
          <th style={HEAD_LEFT_STYLE}>{t('colMessage')}</th>
          <th style={HEAD_LEFT_STYLE}>{t('colModel')}</th>
          <SortHeader label={t('colInput')} sortKey="input" sort={sort} onSort={onSort} numeric />
          <SortHeader label={t('colOutput')} sortKey="output" sort={sort} onSort={onSort} numeric />
          <SortHeader label={t('colBusy')} sortKey="busy" sort={sort} onSort={onSort} numeric />
          <SortHeader label={t('colCache')} sortKey="cache" sort={sort} onSort={onSort} numeric />
        </tr>
      </thead>
      <tbody>
        {rows.map(turn => (
          <tr key={turn.seq}>
            <td style={CELL_LEFT_STYLE}>{whenOf(turn.startedAt)}</td>
            <td
              style={{ ...CELL_TEXT_STYLE, color: 'var(--dsw-alias-label-secondary)' }}
              // The whole prompt on hover. The row can only show one truncated
              // line, and the fold keeps the text whole precisely so that this can
              // be something other than a copy of what is already visible.
              title={turn.prompt ?? t('noPrompt')}
            >
              {turn.prompt === null ? t('noPrompt') : previewOf(turn.prompt)}
            </td>
            <td style={CELL_LEFT_STYLE}>
              {nameFor(turn.route?.provider ?? '', turn.route?.model ?? '', nameOf, t)}
            </td>
            <td style={CELL_NUM_STYLE}>{inputOf(turn, t)}</td>
            <td style={CELL_NUM_STYLE}>
              {turn.usage === null ? DASH : formatCompactTokens(turn.usage.outputTokens ?? 0, t)}
            </td>
            <td style={CELL_NUM_STYLE}>
              {turn.busyMs === null ? DASH : formatCompactDuration(turn.busyMs, t)}
            </td>
            <td style={CELL_NUM_STYLE}>{turn.cacheHit === null ? DASH : `${turn.cacheHit}%`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A column header that orders the table when clicked. */
function SortHeader({ label, sortKey, sort, onSort, numeric = false }: {
  readonly label: string
  readonly sortKey: SortKey
  readonly sort: Sort | null
  readonly onSort: (key: SortKey) => void
  readonly numeric?: boolean
}): ReactNode {
  const active = sort?.key === sortKey
  const direction = active ? sort.direction : null
  return (
    <th
      style={numeric ? HEAD_NUM_STYLE : HEAD_LEFT_STYLE}
      aria-sort={direction === null ? 'none' : direction === 'asc' ? 'ascending' : 'descending'}
    >
      <button type="button" onClick={() => { onSort(sortKey) }} style={HEAD_BUTTON_STYLE(numeric, active)}>
        {label}
        <span style={ARROW_STYLE}>{direction === null ? '' : direction === 'asc' ? '↑' : '↓'}</span>
      </button>
    </th>
  )
}

/**
 * Order turns for display. Pure, so the rule can be pinned without rendering.
 *
 * Two decisions, neither self-evident:
 *
 * - A figure the host could not compute sorts LAST in EITHER direction. A dash is
 *   not a small number, it is an unknown one, and letting it fill the top of a
 *   descending column would read as "these cost the most".
 * - Ties — and turns that are both unknown — fall back to seq order. For the
 *   window-ordered list this view passes in, that IS chronological order, so a sort
 *   never shuffles equal rows arbitrarily; stating it as seq order rather than as
 *   "the input order" keeps the rule true even if a caller ever sorts a shuffled
 *   list.
 * @param turns - the window's turns, in the order they ran.
 * @param sort - the column and direction, or null for the window's own order.
 * @returns a new array; `turns` is never mutated.
 */
export function sortTurns(turns: readonly TurnFacts[], sort: Sort | null): readonly TurnFacts[] {
  if (sort === null) return turns
  const factor = sort.direction === 'asc' ? 1 : -1
  return [...turns].sort((left, right) => {
    const a = sortValue(left, sort.key)
    const b = sortValue(right, sort.key)
    if (a === null && b === null) return left.seq - right.seq
    if (a === null) return 1
    if (b === null) return -1
    if (a === b) return left.seq - right.seq
    return (a - b) * factor
  })
}

/** The numeric value a column sorts by, or null when the turn carries none. */
function sortValue(turn: TurnFacts, key: SortKey): number | null {
  switch (key) {
    case 'when': return turn.startedAt
    case 'input': return inputTokensOf(turn)
    case 'output': return turn.usage === null ? null : (turn.usage.outputTokens ?? 0)
    case 'busy': return turn.busyMs
    // The share arrives pre-formatted (the host's own text, including its `99.95`
    // shape), so it is parsed back for ordering only — never for display.
    case 'cache': return turn.cacheHit === null ? null : Number(turn.cacheHit)
  }
}

/** The turn's billed prompt tokens — the disjoint input buckets summed. */
function inputTokensOf(turn: TurnFacts): number | null {
  const usage = turn.usage
  if (usage === null) return null
  return (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** What the turn asked for, in tokens, or a dash. */
function inputOf(turn: TurnFacts, t: Translate<MessagesKey>): string {
  const tokens = inputTokensOf(turn)
  return tokens === null ? DASH : formatCompactTokens(tokens, t)
}

const DASH = '—'

/** How much of a prompt a row shows before the hover takes over. */
const PROMPT_PREVIEW_CHARS = 64

/**
 * The prompt as one line, for the row.
 *
 * Truncation lives here rather than in the fold: the fold's copy is what the hover
 * shows, so cutting it there would leave the hover repeating the row.
 * @param prompt - the turn's prompt, whole.
 * @returns one collapsed line, cut to {@link PROMPT_PREVIEW_CHARS}.
 */
function previewOf(prompt: string): string {
  const line = prompt.replace(/\s+/gu, ' ').trim()
  return line.length > PROMPT_PREVIEW_CHARS ? `${line.slice(0, PROMPT_PREVIEW_CHARS)}…` : line
}

/**
 * A compact date and clock for one turn.
 *
 * Rendered through the browser's own locale rather than the plugin's: the i18n
 * table carries text, not date patterns, and an instant is better formatted by the
 * platform than by a translation string.
 * @param at - epoch milliseconds, or null when the window does not carry it.
 * @returns the formatted instant, or a dash.
 */
function whenOf(at: number | null): string {
  if (at === null) return DASH
  return new Date(at).toLocaleString([], {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * The header's own button: the label alone, so the header row keeps the table's
 * alignment while the whole caption stays clickable.
 */
function HEAD_BUTTON_STYLE(numeric: boolean, active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: 3,
    margin: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: active ? 'var(--dsw-alias-label-primary)' : 'inherit',
    font: 'inherit',
    fontWeight: 'inherit',
    cursor: 'pointer',
    // The numeric headers are right-aligned, so their caption has to be too.
    justifyContent: numeric ? 'flex-end' : 'flex-start',
    width: '100%',
  }
}

/** Fixed width, so switching the arrow on does not shift the caption. */
const ARROW_STYLE: CSSProperties = {
  display: 'inline-block',
  width: '0.8em',
  textAlign: 'left',
}

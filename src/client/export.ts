/**
 * What this view can hand back to the reader: the figures, and the conversation.
 *
 * Four formats, because they answer two different questions and two different
 * readers. The figures are for a spreadsheet (CSV, compact and readable) and for
 * something that will compute with them (JSON, raw numbers and the whole usage
 * bucket). The conversation is for a person (Markdown, the prompt and the replies
 * as written) and for a tool that wants the log itself (JSONL, one raw event per
 * line, exactly the shape the host writes).
 *
 * Everything here is pure: text in, text out. The filtering, the ordering and the
 * reaching for data all happen in the view, so these functions can be pinned
 * without a DOM — and the one thing that genuinely needs care, CSV quoting, is a
 * function of one string.
 *
 * Two conventions worth stating, because both are deliberate:
 *
 * - **CSV carries compact figures** (`8.2K`, `1分12秒`): it is opened by a human
 *   in a spreadsheet, and a column of `8214` is harder to scan than one of `8.2K`.
 * - **JSON carries raw numbers**: nothing rounded, nothing formatted, because the
 *   caller is a program and the formatting is the part it cannot undo.
 *
 * The cache column drops its `%` in CSV for the same reason: a figure in a
 * spreadsheet that still needs its suffix stripped before it can be summed is not
 * a figure, it is a label.
 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { formatCompactDuration, formatCompactTokens, type SessionTotals } from './format.ts'
import type { MessagesKey } from './locales.ts'
import type { RangeKey } from './time-range.ts'
import type { TurnFacts, TurnSource } from './turn-facts.ts'

/** One turn as the exports see it: its figures, and its own words. */
export interface ExportTurn {
  readonly facts: TurnFacts
  readonly source: TurnSource
}

/** Everything the exports need, assembled by the view. */
export interface ExportInput {
  readonly sessionId: string
  /** The range key in force, for the file's own description of itself. */
  readonly range: RangeKey
  readonly from: number | null
  readonly to: number | null
  /** The turns inside the range, in the order they ran. */
  readonly turns: readonly ExportTurn[]
  /** The range's own totals, or null while the projections are absent. */
  readonly totals: SessionTotals | null
  /** Bound translate, for the column names and the section labels. */
  readonly t: Translate<MessagesKey>
  /** The instant the export was taken, in epoch milliseconds. */
  readonly now: number
}

/**
 * One CSV field, quoted when the format requires it.
 *
 * The whole of CSV's difficulty is here. A prompt contains commas, quotes and
 * newlines as a matter of course, and an unquoted one does not merely look wrong:
 * it shifts every following column of that row, and the spreadsheet quietly reads
 * a different set of figures than the table did. Doubling the quote is RFC 4180's
 * escape, not a choice.
 * @param value - the field's text.
 * @returns the field, quoted and escaped if it has to be.
 */
export function csvField(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** `2026-09-14 15:30`, local, for a header line a reader will look at. */
function readableWhen(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One turn's clock, as the table shows it. */
function whenOf(at: number | null): string {
  if (at === null) return ''
  return new Date(at).toLocaleString([], {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** The model's display spelling, falling back to the raw id, as the tables do. */
function modelOf(turn: ExportTurn): string {
  const route = turn.facts.route
  return route === null ? '' : `${route.provider === '' ? '' : `${route.provider}/`}${route.model}`
}

/** The billed prompt side of one turn, or null when it carries no usage. */
function billedInputOf(turn: ExportTurn): number | null {
  const usage = turn.facts.usage
  if (usage === null) return null
  return (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * The figures, as CSV.
 *
 * The last row is a summary rather than a per-column total: a turn's output and
 * its billed input are known, but the range's split between them is not something
 * this view computes anywhere else, and inventing it here would put a number in
 * the export that no surface in the app agrees with. What it does state — turns,
 * tokens, wall time, cache share — is what the pills above the table state.
 * @param input - the export's material.
 * @returns the whole file's text.
 */
export function usageCsv(input: ExportInput): string {
  const { t } = input
  const rows: string[] = [
    [t('colTime'), t('colMessage'), t('colModel'), t('colInput'), t('colOutput'), t('colBusy'), t('colCache')]
      .map(csvField).join(','),
  ]
  for (const turn of input.turns) {
    const inputTokens = billedInputOf(turn)
    rows.push([
      whenOf(turn.facts.startedAt),
      turn.source.prompt ?? '',
      modelOf(turn),
      inputTokens === null ? '' : formatCompactTokens(inputTokens, t),
      turn.facts.usage === null ? '' : formatCompactTokens(turn.facts.usage.outputTokens ?? 0, t),
      turn.facts.busyMs === null ? '' : formatCompactDuration(turn.facts.busyMs, t),
      turn.facts.cacheHit ?? '',
    ].map(csvField).join(','))
  }
  const totals = input.totals
  if (totals !== null) {
    const summary = [
      t('turnsLabel', { count: String(totals.turns) }),
      t('tokensLabel', { value: formatCompactTokens(totals.totalTokens, t) }),
      t('busyLabel', { value: formatCompactDuration(totals.busyMs, t) }),
      totals.cacheHitPercent === null ? '' : t('cacheLabel', { percent: totals.cacheHitPercent }),
    ].filter(part => part !== '').join(' · ')
    rows.push([t('totalsLabel'), summary, '', '', '', '', ''].map(csvField).join(','))
  }
  return `${rows.join('\r\n')}\r\n`
}

/**
 * The figures, as JSON — raw, unformatted, one object per turn.
 * @param input - the export's material.
 * @returns the whole file's text.
 */
export function usageJson(input: ExportInput): string {
  return `${JSON.stringify({
    sessionId: input.sessionId,
    exportedAt: new Date(input.now).toISOString(),
    range: { key: input.range, from: input.from, to: input.to },
    totals: input.totals,
    turns: input.turns.map(turn => ({
      seq: turn.facts.seq,
      startedAt: turn.facts.startedAt,
      prompt: turn.source.prompt,
      provider: turn.facts.route?.provider ?? null,
      model: turn.facts.route?.model ?? null,
      routeSource: turn.facts.routeSource,
      cacheHit: turn.facts.cacheHit,
      busyMs: turn.facts.busyMs,
      usage: turn.facts.usage,
    })),
  }, null, 2)}\n`
}

/**
 * The conversation, as Markdown.
 *
 * The prompt and the replies are the FULL text: the table shows a truncated
 * preview, and truncation is a view concern — a reader asking for the
 * conversation should get the conversation, not what fitted in a cell.
 * @param input - the export's material.
 * @returns the whole file's text.
 */
export function transcriptMarkdown(input: ExportInput): string {
  const { t } = input
  const lines: string[] = [
    `# ${t('transcriptTitle')}`,
    '',
    `- ${t('sessionLabel')}: \`${input.sessionId}\``,
    `- ${t('exportedAt')}: ${readableWhen(input.now)}`,
    `- ${t('turnsLabel', { count: String(input.turns.length) })}`,
  ]
  for (const turn of input.turns) {
    lines.push('', '---', '')
    const heading = [t('colModel'), whenOf(turn.facts.startedAt), modelOf(turn)].filter(part => part !== '')
    lines.push(`## ${heading.join(' · ')}`, '')
    if (turn.source.prompt !== null) {
      lines.push(`**${t('promptLabel')}**`, '', turn.source.prompt, '')
    }
    if (turn.source.responses.length > 0) {
      lines.push(`**${t('responseLabel')}**`, '')
      // One step's reply per block: a turn can answer more than once, and running
      // them together would read as a single reply that was never sent.
      lines.push(turn.source.responses.join('\n\n'), '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * The conversation, as JSONL: one raw event per line, in log order.
 *
 * The same shape the host writes, so the file can be read by anything that reads
 * a session log — and it is the events, not a rendering of them, which is what
 * makes that true.
 * @param input - the export's material.
 * @returns the whole file's text.
 */
export function transcriptJsonl(input: ExportInput): string {
  const lines: string[] = []
  for (const turn of input.turns) {
    for (const event of turn.source.events) lines.push(JSON.stringify(event))
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * A file name that says what it holds, without saying it in a way a file system
 * will object to: the session id is truncated and stripped, and the stamp is
 * local, matching every other instant this plugin prints.
 * @param input - the export's material.
 * @param extension - the file's extension, without the dot.
 * @returns the file name.
 */
export function exportFileName(input: ExportInput, extension: string): string {
  const date = new Date(input.now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`
  const session = input.sessionId.replace(/[^\w-]/gu, '_').slice(0, 24)
  return `dsh-usage-${session}-${stamp}.${extension}`
}

/**
 * Hand a text file to the browser's own download.
 *
 * A blob URL rather than a data URL: a transcript runs to megabytes, and data
 * URLs have to survive the round trip through a string that some browsers cap.
 * The URL is revoked on the next task rather than immediately, because revoking it
 * in the same tick can cancel the download that was just started.
 * @param name - the file name to offer.
 * @param text - the file's whole contents.
 * @param mime - the media type to declare.
 */
export function downloadText(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

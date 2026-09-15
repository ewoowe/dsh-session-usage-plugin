/**
 * The per-model table: one row per model that ran in this session.
 *
 * Presentational by design — the container owns the fold, the coverage and the
 * polling, so this file has no source of truth of its own to drift from.
 */
import type { ReactNode } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { formatCompactDuration, formatCompactTokens } from './format.ts'
import type { MessagesKey } from './locales.ts'
import type { ModelNameLookup } from './model-names.ts'
import {
  CELL_LEFT_STYLE, CELL_NUM_STYLE, HEAD_LEFT_STYLE, HEAD_NUM_STYLE, TABLE_STYLE,
} from './table-styles.ts'
import type { ModelUsage } from './usage-by-model.ts'

export interface ModelUsageTableProps {
  /** Already ordered largest first by the fold. */
  readonly models: readonly ModelUsage[]
  readonly nameOf: ModelNameLookup
  readonly t: Translate<MessagesKey>
}

export function ModelUsageTable({ models, nameOf, t }: ModelUsageTableProps): ReactNode {
  return (
    <table style={TABLE_STYLE}>
      <thead>
        <tr>
          <th style={HEAD_LEFT_STYLE}>{t('colModel')}</th>
          <th style={HEAD_NUM_STYLE}>{t('colTurns')}</th>
          <th style={HEAD_NUM_STYLE}>{t('colBusy')}</th>
          <th style={HEAD_NUM_STYLE}>{t('colInput')}</th>
          <th style={HEAD_NUM_STYLE}>{t('colOutput')}</th>
          <th style={HEAD_NUM_STYLE}>{t('colCache')}</th>
        </tr>
      </thead>
      <tbody>
        {models.map(model => (
          <tr key={`${model.route.provider}/${model.route.model}`}>
            <td style={CELL_LEFT_STYLE}>{nameFor(model.route.provider, model.route.model, nameOf, t)}</td>
            <td style={CELL_NUM_STYLE}>{model.turns}</td>
            <td style={CELL_NUM_STYLE}>{formatCompactDuration(model.busyMs, t)}</td>
            <td style={CELL_NUM_STYLE}>
              {/* The three prompt-side buckets are disjoint, so their sum is the
                  billed input — the same quantity every other surface divides by. */}
              {formatCompactTokens(
                model.uncachedInputTokens + model.cacheReadTokens + model.cacheWriteTokens,
                t,
              )}
            </td>
            <td style={CELL_NUM_STYLE}>{formatCompactTokens(model.outputTokens, t)}</td>
            <td style={CELL_NUM_STYLE}>{model.cacheHit === null ? '—' : `${model.cacheHit}%`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The name the composer's picker would show, or the bare id when the catalog does
 * not carry it (a retired model), or an explicit "unknown" when the turn named no
 * model at all.
 */
export function nameFor(
  provider: string,
  model: string,
  nameOf: ModelNameLookup,
  t: Translate<MessagesKey>,
): string {
  if (model === '') return t('modelUnknown')
  return nameOf(provider, model) ?? model
}

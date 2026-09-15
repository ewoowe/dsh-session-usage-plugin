/**
 * Table chrome shared by both usage tables.
 *
 * One module rather than two copies: the tables are read side by side, so a
 * padding or border that drifts between them reads as a rendering bug rather than
 * as a difference, and nothing here is worth diverging over.
 */
import type { CSSProperties } from 'react'

/**
 * Page-level surface: these fill the conversation area, not a card of their own.
 *
 * This view takes the composer-overlay mode (see `UsageView`), and three of these
 * declarations are what that mode asks of a view:
 *
 * - `height: 100%` — the mode gives the view the area's whole box and hands it
 *   the scrolling, so an element sized by its content would simply be clipped by
 *   the `overflow: hidden` above it and the table would stop at the fold.
 * - `overflow-y: auto` — the scrolling the mode hands over, done here: one
 *   scroller for the chips, both leaves and the coverage line together.
 * - `padding-bottom` — the composer floats OVER this view in that mode, so the
 *   last rows of a long table would sit underneath it. The variable is the
 *   shell's own published composer height, read exactly the way the trajectory
 *   view reads it, with the same fallback for the moment before it reports one.
 */
export const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '16px 20px',
  paddingBottom: 'calc(var(--dsh-composer-height, 152px) + 16px)',
  height: '100%',
  boxSizing: 'border-box',
  minHeight: 0,
  overflowY: 'auto',
  color: 'var(--dsw-alias-label-primary)',
}

export const EMPTY_STYLE: CSSProperties = {
  padding: '32px 0',
  textAlign: 'center',
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
}

export const TABLE_STYLE: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
  // Fixed, so the row heights do not jump when the figures change width — and so
  // the prompt column can be the one that absorbs the slack.
  tableLayout: 'fixed',
}

export const HEAD_LEFT_STYLE: CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-tertiary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
}

/** Right-aligned header, for columns that hold figures. */
export const HEAD_NUM_STYLE: CSSProperties = {
  ...HEAD_LEFT_STYLE,
  textAlign: 'right',
}

export const CELL_LEFT_STYLE: CSSProperties = {
  padding: '7px 8px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
  whiteSpace: 'nowrap',
}

/** A left-aligned cell whose text may be long: it ellipsizes rather than pushing. */
export const CELL_TEXT_STYLE: CSSProperties = {
  ...CELL_LEFT_STYLE,
  width: '100%',
  maxWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export const CELL_NUM_STYLE: CSSProperties = {
  ...CELL_LEFT_STYLE,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

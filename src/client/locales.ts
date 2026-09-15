/**
 * This plugin's namespaced strings.
 *
 * `zh` and `en` are the locales the shell ships; the pack locales a language pack
 * makes selectable are not translated yet. Every dictionary is typed
 * `Record<MessagesKey, string>`, so a key added to the union fails to compile
 * until both carry it — the `en` fallback chain would otherwise let a forgotten
 * key resolve silently.
 */

/** Locale namespace this plugin owns. */
export const NS = 'sessionUsage'

/** Every string this plugin renders; `t` resolves against this union. */
export type MessagesKey =
  | 'title'
  | 'totalsLabel'
  | 'tokensLabel'
  | 'busyLabel'
  | 'cacheLabel'
  | 'turnsLabel'
  | 'contextLabel'
  | 'contextPressure'
  | 'colModel'
  | 'colTurns'
  | 'colBusy'
  | 'colInput'
  | 'colOutput'
  | 'colCache'
  | 'modelUnknown'
  | 'empty'
  | 'attribution'
  | 'coverage'
  | 'loadAll'
  | 'outsideWindow'
  | 'noUsage'
  | 'loadAllHint'
  | 'loadAllAlso'
  | 'messageTitle'
  | 'modelTitle'
  | 'colTime'
  | 'colMessage'
  | 'noPrompt'
  | 'composerBlocked'
  // Time ranges. The labels name the window the reader is choosing, so they are
  // copy rather than numbers: "24 hours" and "3 days" are how each language
  // spells a span, not a value to interpolate into one pattern.
  | 'rangeSession'
  | 'rangeToday'
  | 'rangeDay'
  | 'rangeYesterday'
  | 'rangeDays3'
  | 'rangeDays7'
  | 'rangeGap'
  | 'loadRange'
  | 'loadRangeHint'
  // Exports: four buttons, and the labels a Markdown transcript needs.
  | 'exportCsv'
  | 'exportJson'
  | 'exportMd'
  | 'exportJsonl'
  | 'transcriptTitle'
  | 'sessionLabel'
  | 'exportedAt'
  | 'promptLabel'
  | 'responseLabel'
  | 'rangeCustom'
  | 'rangeFrom'
  | 'rangeTo'
  | 'rangeUntil'
  | 'rangeEmpty'
  // Compact number and duration units. Not copy of their own: they are how this
  // plugin's figures are spelled, and every language spells them its own way.
  | 'numberThousand'
  | 'numberMillion'
  | 'durationSeconds'
  | 'durationMinutes'

/** Simplified Chinese, the shell's own Chinese. */
export const zh: Record<MessagesKey, string> = {
  title: '用量',
  modelTitle: '模型用量统计',
  totalsLabel: '本会话合计',
  tokensLabel: '用量 {value}',
  busyLabel: '用时 {value}',
  cacheLabel: '缓存命中 {percent}%',
  turnsLabel: '{count} 轮',
  contextLabel: '上下文',
  contextPressure: '已用 {percent}%',
  colModel: '模型',
  colTurns: '轮次',
  colBusy: '用时',
  colInput: '输入',
  colOutput: '输出',
  colCache: '缓存命中',
  modelUnknown: '未知模型',
  empty: '这个会话还没有可统计的轮次',
  attribution: '一轮里换过模型时，整轮记在产出回复的那个模型上。',
  coverage: '已统计 {covered} / {total} 轮',
  loadAll: '载入全部历史',
  outsideWindow: '· 其中 {count} 轮不在已加载窗口',
  noUsage: '· 其中 {count} 轮还没有完整用量记录（正在运行或曾中断）',
  loadAllAlso: '会把消息一并载入对话视图',
  loadAllHint: '把整段会话的历史载入同一个事件窗口。对话视图会随之加载全部消息，行数增多后浮条与弹窗的逐行测量会变慢；载入不回缩——刷新前一直有效，且无法中途取消。正在进行的轮次要等它结束后才会出现用量。',
  messageTitle: '消息用量统计',
  colTime: '时间',
  colMessage: '消息',
  noPrompt: '（无可读提示词）',
  composerBlocked: '用量视图不接收输入，切回「对话」即可继续',
  rangeSession: '本会话',
  rangeToday: '今天',
  rangeDay: '24 小时',
  rangeYesterday: '昨天',
  rangeDays3: '3 天',
  rangeDays7: '7 天',
  rangeGap: '· 更早的轮次还没载入',
  exportCsv: '统计 CSV',
  exportJson: '统计 JSON',
  exportMd: '对话 MD',
  exportJsonl: '对话 JSONL',
  transcriptTitle: '对话记录',
  sessionLabel: '会话',
  exportedAt: '导出时间',
  promptLabel: '问',
  responseLabel: '答',
  loadRange: '载入范围内更早的历史',
  loadRangeHint: '逐页把更早的轮次载入，直到覆盖所选时间段的起点。载入的是消息本体，宿主无法卸载——载进来就一直留着，只能靠刷新页面回到较短的窗口。',
  rangeCustom: '自定义',
  rangeFrom: '起始时间',
  rangeTo: '至',
  rangeUntil: '结束时间',
  rangeEmpty: '没有落在所选时间段内的轮次',
  numberThousand: '{value}K',
  numberMillion: '{value}M',
  durationSeconds: '{seconds}秒',
  durationMinutes: '{minutes}分{seconds}秒',
}

/** English, the source of truth for new keys. */
export const en: Record<MessagesKey, string> = {
  title: 'Usage',
  modelTitle: 'Model usage',
  totalsLabel: 'This session',
  tokensLabel: 'Used {value}',
  busyLabel: 'Ran for {value}',
  cacheLabel: 'Cache hit {percent}%',
  turnsLabel: '{count} turns',
  contextLabel: 'Context',
  contextPressure: '{percent}% full',
  colModel: 'Model',
  colTurns: 'Turns',
  colBusy: 'Wall time',
  colInput: 'Input',
  colOutput: 'Output',
  colCache: 'Cache hit',
  modelUnknown: 'Unknown model',
  empty: 'This session has no completed turns yet',
  attribution: 'A turn that switched models is credited to the one that produced the reply.',
  coverage: 'Folded {covered} of {total} turns',
  loadAll: 'Load the full history',
  outsideWindow: '· {count} outside the loaded window',
  noUsage: '· {count} with no complete usage record yet (running or interrupted)',
  loadAllAlso: 'also loads the messages into the conversation view',
  loadAllHint: 'Loads the whole session into the same event window. The conversation view loads all its messages along with it, so the strip and the dialog measure more rows and get slower; the load does not shrink back — it holds until the page is reloaded — and it cannot be cancelled. A turn still running shows its usage once it ends.',
  messageTitle: 'Message usage',
  colTime: 'When',
  colMessage: 'Message',
  noPrompt: '(no readable prompt)',
  composerBlocked: 'The usage view takes no input — switch back to Conversation to type',
  rangeSession: 'Session',
  rangeToday: 'Today',
  rangeDay: '24 hours',
  rangeYesterday: 'Yesterday',
  rangeDays3: '3 days',
  rangeDays7: '7 days',
  rangeGap: '· older turns are not loaded yet',
  exportCsv: 'Stats CSV',
  exportJson: 'Stats JSON',
  exportMd: 'Chat MD',
  exportJsonl: 'Chat JSONL',
  transcriptTitle: 'Conversation',
  sessionLabel: 'Session',
  exportedAt: 'Exported',
  promptLabel: 'Prompt',
  responseLabel: 'Response',
  loadRange: 'Load the older turns in this range',
  loadRangeHint: 'Pages older turns in until the window covers the start of the chosen span. What arrives is message bodies, and the host cannot unload them — they stay loaded, and only a page reload returns to a shorter window.',
  rangeCustom: 'Custom',
  rangeFrom: 'From',
  rangeTo: 'to',
  rangeUntil: 'Until',
  rangeEmpty: 'No turns fall inside the chosen span',
  numberThousand: '{value}K',
  numberMillion: '{value}M',
  durationSeconds: '{seconds}s',
  durationMinutes: '{minutes}m{seconds}s',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the session usage view. */
    sessionUsage: MessagesKey
  }
}

/**
 * Browser half of the session-usage plugin.
 *
 * One contribution: a conversation view that reports what the session has spent,
 * per model. It needs three seams — `slots` to register the view, `sessions` to
 * reach the viewing session's own event window, and `locale` for its copy — and it
 * takes `remote` separately, because the model NAMES it prints come from the host's
 * catalog and a composition without that layer should still get the view.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
// `SessionSeq` is a value: the branded constructor the jump loader takes.
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
// Declares `remote.session` on the client context. Unlike the sibling plugin this
// one never calls the remote itself, but the model-name lookup below does, and the
// namespace has to be in scope for its call to type-check.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UsageView, type UsageViewInjected, type UsageViewProps } from './UsageView.tsx'
import { en, NS, zh } from './locales.ts'
import { publishModelNames } from './model-names.ts'
import { readSessionTotals, type SessionTotals } from './format.ts'
import { turnFactsOf, turnSourcesFor, type TurnFacts, type TurnSource } from './turn-facts.ts'

/** Cordis context with this plugin's seams; see the type-only imports above. */
type ClientContext = Context

/**
 * Services required before anything registers.
 *
 * A module-level declaration, not just the nested scope below, because `apply`
 * touches `locale` OUTSIDE that scope: the dictionaries have to register before
 * any slot resolves a string. Cordis refuses a property read on a service the
 * plugin never declared — `cannot get property "locale" without inject` — which is
 * how a missing entry here surfaces: not as a missing label, but as a plugin that
 * fails to apply at all.
 *
 * `remote` is deliberately NOT here. The model NAMES come from it, but a host
 * without that layer should still get the view, printing bare ids.
 */
export const inject = ['slots', 'sessions', 'locale', 'conversation']

/**
 * Register the view.
 * @param ctx - owning client context.
 */
export function apply(ctx: Context): void {
  // `zh` and `en` are the locales the shell ships, so both go in through the
  // multi-locale overload: this plugin ships exactly those two for now, and a
  // language pack's locales stay the pack's business.
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'session-usage: dictionaries',
  )

  ctx.inject(['slots', 'sessions', 'locale'], (scope: ClientContext) => {
    // Bound once, resolved per read: `bind` reads the ACTIVE locale at call time,
    // so the view's tab label follows a locale switch without re-registering.
    const t = scope.locale.bind(NS)

    // Model display names, the same arrangement `session-messages-plugin` uses: a
    // nested injection, because `remote` is an EXTRA dependency. A composition
    // without the remote layer still gets the view — it prints raw model ids
    // instead of catalog names, which is worse but not wrong.
    //
    // Loaded once per registration rather than subscribed: the catalog is
    // deployment-wide and takes no session, so one fetch answers every session.
    scope.inject(['remote', 'remote.session'], (remoteScope: ClientContext) => {
      const names = new Map<string, string>()
      remoteScope.effect(() => publishModelNames(
        (provider, model) => names.get(`${provider}/${model}`) ?? null,
      ))
      remoteScope.effect(() => {
        let live = true
        void remoteScope.remote.session.modelCatalog().then((response) => {
          if (!live || !response.ok) return
          for (const group of (response.value as ModelCatalog).groups) {
            for (const model of group.models) names.set(`${group.id}/${model.id}`, model.name)
          }
        }).catch(() => undefined)
        return () => { live = false }
      }, 'session-usage: model names')
    })

    /**
     * The face BOTH usage views read.
     *
     * One window, one fold, one loader — so the per-model table and the
     * per-message table cannot end up describing different slices of the session.
     * Two views computing their own coverage is precisely the divergence this
     * project keeps finding in hindsight.
     *
     * The session id comes from the VIEWING view rather than from whichever session
     * is current, so a tab keeps reporting the conversation it belongs to. The slot
     * hands a plain string; the cast is the plugin's side of "this really is a
     * session id", which the slot's own typing cannot state.
     */
    const faceOf = (sessionId: string): UsageViewInjected => {
      const binding = scope.sessions.binding(sessionId as SessionId)
      const fold = binding === undefined ? null : turnFactsOf(binding.eventSource)
      return {
        sessionId,
        turnFacts: (): ReadonlyMap<number, TurnFacts> | null => (fold === null ? null : fold()),
        // Read fresh on each export rather than held: see `turnSourcesFor`.
        turnSources: (): ReadonlyMap<number, TurnSource> | null =>
          (binding === undefined ? null : turnSourcesFor(binding.eventSource)),
        sessionTotals: (): SessionTotals | null => {
          const session = binding?.session
          return session === undefined ? null : readSessionTotals(session.projections)
        },
        hasOlder: (): boolean => binding?.session.getSnapshot().hasMore === true,
        loadPage: async (): Promise<void> => {
          if (binding === undefined) return
          // One page, 50 messages, by the Session Controller's own pager. The
          // range auto-load uses this rather than the call below because it can
          // stop the moment the range is covered: asking for "7 days" should not
          // drag a month of history in to answer a question about a week.
          await binding.session.loadOlder()
        },
        loadAll: async (): Promise<void> => {
          if (binding === undefined) return
          // The host's own jump loader, aimed at the beginning of the session. It
          // pages backwards until the window covers the target, and it already
          // carries the two things a hand-rolled loop has to invent: a no-progress
          // guard (an empty page that still claims history ends the loop instead of
          // spinning it) and a shared busy flag. Its pages are also four times
          // larger than `loadOlder`'s — 200 messages against 50 — so the whole
          // session arrives in a quarter of the round trips.
          await binding.session.loadThrough(SessionSeq(0))
        },
        blockComposer: (reason: string | null): void => {
          if (binding === undefined) return
          // `conversation.blocks` is the shell's own single-slot registry for "why
          // this session's composer is inert"; `undefined` clears it.
          scope.conversation.blocks.set(
            sessionId as SessionId,
            reason === null ? undefined : { reason },
          )
        },
      }
    }

    // ONE tab. The two tables are leaves inside it, not sibling tabs: they answer
    // the same question at two resolutions, and a reader comparing them should not
    // have to remember which tab they were just in.
    scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view',
      id: 'usage',
      // After the transcript and the trajectory ledger: this is a surface for
      // reading, not a place where work happens.
      order: 10,
      locale: NS,
      label: () => t('title'),
      inject: faceOf,
    }, (props: UsageViewProps) => createElement(UsageView, props)))
  })
}

/**
 * Model display names, so the strip names a model the way the composer does.
 *
 * The projection carries ids only — `modelSelection.lastUsed` is
 * `{ provider, model }` — and an id next to the picker's own label reads as a
 * mismatch rather than as the same choice: `deepseek-flash` beside
 * `DeepSeek-V4.1-Flash` looks like something is misconfigured.
 *
 * The names live in the host's LLM registry and reach the client only through
 * `remote.session.modelCatalog()`, the deployment-wide catalog ui-model-selection
 * loads for its picker. That call is the reason this module exists as a holder
 * rather than as a projection read: it is a plain global read — no session
 * parameter, no per-session state — which is what separates it from
 * `ctx.modelDirectories`. That service is the SELECTION surface (it lazily
 * creates per-session directories and throws for a session outside the active
 * list), and reading it merely to print a label would be the wrong seam.
 *
 * A holder, not a subscription API: the plugin body owns the `remote`
 * dependency and publishes a lookup once the catalog arrives, while the strip
 * reads it without depending on the remote layer at all. A composition without
 * it keeps registering both surfaces and simply keeps showing ids.
 */
import { useSyncExternalStore } from 'react'

/** Maps one `provider` + `model` id pair to the name the picker would show. */
export type ModelNameLookup = (provider: string, model: string) => string | null

let lookup: ModelNameLookup | null = null

/**
 * Bumped on every change. `useSyncExternalStore` compares snapshots by identity,
 * and the value here is a function that can be re-published around the same map —
 * a counter is the honest snapshot: "how many catalogs have arrived".
 */
let revision = 0

const listeners = new Set<() => void>()

function bump(): void {
  revision += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function revisionOf(): number {
  return revision
}

/**
 * Publish the current lookup, replacing any previous one.
 * @param next - the lookup the strip should use.
 * @returns a disposer that unpublishes it, ignored if a newer one replaced it.
 */
export function publishModelNames(next: ModelNameLookup): () => void {
  lookup = next
  bump()
  return () => {
    if (lookup !== next) return
    lookup = null
    bump()
  }
}

/**
 * Resolve one model id to its display name.
 * @param provider - the route's provider id.
 * @param model - the route's model id.
 * @returns the name, or null while no catalog has arrived or this route is absent.
 */
export function modelNameOf(provider: string, model: string): string | null {
  return lookup?.(provider, model) ?? null
}

/**
 * React to catalog arrivals.
 * @returns the lookup to read during render; it changes identity per catalog.
 */
export function useModelNameLookup(): ModelNameLookup {
  useSyncExternalStore(subscribe, revisionOf)
  return modelNameOf
}

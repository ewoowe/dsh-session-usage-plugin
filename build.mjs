/**
 * Build both halves of the plugin.
 *
 * A plain script rather than a `tsdown.config.*` file: this checkout's tsdown
 * loads a config file through `unrun`, which is not in its dependency set, so
 * the CLI path cannot start. The programmatic `build()` API takes the same
 * options inline and never touches the config loader.
 *
 * `config: false` is required — without it every call still probes for a
 * config file and re-enters the failing import.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

/** Plugin id stamped into the module-loader handoff. */
const ID = 'dsh-session-usage'

/**
 * This script's own directory. Every path below is resolved against it rather
 * than the caller's cwd, so the build works whether it is run from inside the
 * plugin (`npm run build`) or from the repository root (`tsx session-messages-plugin/build.mjs`)
 * — relying on cwd silently looked for `<repo>/src/index.ts` in the latter case.
 */
const ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Something with no importer is an entry, which must stay internal. */
function isEntryImport(importer) {
  return importer === undefined
}

/** Whether a specifier is bare (a package name) rather than a path. */
function isBare(source) {
  return !source.startsWith('.') && !source.startsWith('\0') && !source.startsWith('/')
}

/**
 * Node half: bare specifiers stay external and Node resolves them, which is how
 * every other Loader entry works — and it is what keeps a shared library SINGLE:
 * bundling `schemastery` here would give the host's Schema a second copy, and
 * schema identity is compared by reference.
 */
const nodeExternals = {
  name: 'dsh-node-externals',
  resolveId: {
    order: 'pre',
    handler(source, importer) {
      if (isEntryImport(importer)) return null
      return isBare(source) ? { id: source, external: true } : null
    },
  },
}

/**
 * Browser half: a WHITELIST, not "everything bare".
 *
 * The browser module table answers exactly three things — platform seeds,
 * already-materialized modules, and registered package factories (the
 * composition's own client bundles). Anything outside that set is unreachable at
 * runtime however it is declared: `require` throws "missed the module table", and
 * the page shows a failed plugin instead of the surface. ui-chat can import
 * `@deepseek-ai/dsh-token-meter/client` because it is BUNDLED INTO THE SAME
 * BUNDLE, not because the table serves it.
 *
 * So the polarity matters: a specifier named here stays external (it must be
 * answered by the table), and EVERYTHING ELSE IS BUNDLED, which always works.
 * Externalizing by default was the bug — it turns any package the table does not
 * happen to carry into a boot failure, which is precisely the "build-time
 * externals drift" the loader's error names.
 */
const TABLE_PACKAGES = [
  // Platform seeds. Listed as packages, not exact specifiers: the JSX transform
  // rewrites JSX into `react/jsx-runtime`, and bundling THAT drags React's
  // development branch — and its `process.env.NODE_ENV` — into the browser.
  'react',
  'react-dom',
]

/** Whether a specifier is served by the module table. */
function tableAnswers(source) {
  return TABLE_PACKAGES.some(name => source === name || source.startsWith(`${name}/`))
}

const browserExternals = {
  name: 'dsh-browser-table-externals',
  resolveId: {
    order: 'pre',
    handler(source, importer) {
      if (isEntryImport(importer)) return null
      return tableAnswers(source) ? { id: source, external: true } : null
    },
  },
}

/**
 * Refuse to ship a browser bundle that cannot run in a browser.
 *
 * The host's own client build passes a purity gate; a third-party plugin builds
 * outside it, so the same mistakes surface as a page-level failure instead — the
 * two that have already happened here were `require` of a package the module
 * table does not carry ("missed the module table") and a bundled React
 * development branch ("process is not defined"). Both are visible in the finished
 * artifact, so both are checked there, before the plugin is installed rather than
 * after it fails to load.
 * @param artifact - absolute path of the browser bundle.
 */
function assertBrowserPurity(artifact) {
  const text = readFileSync(artifact, 'utf8')
  const leaked = ['process.', 'Buffer', '__dirname', 'globalThis.process']
    .filter(token => text.includes(token))
  if (leaked.length > 0) {
    throw new Error(
      `client bundle references Node globals (${leaked.join(', ')}) — a bundled dependency is not `
      + 'browser-safe; keep it external if the module table carries it, or inline only the pure part',
    )
  }
  const requires = [...text.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1])
  const unknown = [...new Set(requires)].filter(spec => !tableAnswers(spec))
  if (unknown.length > 0) {
    throw new Error(
      `client bundle requires specifiers the module table does not answer (${unknown.join(', ')}) — `
      + 'bundle them instead (see TABLE_PACKAGES for what stays external)',
    )
  }
}

/** Shared options for both halves. */
const common = {
  config: false,
  format: ['esm'],
  target: 'es2024',
  dts: false,
  clean: false,
  outDir: `${ROOT}lib`,
}

// Node half: the Loader imports this by `main` for name, Config, and apply.
await build({
  ...common,
  entry: { index: `${ROOT}src/index.ts` },
  platform: 'node',
  plugins: [nodeExternals],
  // Rolldown defaults the ESM output to .mjs; both halves are named from the
  // package.json exports map, so pin the extension instead of restating it.
  outputOptions: { entryFileNames: 'index.js' },
})

// Browser half: a closure factory registered with the client module loader.
// `cjs`, not `esm`: the factory receives `require` and runs as a function
// body, so ESM `import` statements would be illegal there. The repository's
// own client preset makes the same choice (packages/client/tsdown.client.ts).
await build({
  ...common,
  format: ['cjs'],
  entry: { client: `${ROOT}src/client/index.ts` },
  platform: 'browser',
  plugins: [browserExternals],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

// The browser half is checked before it can be installed: both failure modes it
// guards were silent until the page tried to load the plugin.
assertBrowserPurity(`${ROOT}lib/client.js`)

console.log('session-usage-plugin: built lib/index.js and lib/client.js')

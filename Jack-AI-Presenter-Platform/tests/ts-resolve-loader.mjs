// Node's ESM resolver requires explicit extensions on relative specifiers,
// but this codebase (like the rest of the app, under Vite/vinext's bundler
// module resolution) writes extensionless relative imports everywhere
// ("../lib/foo", not "../lib/foo.ts"). This hook lets `node --test` load
// real source modules unmodified -- for TS-only unit tests (deckRetrieval,
// askJackProvider, etc.) -- by retrying unresolved relative specifiers with
// a ".ts" suffix before giving up. Combine with --experimental-strip-types.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw err;
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(pathToFileURL(fileURLToPath(candidate)).href, context);
    }
    throw err;
  }
}

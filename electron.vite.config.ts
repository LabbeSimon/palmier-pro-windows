import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const CJS_SHIM = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`

/**
 * Drops the CommonJS shim electron-vite splices into the ESM main bundle.
 *
 * It is inserted at an offset computed in UTF-8 bytes but applied as a string
 * index, so every multi-byte character earlier in the bundle — an em dash in a
 * status message is enough — drags the insertion point further off. Twice it
 * landed inside a template literal: once the build failed outright with an
 * unterminated string, and once it silently shipped a slab of JavaScript inside
 * a message shown to the user.
 *
 * Deleting it is safe rather than merely expedient: this main process declares
 * its own `__dirname` from `import.meta.url` and never calls `require`, and the
 * bundle has in fact been running without the shim's declarations all along —
 * they were inside a string.
 */
function dropCjsShim(): Plugin {
  return {
    name: 'palmier:drop-cjs-shim',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.code.includes('-- CommonJS Shims --')) continue
        const before = chunk.code
        chunk.code = chunk.code.replace(CJS_SHIM, '')
        if (chunk.code === before) {
          this.error(
            'the CommonJS shim is present but not in the shape this plugin removes; ' +
              'electron-vite changed it and the workaround needs updating',
          )
        }
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), dropCjsShim()],
    build: {
      lib: { entry: resolve('src/main/index.ts'), formats: ['es'], fileName: () => 'index.js' },
      rollupOptions: { output: { dir: 'out/main' } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // CommonJS: a sandboxed-off preload still loads more reliably as .cjs.
      lib: { entry: resolve('src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
      rollupOptions: { output: { dir: 'out/preload' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
})

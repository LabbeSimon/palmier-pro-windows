import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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

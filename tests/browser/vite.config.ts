import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('./fixture', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('../../node_modules/.cache/stage0/probe-dist', import.meta.url)),
    emptyOutDir: true,
  },
})

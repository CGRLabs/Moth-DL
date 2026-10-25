import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer/src')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    mode: 'production',
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      // electron-vite does not always carry Vite's production minifier across
      // to the renderer; without this the bundle ships unminified at ~3x size.
      minify: 'esbuild',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})

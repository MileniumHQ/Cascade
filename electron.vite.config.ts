import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import solid from 'vite-plugin-solid'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@core': resolve(__dirname, 'src/core'),
  '@stage': resolve(__dirname, 'src/stage'),
  '@ui': resolve(__dirname, 'src/renderer/ui'),
  '@plugins': resolve(__dirname, 'src/plugins')
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: { exclude: ['zod', '@modelcontextprotocol/sdk'] },
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [solid()],
    worker: { format: 'es' },
    build: {
      target: 'esnext',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          splash: resolve(__dirname, 'src/renderer/splash.html'),
          render: resolve(__dirname, 'src/renderer/render.html')
        }
      }
    }
  }
})

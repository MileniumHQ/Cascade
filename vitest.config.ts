import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@stage': resolve(__dirname, 'src/stage')
    }
  },
  test: { include: ['src/**/*.test.ts'] }
})

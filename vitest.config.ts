import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The engine opens real files and real sockets in integration tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // SQLite handles and bound ports must not be shared across workers.
    fileParallelism: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['src/main/index.ts', 'src/main/ipc/**', 'src/preload/**']
    }
  }
})

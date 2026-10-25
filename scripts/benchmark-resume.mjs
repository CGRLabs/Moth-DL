import { spawnSync } from 'node:child_process'

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'test/benchmark/resume-benchmark.test.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, MOTH_RUN_RESUME_BENCHMARK: '1' }
  }
)

if (result.error) throw result.error
process.exitCode = result.status ?? 1

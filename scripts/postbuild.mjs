/**
 * npm runs `postbuild` automatically after `build`, and this project uses it to
 * refresh the Desktop and Start Menu shortcuts.
 *
 * That is Windows-only: `scripts/shortcut.ps1` needs `powershell`, which does
 * not exist on Linux or macOS runners, so shelling out unconditionally fails
 * the build on those platforms. Skip the whole step elsewhere - there are no
 * shortcuts to refresh off Windows.
 */
import { spawnSync } from 'node:child_process'

if (process.platform !== 'win32') {
  console.log('postbuild: not Windows, skipping shortcut refresh.')
} else {
  const result = spawnSync('npm', ['run', 'shortcut'], { stdio: 'inherit', shell: true })
  process.exit(result.status ?? 0)
}
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_DEFS,
  browserDef,
  buildRegCommands,
  candidateAssetDirs,
  candidateExePaths,
  detectBrowsers,
  getStableCrxPath,
  parseRegSz,
  toRegAddArgs,
} from '../../src/main/ingest/extensionInstall.js';
import type { ExtensionBrowserId } from '../../src/shared/ipc.js';

const ID = 'legoanmlgfmocgoghjnacbgejbnifjmk';
const CRX = 'C:\\Users\\moth\\AppData\\Roaming\\moth-dlm\\extension\\tiri.crx';
const VERSION = '1.0.0';

describe('buildRegCommands', () => {
  it('emits one HKCU command per known browser with path + version', () => {
    const commands = buildRegCommands(ID, CRX, VERSION);
    expect(commands).toHaveLength(BROWSER_DEFS.length);
    expect(commands.map((c) => c.browser).sort()).toEqual(['brave', 'chrome', 'edge']);
    for (const command of commands) {
      expect(command.key).toBe(`HKCU\\${browserDef(command.browser).registryRoot}\\${ID}`);
      expect(command.values).toEqual([
        { name: 'path', type: 'REG_SZ', data: CRX },
        { name: 'version', type: 'REG_SZ', data: VERSION },
      ]);
    }
  });

  it('uses each vendor’s own Extensions root, never cross-writing', () => {
    const keys = new Map(buildRegCommands(ID, CRX, VERSION).map((c) => [c.browser, c.key]));
    expect(keys.get('chrome')).toContain('Software\\Google\\Chrome\\Extensions');
    expect(keys.get('edge')).toContain('Software\\Microsoft\\Edge\\Extensions');
    expect(keys.get('brave')).toContain('Software\\BraveSoftware\\Brave\\Extensions');
    expect(keys.get('brave')).not.toContain('Google');
  });

  it('rejects malformed ids, paths and versions without touching the registry', () => {
    expect(() => buildRegCommands('TOOSHORT', CRX, VERSION)).toThrow();
    expect(() => buildRegCommands('z'.repeat(32), CRX, VERSION)).toThrow(); // z is outside a-p
    expect(() => buildRegCommands(ID, 'relative\\moth.crx', VERSION)).toThrow();
    expect(() => buildRegCommands(ID, 'C:\\x\\moth.zip', VERSION)).toThrow();
    expect(() => buildRegCommands(ID, CRX, 'not-a-version')).toThrow();
    expect(() => buildRegCommands(ID, CRX, '1.0')).toThrow();
  });
});

describe('toRegAddArgs', () => {
  it('lowers a command to forced reg.exe add invocations', () => {
    const [command] = buildRegCommands(ID, CRX, VERSION);
    expect(command).toBeDefined();
    if (!command) throw new Error('unreachable');
    const args = toRegAddArgs(command);
    expect(args).toHaveLength(2);
    expect(args[0]).toEqual(['add', command.key, '/v', 'path', '/t', 'REG_SZ', '/d', CRX, '/f']);
    expect(args[1]).toEqual([
      'add',
      command.key,
      '/v',
      'version',
      '/t',
      'REG_SZ',
      '/d',
      VERSION,
      '/f',
    ]);
  });
});

describe('parseRegSz', () => {
  it('extracts the value from reg.exe query output', () => {
    const output = `\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\Extensions\\${ID}\r\n    version    REG_SZ    1.0.0\r\n`;
    expect(parseRegSz(output)).toBe('1.0.0');
  });

  it('returns null when the value line is absent', () => {
    expect(parseRegSz('ERROR: The system was unable to find the specified registry key or value.')).toBe(
      null,
    );
    expect(parseRegSz('')).toBe(null);
  });
});

describe('candidateExePaths / detectBrowsers', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\moth\\AppData\\Local',
  };

  it('derives install locations from the environment without touching disk', () => {
    const paths = candidateExePaths('chrome', env);
    expect(paths).toContain(win32.join('C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'));
    expect(paths).toContain(win32.join('C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'));
    expect(paths).toContain(
      win32.join('C:\\Users\\moth\\AppData\\Local', 'Google\\Chrome\\Application\\chrome.exe'),
    );
    expect(candidateExePaths('brave', {})).toEqual([]);
  });

  it('detects only browsers whose exe exists', () => {
    const chromePaths = new Set(candidateExePaths('chrome', env));
    const detected = detectBrowsers((p) => chromePaths.has(p), env);
    expect(detected).toEqual(['chrome']);
    expect(detectBrowsers(() => false, env)).toEqual([]);
  });

  it('treats a throwing exists check as absent', () => {
    expect(
      detectBrowsers(() => {
        throw new Error('EACCES');
      }, env),
    ).toEqual([]);
  });
});

describe('paths', () => {
  it('stages the crx outside release/ and temp, under %APPDATA%\\moth-dlm', () => {
    expect(getStableCrxPath('C:\\Users\\moth\\AppData\\Roaming')).toBe(
      win32.join('C:\\Users\\moth\\AppData\\Roaming', 'moth-dlm', 'extension', 'tiri.crx'),
    );
  });

  it('probes the packaged assets first, then the dev tree', () => {
    const dirs = candidateAssetDirs('R:\\resources');
    expect(dirs[0]).toBe(win32.join('R:\\resources', 'browser-extension'));
    expect(dirs[1]).toContain('browser-extension');
  });

  it('rejects unknown browsers loudly', () => {
    expect(() => browserDef('opera' as unknown as ExtensionBrowserId)).toThrow();
  });
});

// Integration test: confirm the real [aliases] TOML segment survives the
// agent-core parse + transform + zod-validate pipeline end-to-end.
//
// This bypasses vitest's source-loader by spawning a fresh node process that
// imports the just-built agent-core dist directly. Without this we'd never
// catch a regression where TOML keys silently drop during transform.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = '/root/projects/kimi-code-study';
const SCRIPT = `
import { readFileSync } from 'node:fs';
import { parseConfigString } from '${REPO}/packages/agent-core/dist/index.mjs';
const filePath = process.argv[2];
const text = readFileSync(filePath, 'utf8');
const out = parseConfigString(text, filePath);
console.log(JSON.stringify({
  keys: Object.keys(out),
  aliases: out.aliases ?? null,
}));
`;

describe('agent-core [aliases] integration', () => {
  it('preserves aliases through parseConfigString', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alias-int-'));
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(
      cfgPath,
      `
[aliases]
"/ss" = "/sessions"
"/mm3" = "/model MiniMax-M3 --provider minimax-cn"
"/q" = "/exit"
`,
      'utf8',
    );
    try {
      // Use tsx so the import chain that reaches @moonshot-ai/kosong resolves
      // through its `src/index.ts` export (the package intentionally does
      // not ship a runtime dist — its `exports` only points to source TS).
      // Write the script to a temp file (tsx -e doesn't forward CLI args
      // into the inline script's process.argv).
      const scriptPath = join(dir, 'probe.mjs');
      writeFileSync(scriptPath, SCRIPT, 'utf8');
      const tsxBin = `${REPO}/node_modules/.bin/tsx`;
      const stdout = execFileSync(tsxBin, [scriptPath, cfgPath], {
        encoding: 'utf8',
      }).trim();
      const result = JSON.parse(stdout);
      expect(result.keys).toContain('aliases');
      expect(result.aliases).toEqual({
        '/ss': '/sessions',
        '/mm3': '/model MiniMax-M3 --provider minimax-cn',
        '/q': '/exit',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
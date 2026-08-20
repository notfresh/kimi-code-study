import { parseAliasCommandArgs, handleAliasCommand, type AliasCommandHost } from '@/tui/commands/alias';
import { describe, expect, it, vi, beforeEach } from 'vitest';

function makeHost(initial: Record<string, string> = {}): {
  host: AliasCommandHost;
  config: Record<string, string>;
  setConfigCalls: unknown[];
  showStatusCalls: string[];
  showErrorCalls: string[];
  refreshAliasesCalls: number;
  refreshAutocompleteCalls: number;
} {
  const config = { ...initial };
  const setConfigCalls: unknown[] = [];
  const showStatusCalls: string[] = [];
  const showErrorCalls: string[] = [];
  let refreshAliasesCalls = 0;
  let refreshAutocompleteCalls = 0;

  const harness = {
    getConfig: vi.fn(async () => ({ aliases: { ...config } })),
    setConfig: vi.fn(async (patch: { aliases?: Record<string, string> }) => {
      setConfigCalls.push(patch);
      for (const [k, v] of Object.entries(patch.aliases ?? {})) {
        if (v === undefined) delete config[k];
        else config[k] = v;
      }
      return { aliases: { ...config } };
    }),
  };

  const host: AliasCommandHost = {
    state: { appState: { inputMode: 'normal' } } as unknown as AliasCommandHost['state'],
    harness: harness as unknown as AliasCommandHost['harness'],
    refreshAliases: vi.fn(async () => {
      refreshAliasesCalls++;
    }),
    refreshSlashCommandAutocomplete: vi.fn(() => {
      refreshAutocompleteCalls++;
    }),
    setAppState: vi.fn(),
    showStatus: vi.fn((msg: string) => {
      showStatusCalls.push(msg);
    }),
    showError: vi.fn((msg: string) => {
      showErrorCalls.push(msg);
    }),
    applyTheme: vi.fn(async () => {}),
    appendTranscriptEntry: vi.fn(),
  };

  return {
    host,
    config,
    setConfigCalls,
    showStatusCalls,
    showErrorCalls,
    get refreshAliasesCalls() {
      return refreshAliasesCalls;
    },
    get refreshAutocompleteCalls() {
      return refreshAutocompleteCalls;
    },
  };
}

describe('parseAliasCommandArgs', () => {
  it('returns list for empty args', () => {
    expect(parseAliasCommandArgs('')).toEqual({ kind: 'list' });
    expect(parseAliasCommandArgs('   ')).toEqual({ kind: 'list' });
  });

  it('parses /name "body" into set (drops leading slashes)', () => {
    expect(parseAliasCommandArgs('/ss "/sessions"')).toEqual({
      kind: 'set',
      name: 'ss',
      body: 'sessions',
    });
  });

  it('accepts name without leading slash', () => {
    expect(parseAliasCommandArgs('ss "/sessions"')).toEqual({
      kind: 'set',
      name: 'ss',
      body: 'sessions',
    });
  });

  it('returns error when only the name is given', () => {
    const result = parseAliasCommandArgs('/ss');
    expect(result.kind).toBe('error');
  });

  it('returns error when body is empty after quote-stripping', () => {
    expect(parseAliasCommandArgs('/ss ""')).toMatchObject({ kind: 'error' });
    expect(parseAliasCommandArgs("/ss ''")).toMatchObject({ kind: 'error' });
  });

  it('accepts namespaced names (skill:foo) and bodies with spaces', () => {
    expect(parseAliasCommandArgs('/review "/skill:review-pr $ARGUMENTS"')).toEqual({
      kind: 'set',
      name: 'review',
      body: 'skill:review-pr $ARGUMENTS',
    });
  });

  it('returns error for invalid name characters', () => {
    // The name is the first whitespace-delimited token; an asterisk in the
    // first token is invalid.
    expect(parseAliasCommandArgs('/bad*name "/foo"')).toMatchObject({ kind: 'error' });
  });
});

describe('handleAliasCommand', () => {
  let h: ReturnType<typeof makeHost>;
  beforeEach(() => {
    h = makeHost();
  });

  it('list: shows "no aliases" when config is empty', async () => {
    await handleAliasCommand(h.host, '');
    expect(h.showStatusCalls).toHaveLength(1);
    expect(h.showStatusCalls[0]).toMatch(/No aliases configured/);
  });

  it('list: shows all configured aliases sorted alphabetically', async () => {
    h = makeHost({ ss: 'sessions', q: 'exit', ab: 'about' });
    await handleAliasCommand(h.host, '');
    expect(h.showStatusCalls).toHaveLength(1);
    const msg = h.showStatusCalls[0]!;
    expect(msg).toMatch(/\/ab.*\/about/);
    expect(msg).toMatch(/\/q.*\/exit/);
    expect(msg).toMatch(/\/ss.*\/sessions/);
  });

  it('set: writes new alias, refreshes state, shows "Added"', async () => {
    await handleAliasCommand(h.host, '/m4 "model MiniMax-M3 --provider minimax-cn"');
    expect(h.setConfigCalls).toEqual([
      { aliases: { m4: 'model MiniMax-M3 --provider minimax-cn' } },
    ]);
    expect(h.refreshAliasesCalls).toBe(1);
    expect(h.refreshAutocompleteCalls).toBe(1);
    expect(h.showStatusCalls.some((s) => s.includes('Added') && s.includes('/m4'))).toBe(true);
    expect(h.showErrorCalls).toHaveLength(0);
  });

  it('set: "Updated" verb when overwriting an existing alias', async () => {
    h = makeHost({ ss: 'sessions' });
    await handleAliasCommand(h.host, '/ss "/help"');
    expect(h.showStatusCalls.some((s) => s.startsWith('Updated'))).toBe(true);
  });

  it('set: no-op (no write) when value is identical to existing', async () => {
    h = makeHost({ ss: 'sessions' });
    await handleAliasCommand(h.host, '/ss "/sessions"');
    expect(h.setConfigCalls).toEqual([]);
    expect(h.showStatusCalls.some((s) => s.includes('already set'))).toBe(true);
  });

  it('error: surface parse errors via showError and skip write', async () => {
    await handleAliasCommand(h.host, '/bad*name "/foo"');
    expect(h.showErrorCalls).toHaveLength(1);
    expect(h.setConfigCalls).toEqual([]);
  });
});
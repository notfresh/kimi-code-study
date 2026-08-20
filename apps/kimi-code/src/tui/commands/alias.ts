/**
 * `/alias` — user-defined slash-command alias manager.
 *
 * Subcommands (git-style: no flag prefix, positional):
 *   /alias                                → list all configured aliases
 *   /alias /<name> "<expansion>"          → set alias (no-op if same value exists)
 *
 * Notes:
 *   - This command writes to `~/.kimi-code/config.toml` via `harness.setConfig`.
 *     `setConfig` is a deep-merge, so adding a NEW alias is safe but DELETE is
 *     not supported yet — see TODO below.
 *   - After a successful write the host is asked to re-read the config and
 *     refresh its in-memory alias map, so the new alias takes effect WITHOUT
 *     a session restart.
 *   - Alias names must start with "/" and use `[a-zA-Z0-9_:/.-]+` (matches
 *     `KimiConfigSchema` validation). Trailing "/" is stripped.
 *   - Alias bodies are passed through unchanged except for one normalization:
 *     a body that starts with `/<name>` is rewritten to `<name>` (without the
 *     leading slash) so the schema regex does not reject a target like
 *     `/sessions` — the runtime always rewrites without the slash.
 */

import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import type { ColorToken, ThemeName } from '#/tui/theme';

import type { ResolvedTheme } from '../theme/colors';
import type { TUIState } from '../tui-state';
import type { AppState, TranscriptEntry } from '../types';

const ALIAS_NAME_REGEX = /^[a-zA-Z0-9_:/.-]+$/;

/**
 * Parse the raw input to `/alias`. Returns one of three shapes:
 *   - `list`:    no positional args
 *   - `set`:     exactly two args: name + quoted body
 *   - `error`:   human-readable reason
 *
 * Whitespace splitting is the same one `parseSlashInput` uses for slash
 * commands: trim the trailing of `/alias`, split on first space, then take
 * the rest verbatim as the body.
 */
export type AliasCommandIntent =
  | { readonly kind: 'list' }
  | { readonly kind: 'set'; readonly name: string; readonly body: string }
  | { readonly kind: 'error'; readonly reason: string };

export function parseAliasCommandArgs(args: string): AliasCommandIntent {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: 'list' };

  // First token must be the alias name, with or without leading "/".
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return {
      kind: 'error',
      reason: 'usage: /alias /<name> "<expansion>"  (or /alias alone to list)',
    };
  }
  const rawName = trimmed.slice(0, spaceIdx).trim();
  const rawBody = trimmed.slice(spaceIdx + 1).trim();

  const normalizedName = rawName.startsWith('/') ? rawName.slice(1) : rawName;
  if (normalizedName.length === 0 || !ALIAS_NAME_REGEX.test(normalizedName)) {
    return {
      kind: 'error',
      reason: `invalid alias name "${rawName}" — use letters, digits, _, :, /, ., - (no leading slash needed)`,
    };
  }
  if (rawBody.length === 0) {
    return {
      kind: 'error',
      reason: 'missing expansion body — wrap the target in quotes, e.g. /alias ss "/sessions"',
    };
  }
  // Strip a single matching pair of surrounding double quotes (most common
  // shell-style usage: `/alias /x "/foo bar"`). If the quotes don't match or
  // only one side is present, leave the body as-is — the schema validator
  // will catch anything truly broken downstream.
  let body = rawBody;
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
    body = body.slice(1, -1);
  } else if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) {
    body = body.slice(1, -1);
  }
  if (body.length === 0) {
    return {
      kind: 'error',
      reason: 'expansion body is empty after quote-stripping',
    };
  }
  // Normalize body: drop a leading "/" to match the schema regex (which only
  // applies to keys, but we store bodies without the leading slash too for
  // uniformity — the runtime normalizes either form back to "/<x>").
  body = body.startsWith('/') ? body.slice(1) : body;
  return { kind: 'set', name: normalizedName, body };
}

/**
 * Minimal host surface needed by the /alias command. Kept narrower than
 * SlashCommandHost so this file can be unit-tested without dragging in the
 * whole TUI host interface.
 */
export interface AliasCommandHost {
  state: TUIState;
  readonly harness: KimiHarness;
  refreshSlashCommandAutocomplete(): void;
  refreshAliases(): Promise<void>;
  setAppState(patch: Partial<AppState>): void;
  showStatus(msg: string, color?: ColorToken): void;
  showError(msg: string): void;
  applyTheme(theme: ThemeName, resolved?: ResolvedTheme): Promise<void>;
  appendTranscriptEntry(entry: TranscriptEntry): void;
}

export async function handleAliasCommand(host: AliasCommandHost, args: string): Promise<void> {
  const intent = parseAliasCommandArgs(args);
  if (intent.kind === 'error') {
    host.showError(intent.reason);
    return;
  }
  if (intent.kind === 'list') {
    await listAliases(host);
    return;
  }
  await setAlias(host, intent.name, intent.body);
}

async function listAliases(host: AliasCommandHost): Promise<void> {
  let config;
  try {
    config = await host.harness.getConfig();
  } catch (error) {
    host.showError(`Failed to read config: ${(error as Error).message}`);
    return;
  }
  const aliases = config.aliases ?? {};
  const entries = Object.entries(aliases);
  if (entries.length === 0) {
    host.showStatus('No aliases configured — add one with: /alias /<name> "<expansion>"');
    return;
  }
  // Normalize the raw key/body so display is consistent regardless of whether
  // the user wrote `"/ss"` or `"ss"` (TOML quoted-key quirks). The map key
  // used by the resolver is the form WITHOUT the leading "/", so display
  // should match what the user actually types — also without the slash.
  const normalized = entries.map(([name, body]) => ({
    name: name.startsWith('/') ? name.slice(1) : name,
    body: body.startsWith('/') ? body.slice(1) : body,
  }));
  // Stable display order: alphabetical by alias name.
  normalized.sort((a, b) => a.name.localeCompare(b.name));
  const lines = normalized.map(
    ({ name, body }) => `  /${name.padEnd(20)} → /${body}`,
  );
  host.showStatus(['Aliases:', ...lines].join('\n'));
}

async function setAlias(host: AliasCommandHost, name: string, body: string): Promise<void> {
  // Read current config so we can show the user what changed (and refuse to
  // re-write when the value is identical, which keeps config.toml's mtime
  // stable when `/alias` is called with its current value).
  let current;
  try {
    current = await host.harness.getConfig();
  } catch (error) {
    host.showError(`Failed to read config: ${(error as Error).message}`);
    return;
  }
  const existing = current.aliases?.[name];
  if (existing === body) {
    host.showStatus(`Alias /${name} already set to /${body}; no change.`);
    return;
  }
  try {
    await host.harness.setConfig({
      aliases: {
        [name]: body,
      },
    });
  } catch (error) {
    host.showError(`Failed to write config: ${(error as Error).message}`);
    return;
  }
  // Re-read so the in-memory map reflects the merged result (deep-merge may
  // surface previously-hidden keys from earlier writes that survived on disk
  // but not in `current`).
  try {
    await host.refreshAliases();
  } catch {
    // refreshAliases already swallows errors internally.
  }
  host.refreshSlashCommandAutocomplete();
  const verb = existing === undefined ? 'Added' : 'Updated';
  host.showStatus(`${verb} alias /${name} → /${body}`);
}
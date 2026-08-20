import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const ALIASES_SECTION = 'aliases';

export const AliasesConfigSchema = z
  .record(
    // Slash-command name without the leading "/", e.g. "ss", "mm3",
    // "skill:review-pr". Runtime normalizes by prepending "/".
    z.string().regex(/^[a-zA-Z0-9_:/.-]+$/),
    // Expansion target (also without leading "/"), e.g. "sessions",
    // "model MiniMax-M3 --provider minimax-cn". User's args are appended.
    z.string().min(1),
  )
  .optional();

export type AliasesConfig = z.infer<typeof AliasesConfigSchema>;

registerConfigSection(ALIASES_SECTION, AliasesConfigSchema, {
  defaultValue: undefined,
});
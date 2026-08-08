export const DEFAULT_PLATFORM_SOURCE = 'claude';

function sanitizeRawSource(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

// Parse a CLAUDE_MEM_* boolean-ish env flag. Matches the loose truthy set used
// across the codebase ('1'/'true'/'yes'); anything else that is set counts as
// false. When unset/empty, the caller-supplied default wins.
function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return defaultValue;
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

// Universal-memory switch. This fork exposes claude-mem as shared read/write
// memory for ANY agent, so we preserve each caller's own identity by default
// (see CLAUDE_MEM_ALLOW_ANY_AGENT in SettingsDefaultsManager). Read from
// process.env directly to keep this module dependency-light (importing the
// settings manager here would risk an import cycle). Default: ENABLED.
function allowAnyAgent(): boolean {
  return parseBooleanFlag(process.env.CLAUDE_MEM_ALLOW_ANY_AGENT, true);
}

// Turn an arbitrary caller-supplied agent identity into a safe, stable slug:
// lowercase, non-alphanumeric runs collapsed to a single hyphen, leading/
// trailing hyphens stripped, capped at 64 chars.
function slugifyIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export function normalizePlatformSource(value?: string | null): string {
  if (!value) return DEFAULT_PLATFORM_SOURCE;

  const source = sanitizeRawSource(value);
  if (!source) return DEFAULT_PLATFORM_SOURCE;

  if (source === 'transcript') return 'codex';
  if (source.includes('codex')) return 'codex';
  if (source.includes('cursor')) return 'cursor';
  if (source.includes('claude')) return 'claude';

  // Non-empty, non-alias identity from some other agent (Letta, Hermes, a
  // Multica squad, etc.). With universal memory enabled we preserve it as a
  // sanitized slug so memories are attributed to the real agent; with the flag
  // disabled we keep the legacy behavior of collapsing unknowns to 'claude'.
  if (allowAnyAgent()) {
    const slug = slugifyIdentity(value);
    return slug || DEFAULT_PLATFORM_SOURCE;
  }

  return DEFAULT_PLATFORM_SOURCE;
}

export function normalizePlatformSourceOrNull(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  return normalizePlatformSource(value);
}

export function sortPlatformSources(sources: string[]): string[] {
  const priority = ['claude', 'codex', 'cursor'];

  return [...sources].sort((a, b) => {
    const aPriority = priority.indexOf(a);
    const bPriority = priority.indexOf(b);

    if (aPriority !== -1 || bPriority !== -1) {
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    }

    return a.localeCompare(b);
  });
}

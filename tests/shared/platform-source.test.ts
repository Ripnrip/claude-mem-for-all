import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  normalizePlatformSource,
  DEFAULT_PLATFORM_SOURCE,
} from '../../src/shared/platform-source.js';

describe('normalizePlatformSource', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.CLAUDE_MEM_ALLOW_ANY_AGENT;
    delete process.env.CLAUDE_MEM_ALLOW_ANY_AGENT;
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CLAUDE_MEM_ALLOW_ANY_AGENT;
    } else {
      process.env.CLAUDE_MEM_ALLOW_ANY_AGENT = saved;
    }
  });

  describe('known aliases (flag-independent)', () => {
    it('maps transcript → codex', () => {
      expect(normalizePlatformSource('transcript')).toBe('codex');
    });

    it('maps anything containing codex → codex', () => {
      expect(normalizePlatformSource('Codex CLI')).toBe('codex');
    });

    it('maps anything containing cursor → cursor', () => {
      expect(normalizePlatformSource('cursor-ide')).toBe('cursor');
    });

    it('maps anything containing claude → claude', () => {
      expect(normalizePlatformSource('Claude Code')).toBe('claude');
    });
  });

  describe('empty / undefined input', () => {
    it('falls back to DEFAULT_PLATFORM_SOURCE for undefined', () => {
      expect(normalizePlatformSource(undefined)).toBe(DEFAULT_PLATFORM_SOURCE);
    });

    it('falls back to DEFAULT_PLATFORM_SOURCE for null', () => {
      expect(normalizePlatformSource(null)).toBe(DEFAULT_PLATFORM_SOURCE);
    });

    it('falls back to DEFAULT_PLATFORM_SOURCE for whitespace-only', () => {
      expect(normalizePlatformSource('   ')).toBe(DEFAULT_PLATFORM_SOURCE);
    });
  });

  describe('arbitrary identity with CLAUDE_MEM_ALLOW_ANY_AGENT enabled', () => {
    beforeEach(() => {
      process.env.CLAUDE_MEM_ALLOW_ANY_AGENT = 'true';
    });

    it('preserves an arbitrary agent identity as a slug', () => {
      expect(normalizePlatformSource('Letta')).toBe('letta');
    });

    it('slugifies runs of non-alphanumeric characters to single hyphens', () => {
      expect(normalizePlatformSource('Multica Squad #3')).toBe('multica-squad-3');
    });

    it('strips leading/trailing separators', () => {
      expect(normalizePlatformSource('__hermes__')).toBe('hermes');
    });

    it('caps the slug at 64 characters', () => {
      const long = 'x'.repeat(200);
      expect(normalizePlatformSource(long).length).toBe(64);
    });

    it('is the default behavior when the flag is unset', () => {
      delete process.env.CLAUDE_MEM_ALLOW_ANY_AGENT;
      expect(normalizePlatformSource('letta')).toBe('letta');
    });
  });

  describe('arbitrary identity with CLAUDE_MEM_ALLOW_ANY_AGENT disabled', () => {
    beforeEach(() => {
      process.env.CLAUDE_MEM_ALLOW_ANY_AGENT = 'false';
    });

    it('collapses an unknown agent identity to claude (legacy behavior)', () => {
      expect(normalizePlatformSource('letta')).toBe(DEFAULT_PLATFORM_SOURCE);
    });

    it('still preserves known aliases', () => {
      expect(normalizePlatformSource('codex')).toBe('codex');
    });

    it('still falls back to default for empty input', () => {
      expect(normalizePlatformSource('')).toBe(DEFAULT_PLATFORM_SOURCE);
    });
  });
});

import type { GameData } from '../../gamedata.js';
import { badRequest, conflict } from '../../errors.js';

const LOOKALIKE: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/** Canonical form for uniqueness + reserved checks: lowercase, lookalikes folded, non-alphanumerics dropped. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LOOKALIKE[c] ?? '')
    .replace(/l/g, 'i') // i / l / 1 / ! are visually ambiguous: treat as one letter
    .replace(/[^a-z]/g, '');
}

const ALLOWED = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]*[A-Za-z0-9])?$/;

export function validateDisplayName(raw: string, rules: GameData['economy']['displayName']): { name: string; key: string } {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < rules.minLength || name.length > rules.maxLength) {
    throw badRequest('invalid_display_name', `Display name must be ${rules.minLength}-${rules.maxLength} characters`);
  }
  if (!ALLOWED.test(name)) throw badRequest('invalid_display_name', 'Use letters, numbers, spaces, hyphens and underscores only');
  const key = nameKey(name);
  if (key.length < 2) throw badRequest('invalid_display_name', 'Display name needs more letters');
  if (rules.reserved.map(nameKey).includes(key) || rules.blockedSubstrings.map(nameKey).some((b) => b && key.includes(b))) {
    throw conflict('display_name_reserved', 'That display name is not available');
  }
  return { name, key };
}

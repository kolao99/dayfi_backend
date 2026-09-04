import crypto from 'crypto';
import { db } from '../../../config/database';
import type { AzapEntityAlias, AzapEntityKind, EntityResolution } from './types';

type AliasRow = {
  id: string;
  user_id: string;
  kind: AzapEntityKind;
  alias: string;
  target_id: string;
  display_label: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};

function normalizeAlias(alias: string): string {
  return String(alias || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowToAlias(row: AliasRow): AzapEntityAlias {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    alias: row.alias,
    targetId: row.target_id,
    displayLabel: row.display_label,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

export async function saveEntityAlias(input: {
  userId: string;
  kind: AzapEntityKind;
  alias: string;
  targetId: string;
  displayLabel: string;
  metadata?: Record<string, unknown>;
}): Promise<AzapEntityAlias> {
  const alias = normalizeAlias(input.alias);
  if (!alias) {
    throw new Error('Alias name is required.');
  }
  const id = `azap_alias_${crypto.randomBytes(8).toString('hex')}`;
  const row = await db.one<AliasRow>(
    `INSERT INTO azap_entity_aliases
       (id, user_id, kind, alias, alias_normalized, target_id, display_label, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (user_id, kind, alias_normalized)
     DO UPDATE SET
       target_id = EXCLUDED.target_id,
       display_label = EXCLUDED.display_label,
       metadata = EXCLUDED.metadata,
       alias = EXCLUDED.alias,
       updated_at = NOW()
     RETURNING id, user_id, kind, alias, target_id, display_label, metadata, created_at`,
    [
      id,
      input.userId,
      input.kind,
      input.alias.trim(),
      alias,
      input.targetId,
      input.displayLabel,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return rowToAlias(row);
}

export async function listEntityAliases(
  userId: string,
  kind?: AzapEntityKind
): Promise<AzapEntityAlias[]> {
  const rows = kind
    ? await db.manyOrNone<AliasRow>(
        `SELECT id, user_id, kind, alias, target_id, display_label, metadata, created_at
           FROM azap_entity_aliases
          WHERE user_id = $1 AND kind = $2
          ORDER BY alias ASC`,
        [userId, kind]
      )
    : await db.manyOrNone<AliasRow>(
        `SELECT id, user_id, kind, alias, target_id, display_label, metadata, created_at
           FROM azap_entity_aliases
          WHERE user_id = $1
          ORDER BY kind ASC, alias ASC`,
        [userId]
      );
  return rows.map(rowToAlias);
}

export async function resolveEntityAlias(input: {
  userId: string;
  kind: AzapEntityKind;
  alias: string;
}): Promise<EntityResolution> {
  const needle = normalizeAlias(input.alias);
  if (!needle) {
    return { status: 'not_found', alias: input.alias, kind: input.kind };
  }

  const rows = await db.manyOrNone<AliasRow>(
    `SELECT id, user_id, kind, alias, target_id, display_label, metadata, created_at
       FROM azap_entity_aliases
      WHERE user_id = $1
        AND kind = $2
        AND (
          alias_normalized = $3
          OR alias_normalized LIKE $4
        )`,
    [input.userId, input.kind, needle, `%${needle}%`]
  );

  const matches = rows.map(rowToAlias);
  const exact = matches.filter(
    (m) => normalizeAlias(m.alias) === needle
  );
  const pool = exact.length ? exact : matches;

  if (pool.length === 0) {
    return { status: 'not_found', alias: input.alias, kind: input.kind };
  }
  if (pool.length > 1) {
    return {
      status: 'ambiguous',
      alias: input.alias,
      kind: input.kind,
      matches: pool,
    };
  }
  return { status: 'resolved', alias: pool[0] };
}

export function formatEntityNotFound(input: {
  alias: string;
  kind: AzapEntityKind;
}): string {
  if (input.kind === 'recipient') {
    return (
      `I couldn't find a saved recipient called ${input.alias}.\n\n` +
      `Would you like to:\n` +
      `• Add ${input.alias}\n` +
      `• Choose a saved recipient\n` +
      `• Enter bank details`
    );
  }
  return (
    `I don't have a saved ${input.kind} called ${input.alias} yet.\n\n` +
    `Tell me the details and I'll help you set it up.`
  );
}

export function formatEntityAmbiguous(input: {
  alias: string;
  matches: AzapEntityAlias[];
}): string {
  const lines = input.matches.map((m) => `• ${m.displayLabel}`);
  return (
    `I found more than one match for ${input.alias}:\n\n` +
    `${lines.join('\n')}\n\n` +
    `Which one do you mean?`
  );
}

export function saveRecipientSuggestionMessage(): string {
  return 'Would you like to save this recipient for next time?';
}

export function saveBillerSuggestionMessage(): string {
  return 'Would you like to save this bill as a shortcut?';
}

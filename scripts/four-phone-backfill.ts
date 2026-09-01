/**
 * Four Phase 1 — backfill users.phone_e164 from the legacy users.phone_number.
 *
 * RISK R1: `phone_number` is unnormalized, so '08012345678' and
 * '+2348012345678' can be two rows that normalize to ONE identity. Writing
 * those blindly would either violate users_phone_e164_key or, worse, let one
 * person sign in to another's account.
 *
 * Report (default, read-only):
 *   npx ts-node -r dotenv/config scripts/four-phone-backfill.ts
 * Apply (only after collisions are resolved by hand):
 *   npx ts-node -r dotenv/config scripts/four-phone-backfill.ts --apply
 */

import { db } from '../src/config/database';
import {
  normalizePhoneE164,
  maskPhoneE164,
} from '../src/shared/utils/phoneE164';

type Row = {
  user_id: string;
  email: string | null;
  phone_number: string | null;
  phone_e164: string | null;
};

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const rows = await db.manyOrNone<Row>(
    `SELECT user_id, email, phone_number, phone_e164
       FROM users
      WHERE is_deleted IS NOT TRUE
        AND phone_number IS NOT NULL
        AND phone_e164 IS NULL
      ORDER BY created_at ASC`
  );

  const byE164 = new Map<string, Row[]>();
  const invalid: Array<{ row: Row; reason: string }> = [];

  for (const row of rows) {
    const result = normalizePhoneE164(row.phone_number);
    if (!result.ok) {
      invalid.push({ row, reason: result.reason });
      continue;
    }
    const bucket = byE164.get(result.e164) ?? [];
    bucket.push(row);
    byE164.set(result.e164, bucket);
  }

  // A candidate also collides if some other row ALREADY holds that e164.
  const taken = await db.manyOrNone<{ phone_e164: string; user_id: string }>(
    `SELECT phone_e164, user_id FROM users WHERE phone_e164 IS NOT NULL`
  );
  const takenBy = new Map(taken.map((t) => [t.phone_e164, t.user_id]));

  const clean: Array<{ userId: string; e164: string }> = [];
  const collisions: Array<{ e164: string; userIds: string[] }> = [];

  for (const [e164, bucket] of byE164) {
    const existingOwner = takenBy.get(e164);
    if (bucket.length > 1 || existingOwner) {
      collisions.push({
        e164,
        userIds: [
          ...bucket.map((r) => r.user_id),
          ...(existingOwner ? [`${existingOwner} (already assigned)`] : []),
        ],
      });
      continue;
    }
    clean.push({ userId: bucket[0].user_id, e164 });
  }

  console.log('\n=== Four phone_e164 backfill report ===');
  console.log(`candidates (phone_number set, phone_e164 null): ${rows.length}`);
  console.log(`normalizable and unique:                        ${clean.length}`);
  console.log(`unparseable phone numbers:                      ${invalid.length}`);
  console.log(`COLLISIONS (must be resolved by hand):          ${collisions.length}`);

  if (invalid.length > 0) {
    console.log('\n--- Unparseable (left as NULL, users keep other login methods) ---');
    for (const { row, reason } of invalid.slice(0, 50)) {
      console.log(`  ${row.user_id}  raw="${row.phone_number}"  reason=${reason}`);
    }
    if (invalid.length > 50) console.log(`  ... and ${invalid.length - 50} more`);
  }

  if (collisions.length > 0) {
    console.log('\n--- COLLISIONS: multiple identities normalize to one number ---');
    console.log('Four will NOT merge accounts automatically (rule D1.5).');
    for (const c of collisions) {
      console.log(`  ${maskPhoneE164(c.e164)}  ->  ${c.userIds.join(', ')}`);
    }
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — nothing written. Re-run with --apply to write ${clean.length} row(s).`
    );
    return;
  }

  if (collisions.length > 0) {
    console.error(
      '\nREFUSING TO APPLY: resolve the collisions above first. ' +
        'Assigning a phone number to the wrong identity is an account-takeover bug.'
    );
    process.exitCode = 1;
    return;
  }

  let written = 0;
  for (const { userId, e164 } of clean) {
    // phone_verified stays false: the legacy column proves nothing about
    // whether this person still controls the number. Verification happens at
    // first OTP sign-in.
    await db.none(
      `UPDATE users SET phone_e164 = $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, e164]
    );
    written += 1;
  }

  console.log(`\nAPPLIED — wrote phone_e164 for ${written} user(s).`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });

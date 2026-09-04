import { verifyUserIdentity } from '../../kyc/identityService';
import { buildKycProfileSnapshot } from '../../kyc/smileService';
import { getUserById, updateProfile } from '../auth/identityService';

export async function getFourKycStatus(userId: string) {
  return buildKycProfileSnapshot(userId);
}

export async function verifyBvnFromFour(input: {
  userId: string;
  bvn: string;
  firstName?: string;
  lastName?: string;
}) {
  const bvn = String(input.bvn).replace(/\D/g, '');
  if (!/^\d{11}$/.test(bvn)) {
    throw new Error('BVN must be exactly 11 digits.');
  }

  const user = await getUserById(input.userId);
  if (!user) {
    throw new Error('Please sign in again.');
  }

  // Prefer names from the KYC form — WhatsApp may only have a short display name.
  const incomingFirst = String(input.firstName ?? '').trim();
  const incomingLast = String(input.lastName ?? '').trim();
  if (incomingFirst || incomingLast) {
    const updates: { firstName?: string; lastName?: string } = {};
    if (incomingFirst) updates.firstName = incomingFirst;
    if (incomingLast) updates.lastName = incomingLast;
    const updated = await updateProfile(user.user_id, updates);
    user.first_name = updated.first_name;
    user.last_name = updated.last_name;
  }

  const firstName =
    incomingFirst || String(user.first_name ?? '').trim();
  const lastName = incomingLast || String(user.last_name ?? '').trim();
  if (!firstName || !lastName) {
    throw new Error(
      'Please provide your first and last name to verify your BVN.'
    );
  }

  const outcome = await verifyUserIdentity({
    userId: input.userId,
    bvn,
    firstName,
    lastName,
  });

  return {
    ok: true as const,
    snapshot: outcome,
  };
}

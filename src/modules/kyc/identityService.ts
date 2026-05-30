import AuthService from '../authentication/services';
import PaymentService from '../payment/services';
import { buildKycProfileSnapshot, type KycProfileSnapshot } from './smileService';

const authService = new AuthService();
const paymentService = new PaymentService();

function formatApiError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return fallback;
}

/** Tier 2: BVN (Flutterwave) + level-2 + NGN virtual account. NIN is Tier 3 via Smile. */
export async function verifyUserIdentity(params: {
  userId: string;
  bvn: string;
  nin?: string;
  firstName: string;
  lastName: string;
}): Promise<KycProfileSnapshot> {
  const userId = params.userId;
  const bvn = String(params.bvn).trim();
  const nin = String(params.nin ?? '').trim();

  if (!/^\d{11}$/.test(bvn)) {
    throw new Error('BVN must be exactly 11 digits.');
  }
  if (nin && !/^\d{11}$/.test(nin)) {
    throw new Error('NIN must be exactly 11 digits.');
  }
  if (nin) {
    throw new Error(
      'NIN verification is Tier 3. Complete BVN verification first, then verify your NIN separately.'
    );
  }

  const firstName = String(params.firstName ?? '').trim();
  const lastName = String(params.lastName ?? '').trim();
  if (!firstName || !lastName) {
    throw new Error(
      'Your profile is missing first or last name. Update your profile, then try again.'
    );
  }

  try {
    const lookup = await authService.initiateBvnLookup(bvn, firstName, lastName);
    if (!lookup.verified && !lookup.verificationSkipped) {
      throw new Error(
        'BVN could not be verified. Check the number matches your bank records and that your Dayfi name matches your BVN name.'
      );
    }
  } catch (err: unknown) {
    const msg = formatApiError(err, 'BVN verification failed.');
    if (/bvn/i.test(msg)) throw new Error(msg);
    throw new Error(
      `BVN verification failed: ${msg}. Make sure your BVN is correct and matches the name on your Dayfi account (${firstName} ${lastName}).`
    );
  }

  await authService.saveUserBvn(userId, bvn);
  await authService.updateUserLevel('level-2', userId);

  const profile = await authService.getUserById(userId);
  const email = String(profile?.email ?? '').trim();
  if (!email) {
    throw new Error('Add an email to your profile before creating an NGN bank account.');
  }

  let ngnAccount: { accountNumber?: string; bankName?: string } | undefined;
  try {
    const wallet = await paymentService.ensureNgnVirtualAccount(userId, email, bvn);
    ngnAccount = {
      accountNumber: (wallet as { account_number?: string }).account_number,
      bankName: (wallet as { bank_name?: string }).bank_name,
    };
  } catch (err: unknown) {
    const msg = formatApiError(err, 'Could not create NGN bank account.');
    throw new Error(
      `Your BVN was verified, but we could not create your NGN bank account: ${msg}`
    );
  }

  return buildKycProfileSnapshot(userId, ngnAccount);
}

import { db } from '../../../config/database';
import PaymentService from '../../payment/services';
import { buildKycProfileSnapshot } from '../../kyc/smileService';

type FundingReply = {
  role: 'assistant';
  type: 'text' | 'choice';
  content: string;
  metadata?: Record<string, unknown>;
};

const paymentService = new PaymentService();

/**
 * Real NGN bank-transfer funding via Flutterwave VA.
 * Requires BVN on the Dayfi user (same gate as POST /wallets/add/fiat/ngn).
 */
export async function beginNgnBankFunding(input: {
  userId: string;
  conversationId: string;
}): Promise<FundingReply> {
  const snapshot = await buildKycProfileSnapshot(input.userId);
  if (!snapshot.bvnVerified || !snapshot.bvn) {
    return {
      role: 'assistant',
      type: 'choice',
      content:
        'To receive NGN by bank transfer, complete verification first. Your BVN stays private and is never shown in chat.',
      metadata: { secureSurface: 'kyc', scope: 'kyc' },
    };
  }

  const user = await db.oneOrNone<{ email: string | null }>(
    `SELECT email FROM users WHERE user_id = $1`,
    [input.userId]
  );
  const email = String(user?.email || '').trim();
  if (!email) {
    return {
      role: 'assistant',
      type: 'text',
      content:
        'Your account needs an email before I can create a NGN bank account. Complete verification and try again.',
    };
  }

  try {
    const wallet = await paymentService.ensureNgnVirtualAccount(
      input.userId,
      email,
      snapshot.bvn
    );
    const number = String(
      (wallet as { account_number?: string }).account_number || ''
    );
    const bank = String((wallet as { bank_name?: string }).bank_name || 'Bank');
    const name = String(
      (wallet as { account_name?: string }).account_name || ''
    );
    if (!number) {
      throw new Error('Virtual account not ready');
    }
    return {
      role: 'assistant',
      type: 'text',
      content:
        `*NGN bank transfer*\n\n` +
        `Send NGN from your bank to:\n\n` +
        `Bank: ${bank}\n` +
        `Account: ${number}\n` +
        (name ? `Name: ${name}\n` : '') +
        `\nUse this account only. Your Dayfi wallet credits after the transfer confirms.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[azap/fiat-funding] NGN VA failed', msg);
    return {
      role: 'assistant',
      type: 'text',
      content:
        "I couldn't create your NGN bank account just now. Please try again in a moment.",
    };
  }
}

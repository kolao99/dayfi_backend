import { FourError } from '../errors';
import {
  getIntentForUser,
  updateIntent,
  toPublicIntent,
  type FourActiveIntent,
} from './intentService';

const MINI_APP_VISIBLE = new Set([
  'AWAITING_AUTHORIZATION',
  'PROCESSING',
]);

/**
 * Returns intent review data for the Mini App.
 *
 * Opening the PIN surface promotes AWAITING_CONFIRMATION → AWAITING_AUTHORIZATION
 * so tapping "Confirm with PIN" is the explicit user consent step.
 */
export async function getIntentForMiniApp(
  userId: string,
  intentId: string
): Promise<FourActiveIntent> {
  let intent = await getIntentForUser(userId, intentId);
  if (!intent) {
    throw new FourError('intent_not_found');
  }

  if (intent.status === 'AWAITING_CONFIRMATION') {
    const promoted = await updateIntent(userId, intentId, {
      status: 'AWAITING_AUTHORIZATION',
    });
    if (!promoted) throw new FourError('intent_not_found');
    intent = promoted;
  }

  if (!MINI_APP_VISIBLE.has(intent.status) && intent.status !== 'COMPLETED' && intent.status !== 'FAILED') {
    throw new FourError('intent_invalid_state');
  }

  return intent;
}

export function toMiniAppReview(intent: FourActiveIntent) {
  const pub = toPublicIntent(intent);
  const slots = pub.slots as Record<string, unknown>;
  const recipient = slots.recipient as Record<string, unknown> | undefined;
  if (recipient?.accountNumber) {
    const acct = String(recipient.accountNumber);
    slots.recipient = {
      ...recipient,
      accountNumber: acct.length > 4 ? `••••${acct.slice(-4)}` : '••••',
    };
  }
  return { ...pub, slots };
}

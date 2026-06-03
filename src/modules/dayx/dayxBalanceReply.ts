import { db } from '../../config/database';
import PaymentService from '../payment/services';
import { formatMoney } from '../payment/walletModel';

const paymentService = new PaymentService();
const WALLET_CURRENCIES = ['USD', 'NGN', 'GBP', 'EUR'] as const;

export function detectTotalInNairaQuery(message: string): boolean {
  const q = message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return false;

  const wantsNgn =
    /\b(naira|ngn)\b/.test(q) ||
    q.includes('in naira') ||
    q.includes('to naira') ||
    q.includes('in ngn');

  const wantsTotal =
    /\b(total|overall|combined|everything|all|full|entire|whole|net|worth)\b/.test(
      q
    ) ||
    q.includes('how much') ||
    q.includes('balance');

  return wantsNgn && wantsTotal;
}

export async function buildTotalNgnBalanceReply(
  userId: string
): Promise<string> {
  const rows = await db.any<{ currency: string; balance: string }>(
    `SELECT currency, balance::text AS balance
     FROM wallets WHERE user_id = $1`,
    [userId]
  );

  const balanceMap = new Map<string, number>();
  for (const row of rows) {
    const cur = String(row.currency).toUpperCase();
    const bal = Number(row.balance);
    if (Number.isFinite(bal)) balanceMap.set(cur, bal);
  }

  let totalNgn = 0;
  const breakdown: string[] = [];

  for (const cur of WALLET_CURRENCIES) {
    const bal = balanceMap.get(cur) ?? 0;
    if (bal <= 0) continue;

    let ngnEquiv = bal;
    if (cur !== 'NGN') {
      try {
        const rate = await paymentService.getExchangeRate(cur, 'NGN');
        ngnEquiv = rate > 0 ? bal * rate : 0;
      } catch {
        ngnEquiv = 0;
      }
    }
    totalNgn += ngnEquiv;

    if (cur === 'NGN') {
      breakdown.push(`${cur}: ${formatMoney(bal, cur)}`);
    } else if (ngnEquiv > 0) {
      breakdown.push(
        `${cur}: ${formatMoney(bal, cur)} (≈ ${formatMoney(ngnEquiv, 'NGN')})`
      );
    } else {
      breakdown.push(`${cur}: ${formatMoney(bal, cur)}`);
    }
  }

  if (!breakdown.length) {
    return 'You have no wallet balance yet. Top up a wallet to get started.';
  }

  const totalLine = formatMoney(totalNgn, 'NGN');
  return (
    `Your total available balance is about ${totalLine}.\n\n` +
    `Breakdown:\n${breakdown.join('\n')}\n\n` +
    'Rates are approximate and update live at swap.'
  );
}

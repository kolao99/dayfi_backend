import PaymentService from '../../payment/services';
import { getCryptoBalances } from '../../payment/cryptoSendService';
import { formatMoney, usdLedgerBalance } from '../../payment/walletModel';
import { db } from '../../../config/database';
import {
  formatSupportedNetworksLine,
  getSupportedCryptoAssets,
} from '../../azap/capabilities/moneyCapabilities';
import type { CryptoStableAsset } from '../../../config/cryptoNetworks';

const paymentService = new PaymentService();

export async function buildWalletIntelReply(
  userId: string,
  text: string
): Promise<string | null> {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();

  if (
    /what networks|which network|what crypto can i receive|what can i deposit/.test(
      q
    )
  ) {
    const assets = getSupportedCryptoAssets();
    const lines = assets.map(
      (a) => `*${a}*\n${formatSupportedNetworksLine(a as CryptoStableAsset)}`
    );
    return `You can receive:\n\n${lines.join('\n\n')}`;
  }

  if (/stellar address|usdc stellar|eurc stellar|deposit address/.test(q)) {
    return null; // handled by crypto deposit flow
  }

  if (
    /how much usdc|usdc balance|eurc balance|how much eurc|crypto balance/.test(
      q
    )
  ) {
    const crypto = await getCryptoBalances(userId);
    const wantEurc = /eurc/.test(q);
    if (wantEurc) {
      return `EURC (Stellar): ${crypto.stellar.EURC}\nEURC (Ethereum): ${crypto.ethereum.EURC}`;
    }
    return (
      `USDC (Stellar): ${crypto.stellar.USDC}\n` +
      `USDC (Ethereum): ${crypto.ethereum.USDC}`
    );
  }

  if (/show my (wallet|balances)|what do i hold|my assets/.test(q)) {
    await paymentService.ensureUserLedgerWallets(userId);
    const wallets = await paymentService.getWalletsByUserId(userId);
    const usd = usdLedgerBalance(wallets as never);
    const crypto = await getCryptoBalances(userId);
    return (
      `*Wallet*\n` +
      `Ledger: ${formatMoney(usd, 'USD')}\n\n` +
      `Stellar USDC ${crypto.stellar.USDC} · EURC ${crypto.stellar.EURC}\n` +
      `Ethereum USDC ${crypto.ethereum.USDC} · EURC ${crypto.ethereum.EURC}`
    );
  }

  if (
    /last \d+ transactions|show my transactions|recent (tx|transfers|activity|payments)|transaction history|my (?:payments|history)/.test(
      q
    )
  ) {
    const n = Math.min(10, Number(q.match(/last (\d+)/)?.[1] || 5) || 5);
    const rows = await db.manyOrNone<{
      reason: string | null;
      send_amount: string | null;
      timestamp: Date;
    }>(
      `SELECT reason, send_amount, timestamp
         FROM wallet_transactions
        WHERE user_id = $1
        ORDER BY timestamp DESC
        LIMIT $2`,
      [userId, n]
    );
    if (!rows.length) return 'No transactions yet.';
    const lines = rows.map((r) => {
      const when = r.timestamp.toISOString().slice(0, 10);
      return `• ${when} — ${r.reason || 'Transaction'}${
        r.send_amount ? ` (${r.send_amount})` : ''
      }`;
    });
    return `*Recent activity*\n\n${lines.join('\n')}`;
  }

  if (
    /how can (?:someone|people) send|how (?:do i|to) receive|where do i receive/.test(
      q
    )
  ) {
    return (
      'On WhatsApp you can receive:\n' +
      '• *NGN* — ask for your bank details\n' +
      '• *USDC / EURC* — ask for your deposit address\n\n' +
      'Other African currencies are in the Dayfi app (Yellow Card), not WhatsApp yet.'
    );
  }

  return null;
}

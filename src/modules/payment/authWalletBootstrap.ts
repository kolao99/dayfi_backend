import PaymentService from './services';
import { provisionCryptoWalletsForUser } from './cryptoWalletProvision';

/**
 * After auth: ensure ledger wallets + Stellar/ETH deposit addresses (async, non-blocking).
 */
export function bootstrapWalletsOnAuth(userId: string | undefined | null): void {
  const uid = String(userId || '').trim();
  if (!uid) return;

  void (async () => {
    try {
      const paymentService = new PaymentService();
      await paymentService.ensureUserLedgerWallets(uid);
      await provisionCryptoWalletsForUser(uid);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bootstrapWalletsOnAuth] user=${uid}: ${msg}`);
    }
  })();
}

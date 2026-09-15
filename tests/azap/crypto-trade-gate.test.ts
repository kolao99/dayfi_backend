/**
 * ensureWallet + YC crypto trade gate — unit/DB tests (no real YC money).
 */
process.env.AZAP_LLM_PROVIDER = 'stub';
process.env.FOUR_OTP_PROVIDER = 'stub';
process.env.FOUR_OTP_STUB_CODE = '123456';

import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';
import crypto from 'crypto';
import { db } from '../../src/config/database';
import { requestOtp, verifyOtp } from '../../src/modules/four/auth/phoneAuthService';
import { ensureWallet } from '../../src/modules/payment/ensureWallet';
import { getCryptoAssetWallet } from '../../src/modules/payment/cryptoAssetWalletStore';
import {
  probeYellowCardCryptoCapabilities,
  resetYcCapabilityCacheForTests,
} from '../../src/modules/payment/yellowCardCapabilityService';
import { prepareCryptoTrade } from '../../src/modules/payment/cryptoTradeGate';
import { YellowCardService } from '../../src/modules/payment/yellowCardService';
import {
  resolveEffectiveCapabilities,
  findAssetNetwork,
} from '../../src/modules/azap/crypto/assetRegistry';

const STUB = '123456';
const phones: string[] = [];

async function createUser(): Promise<string> {
  const phone = `+23480${crypto.randomInt(10_000_000, 99_999_999)}`;
  phones.push(phone);
  await requestOtp({ phone });
  return (await verifyOtp({ phone, code: STUB })).user.id;
}

describe('crypto asset wallets + trade gate', function () {
  this.timeout(90000);

  before(async () => {
    // Ensure migration applied when local DB is available.
    await db.none(`
      CREATE TABLE IF NOT EXISTS crypto_asset_wallets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id VARCHAR NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset VARCHAR(16) NOT NULL,
        network VARCHAR(32) NOT NULL,
        address VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING', 'ACTIVE', 'FAILED', 'SUSPENDED')),
        provider VARCHAR(32) NOT NULL DEFAULT 'dayfi',
        custody VARCHAR(32) NOT NULL DEFAULT 'dayfi_ledger',
        trustline_ready BOOLEAN NOT NULL DEFAULT FALSE,
        last_error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, asset, network)
      )
    `);
  });

  after(async () => {
    if (phones.length) {
      await db.none(`DELETE FROM users WHERE phone_e164 = ANY($1::text[])`, [
        phones,
      ]);
    }
  });

  it('rejects unknown asset/network without inventing wallets', async () => {
    const userId = await createUser();
    const r = await ensureWallet({
      userId,
      asset: 'DOGE',
      network: 'doge',
    });
    expect(r.ok).to.equal(false);
    if (!r.ok) expect(r.code).to.equal('UNKNOWN_ASSET_NETWORK');
    const row = await getCryptoAssetWallet(userId, 'DOGE', 'doge');
    expect(row).to.equal(null);
  });

  it('BTC is catalogued but wallet strategy is pending (not hardcoded forever-unsupported)', async () => {
    const userId = await createUser();
    const r = await ensureWallet({
      userId,
      asset: 'BTC',
      network: 'bitcoin',
    });
    expect(r.ok).to.equal(false);
    if (!r.ok) expect(r.code).to.equal('WALLET_STRATEGY_PENDING');
  });

  it('records PENDING then FAILED/ACTIVE row for Stellar USDC (env-dependent)', async () => {
    const userId = await createUser();
    const r = await ensureWallet({
      userId,
      asset: 'USDC',
      network: 'stellar',
    });
    const row = await getCryptoAssetWallet(userId, 'USDC', 'stellar');
    expect(row).to.not.equal(null);
    // Without master wallet / horizon in CI this may FAIL; still must persist status.
    expect(['ACTIVE', 'FAILED', 'PENDING']).to.include(String(row?.status));
    if (r.ok) {
      expect(r.wallet.address).to.match(/^G[A-Z0-9]{55}$/);
      expect(r.wallet.trustline_ready).to.equal(true);
      // Idempotent second call
      const again = await ensureWallet({
        userId,
        asset: 'USDC',
        network: 'stellar',
      });
      expect(again.ok).to.equal(true);
      if (again.ok) expect(again.wallet.address).to.equal(r.wallet.address);
    }
  });

  it('USDC and EURC share the same Stellar address when both activate', async function () {
    const userId = await createUser();
    const usdc = await ensureWallet({
      userId,
      asset: 'USDC',
      network: 'stellar',
    });
    const eurc = await ensureWallet({
      userId,
      asset: 'EURC',
      network: 'stellar',
    });
    if (!usdc.ok || !eurc.ok) {
      this.skip();
      return;
    }
    expect(usdc.wallet.address).to.equal(eurc.wallet.address);
  });

  it('trade gate refuses BUY when YC not entitled (no ledger side effects)', async () => {
    resetYcCapabilityCacheForTests();
    const userId = await createUser();
    const gate = await prepareCryptoTrade({
      userId,
      side: 'buy',
      asset: 'USDC',
      network: 'stellar',
      fiatAmount: 50000,
    });
    // Either wallet not ready (no stellar env) or YC not entitled — never ready:true.
    if (gate.ok && !gate.ready) {
      expect(gate.code).to.be.oneOf([
        'YC_NOT_ENTITLED',
        'WALLET_PENDING',
        'E2E_NOT_READY',
      ]);
    } else if (!gate.ok) {
      expect(gate.code).to.match(/WALLET|PROVISION|TRUSTLINE|UNSUPPORTED|UNKNOWN/);
    } else {
      expect.fail('trade gate must not return ready:true until E2E is complete');
    }
  });

  it('direct settlement helpers require settlementInfo fields', async () => {
    const yc = new YellowCardService();
    let threw = false;
    try {
      await yc.createDirectSettlementCollection({
        directSettlement: true,
        settlementInfo: { cryptoCurrency: 'USDC' },
      });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('capability probe returns structured blockers without secrets', async () => {
    resetYcCapabilityCacheForTests();
    const snap = await probeYellowCardCryptoCapabilities({ forceRefresh: true });
    expect(snap.probedAt).to.be.a('string');
    expect(snap.blockers).to.be.an('array');
    const blob = JSON.stringify(snap).toLowerCase();
    expect(blob).to.not.match(/ychmac|api[_-]?secret|private[_-]?key/);
    // Live account (when reachable) currently has no crypto surfaces → buy not ready.
    expect(snap.buyDirectSettlementReady).to.equal(false);
  });

  it('effective caps expose buy only when wallet + YC pair + static enable align', () => {
    const btc = findAssetNetwork('BTC', 'bitcoin');
    expect(btc).to.not.equal(null);
    expect(btc!.walletStrategy).to.equal('bitcoin_pending');

    const cold = resolveEffectiveCapabilities({ ycPairs: [] });
    expect(cold.every((a) => !a.userExposedBuy && !a.userExposedSell)).to.equal(
      true
    );

    const hot = resolveEffectiveCapabilities({
      ycPairs: [
        { cryptoCurrency: 'USDC', cryptoNetwork: 'XLM' },
        { cryptoCurrency: 'BTC', cryptoNetwork: 'BITCOIN' },
      ],
      forceTrade: true,
    });
    const usdc = hot.find(
      (a) => a.symbol === 'USDC' && a.network === 'stellar'
    );
    const btcEff = hot.find(
      (a) => a.symbol === 'BTC' && a.network === 'bitcoin'
    );
    expect(usdc?.ycDiscovered).to.equal(true);
    expect(usdc?.userExposedBuy).to.equal(true); // wallet implemented + force
    expect(btcEff?.ycDiscovered).to.equal(true);
    expect(btcEff?.walletImplemented).to.equal(false);
    expect(btcEff?.userExposedBuy).to.equal(false); // strategy still pending
  });

  it('ETH is catalogued with evm strategy (not forever-unsupported)', async () => {
    const userId = await createUser();
    const cfg = findAssetNetwork('ETH', 'ethereum');
    expect(cfg?.walletStrategy).to.equal('evm_dayfi');
    const r = await ensureWallet({
      userId,
      asset: 'ETH',
      network: 'ethereum',
    });
    // EVM path may fail without keys in CI — must not be UNKNOWN_ASSET_NETWORK.
    if (!r.ok) {
      expect(r.code).to.not.equal('UNKNOWN_ASSET_NETWORK');
      expect(r.code).to.not.equal('WALLET_STRATEGY_PENDING');
    }
  });
});

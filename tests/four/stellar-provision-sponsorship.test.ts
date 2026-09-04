import { expect } from 'chai';
import { describe, it } from 'mocha';
import StellarSdk from '@stellar/stellar-sdk';
import { estimateXlmRequiredForProvision } from '../../src/modules/payment/cryptoWalletProvision';
import { buildReceiveTrustlineAssets } from '../../src/config/stellarIssuers';

describe('Stellar crypto provision economics + sponsorship', () => {
  it('keeps user funding at 1.5 and gates master at ~3.05', () => {
    const gate = estimateXlmRequiredForProvision();
    const trustlines = buildReceiveTrustlineAssets().length;
    expect(trustlines).to.equal(2);
    // 1.5 funding + 1.0 sponsor locks + 0.5 buffer + 0.05 fees
    expect(gate).to.equal(3.05);
  });

  it('builds endSponsoringFutureReserves with source = user public key', () => {
    const master = StellarSdk.Keypair.random();
    const user = StellarSdk.Keypair.random();
    // Horizon account stub — only need sequence for TransactionBuilder.
    const masterAccount = new StellarSdk.Account(master.publicKey(), '1');
    const asset = new StellarSdk.Asset(
      'USDC',
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    );

    const tx = new StellarSdk.TransactionBuilder(masterAccount, {
      fee: String(Number(StellarSdk.BASE_FEE) * 3),
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(
        StellarSdk.Operation.beginSponsoringFutureReserves({
          sponsoredId: user.publicKey(),
        })
      )
      .addOperation(
        StellarSdk.Operation.changeTrust({
          asset,
          limit: '10000000',
          source: user.publicKey(),
        })
      )
      .addOperation(
        StellarSdk.Operation.endSponsoringFutureReserves({
          source: user.publicKey(),
        })
      )
      .setTimeout(60)
      .build();

    const ops = tx.operations;
    expect(ops).to.have.length(3);
    expect(ops[0].type).to.equal('beginSponsoringFutureReserves');
    expect(ops[1].type).to.equal('changeTrust');
    expect(ops[1].source).to.equal(user.publicKey());
    expect(ops[2].type).to.equal('endSponsoringFutureReserves');
    expect(ops[2].source).to.equal(user.publicKey());
  });
});

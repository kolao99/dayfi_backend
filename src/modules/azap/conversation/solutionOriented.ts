/**
 * Solution-oriented conversational policy for Azap.
 * ACKNOWLEDGE → SOLUTION → NEXT STEP. Never fabricates execution.
 * Capabilities come from assetRegistry + known soft-launch rails.
 */

import {
  AZAP_ASSET_REGISTRY,
  listEnabledAssets,
} from '../crypto/assetRegistry';

export type SoftLaunchCapabilities = {
  receiveAssets: string[];
  sendAssets: string[];
  buyAssets: string[];
  pendingAssets: string[];
  rails: string[];
  corridorsHint: string;
};

export function getSoftLaunchCapabilities(): SoftLaunchCapabilities {
  const receive = [
    ...new Set(listEnabledAssets('receiveEnabled').map((a) => a.symbol)),
  ];
  const send = [
    ...new Set(listEnabledAssets('sendEnabled').map((a) => a.symbol)),
  ];
  const buy = [
    ...new Set(listEnabledAssets('buyEnabled').map((a) => a.symbol)),
  ];
  const pending = [
    ...new Set(
      AZAP_ASSET_REGISTRY.filter(
        (a) =>
          !a.buyEnabled &&
          !a.receiveEnabled &&
          ['BTC', 'ETH', 'SOL'].includes(a.symbol)
      ).map((a) => a.symbol)
    ),
  ];

  return {
    receiveAssets: receive.length ? receive : ['USDC', 'EURC'],
    sendAssets: send.length ? send : ['USDC', 'EURC'],
    buyAssets: buy,
    pendingAssets: pending,
    rails: [
      'NGN transfers (Nigeria banks)',
      'Wallet funding',
      'Airtime & bills',
      'Balance checks',
      'Supported crypto deposits (USDC / EURC)',
    ],
    corridorsHint:
      'Cross-border sends use Yellow Card where the corridor is live (e.g. some GHS/KES/ZAR channels).',
  };
}

function titleCaseLabel(label: string): string {
  return String(label || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Recipient nickname not in saved contacts → setup path, not a dead end. */
export function replyRecipientNotFound(label: string): string {
  const name = titleCaseLabel(label) || 'that person';
  return (
    `I can help with that. I don't have *${name}* set up yet. ` +
    `Send me their bank name and account number and we'll sort the transfer.`
  );
}

export function replyMissingRecipient(): string {
  return `Sure — who are we sending to? A saved name works, or bank details like OPay 8012345678.`;
}

export function replyMissingAmount(who?: string): string {
  if (who) {
    return `Got it — ${who}. How much should I send?`;
  }
  return `How much should I send?`;
}

export function replyIncompleteAccount(
  bankHint: string,
  digits: number
): string {
  const hint = bankHint || 'bank';
  return (
    `Almost — I need the full ${hint} account number ` +
    `(you sent ${digits} digits). Drop the complete 10-digit number and we'll continue.`
  );
}

export function replyUnknownBank(hint: string): string {
  return (
    `I don't recognize "${hint}" yet. Try a name like OPay, GTBank, or Access Bank ` +
    `and I'll keep going.`
  );
}

export function replyBankVerifyFailed(hint: string): string {
  return (
    `I couldn't verify that ${hint || 'bank'} account just now. ` +
    `Double-check the number, or try again in a moment — I'll stay ready.`
  );
}

export function replyInsufficientBalance(amountFormatted: string): string {
  return (
    `That ${amountFormatted} send needs more than what's in your wallet right now. ` +
    `You can fund your wallet first, or send a smaller amount.`
  );
}

export function replyCancelled(): string {
  return `Cancelled. What else should we sort out?`;
}

/** User deferred filling bank/account details — keep transfer resumable, never invent slots. */
export function replyCollectionDeferred(): string {
  return `That's fine. Get it when you're ready and we can continue — or tell me someone else to send to.`;
}

export function replyAmbiguousRecipients(
  label: string,
  candidates: Array<{ name: string; bankName?: string }>
): string {
  const lines = candidates
    .slice(0, 5)
    .map((c, i) => `${i + 1}. ${c.name}${c.bankName ? ` (${c.bankName})` : ''}`)
    .join('\n');
  return (
    `Which ${label} do you mean?\n${lines}\n\n` +
    `Reply with the number, the full name, or say "the other ${label}".`
  );
}

export function replySupportedCoins(): string {
  const caps = getSoftLaunchCapabilities();
  const live = caps.receiveAssets.join(' and ');
  const pending = caps.pendingAssets.length
    ? ` ${caps.pendingAssets.join(', ')} are being prepared but aren't enabled for buying yet.`
    : '';
  return (
    `Right now I support *${live}* for crypto on Azap.${pending} ` +
    `Want to fund USDC, check your balance, or see how crypto deposits work?`
  );
}

export function replyBuyAssetQuestion(assetHint: string): string {
  const symbol = assetHint.toUpperCase();
  const caps = getSoftLaunchCapabilities();
  const live = caps.receiveAssets.join(' and ');

  if (caps.buyAssets.map((a) => a.toUpperCase()).includes(symbol)) {
    return `Yep — ${symbol} buying is available. Tell me how much you want to buy and we'll continue.`;
  }

  if (caps.receiveAssets.map((a) => a.toUpperCase()).includes(symbol)) {
    return (
      `${symbol} is available on Azap for wallet hold / deposit, not as a separate "buy" button yet. ` +
      `I can help you fund ${symbol} into your wallet — want to start?`
    );
  }

  if (['BTC', 'ETH', 'SOL', 'BITCOIN', 'ETHEREUM', 'SOLANA'].includes(symbol)) {
    const pretty =
      symbol === 'BITCOIN'
        ? 'BTC'
        : symbol === 'ETHEREUM'
          ? 'ETH'
          : symbol === 'SOLANA'
            ? 'SOL'
            : symbol;
    return (
      `${pretty} buying isn't enabled on Azap yet. Right now I can help with ${live}. ` +
      `Want to fund USDC or check your wallet?`
    );
  }

  return (
    `That asset isn't enabled on Azap yet. Right now I support ${live}. ` +
    `Want to fund USDC or see what's available?`
  );
}

export function replyCanPayElectricity(): string {
  return (
    `Yep — I can help with electricity (and airtime, data, internet, TV). ` +
    `Say something like "pay electricity" and we'll grab the meter details.`
  );
}

export function replyCanSendCorridor(hint: string): string {
  const q = hint.toLowerCase();
  if (/\bghana|ghs|cedi/.test(q)) {
    return (
      `I can try Ghana (GHS) when Yellow Card has an active payout channel. ` +
      `Say "Send Kola GHS 200" (or your amount) and I'll check what's live.`
    );
  }
  if (/\bkenya|kes|shilling/.test(q)) {
    return (
      `I can try Kenya (KES) when Yellow Card has an active bank channel. ` +
      `Say "Send Kola KES 2000" and I'll check what's available.`
    );
  }
  if (/\bsouth africa|zar|rand/.test(q)) {
    return (
      `I can try South Africa (ZAR) when Yellow Card has an active channel. ` +
      `Tell me the amount and recipient and I'll check.`
    );
  }
  return (
    `For Nigeria I can send to banks from your Azap wallet. ` +
    `For other African corridors I use Yellow Card where the channel is live — ` +
    `tell me the country/currency and amount and I'll check.`
  );
}

export function replyWhatCanIDo(): string {
  return (
    `I can help with transfers, funding your wallet, crypto (USDC / EURC), bills, and checking your money. ` +
    `What are you trying to sort out?`
  );
}

/**
 * If the user is asking a capability question, return a helpful answer.
 * Otherwise null (continue normal routing).
 */
export function tryAnswerCapabilityQuestion(text: string): string | null {
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return null;

  if (
    /why (can'?t|cannot|won'?t) i (buy|get|purchase).*\b(btc|bitcoin|eth|ethereum|sol|solana)\b/.test(
      q
    ) ||
    /why.*(btc|bitcoin).*(not|can'?t|unavailable|disabled)/.test(q)
  ) {
    return (
      `BTC buying isn't enabled on your Azap account yet — we only flip buy on after wallet + Yellow Card + settlement all pass for that pair. ` +
      `Right now you can hold/deposit ${getSoftLaunchCapabilities().receiveAssets.join(' and ')}. Want to fund USDC or check your wallet?`
    );
  }

  if (
    /what('?s| is) usdc\b/.test(q) ||
    /explain usdc/.test(q) ||
    /usdc like i'?m five/.test(q)
  ) {
    return (
      `USDC is a US-dollar stablecoin — roughly 1 USDC ≈ 1 USD. ` +
      `On Azap you can hold/deposit USDC in your wallet and use it as the base for NGN sends and bills. Want to fund some or check your balance?`
    );
  }

  if (
    /difference between usdc and usdt/.test(q) ||
    /usdc vs usdt/.test(q) ||
    /usdt vs usdc/.test(q)
  ) {
    return (
      `Both are dollar stablecoins. USDC is what Azap supports in-wallet today. ` +
      `USDT isn't an Azap wallet asset here yet. Want help funding USDC?`
    );
  }

  if (
    /how (do|does|can) (i |you )?(fund|add money|top ?up)/.test(q) ||
    /how does funding/.test(q)
  ) {
    return (
      `You can fund with a Nigerian bank transfer to your Azap virtual account, or deposit USDC/EURC on a supported network. ` +
      `Say "fund my wallet" and I'll walk you through it.`
    );
  }

  if (
    /why.*(pending|not arrived|hasn'?t arrived|still processing)/.test(q) ||
    /transfer still pending/.test(q)
  ) {
    return (
      `If a transfer is pending, the provider is still processing it — it isn't done until we get a success confirmation. ` +
      `Say "transaction status" or "has it arrived?" and I'll check what I can see.`
    );
  }

  if (
    /what would you (do|recommend)/.test(q) ||
    /should i (save|spend|invest)/.test(q) ||
    /trying to save/.test(q) ||
    /where my money is going/.test(q) ||
    (/500k|₦?\s*500,?000/.test(q) && /what|recommend|do with/.test(q))
  ) {
    return (
      `Depends what the money is for. If you need it soon for rent/bills, keep that portion liquid in your wallet. ` +
      `If it's longer-term, we can talk USDC hold vs sending/saving for goals. What's the money meant for?`
    );
  }

  if (
    /what (coins?|crypto|assets?|tokens?) (do you |can i |are )?(support|available|have)/.test(
      q
    ) ||
    /which (coins?|crypto|assets?)/.test(q) ||
    /supported (coins?|crypto|assets?)/.test(q)
  ) {
    return replySupportedCoins();
  }

  if (
    /^why can'?t i\b/.test(q) ||
    /^why not\b/.test(q) ||
    /why (is that|isn'?t it) (enabled|available|working)/.test(q)
  ) {
    return (
      `Usually that means the rail isn't enabled for your account yet. ` +
      `For crypto, BTC buying isn't live — USDC and EURC are available. Want to fund USDC or check your wallet?`
    );
  }

  if (
    /what about usdc/.test(q) ||
    /okay.*usdc/.test(q) ||
    /how about usdc/.test(q)
  ) {
    return replyBuyAssetQuestion('USDC');
  }

  if (
    /\b(can i |could i |how (do|can) i )?(buy|purchase)\b.*\b(btc|bitcoin|eth|ethereum|sol|solana)\b/.test(
      q
    ) ||
    /\b(btc|bitcoin|eth|ethereum|sol|solana)\b.*\b(buy|purchase|available|support)/.test(
      q
    ) ||
    /^(buy|purchase)\s+(btc|bitcoin|eth|ethereum|sol|solana)\b/.test(q)
  ) {
    const m = q.match(/\b(btc|bitcoin|eth|ethereum|sol|solana)\b/);
    return replyBuyAssetQuestion(m?.[1] || 'BTC');
  }

  if (
    /\b(can i |could i )?buy\b.*\b(usdc|eurc|crypto)\b/.test(q) ||
    /\b(usdc|eurc)\b.*\b(buy|purchase)\b/.test(q)
  ) {
    return replyBuyAssetQuestion(
      /\beurc\b/.test(q) ? 'EURC' : 'USDC'
    );
  }

  if (
    /\b(electricity|nepa|phcn|prepaid meter|postpaid)\b/.test(q) &&
    /\b(can|pay|help|do you)\b/.test(q)
  ) {
    return replyCanPayElectricity();
  }

  if (
    /\b(can (you|i)|do you) (send|transfer).*\b(ghana|kenya|south africa|abroad|international)\b/.test(
      q
    ) ||
    /\bsend (money )?to (ghana|kenya|south africa)\b/.test(q)
  ) {
    return replyCanSendCorridor(q);
  }

  if (
    /what can (you|i|azap) (actually )?do/.test(q) ||
    /what (are )?my options/.test(q) ||
    /how does (this|azap) work/.test(q)
  ) {
    return replyWhatCanIDo();
  }

  return null;
}

/** Facts injected into LLM system prompt — backend is source of truth. */
export function capabilityFactsForPrompt(): string {
  const caps = getSoftLaunchCapabilities();
  return (
    `Current enabled crypto receive/hold: ${caps.receiveAssets.join(', ')}. ` +
    `Buy-enabled via registry: ${
      caps.buyAssets.length ? caps.buyAssets.join(', ') : 'none'
    }. ` +
    `Not enabled for buy yet: ${
      caps.pendingAssets.length ? caps.pendingAssets.join(', ') : 'n/a'
    }. ` +
    `Also help with: NGN bank sends, wallet funding, airtime/bills, balances. ` +
    `Launch model: Nigeria money via Flutterwave + custodial DayFi USDC/EURC (ledger + treasury) — never call it non-custodial. ` +
    `Never claim buy/sell works for an asset unless it appears in Buy-enabled above. ` +
    `Catalogued-but-gated assets (BTC/ETH/SOL/…) stay hidden until wallet + entitlement + E2E pass. ` +
    `Never claim a transfer succeeded.`
  );
}

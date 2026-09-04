import { upsertActiveIntent } from '../intent/intentService';
import {
  getSupportedCryptoNetworks,
  isCryptoWithdrawalSupported,
  normalizeCryptoAsset,
  normalizeCryptoNetwork,
} from '../../azap/capabilities/moneyCapabilities';
import {
  routeCryptoSend,
  getCryptoBalances,
} from '../../payment/cryptoSendService';
import {
  getCryptoNetwork,
  type CryptoNetworkKey,
  type CryptoStableAsset,
} from '../../../config/cryptoNetworks';

type Reply = {
  role: 'assistant';
  type: 'text' | 'review';
  content: string;
  metadata?: Record<string, unknown>;
};

const STELLAR_RE = /\b(G[A-Z0-9]{55})\b/;
const EVM_RE = /\b(0x[a-fA-F0-9]{40})\b/;

export type ParsedCryptoSend = {
  amount: string | null;
  asset: CryptoStableAsset | null;
  network: CryptoNetworkKey | null;
  to: string | null;
  wantsWithdraw: boolean;
};

export function parseCryptoSendUtterance(
  text: string
): ParsedCryptoSend | null {
  const raw = String(text || '').trim();
  const q = raw.toLowerCase();
  const stellar = raw.match(STELLAR_RE)?.[1] ?? null;
  const evm = raw.match(EVM_RE)?.[1] ?? null;
  const to = stellar || evm || null;
  const isSend =
    /\bsend\b/.test(q) || /\bwithdraw\b/.test(q) || /\bcash out\b/.test(q);
  if (!isSend && !to) return null;
  if (!/\busdc\b|\beurc\b/.test(q) && !to) return null;
  // Deposits / "what's my address" are not sends.
  if (/\bdeposit\b|\bfund\b|\baddress\b/.test(q) && !to) return null;

  const asset = normalizeCryptoAsset(
    /\beurc\b/.test(q) ? 'EURC' : /\busdc\b/.test(q) ? 'USDC' : ''
  );
  let network = normalizeCryptoNetwork(
    /\bstellar\b|\bxlm\b/.test(q)
      ? 'stellar'
      : /\barbitrum\b/.test(q)
        ? 'arbitrum'
        : /\bmantle\b/.test(q)
          ? 'mantle'
          : /\bsonic\b/.test(q)
            ? 'sonic'
            : /\bxdc\b|\bxinfin\b/.test(q)
              ? 'xdc'
              : /\bbsc\b|\bbnb\b/.test(q)
                ? 'bsc'
                : /\bethereum\b|\berc-?20\b/.test(q)
                  ? 'ethereum'
                  : ''
  );
  if (!network && stellar) network = 'stellar';
  if (!network && evm) network = 'ethereum';

  const amountMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:usdc|eurc|usd)?/i);
  const amount = amountMatch ? amountMatch[1] : null;

  if (!asset && !to && !/\bwithdraw\b/.test(q)) return null;

  return {
    amount,
    asset,
    network,
    to,
    wantsWithdraw: /\bwithdraw\b|\bcash out\b/.test(q),
  };
}

export async function continueCryptoSend(input: {
  userId: string;
  conversationId: string;
  text: string;
  slots?: Record<string, unknown>;
}): Promise<Reply> {
  const parsed = parseCryptoSendUtterance(input.text);
  const slots: Record<string, unknown> = {
    method: 'crypto_send',
    ...(input.slots ?? {}),
  };
  const asset = (parsed?.asset ||
    slots.asset ||
    null) as CryptoStableAsset | null;
  const network = (parsed?.network ||
    slots.network ||
    null) as CryptoNetworkKey | null;
  const to = (parsed?.to || slots.to || null) as string | null;
  const amount = (parsed?.amount || slots.amount || null) as string | null;

  if (!asset) {
    await persist(input, { ...slots, asset, network, to, amount });
    return {
      role: 'assistant',
      type: 'text',
      content: 'Which asset are you sending — USDC or EURC?',
    };
  }
  if (!network) {
    const nets = getSupportedCryptoNetworks(asset, 'send');
    await persist(input, { ...slots, asset, network, to, amount });
    return {
      role: 'assistant',
      type: 'text',
      content:
        `Which network for ${asset}?\n\n` +
        nets.map((n) => `• ${n.name}`).join('\n'),
    };
  }
  if (!isCryptoWithdrawalSupported(asset, network)) {
    return {
      role: 'assistant',
      type: 'text',
      content: `I can't send ${asset} on ${network} from Azap.`,
    };
  }
  if (!to) {
    await persist(input, { ...slots, asset, network, to, amount });
    const hint =
      getCryptoNetwork(network)?.rail === 'stellar'
        ? 'a Stellar address starting with G'
        : 'an EVM address starting with 0x';
    return {
      role: 'assistant',
      type: 'text',
      content: `What's the destination? Paste ${hint}.`,
    };
  }
  if (getCryptoNetwork(network)?.rail === 'stellar' && !STELLAR_RE.test(to)) {
    return {
      role: 'assistant',
      type: 'text',
      content: 'That does not look like a Stellar address (must start with G).',
    };
  }
  if (getCryptoNetwork(network)?.rail === 'evm' && !EVM_RE.test(to)) {
    return {
      role: 'assistant',
      type: 'text',
      content: 'That does not look like an EVM address (must start with 0x).',
    };
  }
  if (!amount) {
    await persist(input, { ...slots, asset, network, to, amount });
    return {
      role: 'assistant',
      type: 'text',
      content: `How much ${asset} should I send?`,
    };
  }

  if (network === 'stellar' || network === 'ethereum') {
    try {
      const balances = await getCryptoBalances(input.userId);
      const available =
        network === 'stellar'
          ? Number(balances.stellar[asset] || 0)
          : Number(balances.ethereum[asset] || 0);
      if (Number.isFinite(available) && available < Number(amount)) {
        return {
          role: 'assistant',
          type: 'text',
          content:
            `You don't have enough ${asset} on ${
              getCryptoNetwork(network)?.name || network
            } to send ${amount}. ` + `Available: ${available}.`,
        };
      }
    } catch {
      /* chain read failed — send path will still validate on-chain */
    }
  }

  const intent = await upsertActiveIntent({
    userId: input.userId,
    conversationId: input.conversationId,
    intent: 'SEND_CRYPTO',
    status: 'AWAITING_CONFIRMATION',
    slots: { asset, network, to, amount },
  });

  const net = getCryptoNetwork(network);
  return {
    role: 'assistant',
    type: 'review',
    content:
      `Send *${amount} ${asset}* on *${
        net?.name || network
      }* to\n\`${to}\`\n\n` +
      `Tap below to authorize with your PIN. Azap will not send until you confirm.`,
    metadata: {
      intentId: intent.id,
      buttons: [{ id: 'confirm_send', label: 'Confirm send' }],
    },
  };
}

export async function executeCryptoSendFromSlots(input: {
  userId: string;
  asset: string;
  network: string;
  to: string;
  amount: string;
}): Promise<{ hash: string; message: string }> {
  const result = await routeCryptoSend({
    userId: input.userId,
    asset: input.asset,
    network: input.network,
    to: input.to,
    amount: input.amount,
  });
  return {
    hash: result.hash,
    message:
      `Crypto send submitted.\n\n` +
      `${input.amount} ${input.asset} on ${result.network}\n` +
      `To: ${result.to}\n` +
      `Tx: ${result.hash}\n\n` +
      `Status depends on the network confirming the transaction.`,
  };
}

async function persist(
  input: { userId: string; conversationId: string },
  slots: Record<string, unknown>
): Promise<void> {
  await upsertActiveIntent({
    userId: input.userId,
    conversationId: input.conversationId,
    intent: 'SEND_CRYPTO',
    status: 'COLLECTING_INFORMATION',
    slots,
  });
}

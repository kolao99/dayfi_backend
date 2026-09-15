import { appendMessage } from '../conversation/messageService';
import {
  cancelActiveIntent,
  getActiveIntentForConversation,
  upsertActiveIntent,
} from '../intent/intentService';
import { handleKycRequest } from '../kyc/kycFlowService';
import {
  isAmbiguityClarification,
  isCollectionDeferral,
  isLikelyBankName,
  isResumeSendWithNewAmount,
  isSellUsdcIntent,
  parseAmount,
  parseDestinationPart,
  parseUserMessage,
} from './intentParser';
import {
  buildBalanceInCurrencyReply,
  buildBalanceReply,
  buildSendCostQuoteReply,
  hasSufficientBalanceForSend,
  estimateTransferFeeNgn,
} from '../finance/balanceService';
import { continueCryptoFunding, checkCryptoDepositStatus } from '../finance/cryptoDepositFlow';
import {
  beginBillPayment,
  continueBillPayment,
  detectBillCategory,
} from '../finance/billPaymentFlow';
import {
  formatCryptoFundingAsk,
  isDepositStatusQuestion,
  parseCryptoDepositUtterance,
} from '../../azap/capabilities/moneyCapabilities';
import {
  continueCryptoSend,
  parseCryptoSendUtterance,
} from '../finance/cryptoSendFlow';
import { beginNgnBankFunding } from '../finance/fiatFundingFlow';
import { buildWalletIntelReply } from '../finance/walletIntelService';
import {
  beginYellowCardSend,
  continueYellowCardSend,
} from '../finance/yellowCardSendFlow';
import { buildKycProfileSnapshot } from '../../kyc/smileService';
import { proposeActionPlanFromText } from '../../azap/core/azapCore';
import { runConversationalBrain } from '../../azap/conversation/conversationalBrain';
import {
  getLastMoneyContext,
  rememberMoneyContext,
} from '../../azap/conversation/dialogueContext';
import { prepareCryptoTrade } from '../../payment/cryptoTradeGate';
import {
  replyAmbiguousRecipients,
  replyBankVerifyFailed,
  replyCancelled,
  replyCollectionDeferred,
  replyIncompleteAccount,
  replyInsufficientBalance,
  replyMissingAmount,
  replyMissingRecipient,
  replyRecipientNotFound,
  replyUnknownBank,
  tryAnswerCapabilityQuestion,
} from '../../azap/conversation/solutionOriented';
import { formatMoney } from '../../payment/walletModel';
import {
  FUND_BUTTONS,
  fundWalletPromptMessage,
  genericNudge,
  transferPrompt,
} from '../telegram/onboardingService';
import {
  formatRecipientLine,
  lookupRecipientsByName,
  resolveBankRecipient,
  resolveBankName,
  type ResolvedRecipient,
} from '../finance/recipientResolver';

export type EngineReply = {
  role: 'assistant';
  type: 'text' | 'choice' | 'review' | 'receipt';
  content: string;
  metadata?: Record<string, unknown>;
};

export type EngineResult = {
  replies: EngineReply[];
  intentId?: string;
};

async function persistAssistant(
  userId: string,
  conversationId: string,
  reply: EngineReply
): Promise<void> {
  await appendMessage({
    userId,
    conversationId,
    role: 'assistant',
    type: reply.type,
    content: reply.content,
    metadata: reply.metadata ?? {},
  });
}

/** Empty balance → status text + funding menu (no extra "Fund my wallet" turn). */
async function replyBalanceWithOptionalFunding(input: {
  userId: string;
  conversationId: string;
}): Promise<EngineResult> {
  const { userId, conversationId } = input;
  const balance = await buildBalanceReply(userId);
  const statusReply: EngineReply = {
    role: 'assistant',
    type: 'text',
    content: balance.content,
  };
  await persistAssistant(userId, conversationId, statusReply);

  if (!balance.isEmpty || balance.failed) {
    return { replies: [statusReply] };
  }

  const fundReply: EngineReply = {
    role: 'assistant',
    type: 'choice',
    content: fundWalletPromptMessage(),
    metadata: {
      buttons: FUND_BUTTONS.map((b) => ({ ...b })),
      scope: 'fund',
    },
  };
  await persistAssistant(userId, conversationId, fundReply);
  return { replies: [statusReply, fundReply] };
}

async function finalizeSendReview(input: {
  userId: string;
  conversationId: string;
  amount: number;
  resolved: ResolvedRecipient;
}): Promise<EngineResult> {
  const { userId, conversationId, amount, resolved } = input;
  resolved.bankName = await resolveBankName(resolved.bankCode);

  const fee = await estimateTransferFeeNgn();
  const sufficient = await hasSufficientBalanceForSend(userId, amount, fee);
  if (!sufficient) {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'choice',
      content: replyInsufficientBalance(formatMoney(amount, 'NGN')),
      metadata: {
        buttons: FUND_BUTTONS.map((b) => ({ ...b })),
        scope: 'fund',
      },
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  const kyc = await buildKycProfileSnapshot(userId);
  if (!kyc.canSendMoney) {
    // Keep the send slots so the teen can continue after KYC (amount/recipient not lost).
    await upsertActiveIntent({
      userId,
      conversationId,
      intent: 'SEND_MONEY',
      status: 'COLLECTING_INFORMATION',
      slots: {
        amount,
        fee,
        currency: 'NGN',
        recipient: resolved,
        awaitingKyc: true,
      },
    });
    return handleKycRequest({ userId, conversationId, reason: 'send' });
  }

  const intent = await upsertActiveIntent({
    userId,
    conversationId,
    intent: 'SEND_MONEY',
    status: 'AWAITING_CONFIRMATION',
    slots: {
      amount,
      fee,
      currency: 'NGN',
      recipient: resolved,
    },
  });

  await rememberMoneyContext({
    userId,
    conversationId,
    context: {
      recipientName: resolved.name,
      bankName: resolved.bankName,
      accountNumber: resolved.accountNumber,
      amount,
      currency: 'NGN',
      intent: 'SEND_MONEY',
    },
  });

  const total = amount + fee;
  const reply: EngineReply = {
    role: 'assistant',
    type: 'review',
    content:
      `Send ${formatMoney(amount, 'NGN')} to:\n` +
      `${formatRecipientLine(resolved)}\n\n` +
      `Amount: ${formatMoney(amount, 'NGN')}\n` +
      `Fee: ${formatMoney(fee, 'NGN')}\n` +
      `Total: ${formatMoney(total, 'NGN')}\n\n` +
      `Tap below to confirm with your PIN.`,
    metadata: {
      intentId: intent.id,
      buttons: [{ id: 'confirm_send', label: 'Confirm send', disabled: false }],
    },
  };
  await persistAssistant(userId, conversationId, reply);
  return { replies: [reply], intentId: intent.id };
}

async function resolveSendDestination(input: {
  userId: string;
  recipientName: string | null;
  bankTarget: {
    accountNumber: string;
    bankHint: string;
    incomplete?: boolean;
  } | null | undefined;
}): Promise<
  | { ok: true; resolved: ResolvedRecipient }
  | {
      ok: false;
      reply: EngineReply;
      needsBank?: boolean;
      needsCompleteAccount?: boolean;
      needsRecipientSetup?: boolean;
      ambiguous?: boolean;
      candidates?: ResolvedRecipient[];
      pendingRecipientLabel?: string;
      accountNumber?: string;
      bankHint?: string;
    }
> {
  const { userId, recipientName, bankTarget } = input;

  if (bankTarget) {
    if (bankTarget.incomplete) {
      const hint = bankTarget.bankHint || 'bank';
      const digits = bankTarget.accountNumber.length;
      return {
        ok: false,
        reply: {
          role: 'assistant',
          type: 'text',
          content:
            replyIncompleteAccount(hint, digits),
        },
        needsCompleteAccount: true,
        accountNumber: bankTarget.accountNumber,
        bankHint: bankTarget.bankHint,
      };
    }

    if (!bankTarget.bankHint) {
      return {
        ok: false,
        reply: {
          role: 'assistant',
          type: 'text',
          content:
            'Which bank is that account with? For example: OPay, GTBank, or Access Bank.',
        },
        needsBank: true,
        accountNumber: bankTarget.accountNumber,
      };
    }

    const resolved = await resolveBankRecipient(userId, bankTarget);
    if (!resolved.ok) {
      const hint = bankTarget.bankHint || 'bank';
      let content = replyBankVerifyFailed(hint);
      if (resolved.reason === 'unknown_bank') {
        content = replyUnknownBank(hint);
      } else if (resolved.reason === 'unavailable') {
        content =
          `I couldn't reach ${hint} just now. Try again in a moment — I'll stay ready.`;
      }
      return {
        ok: false,
        reply: {
          role: 'assistant',
          type: 'text',
          content,
        },
      };
    }
    return { ok: true, resolved: resolved.resolved };
  }

  if (recipientName) {
    const dest = parseDestinationPart(recipientName);
    if (dest.bankTarget) {
      return resolveSendDestination({
        userId,
        recipientName: null,
        bankTarget: dest.bankTarget,
      });
    }

    const matches = await lookupRecipientsByName(userId, recipientName);
    if (matches.length > 1) {
      return {
        ok: false,
        ambiguous: true,
        candidates: matches,
        pendingRecipientLabel: recipientName,
        reply: {
          role: 'assistant',
          type: 'text',
          content: replyAmbiguousRecipients(
            recipientName,
            matches.map((m) => ({ name: m.name, bankName: m.bankName }))
          ),
        },
      };
    }
    if (matches.length === 1) {
      return { ok: true, resolved: matches[0] };
    }

    return {
      ok: false,
      reply: {
        role: 'assistant',
        type: 'text',
        content: replyRecipientNotFound(recipientName),
      },
      needsRecipientSetup: true,
      pendingRecipientLabel: recipientName,
    };
  }

  return {
    ok: false,
    reply: {
      role: 'assistant',
      type: 'text',
      content: replyMissingRecipient(),
    },
  };
}

export async function handleUserText(input: {
  userId: string;
  conversationId: string;
  text: string;
  skipPlanner?: boolean;
}): Promise<EngineResult> {
  const { userId, conversationId, text, skipPlanner } = input;
  const parsed = parseUserMessage(text);
  let active = await getActiveIntentForConversation(userId, conversationId);

  if (parsed.kind === 'cancel') {
    const wasCryptoDeposit = active?.intent === 'FUND_CRYPTO';
    await cancelActiveIntent(userId, conversationId);
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: wasCryptoDeposit
        ? "Okay, I've cancelled the crypto deposit. " + replyCancelled()
        : replyCancelled(),
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  // Explicit new money action supersedes active slot collection (no cancel required).
  if (
    active &&
    active.status === 'COLLECTING_INFORMATION' &&
    shouldInterruptCollection(parsed)
  ) {
    await cancelActiveIntent(userId, conversationId);
    active = null;
  }

  // Deferral while collecting send details — never treat as bank/account slots.
  if (
    active?.intent === 'SEND_MONEY' &&
    active.status === 'COLLECTING_INFORMATION' &&
    isCollectionDeferral(text)
  ) {
    const slots: Record<string, unknown> = {
      ...(active.slots as Record<string, unknown>),
      deferred: true,
    };
    // Drop any accidental pending bank label that is sentence-like.
    delete slots.pendingBankHint;
    const intent = await upsertActiveIntent({
      userId,
      conversationId,
      intent: 'SEND_MONEY',
      status: 'COLLECTING_INFORMATION',
      slots,
    });
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: replyCollectionDeferred(),
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: intent.id };
  }

  // Ambiguity clarification: "the other Kola" while candidates are active.
  if (
    active?.intent === 'SEND_MONEY' &&
    active.status === 'COLLECTING_INFORMATION' &&
    Array.isArray((active.slots as Record<string, unknown>).ambiguousCandidates)
  ) {
    const slots = active.slots as Record<string, unknown>;
    const candidates = slots.ambiguousCandidates as ResolvedRecipient[];
    if (candidates.length >= 2 && isAmbiguityClarification(text)) {
      const picked = pickAmbiguousCandidate(text, candidates);
      const amount = slots.amount != null ? Number(slots.amount) : null;
      if (picked && amount && amount > 0) {
        return finalizeSendReview({
          userId,
          conversationId,
          amount,
          resolved: picked,
        });
      }
      if (picked) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            recipient: picked,
            currency: 'NGN',
            amount: amount && amount > 0 ? amount : undefined,
          },
        });
        const reply: EngineReply = {
          role: 'assistant',
          type: 'text',
          content: amount && amount > 0
            ? `Got it — ${formatRecipientLine(picked)}. Confirm with your PIN when ready.`
            : replyMissingAmount(formatRecipientLine(picked)),
        };
        // If amount present we already finalize above; this branch is amount-missing.
        await persistAssistant(userId, conversationId, reply);
        return { replies: [reply], intentId: intent.id };
      }
    }
  }

  // Capability discovery before money FSMs / planner (backend is source of truth).
  const capabilityAnswer = tryAnswerCapabilityQuestion(text);
  if (capabilityAnswer && parsed.kind === 'unknown') {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: capabilityAnswer,
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'kyc') {
    return handleKycRequest({ userId, conversationId });
  }

  // Clear intent switches that are not money-workflow continuations.
  if (parsed.kind === 'bill_prompt' || parsed.kind === 'airtime_prompt') {
    const category =
      parsed.kind === 'airtime_prompt'
        ? detectBillCategory(text) || ('AIRTIME' as const)
        : detectBillCategory(text);

    // Continue only when still collecting the *same* bill category.
    if (
      active?.intent === 'PAY_BILL' &&
      (active.status === 'COLLECTING_INFORMATION' ||
        active.status === 'AWAITING_CONFIRMATION')
    ) {
      const activeCat = String(
        (active.slots as Record<string, unknown>)?.categoryCode || ''
      );
      const sameCategory =
        !category || !activeCat || activeCat === category;
      if (sameCategory) {
        const reply = await continueBillPayment({
          userId,
          conversationId,
          text,
          slots: active.slots as Record<string, unknown>,
        });
        await persistAssistant(userId, conversationId, reply);
        return {
          replies: [reply],
          intentId: (reply as { intentId?: string }).intentId,
        };
      }
    }

    const reply = await beginBillPayment({
      userId,
      conversationId,
      categoryCode: category,
      text,
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: (reply as { intentId?: string }).intentId };
  }

  // Active SEND_YC (Yellow Card corridor) continuation.
  if (
    active?.intent === 'SEND_YC' &&
    (active.status === 'COLLECTING_INFORMATION' ||
      active.status === 'AWAITING_CONFIRMATION') &&
    parsed.kind !== 'balance' &&
    parsed.kind !== 'fund' &&
    parsed.kind !== 'swap_unavailable'
  ) {
    const reply = await continueYellowCardSend({
      userId,
      conversationId,
      text,
      slots: active.slots as Record<string, unknown>,
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: reply.intentId || active.id };
  }

  // Active PAY_BILL continuation (amount / phone / provider follow-ups).
  if (
    active?.intent === 'PAY_BILL' &&
    (active.status === 'COLLECTING_INFORMATION' ||
      active.status === 'AWAITING_CONFIRMATION') &&
    parsed.kind !== 'balance' &&
    parsed.kind !== 'fund' &&
    parsed.kind !== 'send' &&
    parsed.kind !== 'send_prompt' &&
    parsed.kind !== 'swap_unavailable' &&
    parsed.kind !== 'balance_in_currency' &&
    parsed.kind !== 'tx_history' &&
    parsed.kind !== 'tx_status' &&
    parsed.kind !== 'unsupported_corridor'
  ) {
    const reply = await continueBillPayment({
      userId,
      conversationId,
      text,
      slots: active.slots as Record<string, unknown>,
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: (reply as { intentId?: string }).intentId };
  }

  if (parsed.kind === 'swap_unavailable') {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content:
        "I can't convert USDC↔EURC (or other crypto assets) right now — there's no live swap rail. " +
        'Your wallet stays in USDC. I can show a NGN/GHS *equivalent*, help you fund USDC, or send money in local currency.',
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  // Deposit status questions beat new-deposit parsing (e.g. "100 USDC received it yet?").
  const cryptoParsedEarly = parseCryptoDepositUtterance(text);
  if (
    isDepositStatusQuestion(text) ||
    cryptoParsedEarly.wantsDepositStatus
  ) {
    const slots = (active?.slots as Record<string, unknown>) || {};
    const status = await checkCryptoDepositStatus({
      userId,
      asset:
        cryptoParsedEarly.asset ||
        (typeof slots.asset === 'string' ? slots.asset : null),
      network:
        cryptoParsedEarly.network ||
        (typeof slots.network === 'string' ? slots.network : null),
      expectedAmount:
        cryptoParsedEarly.amount ??
        (typeof slots.amount === 'number' ? slots.amount : null),
      depositAddress:
        typeof slots.depositAddress === 'string' ? slots.depositAddress : null,
    });
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: status.content,
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: active?.id };
  }

  const cryptoSend = parseCryptoSendUtterance(text);
  const inCryptoSend = active?.intent === 'SEND_CRYPTO';
  if ((inCryptoSend || cryptoSend) && parsed.kind !== 'balance') {
    const looksLikeSend =
      inCryptoSend ||
      Boolean(cryptoSend?.to) ||
      Boolean(cryptoSend?.wantsWithdraw) ||
      (Boolean(cryptoSend?.asset) && /\bsend\b|\bwithdraw\b/i.test(text));
    if (looksLikeSend) {
      const reply = await continueCryptoSend({
        userId,
        conversationId,
        text,
        slots: inCryptoSend ? (active?.slots as Record<string, unknown>) : {},
      });
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply] };
    }
  }

  const cryptoParsed = cryptoParsedEarly;
  const inCryptoFlow = active?.intent === 'FUND_CRYPTO';
  const cryptoContinuation =
    inCryptoFlow ||
    cryptoParsed.wantsDepositAddress ||
    cryptoParsed.wantsCryptoFunding ||
    cryptoParsed.unknownAsset ||
    cryptoParsed.unknownNetwork ||
    (Boolean(cryptoParsed.asset) && Boolean(cryptoParsed.network)) ||
    (inCryptoFlow && parsed.kind === 'amount_update') ||
    /\bfund with crypto\b/i.test(text);
  if (
    cryptoContinuation &&
    parsed.kind !== 'send' &&
    parsed.kind !== 'balance' &&
    parsed.kind !== 'send_prompt' &&
    parsed.kind !== 'fund' &&
    parsed.kind !== 'balance_in_currency' &&
    parsed.kind !== 'unsupported_corridor'
  ) {
    const reply = await continueCryptoFunding({
      userId,
      conversationId,
      text,
      slots: inCryptoFlow
        ? (active?.slots as Record<string, unknown>)
        : { method: 'crypto' },
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  // Continue SEND_MONEY when user supplies bank + account (or incomplete→complete).
  if (
    active?.intent === 'SEND_MONEY' &&
    (active.status === 'COLLECTING_INFORMATION' ||
      active.status === 'AWAITING_CONFIRMATION') &&
    (parsed.kind === 'destination_update' ||
      (parsed.kind === 'send' && Boolean(parsed.bankTarget)))
  ) {
    const slots = {
      ...(active.slots as Record<string, unknown>),
    };
    const amountFromSlots =
      slots.amount != null && Number(slots.amount) > 0
        ? Number(slots.amount)
        : null;
    const bankTarget =
      parsed.kind === 'destination_update'
        ? parsed.bankTarget
        : parsed.kind === 'send'
          ? parsed.bankTarget
          : null;
    const amount =
      (parsed.kind === 'send' ? parsed.amount : null) ?? amountFromSlots;

    if (bankTarget?.incomplete) {
      const intent = await upsertActiveIntent({
        userId,
        conversationId,
        intent: 'SEND_MONEY',
        status: 'COLLECTING_INFORMATION',
        slots: {
          ...slots,
          amount,
          currency: 'NGN',
          pendingBankHint: bankTarget.bankHint,
          pendingIncompleteAccount: bankTarget.accountNumber,
        },
      });
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content:
          `I need the complete ${bankTarget.bankHint || 'bank'} account number. You entered ${bankTarget.accountNumber.length} digits; please send the full 10-digit account number.`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: intent.id };
    }

    const outcome = await resolveSendDestination({
      userId,
      recipientName: null,
      bankTarget,
    });
    if (!outcome.ok) {
      if (outcome.needsCompleteAccount) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            ...slots,
            amount,
            currency: 'NGN',
            pendingBankHint: outcome.bankHint,
            pendingIncompleteAccount: outcome.accountNumber,
          },
        });
        await persistAssistant(userId, conversationId, outcome.reply);
        return { replies: [outcome.reply], intentId: intent.id };
      }
      if (outcome.needsBank && outcome.accountNumber) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            ...slots,
            amount,
            currency: 'NGN',
            pendingAccountNumber: outcome.accountNumber,
          },
        });
        await persistAssistant(userId, conversationId, outcome.reply);
        return { replies: [outcome.reply], intentId: intent.id };
      }
      await persistAssistant(userId, conversationId, outcome.reply);
      return { replies: [outcome.reply], intentId: active.id };
    }

    if (!amount || amount <= 0) {
      const intent = await upsertActiveIntent({
        userId,
        conversationId,
        intent: 'SEND_MONEY',
        status: 'COLLECTING_INFORMATION',
        slots: {
          recipient: outcome.resolved,
          currency: 'NGN',
        },
      });
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: `Got it — ${formatRecipientLine(
          outcome.resolved
        )}. How much would you like to send?`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: intent.id };
    }

    return finalizeSendReview({
      userId,
      conversationId,
      amount,
      resolved: outcome.resolved,
    });
  }

  if (
    parsed.kind === 'amount_update' &&
    active?.intent === 'SEND_MONEY' &&
    (active.status === 'AWAITING_CONFIRMATION' ||
      active.status === 'COLLECTING_INFORMATION')
  ) {
    const slots: Record<string, unknown> = {
      ...(active.slots as Record<string, unknown>),
      amount: parsed.amount,
      currency: 'NGN',
    };
    const recipient = slots.recipient as ResolvedRecipient | undefined;
    if (!recipient?.name) {
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: replyMissingRecipient(),
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: active.id };
    }

    const amount = Number(slots.amount);
    return finalizeSendReview({
      userId,
      conversationId,
      amount,
      resolved: recipient,
    });
  }

  // After cancel: "Actually send 10k instead" → resume last recipient from dialogue context.
  if (
    isResumeSendWithNewAmount(text) &&
    (!active || active.intent !== 'SEND_MONEY')
  ) {
    const amount = parseAmount(text);
    if (amount && amount > 0) {
      const last = await getLastMoneyContext(conversationId);
      if (last?.recipientName) {
        const outcome = await resolveSendDestination({
          userId,
          recipientName: last.recipientName,
          bankTarget: null,
        });
        if (outcome.ok) {
          return finalizeSendReview({
            userId,
            conversationId,
            amount,
            resolved: outcome.resolved,
          });
        }
        await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            amount,
            currency: 'NGN',
            pendingRecipientLabel: last.recipientName,
          },
        });
        const reply: EngineReply = {
          role: 'assistant',
          type: 'text',
          content: replyRecipientNotFound(last.recipientName),
        };
        await persistAssistant(userId, conversationId, reply);
        return { replies: [reply] };
      }
    }
  }

  if (
    parsed.kind === 'recipient_update' &&
    active?.intent === 'SEND_MONEY' &&
    (active.status === 'AWAITING_CONFIRMATION' ||
      active.status === 'COLLECTING_INFORMATION')
  ) {
    const slots = active.slots as Record<string, unknown>;
    const amount = Number(slots.amount ?? 0);
    const outcome = await resolveSendDestination({
      userId,
      recipientName: parsed.recipientName,
      bankTarget: null,
    });

    if (!outcome.ok) {
      if (outcome.ambiguous && outcome.candidates?.length) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            amount: amount > 0 ? amount : undefined,
            currency: 'NGN',
            pendingRecipientLabel: parsed.recipientName,
            ambiguousCandidates: outcome.candidates,
          },
        });
        await persistAssistant(userId, conversationId, outcome.reply);
        return { replies: [outcome.reply], intentId: intent.id };
      }
      await persistAssistant(userId, conversationId, outcome.reply);
      return { replies: [outcome.reply], intentId: active.id };
    }

    if (!amount || amount <= 0) {
      const intent = await upsertActiveIntent({
        userId,
        conversationId,
        intent: 'SEND_MONEY',
        status: 'COLLECTING_INFORMATION',
        slots: {
          recipient: outcome.resolved,
          currency: 'NGN',
        },
      });
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: `Got it — ${formatRecipientLine(
          outcome.resolved
        )}. How much would you like to send?`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: intent.id };
    }

    return finalizeSendReview({
      userId,
      conversationId,
      amount,
      resolved: outcome.resolved,
    });
  }

  // Bank name already known — user sends account digits next.
  if (
    active?.intent === 'SEND_MONEY' &&
    active.status === 'COLLECTING_INFORMATION'
  ) {
    const slots = active.slots as Record<string, unknown>;
    const pendingBank = String(slots.pendingBankHint || '').trim();
    const digits = String(text || '').replace(/\D/g, '');
    if (pendingBank && digits.length === 10 && !/\bk\b/i.test(text)) {
      const outcome = await resolveSendDestination({
        userId,
        recipientName: null,
        bankTarget: { accountNumber: digits, bankHint: pendingBank },
      });
      if (!outcome.ok) {
        await persistAssistant(userId, conversationId, outcome.reply);
        return { replies: [outcome.reply], intentId: active.id };
      }
      const amount = slots.amount != null ? Number(slots.amount) : null;
      if (!amount || amount <= 0) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            recipient: outcome.resolved,
            currency: 'NGN',
          },
        });
        const reply: EngineReply = {
          role: 'assistant',
          type: 'text',
          content: replyMissingAmount(formatRecipientLine(outcome.resolved)),
        };
        await persistAssistant(userId, conversationId, reply);
        return { replies: [reply], intentId: intent.id };
      }
      return finalizeSendReview({
        userId,
        conversationId,
        amount,
        resolved: outcome.resolved,
      });
    }
  }

  if (
    active?.intent === 'SEND_MONEY' &&
    active.status === 'COLLECTING_INFORMATION' &&
    parsed.kind === 'unknown' &&
    isLikelyBankName(text)
  ) {
    const slots = active.slots as Record<string, unknown>;
    const pendingAccount = String(slots.pendingAccountNumber ?? '');
    // "My wife" flow: user sent bank name only → ask for account number.
    if (
      !pendingAccount &&
      (slots.pendingRecipientLabel || slots.amount) &&
      !slots.pendingBankHint
    ) {
      const intent = await upsertActiveIntent({
        userId,
        conversationId,
        intent: 'SEND_MONEY',
        status: 'COLLECTING_INFORMATION',
        slots: {
          ...slots,
          pendingBankHint: text.trim(),
        },
      });
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: `Great. What's the account number for ${text.trim()}?`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: intent.id };
    }
    if (pendingAccount) {
      const outcome = await resolveSendDestination({
        userId,
        recipientName: null,
        bankTarget: { accountNumber: pendingAccount, bankHint: text.trim() },
      });
      if (!outcome.ok) {
        await persistAssistant(userId, conversationId, outcome.reply);
        return { replies: [outcome.reply], intentId: active.id };
      }

      const amount = slots.amount != null ? Number(slots.amount) : null;
      if (!amount || amount <= 0) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            recipient: outcome.resolved,
            currency: 'NGN',
          },
        });
        const reply: EngineReply = {
          role: 'assistant',
          type: 'text',
          content: replyMissingAmount(
            formatRecipientLine(outcome.resolved)
          ),
        };
        await persistAssistant(userId, conversationId, reply);
        return { replies: [reply], intentId: intent.id };
      }

      return finalizeSendReview({
        userId,
        conversationId,
        amount,
        resolved: outcome.resolved,
      });
    }
  }

  if (parsed.kind === 'balance') {
    // Informational — do not destroy an active crypto deposit workflow.
    if (active?.intent !== 'FUND_CRYPTO') {
      await cancelActiveIntent(userId, conversationId);
    }
    return replyBalanceWithOptionalFunding({ userId, conversationId });
  }

  if (parsed.kind === 'balance_in_currency') {
    if (active?.intent !== 'FUND_CRYPTO') {
      await cancelActiveIntent(userId, conversationId);
    }
    const valuation = await buildBalanceInCurrencyReply(
      userId,
      parsed.currency
    );
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: valuation.content,
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'send_cost_quote') {
    const quote = await buildSendCostQuoteReply({
      amount: parsed.amount,
      currency: parsed.currency,
    });
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: quote.content,
      metadata: {
        buttons: [
          { id: 'send_money', title: 'Send money' },
          { id: 'check_balance', title: 'Balance' },
        ],
      },
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'send_prompt') {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: isSellUsdcIntent(text)
        ? 'Selling USDC here means *sending/withdrawing value as NGN* (or another supported payout). ' +
          transferPrompt()
        : transferPrompt(),
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'fund') {
    await cancelActiveIntent(userId, conversationId);
    const reply: EngineReply = {
      role: 'assistant',
      type: 'choice',
      content: fundWalletPromptMessage(),
      metadata: {
        buttons: FUND_BUTTONS.map((b) => ({ ...b })),
        scope: 'fund',
      },
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'bank_details') {
    await cancelActiveIntent(userId, conversationId);
    const reply = await beginNgnBankFunding({ userId, conversationId });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'receive_help') {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'choice',
      content:
        'Someone can send you money in two ways on WhatsApp right now:\n\n' +
        '1. *NGN bank transfer* — I give you your Dayfi NGN account details.\n' +
        '2. *Crypto* — I give you your USDC (or EURC) deposit address.\n\n' +
        'Other African currencies (GHS, KES, …) work in the Dayfi app, but not yet on WhatsApp.\n\n' +
        'Which do you want?',
      metadata: {
        buttons: FUND_BUTTONS.map((b) => ({ ...b })),
        scope: 'fund',
      },
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'tx_history') {
    const intel =
      (await buildWalletIntelReply(userId, 'show my transactions')) ||
      'I could not load your transactions right now.';
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: intel,
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'tx_status') {
    const intel =
      (await buildWalletIntelReply(userId, 'show my transactions')) ||
      'No recent activity found.';
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content:
        `Here's your latest Dayfi activity so you can check if it went through:\n\n${intel}\n\n` +
        `_If this was a crypto deposit, ask "Did my USDC arrive?" for a live chain check._`,
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (parsed.kind === 'unsupported_corridor') {
    // Recipient hint from "Send Kola GHS 500" — amount may already be set.
    const hintMatch = parsed.raw.match(
      /^send\s+([a-z][a-z0-9 .'-]{0,40}?)\s+/i
    );
    const recipientHint =
      hintMatch && !/^(ghs|kes|zar|ugx|ngn)/i.test(hintMatch[1])
        ? hintMatch[1].trim()
        : null;
    const reply = await beginYellowCardSend({
      userId,
      conversationId,
      currency: parsed.currency,
      amount: parsed.amount,
      recipientHint,
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: reply.intentId };
  }

  if (parsed.kind === 'send') {
    let amount = parsed.amount;
    let recipientName = parsed.recipientName;
    const bankTarget = parsed.bankTarget;

    if (parsed.pronounRecipient) {
      const last = await getLastMoneyContext(conversationId);
      if (last?.recipientName) {
        recipientName = last.recipientName;
      } else {
        const reply: EngineReply = {
          role: 'assistant',
          type: 'text',
          content:
            "I don't have a recent recipient yet. Who should I send it to — a name or bank details?",
        };
        await persistAssistant(userId, conversationId, reply);
        return { replies: [reply] };
      }
    }

    if (active?.intent === 'SEND_MONEY') {
      const slots = active.slots as Record<string, unknown>;
      // Only inherit amount/recipient when this utterance did not name a new destination.
      if (!amount && slots.amount) amount = Number(slots.amount);
      if (!recipientName && !bankTarget) {
        const existing = slots.recipient as { name?: string } | undefined;
        recipientName = existing?.name ?? null;
      }
    }

    const outcome = await resolveSendDestination({
      userId,
      recipientName,
      bankTarget,
    });

    if (!outcome.ok) {
      if (outcome.needsCompleteAccount) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            amount,
            currency: 'NGN',
            pendingBankHint: outcome.bankHint,
            pendingIncompleteAccount: outcome.accountNumber,
          },
        });
        await persistAssistant(userId, conversationId, outcome.reply);
        return { replies: [outcome.reply], intentId: intent.id };
      }
      if (outcome.needsBank && outcome.accountNumber) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            amount,
            currency: 'NGN',
            pendingAccountNumber: outcome.accountNumber,
          },
        });
        await persistAssistant(userId, conversationId, outcome.reply);
        return { replies: [outcome.reply], intentId: intent.id };
      }
      if (outcome.ambiguous && outcome.candidates?.length) {
        const intent = await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            amount,
            currency: 'NGN',
            pendingRecipientLabel: outcome.pendingRecipientLabel || recipientName,
            ambiguousCandidates: outcome.candidates,
          },
        });
        await persistAssistant(userId, conversationId, outcome.reply);
        return { replies: [outcome.reply], intentId: intent.id };
      }

      // Persist amount + nickname so bank details can continue this send.
      if (amount && amount > 0) {
        await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            amount,
            currency: 'NGN',
            ...(outcome.pendingRecipientLabel
              ? { pendingRecipientLabel: outcome.pendingRecipientLabel }
              : {}),
          },
        });
      } else if (outcome.pendingRecipientLabel) {
        await upsertActiveIntent({
          userId,
          conversationId,
          intent: 'SEND_MONEY',
          status: 'COLLECTING_INFORMATION',
          slots: {
            currency: 'NGN',
            pendingRecipientLabel: outcome.pendingRecipientLabel,
          },
        });
      }

      await persistAssistant(userId, conversationId, outcome.reply);
      return { replies: [outcome.reply], intentId: active?.id };
    }

    const resolved = outcome.resolved;

    if (!amount || amount <= 0) {
      const intent = await upsertActiveIntent({
        userId,
        conversationId,
        intent: 'SEND_MONEY',
        status: 'COLLECTING_INFORMATION',
        slots: {
          recipient: resolved,
          currency: 'NGN',
        },
      });
      const reply: EngineReply = {
        role: 'assistant',
        type: 'text',
        content: `Got ${formatRecipientLine(
          resolved
        )}. How much should I send?`,
      };
      await persistAssistant(userId, conversationId, reply);
      return { replies: [reply], intentId: intent.id };
    }

    return finalizeSendReview({
      userId,
      conversationId,
      amount,
      resolved,
    });
  }

  if (
    parsed.kind === 'amount_update' &&
    active?.intent === 'SEND_MONEY' &&
    active.status === 'COLLECTING_INFORMATION'
  ) {
    const slots = active.slots as Record<string, unknown>;
    const recipient = slots.recipient as ResolvedRecipient | undefined;
    if (recipient?.name) {
      return finalizeSendReview({
        userId,
        conversationId,
        amount: parsed.amount,
        resolved: recipient,
      });
    }
  }

  const q = text.toLowerCase().trim();
  if (/^(thanks|thank you|thx|ok thanks)[.!]*$/i.test(q)) {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: "You're welcome! 💜",
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  const intel = await buildWalletIntelReply(userId, text);
  if (intel) {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content: intel,
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  // Never let the planner / generic examples steal an active money workflow.
  if (
    active &&
    (active.status === 'COLLECTING_INFORMATION' ||
      active.status === 'AWAITING_CONFIRMATION' ||
      active.status === 'AWAITING_DEPOSIT') &&
    (active.intent === 'SEND_MONEY' ||
      active.intent === 'FUND_CRYPTO' ||
      active.intent === 'SEND_CRYPTO' ||
      active.intent === 'PAY_BILL')
  ) {
    const slots = active.slots as Record<string, unknown>;
    let content =
      'I still need a bit more information to finish that request. You can also say cancel.';
    if (active.intent === 'SEND_MONEY') {
      if (slots.pendingIncompleteAccount || slots.pendingBankHint) {
        const bank = String(slots.pendingBankHint || 'bank');
        content = `I still need the complete 10-digit ${bank} account number to continue your transfer.`;
      } else if (slots.pendingAccountNumber) {
        content =
          'Which bank is that account with? For example: OPay, GTBank, or Access Bank.';
      } else if (!slots.recipient) {
        const label = String(slots.pendingRecipientLabel || '').trim();
        content = label
          ? replyRecipientNotFound(label)
          : replyMissingRecipient();
      } else if (!slots.amount) {
        content = replyMissingAmount();
      } else {
        content =
          'I have your transfer details. Say confirm when you are ready, or cancel to stop.';
      }
    } else if (active.intent === 'FUND_CRYPTO') {
      if (!slots.asset) {
        content = formatCryptoFundingAsk('asset');
      } else if (!slots.network) {
        content = formatCryptoFundingAsk(
          'network',
          slots.asset as 'USDC' | 'EURC'
        );
      } else if (slots.pendingAddress) {
        content =
          `I'm still preparing your ${String(slots.asset)} ${String(slots.network)} deposit address. I'll message you when it's ready.`;
      } else if (slots.depositAddress) {
        const amt =
          slots.amount != null && Number(slots.amount) > 0
            ? `${slots.amount} `
            : '';
        content =
          `I'm watching for your ${amt}${String(slots.asset)} ${String(slots.network)} deposit. ` +
          `Ask "has it arrived?" anytime, or say cancel if you want to stop.`;
      } else {
        content =
          'Tell me the asset and network to continue, for example: Deposit USDC on Stellar.';
      }
    } else if (active.intent === 'PAY_BILL') {
      if (!slots.categoryCode) {
        content = 'Which bill — airtime, data, electricity, internet, or DSTV?';
      } else if (!slots.amount) {
        content = 'How much would you like to pay?';
      } else if (!slots.customerId) {
        content = 'What phone, meter, or account number should I use?';
      } else {
        content =
          'I have your bill details. Confirm with your PIN, or say cancel.';
      }
    }
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content,
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: active.id };
  }

  if (!skipPlanner) {
    // Conversational brain first: ChatGPT-like chat OR structured action.
    try {
      const brain = await runConversationalBrain({
        userId,
        conversationId,
        text,
      });
      if (brain.kind === 'action' && brain.actions.length) {
        const dispatched = await dispatchFirstPlanAction({
          userId,
          conversationId,
          action: brain.actions[0],
        });
        if (dispatched) {
          if (brain.note) {
            const note: EngineReply = {
              role: 'assistant',
              type: 'text',
              content: brain.note,
            };
            await persistAssistant(userId, conversationId, note);
            return {
              replies: [note, ...dispatched.replies],
              intentId: dispatched.intentId,
            };
          }
          return {
            replies: dispatched.replies,
            intentId: dispatched.intentId,
          };
        }
      }
      if (brain.kind === 'chat' && brain.reply) {
        const reply: EngineReply = {
          role: 'assistant',
          type: 'text',
          content: brain.reply,
        };
        await persistAssistant(userId, conversationId, reply);
        return { replies: [reply] };
      }
    } catch (err) {
      console.warn(
        '[azap/engine] conversational brain',
        err instanceof Error ? err.message : 'error'
      );
    }

    // Legacy planner only if brain did not produce a chat/action.
    try {
      const plan = await proposeActionPlanFromText({
        userId,
        conversationId,
        text,
      });
      const actions = plan.actions.slice(0, 4);
      if (actions.length) {
        const dispatched = await dispatchFirstPlanAction({
          userId,
          conversationId,
          action: actions[0],
        });
        if (dispatched) {
          return {
            replies: dispatched.replies,
            intentId: dispatched.intentId,
          };
        }
      }
    } catch (err) {
      console.warn(
        '[azap/engine] planner fallback',
        err instanceof Error ? err.message : 'error'
      );
    }
  }

  const reply: EngineReply = {
    role: 'assistant',
    type: 'text',
    content: genericNudge(),
  };
  await persistAssistant(userId, conversationId, reply);
  return { replies: [reply] };
}

async function dispatchFirstPlanAction(input: {
  userId: string;
  conversationId: string;
  action: {
    type: string;
    amount?: string | null;
    currency?: string | null;
    recipientReference?: string | null;
    asset?: string | null;
    network?: string | null;
  };
}): Promise<EngineResult | null> {
  const { userId, conversationId, action } = input;

  if (action.type === 'crypto_deposit') {
    const reply = await continueCryptoFunding({
      userId,
      conversationId,
      text:
        [action.asset, action.network].filter(Boolean).join(' on ') ||
        'deposit crypto',
      slots: { method: 'crypto', asset: action.asset, network: action.network },
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (action.type === 'crypto_transfer') {
    const reply = await continueCryptoSend({
      userId,
      conversationId,
      text: 'send crypto',
      slots: {
        asset: action.asset,
        network: action.network,
        amount: action.amount,
      },
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (action.type === 'fiat_funding') {
    const reply = await beginNgnBankFunding({ userId, conversationId });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (
    action.type === 'bank_transfer' &&
    (action.amount || action.recipientReference)
  ) {
    const phrase = `Send ${action.amount || ''} ${action.currency || ''} to ${
      action.recipientReference || ''
    }`.replace(/\s+/g, ' ');
    return handleUserText({
      userId,
      conversationId,
      text: phrase.trim(),
      skipPlanner: true,
    });
  }

  if (action.type === 'balance_check') {
    return replyBalanceWithOptionalFunding({ userId, conversationId });
  }

  if (action.type === 'kyc') {
    return handleKycRequest({ userId, conversationId });
  }

  if (action.type === 'airtime_purchase') {
    const reply = await beginBillPayment({
      userId,
      conversationId,
      categoryCode: 'AIRTIME',
      text: action.amount ? `Buy ₦${action.amount} airtime` : 'Buy airtime',
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: (reply as { intentId?: string }).intentId };
  }

  if (action.type === 'bill_payment') {
    const reply = await beginBillPayment({
      userId,
      conversationId,
      text: 'Pay a bill',
    });
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply], intentId: (reply as { intentId?: string }).intentId };
  }

  if (action.type === 'crypto_buy') {
    await cancelActiveIntent(userId, conversationId);
    const asset = String(action.asset || 'USDC').toUpperCase();
    const network = String(action.network || '').trim() || undefined;
    // Launch path: USDC/EURC = custodial DayFi fund (FLW NGN or on-chain deposit).
    // YC direct-settlement is a future rail — do not block Nigeria launch on it.
    const custodialLaunch = !asset || asset === 'USDC' || asset === 'EURC';
    if (!custodialLaunch) {
      try {
        const gate = await prepareCryptoTrade({
          userId,
          side: 'buy',
          asset,
          network,
          fiatAmount: action.amount ? Number(action.amount) : null,
        });
        if (!gate.ok) {
          const reply: EngineReply = {
            role: 'assistant',
            type: 'text',
            content: gate.message,
          };
          await persistAssistant(userId, conversationId, reply);
          return { replies: [reply] };
        }
        if (gate.ready === false) {
          const reply: EngineReply = {
            role: 'assistant',
            type: 'text',
            content: gate.message,
          };
          await persistAssistant(userId, conversationId, reply);
          return { replies: [reply] };
        }
      } catch (err) {
        console.warn(
          '[azap/engine] crypto_buy gate',
          err instanceof Error ? err.message : err
        );
      }
    }
    const reply: EngineReply = {
      role: 'assistant',
      type: 'choice',
      content:
        asset === 'EURC'
          ? 'Getting EURC means *funding your DayFi wallet* — NGN bank transfer or a crypto deposit. Balances are custodial (DayFi ledger + treasury). Which do you want?'
          : 'Buying USDC here means *funding your DayFi wallet* — NGN bank transfer (Flutterwave) or a USDC deposit. Balances are custodial (DayFi ledger + treasury), not a non-custodial exchange. Which do you want?',
      metadata: {
        buttons: FUND_BUTTONS.map((b) => ({ ...b })),
        scope: 'fund',
      },
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (action.type === 'crypto_sell') {
    await cancelActiveIntent(userId, conversationId);
    const asset = String(action.asset || 'USDC').toUpperCase();
    const network = String(action.network || '').trim() || undefined;
    const custodialLaunch = !asset || asset === 'USDC' || asset === 'EURC';
    if (!custodialLaunch) {
      try {
        const gate = await prepareCryptoTrade({
          userId,
          side: 'sell',
          asset,
          network,
          cryptoAmount: action.amount ? Number(action.amount) : null,
        });
        if (!gate.ok) {
          const reply: EngineReply = {
            role: 'assistant',
            type: 'text',
            content: gate.message,
          };
          await persistAssistant(userId, conversationId, reply);
          return { replies: [reply] };
        }
        if (gate.ready === false) {
          const reply: EngineReply = {
            role: 'assistant',
            type: 'text',
            content: gate.message,
          };
          await persistAssistant(userId, conversationId, reply);
          return { replies: [reply] };
        }
      } catch (err) {
        console.warn(
          '[azap/engine] crypto_sell gate',
          err instanceof Error ? err.message : err
        );
      }
    }
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content:
        'Cashing out USDC/EURC means *sending value as NGN* (or another supported payout) from your DayFi balance — custodial off-ramp, not a CEX sell order. ' +
        transferPrompt(),
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  if (action.type === 'crypto_swap') {
    const reply: EngineReply = {
      role: 'assistant',
      type: 'text',
      content:
        "I can't convert USDC↔EURC (or other crypto assets) right now — there's no live swap/conversion rail wired for WhatsApp. " +
        'Your wallet stays in USDC. I can show NGN/GHS equivalents, fund USDC, or send money in local currency.',
    };
    await persistAssistant(userId, conversationId, reply);
    return { replies: [reply] };
  }

  return null;
}

function shouldInterruptCollection(
  parsed: ReturnType<typeof parseUserMessage>
): boolean {
  if (
    parsed.kind === 'fund' ||
    parsed.kind === 'bill_prompt' ||
    parsed.kind === 'airtime_prompt' ||
    parsed.kind === 'kyc' ||
    parsed.kind === 'balance' ||
    parsed.kind === 'balance_in_currency' ||
    parsed.kind === 'unsupported_corridor'
  ) {
    return true;
  }
  if (parsed.kind === 'send') {
    // New destination or a fully specified send replaces the open collection.
    return Boolean(parsed.recipientName || parsed.bankTarget || parsed.pronounRecipient);
  }
  return false;
}

function pickAmbiguousCandidate(
  text: string,
  candidates: ResolvedRecipient[]
): ResolvedRecipient | null {
  if (!candidates.length) return null;
  const q = text.toLowerCase().replace(/\s+/g, ' ').trim();

  const numbered = q.match(/\b([1-9])\b/);
  if (numbered) {
    const idx = Number(numbered[1]) - 1;
    if (idx >= 0 && idx < candidates.length) return candidates[idx];
  }

  for (const c of candidates) {
    const name = c.name.toLowerCase();
    if (q.includes(name) && name.length > 2) return c;
  }

  if (/\b(the\s+)?other\b|\bsecond\b|\blatter\b|\bno\s+wait\b/.test(q)) {
    return candidates[1] ?? candidates[0];
  }
  if (/\bfirst\b|\bformer\b/.test(q)) {
    return candidates[0];
  }
  return null;
}

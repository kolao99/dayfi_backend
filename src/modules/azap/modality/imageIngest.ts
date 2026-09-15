/**
 * Phase 3 scaffold — screenshots/images → vision/OCR → structured entities.
 * Never auto-executes money. Always confirm with the user first.
 */

export type ImageEntityKind = 'bank' | 'crypto' | 'bill' | 'unknown';

export type ExtractedImageEntities = {
  kind: ImageEntityKind;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  asset?: string;
  network?: string;
  walletAddress?: string;
  memo?: string;
  amount?: string;
  currency?: string;
  provider?: string;
  customerRef?: string;
  rawText?: string;
};

export type ImageIngestResult =
  | { ok: true; entities: ExtractedImageEntities; prompt: string }
  | { ok: false; userMessage: string };

export async function ingestPaymentImage(_input: {
  userId: string;
  mediaUrl?: string;
  mimeType?: string;
  mediaId?: string;
}): Promise<ImageIngestResult> {
  return {
    ok: false,
    userMessage:
      "I can't read screenshots yet — paste the account number or wallet address and I'll continue 🙏",
  };
}

/** Build a confirmation prompt from entities — never skip confirmation. */
export function confirmationPromptFromEntities(
  entities: ExtractedImageEntities
): string {
  if (
    entities.kind === 'bank' &&
    entities.accountName &&
    entities.bankName
  ) {
    return `I found *${entities.accountName}*’s ${entities.bankName} account. How much do you want to send?`;
  }
  if (entities.kind === 'crypto' && entities.walletAddress) {
    const asset = entities.asset || 'crypto';
    const net = entities.network ? ` on ${entities.network}` : '';
    return `I found a ${asset} wallet${net}. How much do you want to send?`;
  }
  if (entities.kind === 'bill') {
    return `I found bill details${
      entities.provider ? ` for ${entities.provider}` : ''
    }. Want me to help pay it?`;
  }
  return 'I looked at the image — tell me what you want to do (send, fund, or pay a bill).';
}

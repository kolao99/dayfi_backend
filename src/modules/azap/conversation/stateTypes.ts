export type AzapChannel = 'whatsapp' | 'telegram' | 'app' | 'system';

export type AzapConversationState = {
  userId: string;
  channel: AzapChannel;
  conversationId: string;
  phoneE164?: string | null;
  currentIntent?: string | null;
  actionPlanId?: string | null;
  pendingActions?: unknown[];
  resolvedEntities?: Record<string, unknown>;
  missingFields?: string[];
  confirmationState?: 'none' | 'awaiting' | 'confirmed' | 'cancelled';
  pinState?: 'none' | 'awaiting' | 'verified' | 'failed';
  kycState?: string | null;
  consentState?: string | null;
  activeFlow?: string | null;
  lastToolCalls?: unknown[];
  toolResults?: unknown[];
  idempotencyKey?: string | null;
  expiresAt?: string | null;
  updatedAt: string;
};

export function emptyConversationState(input: {
  userId: string;
  channel: AzapChannel;
  conversationId: string;
  phoneE164?: string | null;
}): AzapConversationState {
  return {
    userId: input.userId,
    channel: input.channel,
    conversationId: input.conversationId,
    phoneE164: input.phoneE164 ?? null,
    confirmationState: 'none',
    pinState: 'none',
    missingFields: [],
    resolvedEntities: {},
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Channel-neutral types for Azap.
 *
 * The conversational engine operates on these shapes — never on raw Telegram
 * or Twilio payloads. Channel adapters normalize inbound/outbound messages.
 */

export type FourChannel = 'telegram' | 'whatsapp' | 'app';

export type FourInboundMessage = {
  channel: FourChannel;
  externalUserId: string;
  externalChatId: string;
  messageId: string;
  text: string;
  timestamp: Date;
  /** True when the user tapped a channel button that sent this text. */
  fromButton?: boolean;
  replyToMessageId?: string;
};

export type FourAction = {
  id: string;
  label: string;
  userText?: string;
  selected?: boolean;
  disabled?: boolean;
  /** Secure surface (PIN, KYC) — channel decides how to launch. */
  secureUrl?: string | null;
};

export type FourOutboundMessage = {
  text: string;
  type?: 'text' | 'choice' | 'review' | 'receipt';
  actions?: FourAction[];
  scope?: string;
  metadata?: Record<string, unknown>;
};

export type FourEngineTurnResult = {
  replies: FourOutboundMessage[];
  intentId?: string;
};

import axios from 'axios';
import {
  buildChoiceKeyboard,
  type PersistedButton,
} from './buttonState';

export type OutboundTelegramMessage = {
  chatId: number | string;
  text: string;
  replyMarkup?: Record<string, unknown>;
  messageId?: number;
};

const outboundStub: OutboundTelegramMessage[] = [];
let stubMessageCounter = 1;

export function isTelegramStubMode(): boolean {
  const mode = String(process.env.FOUR_TELEGRAM_MODE || '').toLowerCase();
  if (mode === 'stub') return true;
  return !process.env.FOUR_TELEGRAM_BOT_TOKEN;
}

export function drainStubOutbound(): OutboundTelegramMessage[] {
  return outboundStub.splice(0, outboundStub.length);
}

export function resetStubOutbound(): void {
  outboundStub.length = 0;
  stubMessageCounter = 1;
}

export async function sendTelegramMessage(
  message: OutboundTelegramMessage
): Promise<{ messageId?: number }> {
  if (isTelegramStubMode()) {
    const messageId = stubMessageCounter++;
    outboundStub.push({ ...message, messageId });
    return { messageId };
  }

  const token = process.env.FOUR_TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('FOUR_TELEGRAM_BOT_TOKEN is not configured');
  }

  const response = await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      chat_id: message.chatId,
      text: message.text,
      reply_markup: message.replyMarkup,
      parse_mode: 'Markdown',
    },
    { timeout: 15000 }
  );

  return { messageId: response.data?.result?.message_id };
}

export async function editMessageReplyMarkup(input: {
  chatId: number | string;
  messageId: number;
  replyMarkup: Record<string, unknown>;
}): Promise<void> {
  if (isTelegramStubMode()) {
    outboundStub.push({
      chatId: input.chatId,
      text: '__edit_markup__',
      replyMarkup: input.replyMarkup,
      messageId: input.messageId,
    });
    return;
  }

  const token = process.env.FOUR_TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await axios.post(
    `https://api.telegram.org/bot${token}/editMessageReplyMarkup`,
    {
      chat_id: input.chatId,
      message_id: input.messageId,
      reply_markup: input.replyMarkup,
    },
    { timeout: 10000 }
  );
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  if (isTelegramStubMode()) return;

  const token = process.env.FOUR_TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await axios.post(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    },
    { timeout: 10000 }
  );
}

export function miniAppUrl(options?: {
  intent?: string;
  mode?: 'setup' | 'authorize';
}): string | null {
  const base = String(process.env.FOUR_TELEGRAM_MINI_APP_URL || '').trim();
  if (!base) return null;

  if (options?.mode === 'setup') {
    try {
      const url = new URL(base);
      url.pathname = '/setup-pin';
      url.search = '';
      return url.toString();
    } catch {
      return base.replace(/\/authorize\/?(\?.*)?$/, '/setup-pin');
    }
  }

  const params = new URLSearchParams();
  if (options?.intent) params.set('intent', options.intent);

  const qs = params.toString();
  if (!qs) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${qs}`;
}

/**
 * Persistent inline keyboard — disabled buttons stay visible with a ✓ prefix.
 */
export function buildInlineKeyboard(
  buttons: PersistedButton[],
  options?: {
    scope?: string;
    intentId?: string;
    webAppUrl?: string | null;
    webAppLabel?: string;
  }
): Record<string, unknown> {
  const scope = options?.scope ?? 'action';
  let webAppUrl = options?.webAppUrl ?? null;
  let webAppLabel = options?.webAppLabel;

  if (!webAppUrl && options?.intentId) {
    webAppUrl = miniAppUrl({ intent: options.intentId });
    webAppLabel = webAppLabel ?? '🔐 Enter PIN to complete';
  }

  return buildChoiceKeyboard(buttons, scope, {
    webAppUrl,
    webAppLabel,
    callbackExtra: options?.intentId,
  });
}

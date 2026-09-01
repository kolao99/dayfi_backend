import axios from 'axios';

export type OutboundTelegramMessage = {
  chatId: number | string;
  text: string;
  replyMarkup?: Record<string, unknown>;
};

const outboundStub: OutboundTelegramMessage[] = [];

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
}

export async function sendTelegramMessage(
  message: OutboundTelegramMessage
): Promise<void> {
  if (isTelegramStubMode()) {
    outboundStub.push(message);
    return;
  }

  const token = process.env.FOUR_TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('FOUR_TELEGRAM_BOT_TOKEN is not configured');
  }

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      chat_id: message.chatId,
      text: message.text,
      reply_markup: message.replyMarkup,
      parse_mode: 'HTML',
    },
    { timeout: 15000 }
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

export function miniAppUrl(intentId?: string): string | null {
  const base = String(process.env.FOUR_TELEGRAM_MINI_APP_URL || '').trim();
  if (!base) return null;
  if (!intentId) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}intent=${encodeURIComponent(intentId)}`;
}

export function buildInlineKeyboard(
  buttons: Array<{ id: string; label: string; disabled?: boolean }>,
  intentId?: string
): Record<string, unknown> {
  const rows: Array<Array<Record<string, unknown>>> = [];

  const active = buttons.filter((b) => !b.disabled);
  if (active.length > 0) {
    rows.push(
      active.map((b) => ({
        text: b.disabled ? `✓ ${b.label}` : b.label,
        callback_data: `four:${b.id}:${intentId ?? ''}`,
      }))
    );
  }

  const pinUrl = miniAppUrl(intentId);
  if (pinUrl) {
    rows.push([
      {
        text: '🔐 Confirm with PIN',
        web_app: { url: pinUrl },
      },
    ]);
  }

  return rows.length ? { inline_keyboard: rows } : {};
}

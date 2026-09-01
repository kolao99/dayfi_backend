import type { ChoiceButton } from './onboardingService';

export type PersistedButton = ChoiceButton & {
  selected?: boolean;
};

/**
 * Global Four button rule: clicked buttons stay visible but become disabled.
 * Selected buttons show a ✓ prefix in Telegram.
 */
export function applyButtonSelection(
  buttons: PersistedButton[],
  selectedId: string
): PersistedButton[] {
  return buttons.map((b) =>
    b.id === selectedId ? { ...b, disabled: true, selected: true } : b
  );
}

export function buildChoiceKeyboard(
  buttons: PersistedButton[],
  scope: string,
  options?: {
    webAppUrl?: string | null;
    webAppLabel?: string;
    callbackExtra?: string;
  }
): Record<string, unknown> {
  const rows: Array<Array<Record<string, unknown>>> = [];

  if (buttons.length > 0) {
    rows.push(
      buttons.map((b) => {
        const prefix = b.disabled || b.selected ? '✓ ' : '';
        const suffix = options?.callbackExtra ? `:${options.callbackExtra}` : '';
        return {
          text: `${prefix}${b.label}`,
          callback_data: b.disabled
            ? `four:noop:${scope}:${b.id}${suffix}`
            : `four:${scope}:${b.id}${suffix}`,
        };
      })
    );
  }

  if (options?.webAppUrl) {
    rows.push([
      {
        text: options.webAppLabel ?? '🔐 Continue',
        web_app: { url: options.webAppUrl },
      },
    ]);
  }

  return rows.length ? { inline_keyboard: rows } : {};
}

export function parseCallbackData(data: string): {
  namespace: string;
  scope: string;
  action: string;
} | null {
  const parts = String(data || '').split(':');
  if (parts.length < 3 || parts[0] !== 'four') return null;
  return { namespace: parts[0], scope: parts[1], action: parts[2] };
}

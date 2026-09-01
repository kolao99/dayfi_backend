import type { ChoiceButton } from './onboardingService';

export type PersistedButton = ChoiceButton & {
  selected?: boolean;
};

/** Strip leading emoji / whitespace from a button label for display. */
export function stripButtonEmoji(label: string): string {
  return (
    label
      .replace(
        /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\s]+/gu,
        ''
      )
      .trim() || label
  );
}

export function buttonUserText(button: ChoiceButton): string {
  return button.userText || stripButtonEmoji(button.label);
}

function selectedButtonLabel(button: ChoiceButton): string {
  const base = stripButtonEmoji(button.label);
  const spoken = buttonUserText(button);
  if (spoken.toLowerCase() === base.toLowerCase()) {
    return `✅ ${base}`;
  }
  return `✅ ${base} - ${spoken}`;
}

/**
 * Global Four button rule: clicked buttons stay visible but become disabled.
 * Selected buttons show ✅ and the spoken user phrase after a hyphen.
 */
export function applyButtonSelection(
  buttons: PersistedButton[],
  selectedId: string
): PersistedButton[] {
  return buttons.map((b) => {
    if (b.id !== selectedId) return b;
    return {
      ...b,
      disabled: true,
      selected: true,
      label: selectedButtonLabel(b),
    };
  });
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
        const suffix = options?.callbackExtra ? `:${options.callbackExtra}` : '';
        return {
          text: b.label,
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

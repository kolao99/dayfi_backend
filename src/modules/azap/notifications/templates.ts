export type AzapNotificationEvent =
  | 'transaction_success'
  | 'transaction_failed'
  | 'transaction_pending'
  | 'kyc_verified'
  | 'kyc_failed'
  | 'security_alert'
  | 'pricing_update'
  | 'billing_consent_required'
  | 'statement_ready'
  | 'maintenance_notice';

export type AzapNotificationTemplate = {
  event: AzapNotificationEvent;
  version: string;
  body: string;
};

export const AZAP_NOTIFICATION_TEMPLATES: AzapNotificationTemplate[] = [
  {
    event: 'billing_consent_required',
    version: 'v1',
    body:
      '✨ Hi {{first_name}}\n\n' +
      'Starting {{effective_date}}, service charges will apply to selected Azap services.\n\n' +
      'Your charges will accumulate throughout your billing cycle and you\'ll receive a detailed breakdown via WhatsApp and email.\n\n' +
      'If you haven\'t given consent, review the updated billing terms below.\n\n' +
      'You can also type:\n"Billing Consent"\nor:\n"Azap Charges"',
  },
  {
    event: 'transaction_success',
    version: 'v1',
    body: '✅ {{summary}}',
  },
  {
    event: 'transaction_failed',
    version: 'v1',
    body: '✗ {{summary}}',
  },
  {
    event: 'security_alert',
    version: 'v1',
    body: '🔐 Security notice for your Azap account:\n{{summary}}',
  },
];

export function renderNotificationTemplate(
  template: AzapNotificationTemplate,
  vars: Record<string, string>
): string {
  return template.body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return vars[key] ?? '';
  });
}

export function getNotificationTemplate(
  event: AzapNotificationEvent,
  version = 'v1'
): AzapNotificationTemplate | null {
  return (
    AZAP_NOTIFICATION_TEMPLATES.find(
      (t) => t.event === event && t.version === version
    ) ?? null
  );
}

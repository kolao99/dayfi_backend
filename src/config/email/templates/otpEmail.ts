import { DAYFI_EMAIL_BRAND } from './brand';
import {
  dayfiEmailHeading,
  dayfiEmailLayout,
  dayfiEmailParagraph,
} from './layout';

export type OtpEmailPurpose =
  | 'login'
  | 'signup'
  | 'password_reset'
  | 'google'
  | 'transaction_pin';

function copyForPurpose(purpose: OtpEmailPurpose) {
  switch (purpose) {
    case 'password_reset':
      return {
        subject: 'Reset your Dayfi password',
        heading: 'Reset your password',
        lead: 'Use this code to reset your Dayfi account password.',
      };
    case 'signup':
      return {
        subject: 'Verify your Dayfi account',
        heading: 'Verify your email',
        lead: 'Enter this code to finish creating your Dayfi account.',
      };
    case 'google':
      return {
        subject: 'Confirm your Dayfi sign-in',
        heading: 'Confirm it’s you',
        lead: 'Enter this code to complete sign-in to Dayfi.',
      };
    case 'transaction_pin':
      return {
        subject: 'Reset your Dayfi transaction PIN',
        heading: 'Reset your PIN',
        lead: 'Use this code to reset your transaction PIN.',
      };
    default:
      return {
        subject: 'Your Dayfi verification code',
        heading: 'Your verification code',
        lead: 'Enter this code to sign in to your Dayfi account.',
      };
  }
}

function otpCodeBlock(code: string): string {
  const { brand, border, ink } = DAYFI_EMAIL_BRAND;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px;">
    <tr>
      <td align="center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${border};border-left:3px solid ${brand};border-radius:12px;background-color:#fafbfd;">
          <tr>
            <td style="padding:18px 28px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:0.28em;color:${ink};">
              ${code}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

export function buildOtpEmail(
  code: string,
  purpose: OtpEmailPurpose,
  expiresMinutes = 30,
  firstName?: string
) {
  const copy = copyForPurpose(purpose);
  const lead = firstName
    ? `Hi ${firstName}, ${copy.lead.charAt(0).toLowerCase()}${copy.lead.slice(1)}`
    : copy.lead;
  const preheader = `Your Dayfi code is ${code}. It expires in ${expiresMinutes} minutes.`;

  const content = [
    dayfiEmailHeading(copy.heading),
    dayfiEmailParagraph(lead, { muted: true }),
    otpCodeBlock(code),
    dayfiEmailParagraph(
      `This code expires in <strong style="color:${DAYFI_EMAIL_BRAND.ink};">${expiresMinutes} minutes</strong>.`,
      { muted: true, marginBottom: 12 }
    ),
    dayfiEmailParagraph(
      'If you didn’t request this code, you can ignore this email. Your account stays secure.',
      { muted: true, marginBottom: 0 }
    ),
  ].join('');

  const html = dayfiEmailLayout({ preheader, content });
  const text = [
    copy.heading,
    '',
    copy.lead,
    '',
    `Code: ${code}`,
    '',
    `This code expires in ${expiresMinutes} minutes.`,
    '',
    'If you didn’t request this code, you can ignore this email.',
    '',
    '— Dayfi',
  ].join('\n');

  return { subject: copy.subject, text, html };
}

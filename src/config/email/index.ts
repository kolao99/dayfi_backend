import nodemailer from 'nodemailer';
import { sendViaResend } from './resendSend';

export type SendVerificationEmailOptions = {
  /**
   * When false, failures are logged only (e.g. post-OTP welcome mail should not
   * roll back a successful verification).
   * @default true
   */
  throwOnFailure?: boolean;
};

function resendSettings() {
  const apiKey = process.env.DAYFI_RESEND_API_KEY?.trim();
  const from =
    process.env.DAYFI_RESEND_FROM?.trim() ||
    'Dayfi <onboarding@resend.dev>';
  return { apiKey, from };
}

function smtpSettings() {
  const host =
    process.env.DAYFI_SMTP_HOST?.trim() || 'smtp.zoho.eu';
  const port = Number(process.env.DAYFI_SMTP_PORT?.trim() || '587');
  const secureFlag = process.env.DAYFI_SMTP_SECURE?.trim().toLowerCase();
  const secure =
    secureFlag === 'true'
      ? true
      : secureFlag === 'false'
        ? false
        : port === 465;

  const user = process.env.DAYFI_SMTP_USER?.trim();
  const pass = process.env.DAYFI_SMTP_PASS?.trim();
  const from =
    process.env.DAYFI_SMTP_FROM?.trim() || '"Dayfi" <no-reply@dayfi.co>';

  return { host, port, secure, user, pass, from };
}

function createTransporter() {
  const { host, port, secure, user, pass } = smtpSettings();

  if (!user || !pass) {
    throw new Error(
      'Email is not configured: set DAYFI_RESEND_API_KEY (recommended) or DAYFI_SMTP_USER and DAYFI_SMTP_PASS (see .env.example).'
    );
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

async function sendWithSmtp(
  userEmail: string,
  subject: string,
  text: string,
  html: string
): Promise<void> {
  const { from } = smtpSettings();
  const transporter = createTransporter();
  const info = await transporter.sendMail({
    from,
    to: userEmail,
    subject,
    text,
    html,
  });
  console.log('Email sent (SMTP): ' + info.messageId);
}

async function sendWithResend(
  userEmail: string,
  subject: string,
  text: string,
  html: string
): Promise<void> {
  const { apiKey, from } = resendSettings();
  if (!apiKey) {
    throw new Error(
      'DAYFI_RESEND_API_KEY is missing. Add it in Railway or .env, or use SMTP vars instead.'
    );
  }
  const { id } = await sendViaResend(apiKey, {
    from,
    to: userEmail,
    subject,
    text,
    html,
  });
  console.log('Email sent (Resend): ' + id);
}

export async function sendVerificationEmail(
  userEmail: string,
  subject: string,
  text: string,
  html: string,
  options?: SendVerificationEmailOptions
) {
  const throwOnFailure = options?.throwOnFailure !== false;
  const useResend = Boolean(resendSettings().apiKey);

  try {
    if (useResend) {
      await sendWithResend(userEmail, subject, text, html);
    } else {
      await sendWithSmtp(userEmail, subject, text, html);
    }
  } catch (error) {
    console.error('Error sending email:', error);
    if (throwOnFailure) {
      throw error;
    }
  }
}

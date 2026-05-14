import nodemailer from 'nodemailer';

export type SendVerificationEmailOptions = {
  /**
   * When false, failures are logged only (e.g. post-OTP welcome mail should not
   * roll back a successful verification).
   * @default true
   */
  throwOnFailure?: boolean;
};

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
      'Email is not configured: set DAYFI_SMTP_USER and DAYFI_SMTP_PASS (see .env.example).'
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

export async function sendVerificationEmail(
  userEmail: string,
  subject: string,
  text: string,
  html: string,
  options?: SendVerificationEmailOptions
) {
  const throwOnFailure = options?.throwOnFailure !== false;
  const { from } = smtpSettings();

  try {
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from,
      to: userEmail,
      subject,
      text,
      html,
    });
    console.log('Email sent: ' + info.messageId);
  } catch (error) {
    console.error('Error sending email:', error);
    if (throwOnFailure) {
      throw error;
    }
  }
}

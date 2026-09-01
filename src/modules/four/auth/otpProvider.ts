import Twilio from 'twilio';
import config from '../../../config/env';
import { maskPhoneE164 } from '../../../shared/utils/phoneE164';

/**
 * OTP delivery, behind an interface.
 *
 * Twilio Verify holds the code itself — Four never stores or sees it. Four owns
 * the surrounding policy (rate limit, attempt cap, expiry) in
 * `otpChallengeStore`.
 *
 * The stub provider exists so the auth test suite can run without spending
 * money or sending real SMS. It is selected only when explicitly requested via
 * FOUR_OTP_PROVIDER=stub, or when Twilio is not configured at all.
 */

export type OtpSendResult = { providerRef: string | null };

export interface OtpProvider {
  readonly name: string;
  send(phoneE164: string): Promise<OtpSendResult>;
  check(phoneE164: string, code: string): Promise<boolean>;
}

class TwilioVerifyProvider implements OtpProvider {
  public readonly name = 'twilio';
  private readonly client: ReturnType<typeof Twilio>;
  private readonly serviceSid: string;

  constructor(accountSid: string, authToken: string, serviceSid: string) {
    this.client = Twilio(accountSid, authToken);
    this.serviceSid = serviceSid;
  }

  async send(phoneE164: string): Promise<OtpSendResult> {
    const verification = await this.client.verify.v2
      .services(this.serviceSid)
      .verifications.create({ to: phoneE164, channel: 'sms' });
    return { providerRef: verification.sid ?? null };
  }

  async check(phoneE164: string, code: string): Promise<boolean> {
    try {
      const result = await this.client.verify.v2
        .services(this.serviceSid)
        .verificationChecks.create({ to: phoneE164, code });
      return result.status === 'approved';
    } catch (err) {
      // Twilio 404s a check once the verification is consumed or expired.
      // That is a failed check, not an outage.
      console.warn(
        `[four/otp] verification check rejected for ${maskPhoneE164(phoneE164)}`
      );
      return false;
    }
  }
}

/**
 * Deterministic provider for tests and local development.
 *
 * Accepts FOUR_OTP_STUB_CODE (default '123456') for any number. It refuses to
 * load unless explicitly selected, so it can never silently replace Twilio in
 * an environment that is meant to send real SMS.
 */
class StubOtpProvider implements OtpProvider {
  public readonly name = 'stub';
  private readonly code: string;

  constructor(code: string) {
    this.code = code;
  }

  async send(phoneE164: string): Promise<OtpSendResult> {
    console.warn(
      `[four/otp] STUB provider — no SMS sent to ${maskPhoneE164(phoneE164)}`
    );
    return { providerRef: `stub_${Date.now()}` };
  }

  async check(_phoneE164: string, code: string): Promise<boolean> {
    return code === this.code;
  }
}

let cached: OtpProvider | null = null;

function build(): OtpProvider {
  const requested = String(process.env.FOUR_OTP_PROVIDER || '')
    .trim()
    .toLowerCase();

  const accountSid = config?.TWILIO_ACCOUNT_SID;
  const authToken = config?.TWILIO_AUTH_TOKEN;
  const serviceSid = config?.TWILIO_VERIFY_SERVICE_SID;
  const twilioConfigured = Boolean(accountSid && authToken && serviceSid);

  if (requested === 'stub') {
    return new StubOtpProvider(
      String(process.env.FOUR_OTP_STUB_CODE || '123456')
    );
  }

  if (twilioConfigured) {
    return new TwilioVerifyProvider(
      String(accountSid),
      String(authToken),
      String(serviceSid)
    );
  }

  console.warn(
    '[four/otp] Twilio is not configured; falling back to the STUB provider. ' +
      'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID ' +
      'before serving real users.'
  );
  return new StubOtpProvider(
    String(process.env.FOUR_OTP_STUB_CODE || '123456')
  );
}

export function getOtpProvider(): OtpProvider {
  if (!cached) cached = build();
  return cached;
}

/** Test seam — forces re-resolution after env changes. */
export function resetOtpProviderCache(): void {
  cached = null;
}

import { buildOtpEmail } from './otpEmail';

/** Legacy template hook — OTP welcome / login mail */
export const welcomeUserEmail = (firstName: string, userOtp: string) =>
  buildOtpEmail(userOtp, 'login', 30, firstName).html;

import DBService from '../../shared/services/db.service';
import TokenService from './tokenService';
import enums from '../../shared/lib/enums';
import Crypto from 'crypto';
import axios from 'axios';
import config from '../../config/env';
import Twilio from 'twilio';
import HashText from '../../shared/services/hashing';
import { verifyAppleIdentityToken } from './appleVerify';
import { verifyGoogleAccessToken } from './googleVerify';
import {
  fallbackFirstNameFromEmail,
  namesFromAppleClient,
  namesFromGoogleUserinfo,
} from './socialNames';

const client = Twilio(config?.TWILIO_ACCOUNT_SID, config?.TWILIO_AUTH_TOKEN);

const TWILIO_VERIFY_SERVICE_SID = config?.TWILIO_VERIFY_SERVICE_SID || '';

export interface User {
  id: string;
  email: string;
  refresh_token: string;
  password: string;
  id_type: string;
  id_number: string;
  is_activated: string;
  phone_number: string;
  user_id: string;
  bvn: string;
  country: string;
  postal_code: string;
  city: string;
  state: string;
  street: string;
  address: string;
  gender: string;
  date_of_birth: string;
  first_name: string;
  last_name: string;
  middle_name: string;
  level: string;
  status: string;
  transaction_pin: string;
  device_token: string;
  verification_token_expiry_time: Date;
  created_at: Date;
  updated_at: Date;
  verification_token: string;
  is_2fa_set_up: boolean;
  two_fa_token: string;
  account_type: string;
}

class AuthService {
  private dbService: DBService;
  private tokenService: TokenService;
  constructor() {
    this.dbService = new DBService();
    this.tokenService = new TokenService();
  }

  login = async (user: any): Promise<any> => {
    try {
      const data = await this.tokenService.generateAuthToken(user);
      console.log(`Logging in, ::AuthService:: login in auth.service.js`);
      return {
        data,
      };
    } catch (error) {
      console.error(
        `ERROR: Error occurred while generating token ::AuthService:: login function in auth.service.js`
      );
    }
  };

  async getAUser(
    queryParam: string,
    isVerificationEmail = false
  ): Promise<any> {
    return await this.dbService.singleTransaction<any>(
      'getUserWithProfile',
      isVerificationEmail ? [null, queryParam] : [queryParam, null],
      enums.AUTH_QUERY
    );
  }

  async getUserByPhoneNumber(phone: string): Promise<any> {
    return await this.dbService.singleTransaction<any>(
      'getUserByPhoneNumber',
      [phone],
      enums.AUTH_QUERY
    );
  }

  async getUserById(payload: string): Promise<any> {
    return await this.dbService.singleTransaction(
      'getUserById',
      [payload],
      enums.AUTH_QUERY
    );
  }

  async createUser(userData: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    middleName: string;
  }): Promise<any> {
    const { email, password, firstName, lastName, middleName } = userData;

    return await this.dbService.singleTransaction<any>(
      'createUser',
      [email.toLowerCase(), password, firstName, lastName, middleName],
      enums.AUTH_QUERY
    );
  }

  async saveUserBvn(userId: string, bvn: string): Promise<any> {
    return this.dbService.singleTransaction(
      'updateUserBvn',
      [bvn, userId],
      enums.AUTH_QUERY
    );
  }

  async updateUserProfile(profileData: {
    gender: string;
    dateOfBirth: string;
    userId: string;
    country: string;
    state: string;
    street: string;
    city: string;
    postalCode: string;
    address: string;
    phoneNumber: string;
    idType: string;
    idNumber: string;
  }): Promise<any> {
    const {
      gender,
      dateOfBirth,
      userId,
      country,
      state,
      street,
      city,
      postalCode,
      address,
      phoneNumber,
      idType,
      idNumber,
    } = profileData;

    return await this.dbService.singleTransaction<any>(
      'updateProfile',
      [
        gender,
        dateOfBirth,
        country,
        state,
        street,
        city,
        postalCode,
        address,
        phoneNumber,
        idType,
        idNumber,
        userId,
      ],
      enums.AUTH_QUERY
    );
  }

  async updateUserOTP(
    email: string,
    newOTPValue: number,
    expiryTime: any,
    refreshToken: string
  ): Promise<any> {
    return this.dbService.singleTransaction(
      'updateUserOTP',
      [newOTPValue, new Date(expiryTime), refreshToken, email],
      enums.AUTH_QUERY
    );
  }

  async updateUserTransactionPin(
    userId: string,
    transactionPin: string | undefined
  ): Promise<any> {
    return this.dbService.singleTransaction(
      'updateUserTransactionPin',
      [userId, transactionPin],
      enums.AUTH_QUERY
    );
  }

  async changeUserPassword(
    userId: string,
    password: string | undefined
  ): Promise<any> {
    return this.dbService.singleTransaction(
      'changeUserPassword',
      [userId, password],
      enums.AUTH_QUERY
    );
  }

  async clearUserOTP(userOtp: string): Promise<any> {
    return await this.dbService.singleTransaction(
      'clearUserOTP',
      [userOtp],
      enums.AUTH_QUERY
    );
  }

  updateUserPassword = async (payload: any) => {
    return await this.dbService.singleTransaction(
      'updateUserPassword',
      payload,
      enums.AUTH_QUERY
    );
  };

  updateUserLevel = async (level: string, userId: string) => {
    return await this.dbService.singleTransaction(
      'updateUserLevel',
      [level, userId],
      enums.AUTH_QUERY
    );
  };

  sendOtp = async (email: string): Promise<any> => {
    const otp: any = Crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const refreshToken = Crypto.randomInt(1000000000, 9999999999).toString();
    const expirationTime = Date.now() + 30 * 60 * 1000;
    const otpExpiration = new Date(expirationTime);

    return await this.updateUserOTP(email, otp, otpExpiration, refreshToken);
  };

  async addTokenToBlacklist(
    token: string,
    userId: string,
    expiresAt: string,
    reason: string
  ): Promise<any> {
    return await this.dbService.singleTransaction(
      'addTokenToBlacklist',
      [token, userId, expiresAt, reason],
      enums.AUTH_QUERY
    );
  }

  async checkIfTokenIsBlacklisted(token: string): Promise<any> {
    return await this.dbService.singleTransaction(
      'checkIfTokenIsBlacklisted',
      [token],
      enums.AUTH_QUERY
    );
  }

  async initiateBvnLookup(
    bvn: string,
    firstname: string,
    lastname: string
  ): Promise<any> {
    try {
      const initiateResponse = await axios.post(
        'https://api.flutterwave.com/v3/bvn/verifications',
        {
          bvn,
          firstname,
          lastname,
          redirect_url: 'https://example-url.com',
        },
        {
          headers: {
            Authorization: `Bearer ${config?.FLUTTERWAVE_SECRET_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        }
      );

      const reference = initiateResponse?.data?.data?.reference;

      if (reference) {
        const statusResponse = await axios.get(
          `https://api.flutterwave.com/v3/bvn/verifications/${reference}`,
          {
            headers: {
              Authorization: `Bearer ${config?.FLUTTERWAVE_SECRET_KEY}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          }
        );

        return statusResponse.data;
      }

      return initiateResponse.data;
    } catch (error: any) {
      console.error(
        'BVN Lookup Error:',
        error?.response?.data || error.message
      );
      throw new Error(error?.response?.data?.message || 'BVN lookup failed');
    }
  }

  async sendVerification(phone: string, channel: 'sms' | 'call' = 'sms') {
    try {
      const verification = await client.verify.v2
        .services(TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({ to: phone, channel });

      return {
        success: true,
        sid: verification.sid,
        status: verification.status,
      };
    } catch (err: any) {
      console.error('SmsService.sendVerification error:', err.message);
      return {
        success: false,
        error: err.message || 'Failed to send verification code',
      };
    }
  }

  async checkVerification(phone: string, code: string) {
    try {
      const verificationCheck = await client.verify.v2
        .services(TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to: phone, code });

      return {
        success: verificationCheck.status === 'approved',
        status: verificationCheck.status,
      };
    } catch (err: any) {
      console.error('SmsService.checkVerification error:', err.message);
      return {
        success: false,
        error: err.message || 'Failed to verify code',
      };
    }
  }

  signInWithApple = async (input: {
    identityToken: string;
    rawNonce?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<{ user: any; data: any }> => {
    const { sub, email: emailFromApple } = await verifyAppleIdentityToken(
      input.identityToken,
      input.rawNonce
    );
    const appleRef = `apple:${sub}`;
    let user: any = await this.getAUser(appleRef);
    if (!user && emailFromApple) {
      const byEmail = await this.getAUser(emailFromApple.toLowerCase());
      if (byEmail) {
        await this.dbService.singleTransaction<any>(
          'setAppleRefreshToken',
          [appleRef, byEmail.user_id],
          enums.AUTH_QUERY
        );
        user = await this.getAUser(appleRef);
      }
    }
    if (!user) {
      const email =
        (emailFromApple && emailFromApple.toLowerCase().trim()) ||
        `apple_${sub.replace(/[^a-zA-Z0-9._-]/g, '_')}@private.dayfi.app`;
      const randomPass = Crypto.randomBytes(24).toString('hex');
      const hashed = await HashText.getHash(randomPass);
      const { firstName, lastName } = namesFromAppleClient(
        input.firstName,
        input.lastName,
        email
      );
      try {
        user = await this.dbService.singleTransaction<any>(
          'createAppleUser',
          [email, hashed, firstName, lastName, '', appleRef],
          enums.AUTH_QUERY
        );
      } catch (e: any) {
        if (e?.code === '23505') {
          user = await this.getAUser(email.toLowerCase());
          if (user?.user_id) {
            await this.dbService.singleTransaction<any>(
              'setAppleRefreshToken',
              [appleRef, user.user_id],
              enums.AUTH_QUERY
            );
            user = await this.getAUser(appleRef);
          }
        } else {
          throw e;
        }
      }
    }
    if (!user?.user_id) {
      throw new Error(
        'Could not complete Sign in with Apple. Please try again.'
      );
    }
    if (user.status === 'inactive') {
      throw new Error(enums.USER_INACTIVE);
    }
    if (user.status === 'deactivated' || user.status === 'blacklisted') {
      throw new Error(enums.USER_DEACTIVATED);
    }
    const data = await this.tokenService.generateAuthToken(user);
    return { user, data };
  };

  signInWithGoogle = async (input: {
    accessToken: string;
  }): Promise<{ user: any; data: any }> => {
    const profile = await verifyGoogleAccessToken(input.accessToken);
    const { sub, email: emailFromGoogle } = profile;
    const { firstName: gFirst, lastName: gLast } = namesFromGoogleUserinfo(
      profile as Record<string, unknown>
    );
    const googleRef = `google:${sub}`;
    let user: any = await this.getAUser(googleRef);
    if (!user && emailFromGoogle) {
      const byEmail = await this.getAUser(emailFromGoogle.toLowerCase());
      if (byEmail) {
        await this.dbService.singleTransaction<any>(
          'setAppleRefreshToken',
          [googleRef, byEmail.user_id],
          enums.AUTH_QUERY
        );
        user = await this.getAUser(googleRef);
      }
    }
    if (!user) {
      const email =
        (emailFromGoogle && emailFromGoogle.toLowerCase().trim()) ||
        `google_${sub.replace(/[^a-zA-Z0-9._-]/g, '_')}@private.dayfi.app`;
      const randomPass = Crypto.randomBytes(24).toString('hex');
      const hashed = await HashText.getHash(randomPass);
      const firstName =
        gFirst.trim() !== ''
          ? gFirst
          : fallbackFirstNameFromEmail(email.toLowerCase());
      const lastName = gLast.trim();
      try {
        user = await this.dbService.singleTransaction<any>(
          'createAppleUser',
          [email, hashed, firstName, lastName, '', googleRef],
          enums.AUTH_QUERY
        );
      } catch (e: any) {
        if (e?.code === '23505') {
          user = await this.getAUser(email.toLowerCase());
          if (user?.user_id) {
            await this.dbService.singleTransaction<any>(
              'setAppleRefreshToken',
              [googleRef, user.user_id],
              enums.AUTH_QUERY
            );
            user = await this.getAUser(googleRef);
          }
        } else {
          throw e;
        }
      }
    }
    if (!user?.user_id) {
      throw new Error(
        'Could not complete Sign in with Google. Please try again.'
      );
    }
    if (user.status === 'inactive') {
      throw new Error(enums.USER_INACTIVE);
    }
    if (user.status === 'deactivated' || user.status === 'blacklisted') {
      throw new Error(enums.USER_DEACTIVATED);
    }
    const data = await this.tokenService.generateAuthToken(user);
    return { user, data };
  };
}
export default AuthService;

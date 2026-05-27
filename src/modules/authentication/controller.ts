import { NextFunction, Request, Response } from 'express';
import enums from '../../shared/lib/enums';
import AuthService from './services';
import PaymentService from '../payment/services';
import { success, errorResponse } from '../../shared/lib/api-response';
import HashText from '../../shared/services/hashing';
import Helper from '../../shared/utils/helper';
import { sendVerificationEmail } from '../../config/email';
import { bootstrapWalletsOnAuth } from '../payment/authWalletBootstrap';

class AuthController {
  private readonly authService: AuthService;
  private readonly paymentService: PaymentService;

  constructor() {
    this.authService = new AuthService();
    this.paymentService = new PaymentService();
  }

  login = async (req: Request, res: Response): Promise<any> => {
    try {
      const { user } = req;
      console.log(
        'Attempting to login user. :::AuthController::login in auth.controller.js'
      );
      const { data } = await this.authService.login(user);
      let userData;
      if (user) {
        bootstrapWalletsOnAuth(user.user_id);
        userData = {
          ...user,
          token: data.token,
          expires: data.expires,
        };
      }
      console.log(
        `Info: ${enums.SENT_SUCCESSFULLY(
          'OTP'
        )}. :::AuthController::login in auth.controller.js`
      );
      return success(res, enums.LOGIN_SUCCESSFUL, enums.HTTP_OK, userData);
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  appleAuth = async (req: Request, res: Response): Promise<any> => {
    try {
      const body = (req as any).validatedBody ?? req.body;
      const authToken = String(body.authToken ?? '');
      const nonce =
        body.nonce != null && String(body.nonce).length > 0
          ? String(body.nonce)
          : undefined;
      const firstName =
        body.firstName != null && String(body.firstName).trim() !== ''
          ? String(body.firstName).trim()
          : undefined;
      const lastName =
        body.lastName != null && String(body.lastName).trim() !== ''
          ? String(body.lastName).trim()
          : undefined;
      const { user, data } = await this.authService.signInWithApple({
        identityToken: authToken,
        rawNonce: nonce,
        firstName,
        lastName,
      });
      const { password: _pw, ...safeUser } = user;
      bootstrapWalletsOnAuth(user.user_id);
      const userData = {
        ...safeUser,
        token: data.token,
        expires: data.expires,
      };
      return success(res, enums.LOGIN_SUCCESSFUL, enums.HTTP_OK, userData);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const lower = msg.toLowerCase();
      if (
        lower.includes('jwt') ||
        lower.includes('token') ||
        lower.includes('nonce') ||
        lower.includes('apple') ||
        lower.includes('expired') ||
        lower.includes('signature')
      ) {
        return errorResponse(res, msg, enums.HTTP_UNAUTHORIZED);
      }
      if (
        msg === enums.USER_INACTIVE ||
        msg === enums.USER_DEACTIVATED
      ) {
        return errorResponse(res, msg, enums.HTTP_UNAUTHORIZED);
      }
      return errorResponse(res, msg, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  googleAuth = async (req: Request, res: Response): Promise<any> => {
    try {
      const body = (req as any).validatedBody ?? req.body;
      const authToken = String(body.authToken ?? '');
      const { user, data } = await this.authService.signInWithGoogle({
        accessToken: authToken,
      });
      const { password: _pw, ...safeUser } = user;
      bootstrapWalletsOnAuth(user.user_id);
      const userData = {
        ...safeUser,
        token: data.token,
        expires: data.expires,
      };
      return success(res, enums.LOGIN_SUCCESSFUL, enums.HTTP_OK, userData);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const lower = msg.toLowerCase();
      if (
        lower.includes('token') ||
        lower.includes('google') ||
        lower.includes('invalid') ||
        lower.includes('expired') ||
        lower.includes('unauthorized') ||
        lower.includes('forbidden')
      ) {
        return errorResponse(res, msg, enums.HTTP_UNAUTHORIZED);
      }
      if (
        msg === enums.USER_INACTIVE ||
        msg === enums.USER_DEACTIVATED
      ) {
        return errorResponse(res, msg, enums.HTTP_UNAUTHORIZED);
      }
      return errorResponse(res, msg, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  validateEmail = async (req: Request, res: Response): Promise<any> => {
    try {
      const email = String(req.body.email).toLowerCase();
      // Message wording is matched by the mobile app (check for "does not exist").
      return success(
        res,
        'This email does not exist in our system. You can create an account.',
        enums.HTTP_OK,
        {
          available: true,
          email,
        }
      );
    } catch (err: any) {
      return errorResponse(
        res,
        err.message,
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  createUser = async (req: Request, res: Response): Promise<any> => {
    try {
      const userData = req.body;
      const { hashed } = req;

      userData.password = hashed;

      const newUser = await this.authService.createUser(userData);

      const otp = await this.authService.sendOtp(newUser?.email);
      await sendVerificationEmail(
        newUser?.email.toLowerCase(),
        'Signup Successful',
        'Hello,\n\nYour registration was successful! Welcome to Dayfi.\n\nBest,\nDayfi Team',
        `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <p>Hello,</p>
      <p>Your registration was successful! Welcome to <strong>Dayfi</strong>.</p>
      <p><strong>Your OTP is:</strong> ${otp.verification_token}</p>
      <p>Best regards,<br>Dayfi Team</p>
    </div>
  `
      );

      return success(res, enums.CREATED_SUCCESSFULLY('User'), enums.HTTP_OK, {
        ...newUser,
        ...otp,
      });
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  updateUserProfile = async (req: Request, res: Response): Promise<any> => {
    try {
      const { body: profileData } = req;
      const user = req.user;
      const snakeUserData = await Helper.snakeToCamelCase(user);

      const updatedProfileData = {
        ...snakeUserData,
        ...profileData,
      };

      await this.authService.updateUserProfile(updatedProfileData);
      if (profileData.dateOfBirth || profileData.gender) {
        await this.authService.updateUserLevel('level-1', user?.user_id);
      }

      if (profileData.idType || profileData.idNumber) {
        await this.authService.updateUserLevel('level-2', user?.user_id);
        await this.tryProvisionNgnVirtualAccount(user?.user_id);
      }

      const walletList = await this.paymentService.getWalletsByUserId(
        user?.user_id
      );
      if (!walletList?.length) {
        await this.paymentService.ensurePrimaryWallet(user?.user_id);
      }

      const profile = await this.authService.getUserById(user?.user_id);

      console.log('User profile updated successfully.');
      return success(
        res,
        enums.UPDATED_SUCCESSFULLY('User Profile'),
        enums.HTTP_OK,
        profile
      );
    } catch (err) {
      console.error(`Error while updating user profile: ${err.message}`);
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  private tryProvisionNgnVirtualAccount = async (
    userId: string | undefined
  ): Promise<void> => {
    if (!userId) return;
    try {
      const profile = await this.authService.getUserById(userId);
      const bvn = String(profile?.bvn ?? '').trim();
      const email = String(profile?.email ?? '').trim();
      if (!bvn || !email) return;
      await this.paymentService.ensureNgnVirtualAccount(userId, email, bvn);
    } catch (err: unknown) {
      console.warn(
        `[tryProvisionNgnVirtualAccount] skipped: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  verifyUserPhone = async (req: Request, res: Response): Promise<any> => {
    try {
      const { phoneNumber, code } = req.body;
      const user = req.user;

      if (!phoneNumber || !code) {
        return errorResponse(
          res,
          'Phone number and OTP code are required.',
          enums.HTTP_BAD_REQUEST
        );
      }

      const verification = await this.authService.checkVerification(
        phoneNumber,
        code
      );

      if (!verification.success) {
        return errorResponse(
          res,
          'Invalid or expired OTP.',
          enums.HTTP_BAD_REQUEST
        );
      }

      await this.authService.updateUserLevel('level-1', user?.user_id);

      await this.paymentService.ensurePrimaryWallet(user?.user_id);

      const profile = await this.authService.getUserById(user?.user_id);

      return success(
        res,
        'Phone number verified successfully. Level 1 activated; USD and NGN wallets ready.',
        enums.HTTP_OK,
        profile
      );
    } catch (err: any) {
      console.error(`Error while verifying user phone: ${err.message}`);
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  updateTransactionPin = async (req: Request, res: Response): Promise<any> => {
    try {
      const { body: profileData } = req;
      const user = req.user;
      const { hashed } = req;
      const verifyHash = await HashText.verifyHash(
        profileData.transactionPin,
        String(user?.transaction_pin)
      );

      if (verifyHash) {
        console.log(
          `Transaction pin is the same for user. AuthController::updateUserProfile in auth.middleware.js`
        );
        return errorResponse(res, enums.PIN_EXIST, enums.HTTP_BAD_REQUEST);
      }

      const profile = await this.authService.updateUserTransactionPin(
        user?.user_id,
        hashed
      );

      console.log('User profile updated successfully.');
      return success(
        res,
        enums.UPDATED_SUCCESSFULLY('Transaction pin'),
        enums.HTTP_OK,
        profile
      );
    } catch (err) {
      console.error(`Error while updating user profile: ${err.message}`);
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  changePassword = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const {
        user,
        hashed,
        body: { oldPassword, password },
      } = req;
      console.log(user?.user_id);

      if (user?.password) {
        const isOldPasswordCorrect = await HashText.verifyHash(
          oldPassword,
          user.password
        );

        if (!isOldPasswordCorrect) {
          return errorResponse(
            res,
            'Old password is incorrect',
            enums.HTTP_UNAUTHORIZED
          );
        }

        const isNewSameAsOld = await HashText.verifyHash(
          password,
          user.password
        );

        if (isNewSameAsOld) {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Info: User is trying to reuse the current password`
          );
          return errorResponse(
            res,
            enums.ALREADY_IN_USE('Password'),
            enums.HTTP_BAD_REQUEST
          );
        }
      }

      await this.authService.changeUserPassword(user?.user_id, hashed);

      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: Password changed successfully`
      );
      return success(res, enums.PASSWORD_RESET_SUCCESSFULLY, enums.HTTP_OK, {});
    } catch (err: any) {
      console.error(
        `Reset password failed ::${enums.RESET_PASSWORD_CONTROLLER}`
      );
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
      return next();
    }
  };

  changeTransactionPin = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const {
        user,
        hashed,
        body: { oldTransactionPin, transactionPin },
      } = req;

      if (user?.transaction_pin) {
        const isOldPinCorrect = await HashText.verifyHash(
          oldTransactionPin,
          user.transaction_pin
        );

        if (!isOldPinCorrect) {
          return errorResponse(
            res,
            'Old transaction PIN is incorrect',
            enums.HTTP_UNAUTHORIZED
          );
        }

        const isSameAsOld = await HashText.verifyHash(
          transactionPin,
          user.transaction_pin
        );

        if (isSameAsOld) {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Info: User is trying to reuse the current transaction PIN`
          );
          return errorResponse(
            res,
            enums.ALREADY_IN_USE('Transaction PIN'),
            enums.HTTP_BAD_REQUEST
          );
        }
      }

      await this.authService.updateUserTransactionPin(user?.user_id, hashed);

      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: Transaction PIN changed successfully`
      );
      return success(
        res,
        'Transaction PIN changed successfully',
        enums.HTTP_OK,
        {}
      );
    } catch (err: any) {
      console.error(
        `Transaction PIN change failed ::${enums.RESET_PASSWORD_CONTROLLER}`
      );
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
      return next();
    }
  };

  resendOtp = async (req: Request, res: Response): Promise<any> => {
    try {
      const {
        body: { email },
      } = req;

      console.log(
        'Resending OTP to  user. :::AuthController::resend in auth.controller.js'
      );

      const user = await this.authService.sendOtp(email);

      console.log(
        `Info: ${enums.SENT_SUCCESSFULLY(
          'OTP'
        )}. :::AuthController::resendOtp in auth.controller.js`
      );

      return success(res, enums.SENT_SUCCESSFULLY('OTP'), enums.HTTP_OK, user);
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  verifyBvn = async (req: Request, res: Response): Promise<any> => {
    try {
      const {
        body: { bvn },
        user,
      } = req;

      if (!user?.user_id) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }

      const result = await this.authService.initiateBvnLookup(
        bvn,
        user.first_name,
        user.last_name
      );

      await this.authService.saveUserBvn(user.user_id, String(bvn).trim());
      await this.tryProvisionNgnVirtualAccount(user.user_id);

      const message = result.verificationSkipped
        ? 'BVN saved successfully'
        : 'BVN verified successfully';

      console.log(`Info: ${message}. :::AuthController::verifyBvn`);

      return success(res, message, enums.HTTP_OK, {
        verified: result.verified,
        verificationSkipped: result.verificationSkipped ?? false,
        flutterwave: result.data ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status =
        msg.includes('11 digits') || msg.toLowerCase().includes('bvn')
          ? enums.HTTP_BAD_REQUEST
          : enums.HTTP_INTERNAL_SERVER_ERROR;
      return errorResponse(res, msg, status);
    }
  };

  verifyOtp = async (req: Request, res: Response): Promise<any> => {
    const { body }: any = req;

    try {
      console.log(
        'Verifying OTP, :::AuthController:: verifying OTP in auth.controller.js'
      );

      const data = await this.authService.clearUserOTP(body.userOtp);

      const userData = {
        phone_number: data?.phone_number,
        user_id: data.user_id,
        email: data.email,
        first_name: data.first_name,
        last_name: data.last_name,
        status: data.status,
        refreshToken: data.refresh_token,
        created_at: data.created_at,
        updated_at: data.updated_at,
      };

      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: OTP verified successfully auth.controller.js`
      );
      if (body.type === 'email') {
        await sendVerificationEmail(
          data.email.toLowerCase(),
          'Verification Successful',
          'Hello,\n\nYour verification was successful! Welcome to Dayfi.\n\nBest,\nDayfi Team',
          `<p>Hello,</p><p>Your verification was successful! Welcome to Dayfi.</p><p>Best,<br>Dayfi Team</p>`,
          { throwOnFailure: false }
        );
      }

      bootstrapWalletsOnAuth(data.user_id);

      return success(
        res,
        enums.OTP_VERIFIED_SUCCESSFULLY,
        enums.HTTP_OK,
        userData
      );
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  forgotPassword = async (req: Request, res: Response): Promise<any> => {
    const { user } = req;
    const email = user?.email;
    try {
      const data: any = await this.authService.sendOtp(
        String(email?.toLowerCase())
      );

      const userData = {
        phone_number: user?.phone_number,
        user_id: user?.user_id,
        email: user?.email,
        first_name: user?.first_name,
        last_name: user?.last_name,
        status: user?.status,
        created_at: user?.created_at,
        updated_at: user?.updated_at,
        otp: data.verification_token,
      };

      await sendVerificationEmail(
        email.toLowerCase(),
        'Reset password initiation Successful',
        'Hello,\n\nYour reset password initiation was successful.\n\nBest,\nDayfi Team',
        `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <p>Hello,</p>
      <p>Your Reset password initiation was successful!</p>
      <p><strong>Your OTP is:</strong> ${userData.otp}</p>
      <p>Best regards,<br>Dayfi Team</p>
    </div>
  `
      );
      return success(
        res,
        enums.SENT_SUCCESSFULLY('OTP'),
        enums.HTTP_OK,
        userData
      );
    } catch (err) {
      console.error(
        'Error: Error while sending email to user in auth.controller.js'
      );
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  resetTransactionPin = async (req: Request, res: Response): Promise<any> => {
    const { user } = req;
    const email = user?.email;
    try {
      const data: any = await this.authService.sendOtp(
        String(email?.toLowerCase())
      );

      const userData = {
        phone_number: user?.phone_number,
        user_id: user?.user_id,
        email: user?.email,
        first_name: user?.first_name,
        last_name: user?.last_name,
        status: user?.status,
        created_at: user?.created_at,
        updated_at: user?.updated_at,
        otp: data.verification_token,
      };

      await sendVerificationEmail(
        email.toLowerCase(),
        'Reset transaction pin Successful',
        'Hello,\n\nYour reset transaction pin initiation was successful.\n\nBest,\nDayfi Team',
        `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <p>Hello,</p>
      <p>Your Reset transaction pin initiation was successful!</p>
      <p><strong>Your OTP is:</strong> ${userData.otp}</p>
      <p>Best regards,<br>Dayfi Team</p>
    </div>
  `
      );
      return success(
        res,
        enums.SENT_SUCCESSFULLY('OTP'),
        enums.HTTP_OK,
        userData
      );
    } catch (err) {
      console.error(
        'Error: Error while sending email to user in auth.controller.js'
      );
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };

  resetPassword = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const {
        user,
        hashed,
        body: { password },
      } = req;
      if (user?.password) {
        const isPasswordMatch = await HashText.verifyHash(
          password,
          user.password
        );
        if (isPasswordMatch) {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Info: confirms that user is trying to use same password as current one auth.controller.js`
          );
          return errorResponse(
            res,
            enums.ALREADY_IN_USE('Password'),
            enums.HTTP_BAD_REQUEST
          );
        }
      }

      await this.authService.updateUserPassword([hashed, user?.user_id]);
      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: Password reset successfully`
      );
      return success(res, enums.PASSWORD_RESET_SUCCESSFULLY, enums.HTTP_OK, {});
    } catch (err) {
      console.error(
        `Reset password failed ::${enums.RESET_PASSWORD_CONTROLLER}`
      );
      errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
      return next();
    }
  };

  addTokenToBlacklist = async (req: Request, res: Response): Promise<any> => {
    try {
      const {
        body: { token },
      } = req;
      const decoded: any = HashText.decodeToken(token);
      const expiresAt = decoded.exp
        ? new Date(decoded.exp * 1000).toISOString()
        : new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const existingBlacklistedToken =
        await this.authService.checkIfTokenIsBlacklisted(token);
      const userId = decoded.data ? decoded?.data?.user_id : decoded?.user_id;
      if (existingBlacklistedToken) {
        return errorResponse(res, 'Invalid token', enums.HTTP_UNAUTHORIZED);
      }
      console.log(
        'Adding token to blacklist. :::AuthController::addTokenToBlacklist in auth.controller.js'
      );

      const blacklistedToken = await this.authService.addTokenToBlacklist(
        token,
        userId,
        expiresAt,
        'logout'
      );

      console.log(
        `Info: Token blacklisted successfully. :::AuthController::addTokenToBlacklist in auth.controller.js`
      );

      return success(res, 'Logout successful', enums.HTTP_OK, blacklistedToken);
    } catch (err) {
      return errorResponse(res, err.message, enums.HTTP_INTERNAL_SERVER_ERROR);
    }
  };
}

export const authController = new AuthController();

import express from 'express';
import { authController } from './controller';
import { authMiddleware } from './middleware';
import { authValidator } from './validator';

const Router = express.Router();

Router.post(
  '/validate-email',
  authValidator.validateEmailValidator,
  authMiddleware.getUser('validate'),
  authController.validateEmail
);

Router.post(
  '/apple-auth',
  authValidator.appleAuthValidator,
  authController.appleAuth
);

Router.post(
  '/google-auth',
  authValidator.googleAuthValidator,
  authController.googleAuth
);

Router.post(
  '/signup',
  authValidator.createUserValidator,
  authMiddleware.getUser('validate'),
  authMiddleware.hashData,
  authController.createUser
);

Router.patch(
  '/update-profile/:user_id',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  authValidator.updateUserProfileValidator,
  authMiddleware.checkUserPhoneNumber,
  authMiddleware.getUser('authenticate'),
  authMiddleware.getUser('login'),
  authMiddleware.hashData,
  authController.updateUserProfile
);

Router.post(
  '/verify-sms-otp',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  authValidator.verifyUserPhoneValidator,
  authController.verifyUserPhone
);

Router.post(
  '/reset-transaction-pin',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  authController.resetTransactionPin
);

Router.patch(
  '/update-transaction-pin',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  authValidator.updateTransactionPinValidator,
  authMiddleware.hashData,
  authController.updateTransactionPin
);

Router.patch(
  '/change-transaction-pin',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  authValidator.changeTransactionPinValidator,
  authMiddleware.hashData,
  authController.changeTransactionPin
);

Router.patch(
  '/change-password',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  authValidator.changePasswordValidator,
  authMiddleware.hashData,
  authController.changePassword
);

Router.post(
  '/login',
  authValidator.loginValidator,
  authMiddleware.getUser('authenticate'),
  authMiddleware.getUser('login'),
  authMiddleware.validatePassword,
  authController.login
);

Router.post(
  '/resend-otp',
  authValidator.resendOtpValidator,
  authMiddleware.getUser('authenticate'),
  authController.resendOtp
);

Router.post(
  '/verify-bvn',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  authValidator.verifyBvnValidator,
  authController.verifyBvn
);

Router.post(
  '/verify-otp',
  authValidator.verifyOtpValidator,
  authMiddleware.getUser('verify'),
  authMiddleware.checkExpiry,
  authController.verifyOtp
);

Router.post(
  '/forgot-password',
  authValidator.forgotPasswordValidator,
  authMiddleware.getUser('authenticate'),
  authController.forgotPassword
);

Router.patch(
  '/reset-password',
  authValidator.createPasswordValidator,
  authMiddleware.getUser('authenticate'),
  authMiddleware.hashData,
  authController.resetPassword
);

// Router.post(
//   '/logout',
//   authValidator.logoutValidator,
//   authController.addTokenToBlacklist
// );

export const authRouter = Router;

import enums from '../../shared/lib/enums';
import { errorResponse } from '../../shared/lib/api-response';
import AuthService from './services';
import HashText from '../../shared/services/hashing';
import { NextFunction, Request, Response } from 'express';

class AuthMiddleware {
  private authService: AuthService;

  constructor() {
    this.authService = new AuthService();
  }

  hashData = async (
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const {
        body: { password, transactionPin },
      } = req;
      const payload = password?.trim() || transactionPin?.trim();
      let hash;
      if (payload) {
        hash = await HashText.getHash(payload);
      }

      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: successfully hashed user data auth.middleware.js`
      );

      req.hashed = hash;
      return next();
    } catch (error) {
      console.error(`hashing user data failed:::${enums.HASH_DATA_MIDDLEWARE}`);
      return next(error);
    }
  };

  checkExpiry = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user } = req;
      const current_time = new Date().toISOString();
      if (
        user?.verification_token_expiry_time.toISOString() &&
        user?.verification_token_expiry_time.toISOString() <= current_time
      ) {
        console.log(
          'OTP has expired, :::AuthController:: checkExpiry in auth.service.js'
        );
        errorResponse(res, enums.INVALID('OTP'), enums.HTTP_UNAUTHORIZED);
      }
      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: OTP verification successful`
      );
      return next();
    } catch (error) {
      console.error(
        `OTP verification failed:: ${enums.CHECK_EXPIRY_MIDDLEWARE}`
      );
      return next(error);
    }
  };

  getUser =
    (type = '') =>
    async (req: Request, res: Response, next: NextFunction): Promise<any> => {
      try {
        const {
          body: { email, userOtp, refreshToken },
          params: { user_id },
        } = req;
        const payload = email || user_id || userOtp || refreshToken;
        const user = await this.authService.getAUser(payload);

        if (!user && type === 'authenticate') {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Info: successfully confirms that user does not exist auth.middleware.js`
          );
          return errorResponse(
            res,
            enums.NOT_FOUND('User'),
            enums.HTTP_NOT_FOUND
          );
        }
        if (user && user.status === 'inactive' && type === 'login') {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Info: successfully confirms that user account is inactive in the database but is not valid auth.middleware.js`
          );
          return errorResponse(
            res,
            enums.USER_INACTIVE,
            enums.HTTP_UNAUTHORIZED
          );
        }

        if (
          user &&
          (user.status === 'deactivated' || user.status === 'blacklisted') &&
          type === 'login'
        ) {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Info: successfully confirms that user account exists in the database but is not valid auth.middleware.js`
          );
          return errorResponse(
            res,
            enums.USER_DEACTIVATED,
            enums.HTTP_UNAUTHORIZED
          );
        }

        if (user && type === 'validate' && user.status === 'active') {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Info: successfully confirms that user with email:'${payload}' already exist in the DB auth.middleware.js`
          );
          // Message wording is matched by the mobile app (check for "already exists").
          return errorResponse(
            res,
            'An account with this email already exists. Please log in.',
            enums.HTTP_BAD_REQUEST
          );
        }

        if (user && type === 'validate' && user.status === 'inactive') {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Info: successfully confirms that user with email:'${payload}' already exist in the DB, activate your account auth.middleware.js`
          );
          return errorResponse(
            res,
            'An account with this email already exists but is not activated yet.',
            enums.HTTP_BAD_REQUEST
          );
        }

        if (!user && type === 'verify') {
          console.log(
            `${enums.CURRENT_TIME_STAMP}, Invalid OTP:'${payload}'  auth.middleware.js`
          );
          return errorResponse(res, enums.INVALID('OTP'), enums.HTTP_NOT_FOUND);
        }

        if (!user && type === 'validate') {
          return next();
        }

        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: successfully fetched user details from the database auth.middleware.js`
        );

        req.user = user;
        return next();
      } catch (err) {
        console.error(
          `getting user details from the database failed::${enums.GET_USER_MIDDLEWARE}`
        );
        return next(err);
      }
    };

  checkUserPhoneNumber = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const {
        body: { phoneNumber },
      } = req;

      const user = await this.authService.getUserByPhoneNumber(phoneNumber);

      if (user) {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: successfully confirms that user with phone number:'${phoneNumber}' already exist in the DB auth.middleware.js`
        );
        return errorResponse(
          res,
          enums.ALREADY_IN_USE('Phone number'),
          enums.HTTP_BAD_REQUEST
        );
      }
      return next();
    } catch (err) {
      console.error(
        `getting user details from the database failed::${enums.GET_USER_MIDDLEWARE}`
      );
      return next(err);
    }
  };

  getAuthToken = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      let token: any = req.headers.authorization;
      if (!token) {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: successfully decoded that no authentication token was sent with the headers auth.middleware.js`
        );
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }

      if (!token.startsWith('Bearer ')) {
        return errorResponse(
          res,
          enums.INVALID('Token'),
          enums.HTTP_UNAUTHORIZED
        );
      }

      if (token.startsWith('Bearer ')) {
        token = token.slice(7, token.length);
      }

      req.token = token;
      return next();
    } catch (err) {
      console.error(
        `confirming request header status if authentication token was sent along failed:::${enums.GET_AUTH_TOKEN_MIDDLEWARE}`
      );
      return next(err);
    }
  };

  validatePassword = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const {
        user,
        body: { email, password, encryptedPassword },
      } = req;
      let verifyHash;
      if (password != null) {
        verifyHash = await HashText.verifyHash(
          password,
          String(user?.password)
        );
      } else {
        verifyHash = encryptedPassword === user?.password;
      }

      if (!verifyHash) {
        console.log(
          `Password does not match for user with email: ${email}. AuthService::loginService in auth.middleware.js`
        );
        return errorResponse(
          res,
          enums.INVALID_LOGIN_DETAILS,
          enums.HTTP_UNAUTHORIZED
        );
      }
      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: successfully verified user password auth.middleware.js`
      );
      return next();
    } catch (err) {
      console.error(
        `user password verification failed::: ${enums.VALIDATE_PASSWORD_MIDDLEWARE}`
      );
      return next(err);
    }
  };

  validateUserAuthToken = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const { token }: any = req;
      const decoded: any = HashText.decodeToken(token);

      const blacklistedToken = await this.authService.checkIfTokenIsBlacklisted(
        token
      );

      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: successfully decoded authentication token sent using the authentication secret auth.middleware.js`
      );

      if (decoded.message) {
        if (decoded.message === 'jwt expired') {
          return errorResponse(
            res,
            enums.SESSION_EXPIRED,
            enums.HTTP_UNAUTHORIZED
          );
        }
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: successfully decoded authentication token has a message which is an error message secret auth.middleware.js`
        );
        return errorResponse(res, decoded.message, enums.HTTP_UNAUTHORIZED);
      }

      if (blacklistedToken) {
        return errorResponse(
          res,
          enums.SESSION_EXPIRED,
          enums.HTTP_UNAUTHORIZED
        );
      }

      const user = await this.authService.getUserById(decoded.data.user_id);

      console.log(
        `${enums.CURRENT_TIME_STAMP}, Info: successfully fetched the user details using the decoded id auth.middleware.js`
      );

      if (!user) {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: successfully decoded that the user with the decoded id does not exist in the DB auth.middleware.js`
        );
        return errorResponse(
          res,
          enums.USER_NOT_EXIST,
          enums.HTTP_UNAUTHORIZED
        );
      }

      if (user && user.status === 'inactive') {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: successfully confirms that user account is inactive in the database but is not valid auth.middleware.js`
        );
        return errorResponse(res, enums.USER_INACTIVE, enums.HTTP_UNAUTHORIZED);
      }

      if (
        user &&
        (user.status === 'deactivated' || user.status === 'blacklisted')
      ) {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: successfully confirms that user account exists in the database but is not valid auth.middleware.js`
        );
        return errorResponse(
          res,
          enums.USER_DEACTIVATED,
          enums.HTTP_UNAUTHORIZED
        );
      }

      req.user = user;
      return next();
    } catch (err) {
      console.error(
        `validating authentication token failed:::${enums.VALIDATE_USER_AUTH_TOKEN_MIDDLEWARE}`
      );
      return next(err);
    }
  };
}

export const authMiddleware = new AuthMiddleware();

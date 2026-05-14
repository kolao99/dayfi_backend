import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../../shared/lib/api-response';
import PaymentsService from './services';
import enums from '../../shared/lib/enums';
import HashText from '../../shared/services/hashing';

class PaymentMiddleware {
  private readonly paymentsService: PaymentsService;

  constructor() {
    this.paymentsService = new PaymentsService();
  }

  checkWalletExists = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const dayfiId: string = req.body.dayfiId || req.params.dayfiId;

      if (!dayfiId || dayfiId === 'null' || dayfiId === 'undefined') {
        return errorResponse(
          res,
          'Wallet identifier (dayfiId) is required',
          enums.HTTP_BAD_REQUEST
        );
      }

      const wallet = await this.paymentsService.getWalletByDayfiId(dayfiId);

      if (!wallet) {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: Wallet not found in checkWalletExists`
        );
        return errorResponse(res, 'Wallet not found', enums.HTTP_NOT_FOUND);
      }

      (req as any).wallet = wallet;
      return next();
    } catch (error) {
      next(error);
    }
  };

  checkUserWalletExists = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const { body } = req;
      const { user } = req;

      const wallet = await this.paymentsService.fetchUserWalletByCurrency(
        user?.user_id,
        body.currency
      );

      if (wallet) {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: confirms that user already have a wallet with currency ${body.currency} in PaymentMiddleware`
        );
        return errorResponse(
          res,
          'User already have a wallet with this currency',
          enums.HTTP_BAD_REQUEST
        );
      }

      return next();
    } catch (error) {
      next(error);
    }
  };

  checkWalletExistsByUserId = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const userId: string = req.user?.user_id;

      const wallet = await this.paymentsService.getWalletByUserId(userId);

      if (!wallet) {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: Wallet not found in checkWalletExists`
        );
        return errorResponse(res, 'Wallet not found', enums.HTTP_NOT_FOUND);
      }

      (req as any).wallet = wallet;
      return next();
    } catch (error) {
      next(error);
    }
  };

  checkSufficientBalance = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const amount: number = parseFloat(req.body.amount);
      const wallet = (req as any).wallet;

      if (!wallet) {
        return errorResponse(
          res,
          'Wallet is not loaded. Run checkWalletExists first.',
          enums.HTTP_BAD_REQUEST
        );
      }

      if (wallet.balance < amount) {
        return errorResponse(
          res,
          'Insufficient wallet balance',
          enums.HTTP_BAD_REQUEST
        );
      }

      return next();
    } catch (error) {
      next(error);
    }
  };

  validatePasswordOrPin =
    (type = '') =>
    async (req: Request, res: Response, next: NextFunction): Promise<any> => {
      try {
        const {
          user,
          body: { pin, password, encryptedPassword, encryptedPin },
        } = req;

        if (type === 'password') {
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
              `Password does not match for user with id: ${user?.user_id}. in auth.middleware.js`
            );
            return errorResponse(
              res,
              enums.INVALID_PASSWORD,
              enums.HTTP_BAD_REQUEST
            );
          }
        }

        if (type === 'pin') {
          let verifyHash;

          if (pin != null) {
            verifyHash = await HashText.verifyHash(
              pin,
              String(user?.transaction_pin)
            );
          } else {
            verifyHash = encryptedPin === user?.transaction_pin;
          }
          if (!verifyHash) {
            console.log(
              `Transaction pin does not match for user with id: ${user?.user_id}. in auth.middleware.js`
            );
            return errorResponse(
              res,
              enums.INVALID_PIN,
              enums.HTTP_BAD_REQUEST
            );
          }
        }
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: successfully verified user password/PIN auth.middleware.js`
        );
        return next();
      } catch (err) {
        console.error(
          `user password/pin verification failed::: ${enums.VALIDATE_PASSWORD_OR_PIN_MIDDLEWARE}`
        );
        return next(err);
      }
    };
}

export const paymentMiddleware = new PaymentMiddleware();

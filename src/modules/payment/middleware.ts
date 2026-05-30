import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../../shared/lib/api-response';
import PaymentsService from './services';
import enums from '../../shared/lib/enums';
import HashText from '../../shared/services/hashing';
import { DISPLAY_CURRENCIES, PRIMARY_CURRENCY } from './walletModel';

class PaymentMiddleware {
  private readonly paymentsService: PaymentsService;

  constructor() {
    this.paymentsService = new PaymentsService();
  }

  /** Sets default spend currency when the client omits `spendCurrency`. */
  withSpendCurrency =
    (defaultCurrency: string) =>
    (req: Request, _res: Response, next: NextFunction): void => {
      (req as any).spendCurrencyDefault = defaultCurrency;
      next();
    };

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

  /**
   * Loads the wallet used for balance checks.
   * Default: unified USD. Legacy Nigeria bank transfer: `spendCurrency: NGN`.
   */
  checkWalletExistsByUserId = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    try {
      const userId: string = req.user?.user_id;
      const spendCurrency = String(
        req.body?.debitCurrency ??
          req.body?.spendCurrency ??
          req.body?.fromCurrency ??
          req.query?.spendCurrency ??
          (req as any).spendCurrencyDefault ??
          PRIMARY_CURRENCY
      )
        .trim()
        .toUpperCase();

      await this.paymentsService.ensureUserLedgerWallets(userId);

      const allowed = DISPLAY_CURRENCIES as readonly string[];
      const currency = allowed.includes(spendCurrency)
        ? spendCurrency
        : PRIMARY_CURRENCY;

      let wallet = await this.paymentsService.getWalletByCurrency(
        userId,
        currency
      );

      if (!wallet) {
        wallet = await this.paymentsService.getWalletByUserId(userId);
      }

      if (!wallet) {
        console.log(
          `${enums.CURRENT_TIME_STAMP}, Info: Wallet not found in checkWalletExists`
        );
        return errorResponse(res, 'Wallet not found', enums.HTTP_NOT_FOUND);
      }

      (req as any).wallet = wallet;
      (req as any).spendCurrency = currency;
      (req as any).debitCurrency = currency;
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
      const fee: number = parseFloat(req.body.fee) || 0;
      const wallet = (req as any).wallet;

      if (!wallet) {
        return errorResponse(
          res,
          'Wallet is not loaded. Run checkWalletExists first.',
          enums.HTTP_BAD_REQUEST
        );
      }

      const totalRequired = amount + fee;
      if (Number(wallet.balance) < totalRequired) {
        return errorResponse(
          res,
          fee > 0
            ? `Insufficient wallet balance. You need ₦${totalRequired.toLocaleString()} (₦${amount.toLocaleString()} + ₦${fee.toLocaleString()} fee).`
            : 'Insufficient wallet balance',
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
          if (!user?.transaction_pin) {
            return errorResponse(
              res,
              'Set a transaction PIN before making transfers',
              enums.HTTP_BAD_REQUEST
            );
          }

          let verifyHash;

          if (pin != null) {
            verifyHash = await HashText.verifyHash(
              pin,
              String(user.transaction_pin)
            );
          } else {
            verifyHash = encryptedPin === user.transaction_pin;
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

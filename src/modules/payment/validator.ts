import Joi, { Schema } from 'joi';
import { Request, Response, NextFunction } from 'express';
import enums from '../../shared/lib/enums';
import { errorResponse } from '../../shared/lib/api-response';

class PaymentValidator {
  private validateRequestBody(
    req: Request,
    res: Response,
    next: NextFunction,
    schema: Schema,
    validatorName: string
  ): any {
    console.log(
      `Validating request body in PaymentValidator::${validatorName}`
    );
    const { body } = req;
    const { error, value } = schema.validate(body);

    if (error) {
      console.error(`Validation error in PaymentValidator::${validatorName}`);
      return this.handleError(
        res,
        error.details[0].message.replace(/"/g, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    console.log(`Validation successful in PaymentValidator::${validatorName}`);
    req.validatedBody = value;
    next();
  }

  private validateRequestQuery(
    req: Request,
    res: Response,
    next: NextFunction,
    schema: Joi.ObjectSchema,
    validatorName: string
  ): any {
    console.log(
      `Validating request query in PaymentValidator::${validatorName}`
    );

    const { error, value } = schema.validate(req.query, { abortEarly: false });

    if (error) {
      console.error(`Validation error in PaymentValidator::${validatorName}`);
      return this.handleError(
        res,
        error.details.map((d) => d.message).join(', '),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    console.log(`Validation successful in PaymentValidator::${validatorName}`);
    req.validatedQuery = value;
    next();
  }

  resolveBankAccount = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      accountNumber: Joi.string().pattern(/^\d+$/).required(),
      bankCode: Joi.string().required(),
    });

    this.validateRequestBody(req, res, next, schema, 'resolveBankAccount');
  };

  chargeUserCard = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      cardNumber: Joi.string().pattern(/^\d+$/).required(),
      cvv: Joi.string().pattern(/^\d+$/).required(),
      expiryMonth: Joi.string().required(),
      expiryYear: Joi.string().required(),
      amount: Joi.number().positive().required(),
      email: Joi.string().email().required(),
      firstName: Joi.string().required(),
      lastName: Joi.string().required(),
      IP: Joi.string().required(),
      redirectUrl: Joi.string().uri().optional(),
      meta: Joi.any().optional(),
      suggestedAuth: Joi.string().required(),
      pin: Joi.string().required(),
    });

    this.validateRequestBody(req, res, next, schema, 'chargeUserCard');
  };

  verifyCardCharge = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      transactionReference: Joi.string().required(),
      otp: Joi.string().required(),
    });

    this.validateRequestBody(req, res, next, schema, 'verifyCardCharge');
  };

  verifyPayment = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      transactionReference: Joi.string().required(),
    });

    this.validateRequestBody(req, res, next, schema, 'verifyPayment');
  };

  chargeUserWithToken = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      token: Joi.string().required(),
      amount: Joi.number().positive().required(),
      email: Joi.string().email().required(),
      firstname: Joi.string().required(),
      lastname: Joi.string().required(),
      IP: Joi.string().required(),
      narration: Joi.string().optional(),
      meta: Joi.any().optional(),
    });

    this.validateRequestBody(req, res, next, schema, 'chargeUserWithToken');
  };

  transferToVirtualAccount = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const schema = Joi.object({
      amount: Joi.number().positive().required().messages({
        'number.base': 'Amount must be a number',
        'number.positive': 'Amount must be a positive number',
        'any.required': 'Amount is required',
      }),
      dayfiId: Joi.string().trim().required().messages({
        'string.base': 'Dayfi ID must be a string',
        'any.required': 'Dayfi ID is required',
      }),
      pin: Joi.string().required(),
      debitCurrency: Joi.string()
        .trim()
        .uppercase()
        .valid('NGN', 'USD', 'EUR', 'GBP')
        .optional(),
      spendCurrency: Joi.string()
        .trim()
        .uppercase()
        .valid('NGN', 'USD', 'EUR', 'GBP')
        .optional(),
    });

    this.validateRequestBody(
      req,
      res,
      next,
      schema,
      'transferToVirtualAccount'
    );
  };

  bankTransfer = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amount: Joi.number().positive().required().messages({
        'number.base': 'Amount must be a number',
        'number.positive': 'Amount must be a positive number',
        'any.required': 'Amount is required',
      }),
      accountNumber: Joi.string().pattern(/^\d+$/).required(),
      bankCode: Joi.string().required(),
      bankName: Joi.string().required(),
      accountName: Joi.string().required(),
      fee: Joi.number().min(0).required(),
      pin: Joi.string().required(),
      /** USD = unified balance (default). NGN = legacy Flutterwave local payout. */
      spendCurrency: Joi.string()
        .trim()
        .uppercase()
        .valid('USD', 'NGN', 'EUR', 'GBP')
        .default('NGN'),
      debitCurrency: Joi.string()
        .trim()
        .uppercase()
        .valid('USD', 'NGN', 'EUR', 'GBP')
        .optional(),
    });

    this.validateRequestBody(req, res, next, schema, 'bankTransfer');
  };

  addDayfiId = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      dayfiId: Joi.string().trim().required().messages({
        'string.base': 'Dayfi ID must be a string',
        'any.required': 'Dayfi ID is required',
      }),
    });

    this.validateRequestBody(req, res, next, schema, 'addDayfiId');
  };

  createWallet: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        currency: Joi.string().required().valid('CAD', 'USD', 'GBP', 'EUR'),
      });

      this.validateRequestBody(req, res, next, schema, 'createWalletValidator');
    };

  createExchangeRate: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        baseCurrency: Joi.string()
          .trim()
          .uppercase()
          .valid('NGN', 'USD', 'EUR', 'GBP', 'CAD')
          .required(),
        targetCurrency: Joi.string()
          .trim()
          .uppercase()
          .valid('NGN', 'USD', 'EUR', 'GBP', 'CAD')
          .invalid(Joi.ref('baseCurrency'))
          .required(),
        rate: Joi.number().positive().required(),
        source: Joi.string().trim().optional().default('manual'),
      });

      this.validateRequestBody(
        req,
        res,
        next,
        schema,
        'createExchangeRateValidator'
      );
    };

  getExchangeRate: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        baseCurrency: Joi.string()
          .trim()
          .uppercase()
          .valid('NGN', 'USD', 'EUR', 'GBP', 'CAD')
          .required(),
        targetCurrency: Joi.string()
          .trim()
          .uppercase()
          .valid('NGN', 'USD', 'EUR', 'GBP', 'CAD')
          .invalid(Joi.ref('baseCurrency'))
          .required(),
      });

      const { error, value } = schema.validate(req.query);

      if (error) {
        return this.handleError(
          res,
          error.details[0].message.replace(/"/g, ''),
          enums.HTTP_UNPROCESSABLE_ENTITY
        );
      }

      req.validatedQuery = value;
      next();
    };

  getPayoutQuote = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amountUsd: Joi.number().positive().required(),
      targetCurrency: Joi.string().trim().uppercase().min(3).max(4).required(),
      feeUsd: Joi.number().min(0).optional(),
    });
    this.validateRequestQuery(req, res, next, schema, 'getPayoutQuote');
  };

  walletRecoveryPhrase = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      pin: Joi.string().required(),
    });
    this.validateRequestBody(req, res, next, schema, 'walletRecoveryPhrase');
  };

  investmentDeposit = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amount: Joi.number().positive().min(1).required(),
      lockDays: Joi.number().integer().valid(30, 90, 180, 365).required(),
      name: Joi.string().trim().min(1).max(120).required(),
      pin: Joi.string().required(),
      idempotencyKey: Joi.string().max(255).optional(),
    });
    this.validateRequestBody(req, res, next, schema, 'investmentDeposit');
  };

  getInvestmentQuote = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amount: Joi.number().positive().min(1).required(),
      lockDays: Joi.number().integer().valid(30, 90, 180, 365).required(),
    });
    this.validateRequestQuery(req, res, next, schema, 'getInvestmentQuote');
  };

  investmentClaim = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      pin: Joi.string().required(),
      idempotencyKey: Joi.string().max(255).optional(),
    });
    this.validateRequestBody(req, res, next, schema, 'investmentClaim');
  };

  investmentWithdraw = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amount: Joi.number().positive().required(),
      pin: Joi.string().required(),
      idempotencyKey: Joi.string().max(255).optional(),
    });
    this.validateRequestBody(req, res, next, schema, 'investmentWithdraw');
  };

  dayEarnPreview = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amount: Joi.number().positive().min(1).required(),
      currency: Joi.string()
        .trim()
        .uppercase()
        .valid('NGN', 'USD', 'EUR', 'GBP')
        .required(),
    });
    this.validateRequestQuery(req, res, next, schema, 'dayEarnPreview');
  };

  dayEarnCreatePot = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(120).required(),
      amount: Joi.number().positive().min(1).required(),
      currency: Joi.string()
        .trim()
        .uppercase()
        .valid('NGN', 'USD', 'EUR', 'GBP')
        .required(),
      pin: Joi.string().required(),
      idempotencyKey: Joi.string().max(255).optional(),
    });
    this.validateRequestBody(req, res, next, schema, 'dayEarnCreatePot');
  };

  dayEarnDeposit = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amount: Joi.number().positive().min(1).required(),
      pin: Joi.string().required(),
      idempotencyKey: Joi.string().max(255).optional(),
    });
    this.validateRequestBody(req, res, next, schema, 'dayEarnDeposit');
  };

  dayEarnWithdraw = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amount: Joi.number().positive().optional(),
      withdrawAll: Joi.boolean().optional(),
      pin: Joi.string().required(),
      idempotencyKey: Joi.string().max(255).optional(),
    });
    this.validateRequestBody(req, res, next, schema, 'dayEarnWithdraw');
  };

  dayEarnRename = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(120).required(),
    });
    this.validateRequestBody(req, res, next, schema, 'dayEarnRename');
  };

  swapCurrency: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        fromCurrency: Joi.string()
          .trim()
          .uppercase()
          .valid('NGN', 'USD', 'EUR', 'GBP', 'CAD')
          .required(),
        toCurrency: Joi.string()
          .trim()
          .uppercase()
          .valid('NGN', 'USD', 'EUR', 'GBP', 'CAD')
          .invalid(Joi.ref('fromCurrency'))
          .required(),
        amount: Joi.number().positive().required(),
        pin: Joi.string().required(),
        spendCurrency: Joi.string()
          .trim()
          .uppercase()
          .valid('NGN', 'USD', 'EUR', 'GBP')
          .optional(),
      });

      this.validateRequestBody(req, res, next, schema, 'swapCurrencyValidator');
    };

  fetchWalletTransactions = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const schema = Joi.object({
      status: Joi.string().valid(
        'pending-collection',
        'success-collection',
        'failed-collection',
        'pending-payment',
        'success-payment',
        'failed-payment'
      ),
      startDate: Joi.date().iso(),
      endDate: Joi.date().iso(),
      search: Joi.string().min(1).max(255),
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(10),
      sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
    });

    const { error, value } = schema.validate(req.query);

    if (error) {
      return this.handleError(
        res,
        error.details[0].message.replace(/"/g, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    req.validatedBody = value;
    next();
  };

  fetchBeneficiaries = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(200).default(100),
    });

    const { error, value } = schema.validate(req.query);

    if (error) {
      return this.handleError(
        res,
        error.details[0].message.replace(/"/g, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    req.validatedBody = value;
    next();
  };

  saveBeneficiary = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      country: Joi.string().trim().min(2).max(10).required(),
      phone: Joi.string().allow('').optional(),
      ledgerCurrency: Joi.string().trim().min(3).max(10).required(),
      source: Joi.object({
        accountType: Joi.string()
          .valid(
            'dayfi',
            'crypto',
            'bank',
            'mobile',
            'phone',
            'mobile_money',
            'momo'
          )
          .required(),
        accountNumber: Joi.string().trim().min(1).max(255).required(),
        networkId: Joi.string().allow('').optional(),
      }).required(),
    });

    this.validateRequestBody(req, res, next, schema, 'saveBeneficiary');
  };

  fetchExchangeRates = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      currency: Joi.string().required(),
    });

    this.validateRequestQuery(req, res, next, schema, 'fetchExchangeRates');
  };

  createCollectionRequest = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const schema = Joi.object({
      amount: Joi.number().positive().required(),
      currency: Joi.string().required(),
      channelId: Joi.string().required(),
      channelName: Joi.string().required(),
      country: Joi.string().required(),
      reason: Joi.string().optional(),
      metadata: Joi.object().optional(),
      recipient: Joi.object({
        name: Joi.string().required(),
        country: Joi.string().required(),
        phone: Joi.string().required(),
        address: Joi.string().required(),
        dob: Joi.string().required(),
        email: Joi.string().email().required(),
        idNumber: Joi.string().required(),
        idType: Joi.string().required(),
      }).required(),
      source: Joi.object({
        accountNumber: Joi.string().required(),
        accountType: Joi.string().required(),
        networkId: Joi.string().required(),
      }).required(),
    });

    this.validateRequestBody(req, res, next, schema, 'createCollectionRequest');
  };

  createPaymentRequest = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      amount: Joi.number().positive().required(),
      collectionSequenceId: Joi.string().required(),
      currency: Joi.string().required(),
      channelId: Joi.string().required(),
      country: Joi.string().required(),
      reason: Joi.string().required(),
      accountNumber: Joi.string().required(),
      accountType: Joi.string().required(),
      networkCountry: Joi.string().required(),
      networkId: Joi.string().required(),
      accountName: Joi.string().optional(),
      metadata: Joi.object().optional(),
    });

    this.validateRequestBody(req, res, next, schema, 'createPaymentRequest');
  };

  walletFundedYellowCardSend = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const schema = Joi.object({
      sendAmount: Joi.number().positive().required(),
      receiveAmount: Joi.number().positive().required(),
      receiveCurrency: Joi.string().required(),
      country: Joi.string().required(),
      channelId: Joi.string().required(),
      networkId: Joi.string().required(),
      accountNumber: Joi.string().required(),
      accountName: Joi.string().required(),
      accountType: Joi.string().default('bank'),
      reason: Joi.string().default('other'),
      fee: Joi.number().min(0).default(0.05),
      spendCurrency: Joi.string().default('USD'),
      debitCurrency: Joi.string().optional(),
      pin: Joi.string().required(),
      recipient: Joi.object({
        name: Joi.string().required(),
        country: Joi.string().required(),
        phone: Joi.string().required(),
        address: Joi.string().required(),
        dob: Joi.string().required(),
        email: Joi.string().email().required(),
        idNumber: Joi.string().required(),
        idType: Joi.string().required(),
      }).optional(),
    });

    this.validateRequestBody(req, res, next, schema, 'walletFundedYellowCardSend');
  };

  sendCrypto = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      to: Joi.string().trim().required(),
      amount: Joi.string()
        .pattern(/^\d+(\.\d+)?$/)
        .required(),
      asset: Joi.string().trim().uppercase().valid('USDC', 'EURC').required(),
      network: Joi.string()
        .trim()
        .lowercase()
        .valid(
          'stellar',
          'ethereum',
          'eth',
          'bsc',
          'arbitrum',
          'sonic',
          'xdc',
          'mantle'
        )
        .required(),
      memo: Joi.string().max(28).optional(),
      pin: Joi.string().required(),
    });
    this.validateRequestBody(req, res, next, schema, 'sendCrypto');
  };

  resolveBankDetailsYC = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      accountNumber: Joi.string().required(),
      networkId: Joi.string().optional(),
      bankCode: Joi.string().optional(),
    }).or('networkId', 'bankCode');

    this.validateRequestBody(req, res, next, schema, 'resolveBankDetailsYC');
  };

  createWebhook = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      url: Joi.string().uri().required(),
      state: Joi.string().required(),
    });

    this.validateRequestBody(req, res, next, schema, 'createWebhook');
  };

  updateWebhook = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      id: Joi.string().uuid().required(),
      active: Joi.boolean().required(),
      url: Joi.string().uri().required(),
      state: Joi.string().required(),
    });

    this.validateRequestBody(req, res, next, schema, 'updateWebhook');
  };

  validateBill = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      categoryCode: Joi.string().required(),
      billerCode: Joi.string().required(),
      itemCode: Joi.string().required(),
      customerId: Joi.string().required(),
    });
    this.validateRequestBody(req, res, next, schema, 'validateBill');
  };

  payBill = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      categoryCode: Joi.string().required(),
      billerCode: Joi.string().required(),
      itemCode: Joi.string().required(),
      customerId: Joi.string().required(),
      amount: Joi.number().positive().required(),
      billerName: Joi.string().optional(),
      itemName: Joi.string().optional(),
      spendCurrency: Joi.string().valid('NGN').default('NGN'),
      pin: Joi.string().required(),
    });
    this.validateRequestBody(req, res, next, schema, 'payBill');
  };

  private handleError(res: Response, message: string, statusCode: number) {
    errorResponse(res, message, statusCode);
  }
}

export const paymentValidator = new PaymentValidator();

import Joi, { Schema } from 'joi';
import enums from '../../shared/lib/enums';
import moment from 'moment';
import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../../shared/lib/api-response';

class AuthValidator {
  // constructor() {}

  private validateRequestBody(
    req: Request,
    res: Response,
    next: NextFunction,
    schema: Schema,
    validatorName: string
  ): any {
    console.log(
      `Validating incoming request body in AuthValidator::${validatorName} in authValidator.js`
    );
    const { body } = req;
    const { error, value } = schema.validate(body);

    if (error) {
      console.error(
        `Error occurred while validating incoming request body in AuthValidator::${validatorName}`
      );
      return this.handleError(
        res,
        error.details[0].message.replace(/"/g, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    } else {
      console.log(
        `Finished validating incoming request body in AuthValidator::${validatorName}`
      );
      req.validatedBody = value;
      next();
    }
  }

  loginValidator: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        email: Joi.string().email().min(3).required(),
        password: Joi.string().min(8).optional(),
        encryptedPassword: Joi.string().min(8).optional(),
      }).xor('password', 'encryptedPassword');

      this.validateRequestBody(req, res, next, schema, 'loginValidator');
    };

  logoutValidator: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        token: Joi.string().required(),
      });

      this.validateRequestBody(req, res, next, schema, 'loginValidator');
    };

  passwordValidator: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        password: Joi.string().min(8).optional(),
        encryptedPassword: Joi.string().min(8).optional(),
      }).xor('password', 'encryptedPassword');

      this.validateRequestBody(req, res, next, schema, 'passwordValidator');
    };

  verifyOtpValidator: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        userOtp: Joi.string().length(6).required(),
        type: Joi.string().valid('email', 'password'),
      });

      this.validateRequestBody(req, res, next, schema, 'verifyOtpValidator');
    };

  verifyEmailOtpValidator: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => any = async (req, res, next) => {
    const schema = Joi.object({
      Otp: Joi.string().length(6).required(),
    });

    this.validateRequestBody(req, res, next, schema, 'verifyEmailOtpValidator');
  };
  resendOtpValidator: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        email: Joi.string().email().min(3).required(),
        type: Joi.string().valid('pin', 'password').optional().messages({
          'any.only': "Type must be one of 'password' or 'pin'.",
        }),
      });

      this.validateRequestBody(req, res, next, schema, 'resendOtpValidator');
    };

  verifyBvnValidator: (req: Request, res: Response, next: NextFunction) => any =
    async (req, res, next) => {
      const schema = Joi.object({
        bvn: Joi.string().length(11).pattern(/^\d+$/).required(),
      });

      this.validateRequestBody(req, res, next, schema, 'verifyBvnValidator');
    };

  resendPhoneOtpValidator: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => any = async (req, res, next) => {
    const schema = Joi.object({
      phoneNumber: Joi.string()
        .pattern(/^\+?[0-9\s\-()]{7,15}$/)
        .required()
        .messages({
          'string.pattern.base':
            'Phone number must be a valid format and contain between 7 and 15 digits.',
          'any.required': 'Phone number is required.',
        }),
    });

    this.validateRequestBody(req, res, next, schema, 'resendPhoneOtpValidator');
  };

  forgotPasswordValidator = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const schema = Joi.object({
      email: Joi.string().email().required(),
    });

    this.validateRequestBody(req, res, next, schema, 'forgotPasswordValidator');
  };

  validateEmailValidator = async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const schema = Joi.object({
      email: Joi.string().email().min(3).required(),
    });

    this.validateRequestBody(req, res, next, schema, 'validateEmailValidator');
  };

  createPasswordValidator: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => any = async (req, res, next) => {
    const schema = Joi.object({
      email: Joi.string().email().min(3).required(),
      password: Joi.string().min(8).required(),
    });

    this.validateRequestBody(req, res, next, schema, 'createPasswordValidator');
  };

  createUserValidator = (req: Request, res: Response, next: NextFunction) => {
    const { body } = req;
    const schema = Joi.object({
      email: Joi.string().email().required(),
      firstName: Joi.string().required(),
      lastName: Joi.string().required(),
      middleName: Joi.string().optional(),
      password: Joi.string()
        .min(8)
        .max(30)
        .pattern(
          /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*?&#.])[A-Za-z\d@$!%*?&#.]{8,}$/
        )
        .required()
        .messages({
          'string.min': 'Password must be at least 8 characters long.',
          'string.pattern.base':
            'Password must contain at least one letter, one number, and one special character.',
          'any.required': 'Password is required.',
        }),
    });

    const { error, value } = schema.validate(body);
    if (error) {
      return this.handleError(
        res,
        error.details[0].message.replace(/"/gi, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    req.validatedBody = value;
    next();
  };

  updateTransactionPinValidator = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const { body } = req;

    const schema = Joi.object({
      transactionPin: Joi.string().required(),
    });

    const { error, value } = schema.validate(body);
    if (error) {
      return this.handleError(
        res,
        error.details[0].message.replace(/"/gi, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    req.validatedBody = value;
    next();
  };

  changePasswordValidator = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const { body } = req;

    const schema = Joi.object({
      password: Joi.string().required(),
      oldPassword: Joi.string().required(),
    });

    const { error, value } = schema.validate(body);
    if (error) {
      return this.handleError(
        res,
        error.details[0].message.replace(/"/gi, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    req.validatedBody = value;
    next();
  };

  changeTransactionPinValidator = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const { body } = req;

    const schema = Joi.object({
      transactionPin: Joi.string().required(),
      oldTransactionPin: Joi.string().required(),
    });

    const { error, value } = schema.validate(body);
    if (error) {
      return this.handleError(
        res,
        error.details[0].message.replace(/"/gi, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    req.validatedBody = value;
    next();
  };

  verifyUserPhoneValidator = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const { body } = req;

    const schema = Joi.object({
      phoneNumber: Joi.string().required(),
      code: Joi.string().required(),
    });

    const { error, value } = schema.validate(body);
    if (error) {
      return this.handleError(
        res,
        error.details[0].message.replace(/"/gi, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    req.validatedBody = value;
    next();
  };

  updateUserProfileValidator = (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const { body } = req;

    const schema = Joi.object({
      gender: Joi.string()
        .valid('male', 'female', 'non-binary', 'prefer-not-to-say')
        .optional()
        .messages({
          'any.only':
            'Gender must be one of "male", "female", "non-binary", or "prefer-not-to-say".',
        }),
      dateOfBirth: Joi.date()
        .iso()
        .less(moment().subtract(18, 'years').toDate())
        .optional()
        .messages({
          'date.less': 'You must be at least 18 years old.',
        }),
      country: Joi.string().optional(),
      state: Joi.string().optional(),
      street: Joi.string().optional(),
      idType: Joi.string().optional(),
      idNumber: Joi.string().optional(),
      bvn: Joi.string().optional(),
      city: Joi.string().optional(),
      postalCode: Joi.string().optional(),
      address: Joi.string().optional(),
      phoneNumber: Joi.string()
        .pattern(/^\+?[0-9\s\-()]{7,15}$/)
        .optional()
        .messages({
          'string.pattern.base':
            'Phone number must be a valid format and contain between 7 and 15 digits.',
        }),
    });

    const { error, value } = schema.validate(body);
    if (error) {
      return this.handleError(
        res,
        error.details[0].message.replace(/"/gi, ''),
        enums.HTTP_UNPROCESSABLE_ENTITY
      );
    }

    req.validatedBody = value;
    next();
  };

  private handleError = (
    res: Response,
    message: string,
    statusCode: number
  ) => {
    errorResponse(res, message, statusCode);
  };
}

export const authValidator = new AuthValidator();

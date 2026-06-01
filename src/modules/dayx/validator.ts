import { NextFunction, Request, Response } from 'express';
import Joi from 'joi';
import { errorResponse } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';

class DayxValidator {
  private validateRequestBody(
    req: Request,
    res: Response,
    next: NextFunction,
    schema: Joi.ObjectSchema
  ) {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return errorResponse(
        res,
        error.details.map((d) => d.message).join(', '),
        enums.HTTP_BAD_REQUEST
      );
    }
    req.body = value;
    return next();
  }

  chat = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      message: Joi.string().trim().min(1).max(2000).required(),
      history: Joi.array()
        .items(
          Joi.object({
            role: Joi.string().valid('user', 'assistant').required(),
            content: Joi.string().trim().min(1).max(4000).required(),
          })
        )
        .max(20)
        .optional(),
    });
    return this.validateRequestBody(req, res, next, schema);
  };

  flowTurn = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      flow: Joi.string()
        .valid('send', 'swap', 'pay', 'add_money')
        .required(),
      action: Joi.string()
        .valid('start', 'select', 'submit', 'cancel')
        .required(),
      session: Joi.object({
        flow: Joi.string().required(),
        step: Joi.string().required(),
        data: Joi.object().unknown(true).optional(),
      }).optional()
        .allow(null),
      optionId: Joi.string().trim().max(120).optional(),
      field: Joi.string().trim().max(80).optional(),
      value: Joi.alternatives()
        .try(Joi.string().max(500), Joi.number())
        .optional(),
      utterance: Joi.string().trim().max(2000).optional(),
      walletBalances: Joi.array()
        .items(
          Joi.object({
            currency: Joi.string().trim().uppercase().max(8).required(),
            balance: Joi.number().required(),
            symbol: Joi.string().trim().max(8).optional(),
          })
        )
        .max(12)
        .optional(),
    });
    return this.validateRequestBody(req, res, next, schema);
  };
}

export const dayxValidator = new DayxValidator();

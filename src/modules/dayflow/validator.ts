import { NextFunction, Request, Response } from 'express';
import Joi from 'joi';
import { errorResponse } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';

class DayflowValidator {
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
      message: Joi.string().trim().min(1).max(4000).required(),
      history: Joi.array()
        .items(
          Joi.object({
            role: Joi.string().valid('user', 'assistant').required(),
            content: Joi.string().trim().min(1).max(8000).required(),
          })
        )
        .max(20)
        .optional(),
    });
    return this.validateRequestBody(req, res, next, schema);
  };

  savePlan = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      title: Joi.string().trim().max(120).optional(),
      budgetType: Joi.string()
        .valid('weekly', 'monthly', 'annual', 'custom')
        .optional(),
      periodLabel: Joi.string().trim().max(80).optional(),
      totalBudget: Joi.number().min(0).required(),
      spent: Joi.number().min(0).optional(),
      currency: Joi.string().valid('NGN').optional(),
      summaryLine: Joi.string().trim().max(500).optional(),
      categories: Joi.array()
        .items(
          Joi.object({
            name: Joi.string().required(),
            allocated: Joi.number().min(0).required(),
            spent: Joi.number().min(0).optional(),
            locked: Joi.boolean().optional(),
          })
        )
        .optional(),
      upcoming: Joi.array().optional(),
      goals: Joi.array().optional(),
      lockedCategories: Joi.array().items(Joi.string()).optional(),
      sweepToDayEarn: Joi.boolean().optional(),
      leftover: Joi.number().min(0).optional(),
    });
    return this.validateRequestBody(req, res, next, schema);
  };

  ackIncome = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      transactionIds: Joi.array().items(Joi.string().trim().min(1)).min(1).max(20).required(),
    });
    return this.validateRequestBody(req, res, next, schema);
  };
}

export const dayflowValidator = new DayflowValidator();

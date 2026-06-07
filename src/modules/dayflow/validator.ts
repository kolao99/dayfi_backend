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
      mode: Joi.string()
        .valid('addItem', 'editBudget', 'general')
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
      currency: Joi.string().valid('USD', 'NGN').optional(),
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

  saveTemplate = (req: Request, res: Response, next: NextFunction) => {
    const paymentSchema = Joi.object({
      title: Joi.string().trim().min(1).max(120).required(),
      amount: Joi.number().min(0).required(),
      dueLabel: Joi.string().allow('', null).optional(),
      recipientHint: Joi.string().allow('', null).optional(),
      autoSend: Joi.boolean().optional(),
    });

    const schema = Joi.object({
      title: Joi.string().trim().max(120).optional(),
      periodLabel: Joi.string().trim().max(80).optional(),
      budgetType: Joi.string()
        .valid('weekly', 'monthly', 'annual', 'custom')
        .optional(),
      totalBudget: Joi.number().min(0).required(),
      categories: Joi.array()
        .items(
          Joi.object({
            name: Joi.string().required(),
            allocated: Joi.number().min(0).required(),
          })
        )
        .optional(),
      payments: Joi.array().items(paymentSchema).optional(),
      goals: Joi.array().optional(),
      leftover: Joi.number().min(0).optional(),
      sweepToDayEarn: Joi.boolean().optional(),
      readyToApprove: Joi.boolean().optional(),
    });
    return this.validateRequestBody(req, res, next, schema);
  };

  createFlow = (req: Request, res: Response, next: NextFunction) => {
    const scheduleSchema = Joi.object({
      id: Joi.string().optional(),
      title: Joi.string().trim().min(1).max(120).required(),
      amount: Joi.number().positive().required(),
      sourceAmount: Joi.number().positive().optional(),
      frequency: Joi.string()
        .valid('once', 'weekly', 'biweekly', 'monthly')
        .optional(),
      dueLabel: Joi.string().trim().max(80).optional(),
      nextRunAt: Joi.string().isoDate().optional(),
      recipientHint: Joi.string().trim().max(200).optional(),
      recipientId: Joi.string().trim().max(255).allow(null).optional(),
      paymentType: Joi.string().valid('send', 'bill', 'savings').optional(),
      autoPay: Joi.boolean().optional(),
      execution: Joi.object({
        toCurrency: Joi.string().trim().valid('USD', 'NGN', 'GBP', 'EUR').optional(),
        bill: Joi.object({
          categoryCode: Joi.string().trim().required(),
          billerCode: Joi.string().trim().required(),
          itemCode: Joi.string().trim().required(),
          customerId: Joi.string().trim().required(),
          billerName: Joi.string().trim().max(120).optional(),
          itemName: Joi.string().trim().max(120).optional(),
        }).optional(),
      }).optional(),
    });

    const schema = Joi.object({
      title: Joi.string().trim().max(120).optional(),
      budgetType: Joi.string()
        .valid('weekly', 'monthly', 'annual', 'custom')
        .optional(),
      periodLabel: Joi.string().trim().max(80).optional(),
      summaryLine: Joi.string().trim().max(500).optional(),
      currency: Joi.string().valid('USD', 'NGN').optional(),
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
      schedules: Joi.array().items(scheduleSchema).optional(),
    }).or('categories', 'schedules');

    return this.validateRequestBody(req, res, next, schema);
  };

  patchSchedule = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      title: Joi.string().trim().min(1).max(120).optional(),
      amount: Joi.number().positive().optional(),
      recipientHint: Joi.string().trim().max(200).allow('', null).optional(),
      recipientId: Joi.string().trim().max(255).allow(null, '').optional(),
      paymentType: Joi.string().valid('send', 'bill', 'savings').optional(),
      execution: Joi.object({
        toCurrency: Joi.string()
          .trim()
          .valid('USD', 'NGN', 'GBP', 'EUR')
          .optional(),
        bill: Joi.object({
          categoryCode: Joi.string().trim().required(),
          billerCode: Joi.string().trim().required(),
          itemCode: Joi.string().trim().required(),
          customerId: Joi.string().trim().required(),
          billerName: Joi.string().trim().max(120).optional(),
          itemName: Joi.string().trim().max(120).optional(),
        }).optional(),
      }).optional(),
    }).min(1);

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

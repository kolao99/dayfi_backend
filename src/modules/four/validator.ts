import { NextFunction, Request, Response } from 'express';
import Joi from 'joi';
import { errorResponse } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import {
  MESSAGE_ROLES,
  MESSAGE_TYPES,
} from './conversation/messageService';

/**
 * Shape validation only. Phone numbers are accepted loosely here and normalized
 * canonically in `phoneE164`, so the client can send 08012345678 or
 * +234 801 234 5678 without the API caring.
 */
class FourValidator {
  private validateBody(
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

  requestOtp = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      phone: Joi.string().trim().min(7).max(24).required(),
    });
    return this.validateBody(req, res, next, schema);
  };

  verifyOtp = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      phone: Joi.string().trim().min(7).max(24).required(),
      code: Joi.string()
        .trim()
        .pattern(/^\d{4,8}$/)
        .required()
        .messages({ 'string.pattern.base': 'code must be 4-8 digits' }),
      deviceLabel: Joi.string().trim().max(120).optional(),
      platform: Joi.string().trim().valid('ios', 'android', 'web').optional(),
    });
    return this.validateBody(req, res, next, schema);
  };

  updateProfile = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      firstName: Joi.string().trim().min(1).max(100).optional(),
      lastName: Joi.string().trim().min(1).max(100).optional(),
      // Email stays optional forever — Four never requires it to sign in.
      email: Joi.string().trim().email().max(255).optional(),
    }).min(1);
    return this.validateBody(req, res, next, schema);
  };

  createConversation = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      title: Joi.string().trim().min(1).max(200).optional(),
    });
    return this.validateBody(req, res, next, schema);
  };

  postMessage = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      conversationId: Joi.string().uuid().required(),
      // Phase 2 persists what the client says. Assistant replies are written
      // by the server itself once the intent engine lands; the API accepts a
      // role so system/event messages can be recorded too.
      role: Joi.string()
        .valid(...MESSAGE_ROLES)
        .default('user'),
      type: Joi.string()
        .valid(...MESSAGE_TYPES)
        .default('text'),
      content: Joi.string().trim().max(8000).allow('', null).optional(),
      metadata: Joi.object().unknown(true).optional(),
      clientMessageId: Joi.string().trim().max(64).optional(),
    }).custom((value, helpers) => {
      const hasContent =
        typeof value.content === 'string' && value.content.trim() !== '';
      const hasMetadata =
        value.metadata && Object.keys(value.metadata).length > 0;
      if (!hasContent && !hasMetadata) {
        return helpers.message({
          custom: 'a message needs content or metadata',
        } as any);
      }
      return value;
    });
    return this.validateBody(req, res, next, schema);
  };

  listMessagesQuery = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).max(200).optional(),
      before: Joi.string().pattern(/^\d+$/).optional(),
    });
    const { error, value } = schema.validate(req.query, {
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
    (req as any).validatedQuery = value;
    return next();
  };

  linkTelegram = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      telegramUserId: Joi.alternatives()
        .try(Joi.number().integer().positive(), Joi.string().pattern(/^\d+$/))
        .required(),
      chatId: Joi.alternatives()
        .try(Joi.number().integer(), Joi.string().pattern(/^-?\d+$/))
        .optional(),
      username: Joi.string().trim().max(64).allow('', null).optional(),
    });
    return this.validateBody(req, res, next, schema);
  };

  authorizeIntent = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      pin: Joi.string()
        .trim()
        .pattern(/^\d{4,6}$/)
        .required(),
    });
    return this.validateBody(req, res, next, schema);
  };

  setupPin = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      pin: Joi.string()
        .trim()
        .pattern(/^\d{4}$/)
        .required(),
      confirmPin: Joi.string()
        .trim()
        .pattern(/^\d{4}$/)
        .required(),
    });
    return this.validateBody(req, res, next, schema);
  };

  verifyKycBvn = (req: Request, res: Response, next: NextFunction) => {
    const schema = Joi.object({
      bvn: Joi.string()
        .trim()
        .pattern(/^\d{11}$/)
        .required()
        .messages({ 'string.pattern.base': 'BVN must be exactly 11 digits' }),
      firstName: Joi.string().trim().min(1).max(100).optional(),
      lastName: Joi.string().trim().min(1).max(100).optional(),
    });
    return this.validateBody(req, res, next, schema);
  };
}

export default new FourValidator();

import express from 'express';
import { authMiddleware } from '../authentication/middleware';
import { dayflowController } from './controller';
import { dayflowValidator } from './validator';

const Router = express.Router();

Router.get(
  '/status',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowController.status
);

Router.post(
  '/chat',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowValidator.chat,
  dayflowController.chat
);

export const dayflowRouter = Router;

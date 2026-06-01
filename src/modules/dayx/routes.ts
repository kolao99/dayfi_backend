import express from 'express';
import { authMiddleware } from '../authentication/middleware';
import { dayxController } from './controller';
import { dayxValidator } from './validator';

const Router = express.Router();

Router.get(
  '/status',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayxController.status
);

Router.post(
  '/chat',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayxValidator.chat,
  dayxController.chat
);

Router.post(
  '/flow/turn',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayxValidator.flowTurn,
  dayxController.flowTurn
);

export const dayxRouter = Router;

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

Router.get(
  '/dashboard',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowController.dashboard
);

Router.get(
  '/plan',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowController.getPlan
);

Router.put(
  '/plan',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowValidator.savePlan,
  dayflowController.savePlan
);

Router.get(
  '/income/pending',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowController.pendingIncome
);

Router.post(
  '/income/ack',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowValidator.ackIncome,
  dayflowController.ackIncome
);

Router.post(
  '/chat',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowValidator.chat,
  dayflowController.chat
);

Router.get(
  '/flows',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowController.listFlows
);

Router.get(
  '/flows/:flowId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowController.getFlow
);

Router.post(
  '/flows',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowValidator.createFlow,
  dayflowController.createFlow
);

Router.post(
  '/flows/:flowId/cancel',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayflowController.cancelFlow
);

export const dayflowRouter = Router;

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

Router.get(
  '/v2/status',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayxController.v2Status
);

Router.post(
  '/v2/chat',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayxValidator.v2Chat,
  dayxController.v2Chat
);

Router.get(
  '/voices',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayxController.voices
);

Router.post(
  '/tts',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  dayxValidator.tts,
  dayxController.tts
);

export const dayxRouter = Router;

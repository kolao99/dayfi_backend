import express from 'express';
import { authMiddleware } from '../authentication/middleware';
import notificationController from './controller';

const Router = express.Router();

Router.get(
  '/',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  notificationController.list
);
Router.get(
  '/unread-count',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  notificationController.unreadCount
);
Router.put(
  '/read-all',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  notificationController.markAllRead
);
Router.put(
  '/:notificationId',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  notificationController.markRead
);

export const notificationRouter = Router;

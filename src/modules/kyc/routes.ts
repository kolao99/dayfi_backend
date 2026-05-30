import express from 'express';
import { authMiddleware } from '../authentication/middleware';
import { kycController } from './controller';

const Router = express.Router();

Router.post(
  '/verify-identity',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  kycController.verifyIdentity
);

Router.get('/status', authMiddleware.getAuthToken, authMiddleware.validateUserAuthToken, kycController.getKycStatus);

Router.get('/smile/config', kycController.smileConfig);

Router.post('/smile/webhook', kycController.smileWebhook);

Router.post(
  '/smile/complete',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  kycController.completeSmileKyc
);

Router.post(
  '/smile/prepare-bvn',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  kycController.prepareSmileBvn
);

Router.post(
  '/smile/verify-bvn',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  kycController.verifyBvnWithSmile
);

Router.post(
  '/smile/verify-nin',
  authMiddleware.getAuthToken,
  authMiddleware.validateUserAuthToken,
  kycController.verifyNinWithSmile
);

export const kycRouter = Router;

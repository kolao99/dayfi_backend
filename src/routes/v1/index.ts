import express from 'express';
import { authRouter } from '../../modules/authentication/routes';
import { paymentRouter } from '../../modules/payment/routes';
import { kycRouter } from '../../modules/kyc/routes';
import { dayxRouter } from '../../modules/dayx/routes';
import { dayflowRouter } from '../../modules/dayflow/routes';
import { notificationRouter } from '../../modules/notifications/routes';
import { healthRouter } from '../../modules/health/routes';

const appRouter = express.Router();

appRouter.use('/health', healthRouter);
appRouter.use('/auth', authRouter);
appRouter.use('/payments', paymentRouter);
appRouter.use('/kyc', kycRouter);
appRouter.use('/dayx', dayxRouter);
appRouter.use('/dayflow', dayflowRouter);
appRouter.use('/notifications', notificationRouter);

export const Router = appRouter;

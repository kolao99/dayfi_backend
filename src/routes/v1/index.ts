import express from 'express';
import { authRouter } from '../../modules/authentication/routes';
import { paymentRouter } from '../../modules/payment/routes';
import { kycRouter } from '../../modules/kyc/routes';
import { dayxRouter } from '../../modules/dayx/routes';
import { notificationRouter } from '../../modules/notifications/routes';

const appRouter = express.Router();

appRouter.use('/auth', authRouter);
appRouter.use('/payments', paymentRouter);
appRouter.use('/kyc', kycRouter);
appRouter.use('/dayx', dayxRouter);
appRouter.use('/notifications', notificationRouter);

export const Router = appRouter;

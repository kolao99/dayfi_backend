import express from 'express';
import { authRouter } from '../../modules/authentication/routes';
import { paymentRouter } from '../../modules/payment/routes';
import { kycRouter } from '../../modules/kyc/routes';
import { dayxRouter } from '../../modules/dayx/routes';

const appRouter = express.Router();

appRouter.use('/auth', authRouter);
appRouter.use('/payments', paymentRouter);
appRouter.use('/kyc', kycRouter);
appRouter.use('/dayx', dayxRouter);

export const Router = appRouter;

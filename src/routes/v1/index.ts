import express from 'express';
import { authRouter } from '../../modules/authentication/routes';
import { paymentRouter } from '../../modules/payment/routes';
import { kycRouter } from '../../modules/kyc/routes';

const appRouter = express.Router();

appRouter.use('/auth', authRouter);
appRouter.use('/payments', paymentRouter);
appRouter.use('/kyc', kycRouter);

export const Router = appRouter;

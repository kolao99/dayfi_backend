import express from 'express';
import { authRouter } from '../../modules/authentication/routes';
import { paymentRouter } from '../../modules/payment/routes';

const appRouter = express.Router();

appRouter.use('/auth', authRouter);
appRouter.use('/payments', paymentRouter);

export const Router = appRouter;

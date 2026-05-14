import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Router, ROUTE_BASE } from '../routes';
import { GlobalErrorCatcherMiddleware } from '../shared/middlewares/global-error-catcher.middleware';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(cors());

app.use(express.static('public'));

// Use helmet to secure Express headers
app.use(helmet());
app.disable('x-powered-by');

app.use(ROUTE_BASE.V1_PATH, Router);

app.use(GlobalErrorCatcherMiddleware);

export default app;

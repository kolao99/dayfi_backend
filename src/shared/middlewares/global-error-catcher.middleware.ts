import { NextFunction, Request, Response } from 'express';
import { HttpException } from '../lib/errors';

export function GlobalErrorCatcherMiddleware(
  err: any,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  console.error(err);

  const isHttpException = err instanceof HttpException;

  if (err?.code == null || !isHttpException) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Internal server error. Please try again later.';
    res.status(500).json({
      status: 'error',
      code: 500,
      message,
    });
    return;
  }
  res.status(err.code).json({
    status: 'error',
    code: err.code,
    message: err.message,
  });
}

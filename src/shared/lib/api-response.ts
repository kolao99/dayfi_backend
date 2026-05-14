import { Response } from 'express';

function toErrorMessage(err: unknown): string {
  if (err == null) return 'An error occurred';
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (m != null && String(m).trim() !== '') return String(m);
  }
  return String(err);
}

/** Synchronous JSON error body (same shape as success) so clients never get plain-text 500s. */
export const errorResponse = (res: Response, err: unknown, code: number) => {
  const raw = toErrorMessage(err);
  const capitalized =
    raw.length > 0 ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
  return res.status(code).json({
    status: 'error',
    code: code,
    message: capitalized,
  });
};

export const success = (
  res: Response,
  message: string,
  code: number,
  data?: any
) => {
  return res.status(code).json({
    status: 'success',
    message,
    code,
    data,
  });
};

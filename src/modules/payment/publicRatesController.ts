import { Request, Response } from 'express';
import { errorResponse, success } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { getPublicCorridorRates } from './ycPublicRatesService';

export async function publicRates(_req: Request, res: Response): Promise<void> {
  try {
    const data = await getPublicCorridorRates();
    success(res, enums.FETCHED_SUCCESSFULLY('Public corridor rates'), enums.HTTP_OK, data);
  } catch (err: unknown) {
    errorResponse(
      res,
      err instanceof Error ? err.message : 'Unable to load corridor rates',
      enums.HTTP_INTERNAL_SERVER_ERROR
    );
  }
}

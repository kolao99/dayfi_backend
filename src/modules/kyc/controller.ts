import { Request, Response } from 'express';
import { success, errorResponse } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import {
  mergeAndApplySmileResult,
  parseSmileKycPayload,
  smileCallbackUrl,
  verifyIdWithSmile,
} from './smileService';

class KycController {
  smileConfig = async (_req: Request, res: Response): Promise<any> => {
    try {
      const callbackUrl = smileCallbackUrl();
      return success(res, enums.FETCHED_SUCCESSFULLY('Smile config'), enums.HTTP_OK, {
        callbackUrl,
      });
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  smileWebhook = async (req: Request, res: Response): Promise<any> => {
    try {
      const parsed = parseSmileKycPayload(req.body);
      if (!parsed?.userId) {
        return success(res, 'Ignored', enums.HTTP_OK, { processed: false });
      }

      if (!parsed.verified) {
        console.warn(
          `[smileWebhook] non-success job for ${parsed.userId}: ${parsed.resultCode} ${parsed.resultText}`
        );
        return success(res, 'Received', enums.HTTP_OK, { processed: false });
      }

      const outcome = await mergeAndApplySmileResult(parsed);
      return success(res, 'Smile KYC processed', enums.HTTP_OK, {
        processed: true,
        ...outcome,
      });
    } catch (err: unknown) {
      console.error('[smileWebhook]', err);
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  /** Mobile posts Biometric KYC / SDK JSON after onSuccess. */
  completeSmileKyc = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      if (!user?.user_id) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }

      const raw =
        req.body?.smileResult ?? req.body?.result ?? req.body?.payload ?? req.body;
      const idTypeHint = String(req.body?.idType ?? req.body?.id_type ?? 'BVN');

      let parsed = parseSmileKycPayload(raw, idTypeHint);
      if (!parsed) {
        return errorResponse(
          res,
          'Invalid Smile ID result payload',
          enums.HTTP_BAD_REQUEST
        );
      }

      parsed = { ...parsed, userId: user.user_id };

      if (!parsed.verified) {
        return errorResponse(
          res,
          parsed.resultText || 'Identity verification was not approved',
          enums.HTTP_BAD_REQUEST
        );
      }

      const outcome = await mergeAndApplySmileResult(parsed);
      return success(res, 'KYC updated successfully', enums.HTTP_OK, outcome);
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  /** Verify NIN via Smile Enhanced KYC (server-side), then tier-2 + NGN VA. */
  verifyNinWithSmile = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      if (!user?.user_id) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }

      const nin = String(req.body?.nin ?? '').trim();
      if (!/^\d{11}$/.test(nin)) {
        return errorResponse(
          res,
          'NIN must be exactly 11 digits',
          enums.HTTP_BAD_REQUEST
        );
      }

      const parsed = await verifyIdWithSmile({
        userId: user.user_id,
        idType: 'NIN_V2',
        idNumber: nin,
        firstName: user.first_name ?? '',
        lastName: user.last_name ?? '',
        dob: user.date_of_birth ?? undefined,
      });

      const outcome = await mergeAndApplySmileResult(parsed);
      return success(res, 'NIN verified successfully', enums.HTTP_OK, outcome);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResponse(res, msg, enums.HTTP_BAD_REQUEST);
    }
  };
}

export const kycController = new KycController();

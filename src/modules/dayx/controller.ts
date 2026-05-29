import { Request, Response } from 'express';
import { errorResponse, success } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { chatWithDayx, getDayxStatus } from './dayxService';

class DayxController {
  status = async (_req: Request, res: Response): Promise<any> => {
    return success(
      res,
      enums.FETCHED_SUCCESSFULLY('DayX status'),
      enums.HTTP_OK,
      getDayxStatus()
    );
  };

  chat = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const { message, history } = req.body;

      const result = await chatWithDayx({
        userId,
        message: String(message),
        history: Array.isArray(history) ? history : [],
      });

      return success(res, 'DayX reply', enums.HTTP_OK, result);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'DAYX_AI_UNAVAILABLE') {
        return errorResponse(
          res,
          'DayX AI is not configured on the server. Set OPENAI_API_KEY.',
          enums.HTTP_SERVICE_UNAVAILABLE
        );
      }
      return errorResponse(
        res,
        msg || 'DayX chat failed',
        enums.HTTP_BAD_REQUEST
      );
    }
  };
}

export const dayxController = new DayxController();

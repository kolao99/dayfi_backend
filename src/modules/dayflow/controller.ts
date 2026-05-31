import { Request, Response } from 'express';
import { errorResponse, success } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { chatWithDayflow, getDayflowStatus } from './dayflowService';

class DayflowController {
  status = async (_req: Request, res: Response): Promise<any> => {
    return success(
      res,
      enums.FETCHED_SUCCESSFULLY('DayFlow status'),
      enums.HTTP_OK,
      getDayflowStatus()
    );
  };

  chat = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const { message, history } = req.body;

      const result = await chatWithDayflow({
        userId,
        message: String(message),
        history: Array.isArray(history) ? history : [],
      });

      return success(res, 'DayFlow reply', enums.HTTP_OK, result);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'DAYFLOW_AI_UNAVAILABLE') {
        return errorResponse(
          res,
          'DayFlow AI is not configured on the server. Set GROQ_API_KEY (or OPENAI_API_KEY).',
          enums.HTTP_SERVICE_UNAVAILABLE
        );
      }
      return errorResponse(
        res,
        msg || 'DayFlow chat failed',
        enums.HTTP_BAD_REQUEST
      );
    }
  };
}

export const dayflowController = new DayflowController();

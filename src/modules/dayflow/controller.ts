import { Request, Response } from 'express';
import { errorResponse, success } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { chatWithDayflow, getDayflowStatus } from './dayflowService';
import {
  acknowledgeIncome,
  getActivePlan,
  getDayflowDashboard,
  getPendingIncome,
  upsertActivePlan,
} from './dayflowPlanService';

class DayflowController {
  status = async (_req: Request, res: Response): Promise<any> => {
    return success(
      res,
      enums.FETCHED_SUCCESSFULLY('DayFlow status'),
      enums.HTTP_OK,
      getDayflowStatus()
    );
  };

  dashboard = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const data = await getDayflowDashboard(userId);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('DayFlow dashboard'),
        enums.HTTP_OK,
        data
      );
    } catch (err: any) {
      return errorResponse(
        res,
        String(err?.message ?? err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  getPlan = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const plan = await getActivePlan(userId);
      return success(res, 'DayFlow plan', enums.HTTP_OK, { plan });
    } catch (err: any) {
      return errorResponse(
        res,
        String(err?.message ?? err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  savePlan = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const plan = await upsertActivePlan(userId, req.body);
      return success(res, 'DayFlow plan saved', enums.HTTP_OK, { plan });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'DAYFLOW_PLANS_TABLE_MISSING') {
        return errorResponse(
          res,
          'DayFlow plans table not migrated yet. Run npm run migrate up.',
          enums.HTTP_SERVICE_UNAVAILABLE
        );
      }
      return errorResponse(res, msg, enums.HTTP_BAD_REQUEST);
    }
  };

  pendingIncome = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const pendingIncome = await getPendingIncome(userId);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Pending income'),
        enums.HTTP_OK,
        { pendingIncome }
      );
    } catch (err: any) {
      return errorResponse(
        res,
        String(err?.message ?? err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  ackIncome = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const { transactionIds } = req.body as { transactionIds?: string[] };
      await acknowledgeIncome(userId, transactionIds ?? []);
      return success(res, 'Income acknowledged', enums.HTTP_OK, { ok: true });
    } catch (err: any) {
      return errorResponse(
        res,
        String(err?.message ?? err),
        enums.HTTP_BAD_REQUEST
      );
    }
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

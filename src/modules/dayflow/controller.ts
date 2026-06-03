import { Request, Response } from 'express';
import { errorResponse, success } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { chatWithDayflow, getDayflowStatus } from './dayflowService';
import {
  cancelFlow,
  createAndActivateFlow,
  getFlow,
  listFlows,
  runDueSchedulesForUser,
  updateFlowSchedule,
} from './dayflowFlowService';
import {
  acknowledgeIncome,
  getActivePlan,
  getDayflowDashboard,
  getPendingIncome,
  getPlanTemplate,
  savePlanTemplate,
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

  getTemplate = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const template = await getPlanTemplate(userId);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('DayBudget template'),
        enums.HTTP_OK,
        { template }
      );
    } catch (err: any) {
      return errorResponse(
        res,
        String(err?.message ?? err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  saveTemplate = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const template = await savePlanTemplate(userId, req.body);
      return success(
        res,
        enums.CREATED_SUCCESSFULLY('DayBudget template'),
        enums.HTTP_OK,
        { template }
      );
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'DAYFLOW_TEMPLATE_TABLE_MISSING') {
        return errorResponse(
          res,
          'DayBudget template table not migrated yet. Run npm run migrate up.',
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

  listFlows = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const status =
        typeof req.query.status === 'string' ? req.query.status : undefined;
      const flows = await listFlows(userId, status);
      return success(res, 'DayFlow flows', enums.HTTP_OK, { flows });
    } catch (err: any) {
      return errorResponse(
        res,
        String(err?.message ?? err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  getFlow = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const flowId = String(req.params.flowId ?? '');
      const flow = await getFlow(userId, flowId);
      if (!flow) {
        return errorResponse(res, 'Flow not found', enums.HTTP_NOT_FOUND);
      }
      return success(res, 'DayFlow flow', enums.HTTP_OK, { flow });
    } catch (err: any) {
      return errorResponse(
        res,
        String(err?.message ?? err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  createFlow = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const flow = await createAndActivateFlow(userId, req.body);
      return success(res, 'DayFlow flow created', enums.HTTP_CREATED, {
        flow,
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'DAYFLOW_FLOWS_TABLE_MISSING') {
        return errorResponse(
          res,
          'DayFlow flows table not migrated yet. Run npm run migrate up.',
          enums.HTTP_SERVICE_UNAVAILABLE
        );
      }
      return errorResponse(res, msg, enums.HTTP_BAD_REQUEST);
    }
  };

  updateSchedule = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const flowId = String(req.params.flowId ?? '');
      const scheduleId = String(req.params.scheduleId ?? '');
      const flow = await updateFlowSchedule(
        userId,
        flowId,
        scheduleId,
        req.body
      );
      return success(res, 'DayFlow schedule updated', enums.HTTP_OK, { flow });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'Flow not found' || msg === 'Schedule not found') {
        return errorResponse(res, msg, enums.HTTP_NOT_FOUND);
      }
      if (msg === 'DAYFLOW_FLOWS_TABLE_MISSING') {
        return errorResponse(
          res,
          'DayFlow flows table not migrated yet. Run npm run migrate up.',
          enums.HTTP_SERVICE_UNAVAILABLE
        );
      }
      return errorResponse(res, msg, enums.HTTP_BAD_REQUEST);
    }
  };

  cancelFlow = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const flowId = String(req.params.flowId ?? '');
      const result = await cancelFlow(userId, flowId);
      return success(res, 'DayFlow flow cancelled', enums.HTTP_OK, result);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'Flow not found') {
        return errorResponse(res, msg, enums.HTTP_NOT_FOUND);
      }
      return errorResponse(res, msg, enums.HTTP_BAD_REQUEST);
    }
  };

  runDueSchedules = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const result = await runDueSchedulesForUser(userId);
      return success(res, 'DayFlow schedules executed', enums.HTTP_OK, result);
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

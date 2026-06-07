import { Request, Response } from 'express';
import {
  createBudget,
  deleteBudget,
  getBudget,
  listBudgets,
  pauseBudget,
  resumeBudget,
  updateBudget,
  type BudgetFrequency,
  type BudgetType,
} from './budgetService';

class BudgetController {
  list = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const status = req.query.status as string | undefined;
      const budgets = await listBudgets(userId, status);
      res.status(200).json({ success: true, data: { budgets } });
    } catch (e: any) {
      res.status(500).json({
        success: false,
        message: e?.message ?? 'Failed to load budgets',
      });
    }
  };

  getOne = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.user_id;
      const { budgetId } = req.params;
      if (!userId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const budget = await getBudget(userId, budgetId);
      if (!budget) {
        res.status(404).json({ success: false, message: 'Budget not found' });
        return;
      }
      res.status(200).json({ success: true, data: budget });
    } catch (e: any) {
      res.status(500).json({
        success: false,
        message: e?.message ?? 'Failed to load budget',
      });
    }
  };

  create = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const {
        name,
        type,
        amount,
        currency,
        frequency,
        categories,
        recipientId,
        metadata,
        nextRunAt,
      } = req.body ?? {};

      if (!name || typeof name !== 'string' || name.trim().length < 2) {
        res.status(400).json({ success: false, message: 'Name is required' });
        return;
      }
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        res
          .status(400)
          .json({ success: false, message: 'Amount must be greater than 0' });
        return;
      }

      const allowedTypes: BudgetType[] = [
        'recurring_send',
        'category_spend',
        'bill_reminder',
        'invest_allocation',
      ];
      if (!allowedTypes.includes(type)) {
        res.status(400).json({ success: false, message: 'Invalid budget type' });
        return;
      }

      const allowedFreq: BudgetFrequency[] = [
        'once',
        'weekly',
        'biweekly',
        'monthly',
      ];
      const freq = (frequency ?? 'monthly') as BudgetFrequency;
      if (!allowedFreq.includes(freq)) {
        res.status(400).json({ success: false, message: 'Invalid frequency' });
        return;
      }

      const budget = await createBudget(userId, {
        name,
        type,
        amount: parsedAmount,
        currency,
        frequency: freq,
        categories: Array.isArray(categories) ? categories : [],
        recipientId: recipientId ?? null,
        nextRunAt:
          typeof nextRunAt === 'string' && nextRunAt.trim().length > 0
            ? nextRunAt.trim()
            : undefined,
        metadata:
          metadata && typeof metadata === 'object' ? metadata : undefined,
      });

      res.status(201).json({ success: true, data: budget });
    } catch (e: any) {
      res.status(500).json({
        success: false,
        message: e?.message ?? 'Failed to create budget',
      });
    }
  };

  update = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.user_id;
      const { budgetId } = req.params;
      if (!userId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }

      const patch: Parameters<typeof updateBudget>[2] = {};
      if (req.body?.name != null) patch.name = String(req.body.name);
      if (req.body?.amount != null) patch.amount = Number(req.body.amount);
      if (req.body?.status != null) patch.status = req.body.status;
      if (req.body?.categories != null) patch.categories = req.body.categories;
      if (req.body?.metadata != null) patch.metadata = req.body.metadata;
      if (req.body?.frequency != null) patch.frequency = req.body.frequency;

      const budget = await updateBudget(userId, budgetId, patch);
      if (!budget) {
        res.status(404).json({ success: false, message: 'Budget not found' });
        return;
      }
      res.status(200).json({ success: true, data: budget });
    } catch (e: any) {
      res.status(500).json({
        success: false,
        message: e?.message ?? 'Failed to update budget',
      });
    }
  };

  pause = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.user_id;
      const { budgetId } = req.params;
      if (!userId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const budget = await pauseBudget(userId, budgetId);
      if (!budget) {
        res.status(404).json({ success: false, message: 'Budget not found' });
        return;
      }
      res.status(200).json({ success: true, data: budget });
    } catch (e: any) {
      res.status(500).json({
        success: false,
        message: e?.message ?? 'Failed to pause budget',
      });
    }
  };

  resume = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.user_id;
      const { budgetId } = req.params;
      if (!userId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const budget = await resumeBudget(userId, budgetId);
      if (!budget) {
        res.status(404).json({ success: false, message: 'Budget not found' });
        return;
      }
      res.status(200).json({ success: true, data: budget });
    } catch (e: any) {
      res.status(500).json({
        success: false,
        message: e?.message ?? 'Failed to resume budget',
      });
    }
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user?.user_id;
      const { budgetId } = req.params;
      if (!userId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
      }
      const ok = await deleteBudget(userId, budgetId);
      if (!ok) {
        res.status(404).json({ success: false, message: 'Budget not found' });
        return;
      }
      res.status(200).json({ success: true, message: 'Budget cancelled' });
    } catch (e: any) {
      res.status(500).json({
        success: false,
        message: e?.message ?? 'Failed to delete budget',
      });
    }
  };
}

export const budgetController = new BudgetController();

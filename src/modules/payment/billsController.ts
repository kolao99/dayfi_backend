import { Request, Response } from 'express';
import { success, errorResponse } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { billsService } from './billsService';

class BillsController {
  getCategories = async (_req: Request, res: Response): Promise<any> => {
    try {
      const categories = await billsService.getCategories();
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Bill categories'),
        enums.HTTP_OK,
        categories
      );
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  getBillers = async (req: Request, res: Response): Promise<any> => {
    try {
      const category = String(req.params.category ?? '').toUpperCase();
      if (!category) {
        return errorResponse(res, 'Category is required', enums.HTTP_BAD_REQUEST);
      }
      const billers = await billsService.getBillers(category);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Billers'),
        enums.HTTP_OK,
        billers
      );
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  getItems = async (req: Request, res: Response): Promise<any> => {
    try {
      const billerCode = String(req.params.billerCode ?? '').trim();
      if (!billerCode) {
        return errorResponse(res, 'Biller code is required', enums.HTTP_BAD_REQUEST);
      }
      const items = await billsService.getItems(billerCode);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Bill items'),
        enums.HTTP_OK,
        items
      );
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  validateBill = async (req: Request, res: Response): Promise<any> => {
    try {
      const body = (req as any).validatedBody ?? req.body;
      const data = await billsService.validateBill({
        categoryCode: body.categoryCode,
        billerCode: body.billerCode,
        itemCode: body.itemCode,
        customerId: body.customerId,
      });
      return success(res, 'Bill validated successfully', enums.HTTP_OK, data);
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  payBill = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = req.user;
      if (!user?.user_id) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }
      const body = (req as any).validatedBody ?? req.body;
      const result = await billsService.payBill({
        userId: user.user_id,
        categoryCode: body.categoryCode,
        billerCode: body.billerCode,
        itemCode: body.itemCode,
        customerId: body.customerId,
        amount: body.amount,
        billerName: body.billerName,
        itemName: body.itemName,
      });
      return success(res, 'Bill payment successful', enums.HTTP_OK, result);
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  getStatus = async (req: Request, res: Response): Promise<any> => {
    try {
      const reference = String(req.params.reference ?? '').trim();
      if (!reference) {
        return errorResponse(res, 'Reference is required', enums.HTTP_BAD_REQUEST);
      }
      const { fetchBillPaymentStatus } = await import('./flutterwaveService');
      const status = await fetchBillPaymentStatus(reference);
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Bill payment status'),
        enums.HTTP_OK,
        status
      );
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };
}

export const billsController = new BillsController();

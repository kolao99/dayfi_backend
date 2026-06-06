import { Request, Response } from 'express';
import enums from '../../shared/lib/enums';
import { errorResponse, success } from '../../shared/lib/api-response';
import {
  countUnreadNotifications,
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notificationService';

class NotificationController {
  list = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }
      const rows = await listUserNotifications(userId);
      const data = rows.map((row) => ({
        id: row.id,
        title: row.title,
        message: row.message,
        type: row.type,
        read: row.is_read,
        created_at: row.created_at,
        metadata: row.metadata ?? {},
      }));
      return success(
        res,
        enums.FETCHED_SUCCESSFULLY('Notifications'),
        enums.HTTP_OK,
        data
      );
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  unreadCount = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }
      const count = await countUnreadNotifications(userId);
      return success(res, enums.FETCHED_SUCCESSFULLY('Unread count'), enums.HTTP_OK, {
        count,
      });
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  markAllRead = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }
      const updated = await markAllNotificationsRead(userId);
      return success(res, 'Notifications updated', enums.HTTP_OK, {
        updated,
      });
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };

  markRead = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return errorResponse(res, enums.NO_TOKEN, enums.HTTP_UNAUTHORIZED);
      }
      const id = String(req.params.notificationId ?? '').trim();
      if (!id) {
        return errorResponse(res, 'Notification id required', enums.HTTP_BAD_REQUEST);
      }
      const row = await markNotificationRead(userId, id);
      if (!row) {
        return errorResponse(res, 'Notification not found', enums.HTTP_NOT_FOUND);
      }
      return success(res, 'Notification updated', enums.HTTP_OK, {
        notificationId: row.id,
        read: row.is_read,
      });
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_INTERNAL_SERVER_ERROR
      );
    }
  };
}

export default new NotificationController();

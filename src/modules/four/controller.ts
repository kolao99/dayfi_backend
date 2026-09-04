import { Request, Response } from 'express';
import { errorResponse, success } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { isFourError } from './errors';
import { requestOtp, verifyOtp } from './auth/phoneAuthService';
import {
  getUserById,
  toPublicUser,
  updateProfile,
} from './auth/identityService';
import {
  listActiveSessions,
  revokeSessionByToken,
} from './auth/sessionService';
import {
  archiveConversation,
  createConversation,
  getConversationForUser,
  getLatestConversation,
  listConversations,
  toPublicConversation,
} from './conversation/conversationService';
import {
  appendMessage,
  listMessages,
  toPublicMessage,
} from './conversation/messageService';
import { linkTelegramUser } from './telegram/telegramLinkService';
import { processTelegramUpdate } from './telegram/telegramWebhookService';
import { processWhatsappWebhook, processMetaWhatsappWebhook } from './whatsapp/whatsappWebhookService';
import { buildTwimlResponse } from './whatsapp/whatsappReplyContext';
import { verifyMetaWebhookSubscribe } from './whatsapp/metaCloudProvider';
import { isMetaWhatsappProvider } from './whatsapp/whatsappProviderEnv';
import {
  authorizeIntentWithPin,
  buildReviewSummary,
} from './intent/authorizeService';
import {
  getIntentForMiniApp,
  toMiniAppReview,
} from './intent/miniAppService';
import { setupTransactionPin } from './security/pinSetupService';
import {
  getFourKycStatus,
  verifyBvnFromFour,
} from './security/kycVerifyService';

/**
 * Four API controller — auth, conversations, Telegram vertical slice.
 */

function clientIp(req: Request): string | null {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0];
  return (forwarded || req.ip || '').trim() || null;
}

/** Turns a FourError into its safe user-facing message; hides anything else. */
function fail(res: Response, err: unknown, context: string) {
  if (isFourError(err)) {
    if (err.retryAfterSeconds != null) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }
    return errorResponse(res, err.message, err.httpStatus);
  }
  console.error(`[four/controller] ${context}`, err);
  return errorResponse(
    res,
    'Something went wrong. Please try again.',
    enums.HTTP_INTERNAL_SERVER_ERROR
  );
}

class FourController {
  /**
   * POST /api/v1/four/auth/request-otp
   *
   * Response is identical for known and unknown numbers (D1.4).
   */
  requestOtp = async (req: Request, res: Response): Promise<any> => {
    try {
      const result = await requestOtp({
        phone: String(req.body.phone),
        ip: clientIp(req),
      });
      return success(res, 'Verification code sent.', enums.HTTP_OK, result);
    } catch (err) {
      return fail(res, err, 'requestOtp');
    }
  };

  /** POST /api/v1/four/auth/verify-otp */
  verifyOtp = async (req: Request, res: Response): Promise<any> => {
    try {
      const result = await verifyOtp({
        phone: String(req.body.phone),
        code: String(req.body.code),
        ip: clientIp(req),
        deviceLabel: req.body.deviceLabel ?? null,
        platform: req.body.platform ?? null,
      });

      return success(res, 'Signed in.', enums.HTTP_OK, {
        user: result.user,
        isNewUser: result.isNewUser,
        needsProfile: result.needsProfile,
        needsPin: result.needsPin,
        session: {
          // Returned exactly once; the server stores only its hash.
          token: result.session.token,
          expiresAt: result.session.expiresAt,
        },
      });
    } catch (err) {
      return fail(res, err, 'verifyOtp');
    }
  };

  /** GET /api/v1/four/auth/session — session restore on app launch. */
  getSession = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = await getUserById(req.four!.userId);
      if (!user) {
        return errorResponse(
          res,
          'Please sign in again.',
          enums.HTTP_UNAUTHORIZED
        );
      }
      return success(res, 'Session active.', enums.HTTP_OK, {
        user: toPublicUser(user),
        sessionId: req.four!.sessionId,
      });
    } catch (err) {
      return fail(res, err, 'getSession');
    }
  };

  /** POST /api/v1/four/auth/logout — revokes this device's session only. */
  logout = async (req: Request, res: Response): Promise<any> => {
    try {
      const token = req.four?.token;
      if (!token) {
        return errorResponse(
          res,
          'Please sign in again.',
          enums.HTTP_UNAUTHORIZED
        );
      }
      await revokeSessionByToken(token);
      return success(res, 'Signed out.', enums.HTTP_OK, { revoked: true });
    } catch (err) {
      return fail(res, err, 'logout');
    }
  };

  /** GET /api/v1/four/auth/sessions */
  listSessions = async (req: Request, res: Response): Promise<any> => {
    try {
      const sessions = await listActiveSessions(req.four!.userId);
      return success(res, 'Sessions.', enums.HTTP_OK, { sessions });
    } catch (err) {
      return fail(res, err, 'listSessions');
    }
  };

  /** PATCH /api/v1/four/auth/profile */
  updateProfile = async (req: Request, res: Response): Promise<any> => {
    try {
      const user = await updateProfile(req.four!.userId, {
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        email: req.body.email,
      });
      return success(res, 'Profile updated.', enums.HTTP_OK, {
        user: toPublicUser(user),
      });
    } catch (err: any) {
      if (String(err?.code) === '23505') {
        return errorResponse(
          res,
          'That email is already in use.',
          enums.HTTP_CONFLICT
        );
      }
      return fail(res, err, 'updateProfile');
    }
  };

  // ---------------------------------------------------------------------
  // Conversations (Phase 2)
  //
  // Every handler scopes by req.four.userId. A conversation belonging to
  // another user is reported as 404, never 403, so ids cannot be probed.
  // ---------------------------------------------------------------------

  /** GET /api/v1/four/conversations */
  listConversations = async (req: Request, res: Response): Promise<any> => {
    try {
      const conversations = await listConversations(req.four!.userId, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        includeArchived: String(req.query.includeArchived) === 'true',
      });
      return success(res, 'Conversations.', enums.HTTP_OK, {
        conversations: conversations.map(toPublicConversation),
      });
    } catch (err) {
      return fail(res, err, 'listConversations');
    }
  };

  /**
   * POST /api/v1/four/conversations — the "new chat" action.
   * Previous conversations are kept, never deleted (rule §17).
   */
  createConversation = async (req: Request, res: Response): Promise<any> => {
    try {
      const conversation = await createConversation(
        req.four!.userId,
        req.body.title ?? null
      );
      return success(res, 'Conversation created.', enums.HTTP_CREATED, {
        conversation: toPublicConversation(conversation),
      });
    } catch (err) {
      return fail(res, err, 'createConversation');
    }
  };

  /**
   * GET /api/v1/four/conversations/latest — what the app reopens on launch.
   * Pure read: returns null for a new user rather than creating a row.
   */
  getLatestConversation = async (req: Request, res: Response): Promise<any> => {
    try {
      const conversation = await getLatestConversation(req.four!.userId);
      return success(res, 'Latest conversation.', enums.HTTP_OK, {
        conversation: conversation ? toPublicConversation(conversation) : null,
      });
    } catch (err) {
      return fail(res, err, 'getLatestConversation');
    }
  };

  /** GET /api/v1/four/conversations/:id */
  getConversation = async (req: Request, res: Response): Promise<any> => {
    try {
      const conversation = await getConversationForUser(
        req.four!.userId,
        req.params.id
      );
      if (!conversation) {
        return errorResponse(
          res,
          'Conversation not found.',
          enums.HTTP_NOT_FOUND
        );
      }
      return success(res, 'Conversation.', enums.HTTP_OK, {
        conversation: toPublicConversation(conversation),
      });
    } catch (err) {
      return fail(res, err, 'getConversation');
    }
  };

  /** GET /api/v1/four/conversations/:id/messages */
  listMessages = async (req: Request, res: Response): Promise<any> => {
    try {
      const query = (req as any).validatedQuery ?? {};
      const result = await listMessages(req.four!.userId, req.params.id, {
        limit: query.limit,
        before: query.before ?? null,
      });
      if (!result) {
        return errorResponse(
          res,
          'Conversation not found.',
          enums.HTTP_NOT_FOUND
        );
      }
      return success(res, 'Messages.', enums.HTTP_OK, {
        messages: result.messages.map(toPublicMessage),
        nextBefore: result.nextBefore,
        hasMore: result.hasMore,
      });
    } catch (err) {
      return fail(res, err, 'listMessages');
    }
  };

  /** POST /api/v1/four/messages */
  postMessage = async (req: Request, res: Response): Promise<any> => {
    try {
      const result = await appendMessage({
        userId: req.four!.userId,
        conversationId: req.body.conversationId,
        role: req.body.role,
        type: req.body.type,
        content: req.body.content ?? null,
        metadata: req.body.metadata,
        clientMessageId: req.body.clientMessageId ?? null,
      });

      if (!result) {
        return errorResponse(
          res,
          'Conversation not found.',
          enums.HTTP_NOT_FOUND
        );
      }

      return success(
        res,
        result.deduplicated ? 'Message already recorded.' : 'Message saved.',
        result.deduplicated ? enums.HTTP_OK : enums.HTTP_CREATED,
        {
          message: toPublicMessage(result.message),
          deduplicated: result.deduplicated,
        }
      );
    } catch (err) {
      return fail(res, err, 'postMessage');
    }
  };

  /** DELETE /api/v1/four/conversations/:id — archive, not destroy. */
  archiveConversation = async (req: Request, res: Response): Promise<any> => {
    try {
      const archived = await archiveConversation(
        req.four!.userId,
        req.params.id
      );
      if (!archived) {
        return errorResponse(
          res,
          'Conversation not found.',
          enums.HTTP_NOT_FOUND
        );
      }
      return success(res, 'Conversation archived.', enums.HTTP_OK, {
        archived: true,
      });
    } catch (err) {
      return fail(res, err, 'archiveConversation');
    }
  };

  /** POST /api/v1/four/telegram/webhook */
  telegramWebhook = async (req: Request, res: Response): Promise<any> => {
    try {
      const result = await processTelegramUpdate(req.body);
      return success(res, 'OK', enums.HTTP_OK, result);
    } catch (err) {
      return fail(res, err, 'telegramWebhook');
    }
  };

  /** GET /api/v1/four/whatsapp/webhook — Meta webhook verification */
  whatsappWebhookVerify = (req: Request, res: Response): any => {
    const result = verifyMetaWebhookSubscribe(
      req.query as Record<string, unknown>
    );
    if (result.ok) {
      return res.status(200).type('text/plain').send(result.challenge);
    }
    console.warn(`[four/whatsapp] Meta verify failed: ${result.reason}`);
    return res.status(403).type('text/plain').send('Forbidden');
  };

  /** POST /api/v1/four/whatsapp/webhook — Twilio or Meta WhatsApp inbound */
  whatsappWebhook = async (req: Request, res: Response): Promise<any> => {
    try {
      if (isMetaWhatsappProvider()) {
        void processMetaWhatsappWebhook(req.body).catch((err) => {
          console.error('[four/whatsapp] Meta inbound handler failed', err);
        });
        return res.status(200).type('text/plain').send('EVENT_RECEIVED');
      }

      const result = await processWhatsappWebhook(req.body);
      res.status(enums.HTTP_OK);
      res.type('text/xml');
      return res.send(buildTwimlResponse(result.twimlBodies ?? []));
    } catch (err) {
      return fail(res, err, 'whatsappWebhook');
    }
  };

  /** POST /api/v1/four/telegram/link — after phone OTP in Mini App */
  linkTelegram = async (req: Request, res: Response): Promise<any> => {
    try {
      const link = await linkTelegramUser({
        userId: req.four!.userId,
        telegramUserId: req.body.telegramUserId,
        chatId: req.body.chatId ?? null,
        username: req.body.username ?? null,
      });
      return success(res, 'Telegram linked.', enums.HTTP_OK, {
        telegramUserId: link.telegram_user_id,
        linkedAt: link.linked_at,
      });
    } catch (err) {
      return fail(res, err, 'linkTelegram');
    }
  };

  /** GET /api/v1/four/intents/:id — Mini App review surface */
  getIntent = async (req: Request, res: Response): Promise<any> => {
    try {
      const intent = await getIntentForMiniApp(
        req.four!.userId,
        req.params.id
      );
      const pub = toMiniAppReview(intent);
      return success(res, 'Intent.', enums.HTTP_OK, {
        intent: pub,
        summary: buildReviewSummary(pub),
      });
    } catch (err) {
      return fail(res, err, 'getIntent');
    }
  };

  /** POST /api/v1/four/intents/:id/authorize — PIN + execute */
  authorizeIntent = async (req: Request, res: Response): Promise<any> => {
    try {
      const result = await authorizeIntentWithPin({
        userId: req.four!.userId,
        intentId: req.params.id,
        pin: String(req.body.pin),
      });
      return success(res, 'Authorized.', enums.HTTP_OK, result);
    } catch (err) {
      return fail(res, err, 'authorizeIntent');
    }
  };

  /** POST /api/v1/four/security/setup-pin — Telegram Mini App PIN creation */
  setupPin = async (req: Request, res: Response): Promise<any> => {
    try {
      await setupTransactionPin({
        userId: req.four!.userId,
        pin: String(req.body.pin),
        confirmPin: String(req.body.confirmPin),
      });
      return success(res, 'PIN secured.', enums.HTTP_OK, { ok: true });
    } catch (err) {
      return fail(res, err, 'setupPin');
    }
  };

  /** GET /api/v1/four/kyc/status — Mini App KYC status surface */
  getKycStatus = async (req: Request, res: Response): Promise<any> => {
    try {
      const snapshot = await getFourKycStatus(req.four!.userId);
      // Tell the frontend if name fields are needed for BVN verification
      const user = await getUserById(req.four!.userId);
      const nameNeeded =
        !String(user?.first_name ?? '').trim() ||
        !String(user?.last_name ?? '').trim();
      return success(res, 'KYC status.', enums.HTTP_OK, {
        ...snapshot,
        nameNeeded,
      });
    } catch (err) {
      return fail(res, err, 'getKycStatus');
    }
  };

  /** POST /api/v1/four/kyc/verify-bvn — delegates to existing Dayfi KYC service */
  verifyKycBvn = async (req: Request, res: Response): Promise<any> => {
    try {
      const result = await verifyBvnFromFour({
        userId: req.four!.userId,
        bvn: String(req.body.bvn),
        firstName: req.body.firstName ? String(req.body.firstName) : undefined,
        lastName: req.body.lastName ? String(req.body.lastName) : undefined,
      });
      return success(res, 'BVN verified.', enums.HTTP_OK, result);
    } catch (err) {
      if (err instanceof Error && err.message) {
        return errorResponse(res, err.message, enums.HTTP_BAD_REQUEST);
      }
      return fail(res, err, 'verifyKycBvn');
    }
  };
}

export default new FourController();

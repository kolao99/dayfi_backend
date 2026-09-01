import express from 'express';
import fourController from './controller';
import fourValidator from './validator';
import { requireFourSession, requireFourSessionOrTelegramWebApp, requireTelegramWebhookSecret } from './middleware';

/**
 * Four API — mounted at /api/v1/four.
 *
 * Phase 1 exposes authentication; Phase 2 adds backend-owned conversations.
 * The request planner, authorization and execution land in later phases.
 *
 * Only the two OTP endpoints are public; everything else requires a Four
 * session. Four never accepts a Dayfi organization API key.
 */
const fourRouter = express.Router();

fourRouter.post(
  '/auth/request-otp',
  fourValidator.requestOtp,
  fourController.requestOtp
);

fourRouter.post(
  '/auth/verify-otp',
  fourValidator.verifyOtp,
  fourController.verifyOtp
);

fourRouter.get('/auth/session', requireFourSession, fourController.getSession);

fourRouter.post('/auth/logout', requireFourSession, fourController.logout);

fourRouter.get(
  '/auth/sessions',
  requireFourSession,
  fourController.listSessions
);

fourRouter.patch(
  '/auth/profile',
  requireFourSession,
  fourValidator.updateProfile,
  fourController.updateProfile
);

// --- Conversations (Phase 2) -------------------------------------------
// The backend is the source of truth for chat history (rule §16), so every
// one of these requires a session and is scoped to the session's user.

fourRouter.get(
  '/conversations',
  requireFourSession,
  fourController.listConversations
);

fourRouter.post(
  '/conversations',
  requireFourSession,
  fourValidator.createConversation,
  fourController.createConversation
);

// Declared before '/conversations/:id' so "latest" is not read as an id.
fourRouter.get(
  '/conversations/latest',
  requireFourSession,
  fourController.getLatestConversation
);

fourRouter.get(
  '/conversations/:id',
  requireFourSession,
  fourController.getConversation
);

fourRouter.get(
  '/conversations/:id/messages',
  requireFourSession,
  fourValidator.listMessagesQuery,
  fourController.listMessages
);

fourRouter.delete(
  '/conversations/:id',
  requireFourSession,
  fourController.archiveConversation
);

fourRouter.post(
  '/messages',
  requireFourSession,
  fourValidator.postMessage,
  fourController.postMessage
);

// --- Telegram + vertical slice (Phase 3) --------------------------------

fourRouter.post(
  '/telegram/webhook',
  requireTelegramWebhookSecret,
  fourController.telegramWebhook
);

fourRouter.post(
  '/telegram/link',
  requireFourSession,
  fourValidator.linkTelegram,
  fourController.linkTelegram
);

fourRouter.get(
  '/intents/:id',
  requireFourSessionOrTelegramWebApp,
  fourController.getIntent
);

fourRouter.post(
  '/intents/:id/authorize',
  requireFourSessionOrTelegramWebApp,
  fourValidator.authorizeIntent,
  fourController.authorizeIntent
);

fourRouter.post(
  '/security/setup-pin',
  requireFourSessionOrTelegramWebApp,
  fourValidator.setupPin,
  fourController.setupPin
);

export { fourRouter };

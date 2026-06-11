import { Request, Response } from 'express';
import { errorResponse, success } from '../../shared/lib/api-response';
import enums from '../../shared/lib/enums';
import { processDayxFlowTurn } from './dayxFlowService';
import { chatWithDayx, getDayxStatus } from './dayxService';
import { chatWithDayxV2 } from './dayxV2Service';
import {
  getYarnGptStatus,
  synthesizeYarnGptSpeech,
} from './dayxTtsService';

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
          'DayX AI is not configured on the server. Set GROQ_API_KEY (or OPENAI_API_KEY).',
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

  v2Status = async (_req: Request, res: Response): Promise<any> => {
    const dayx = getDayxStatus();
    const tts = getYarnGptStatus();
    return success(res, 'DayX v2 status', enums.HTTP_OK, {
      ...dayx,
      tts,
      version: 2,
    });
  };

  v2Chat = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const { message, history, voiceName, firstName, isFirstSession } =
        req.body;

      const result = await chatWithDayxV2({
        userId,
        message: String(message),
        history: Array.isArray(history) ? history : [],
        voiceName: voiceName ? String(voiceName) : undefined,
        firstName: firstName ? String(firstName) : undefined,
        isFirstSession: isFirstSession === true,
      });

      return success(res, 'DayX v2 reply', enums.HTTP_OK, result);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg === 'DAYX_AI_UNAVAILABLE') {
        return errorResponse(
          res,
          'DayX AI is not configured on the server. Set GROQ_API_KEY (or OPENAI_API_KEY).',
          enums.HTTP_SERVICE_UNAVAILABLE
        );
      }
      return errorResponse(
        res,
        msg || 'DayX v2 chat failed',
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  tts = async (req: Request, res: Response): Promise<any> => {
    try {
      const { text, voice, format } = req.body;
      const { buffer, format: outFormat, voice: usedVoice } =
        await synthesizeYarnGptSpeech({
          text: String(text),
          voice: voice ? String(voice) : undefined,
          format: format as 'mp3' | 'wav' | 'opus' | 'flac' | undefined,
        });

      return success(res, 'Speech synthesized', enums.HTTP_OK, {
        audioBase64: buffer.toString('base64'),
        format: outFormat,
        voice: usedVoice,
        mimeType:
          outFormat === 'mp3'
            ? 'audio/mpeg'
            : outFormat === 'wav'
              ? 'audio/wav'
              : 'audio/octet-stream',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'YARNGPT_NOT_CONFIGURED') {
        return errorResponse(
          res,
          'YarnGPT TTS is not configured. Set YARNGPT_API_KEY on the server.',
          enums.HTTP_SERVICE_UNAVAILABLE
        );
      }
      return errorResponse(
        res,
        msg || 'TTS failed',
        enums.HTTP_BAD_REQUEST
      );
    }
  };

  voices = async (_req: Request, res: Response): Promise<any> => {
    return success(
      res,
      'TTS voices',
      enums.HTTP_OK,
      getYarnGptStatus()
    );
  };

  flowTurn = async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.user?.user_id as string;
      const result = await processDayxFlowTurn(userId, req.body);
      return success(res, 'DayX flow', enums.HTTP_OK, result);
    } catch (err: unknown) {
      return errorResponse(
        res,
        err instanceof Error ? err.message : String(err),
        enums.HTTP_BAD_REQUEST
      );
    }
  };
}

export const dayxController = new DayxController();

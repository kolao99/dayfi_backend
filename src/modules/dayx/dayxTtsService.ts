import axios from 'axios';

export const YARNGPT_VOICES = [
  'Idera',
  'Emma',
  'Zainab',
  'Osagie',
  'Wura',
  'Jude',
  'Chinenye',
  'Tayo',
  'Regina',
  'Femi',
  'Adaora',
  'Umar',
  'Mary',
  'Nonso',
  'Remi',
  'Adam',
] as const;

export type YarnGptVoice = (typeof YARNGPT_VOICES)[number];
export type YarnGptFormat = 'mp3' | 'wav' | 'opus' | 'flac';

export function yarnGptConfigured(): boolean {
  return Boolean(process.env.YARNGPT_API_KEY?.trim());
}

export function getYarnGptStatus() {
  return {
    enabled: yarnGptConfigured(),
    provider: 'yarngpt',
    defaultVoice:
      process.env.YARNGPT_DEFAULT_VOICE?.trim() || 'Idera',
    voices: [...YARNGPT_VOICES],
  };
}

export async function synthesizeYarnGptSpeech(params: {
  text: string;
  voice?: string;
  format?: YarnGptFormat;
}): Promise<{ buffer: Buffer; format: YarnGptFormat; voice: string }> {
  const apiKey = process.env.YARNGPT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('YARNGPT_NOT_CONFIGURED');
  }

  const text = params.text.trim().slice(0, 2000);
  if (!text) {
    throw new Error('Text is required for speech synthesis');
  }

  const voice =
    params.voice?.trim() ||
    process.env.YARNGPT_DEFAULT_VOICE?.trim() ||
    'Idera';
  const format = params.format ?? 'mp3';

  const response = await axios.post<ArrayBuffer>(
    'https://yarngpt.ai/api/v1/tts',
    {
      text,
      voice,
      response_format: format,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 120000,
      validateStatus: (status) => status < 500,
    }
  );

  if (response.status >= 400) {
    let detail = `YarnGPT TTS failed (${response.status})`;
    try {
      const errText = Buffer.from(response.data).toString('utf8');
      const parsed = JSON.parse(errText) as { detail?: string; message?: string };
      detail = parsed.detail ?? parsed.message ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }

  const buffer = Buffer.from(response.data);
  if (buffer.length < 256) {
    throw new Error('YarnGPT returned an empty or invalid audio response');
  }

  return { buffer, format, voice };
}

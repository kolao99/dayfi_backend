import axios from 'axios';

export function isDayxAiConfigured(): boolean {
  return Boolean(
    process.env.GROQ_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  );
}

function resolveProvider(): 'groq' | 'openai' {
  return process.env.GROQ_API_KEY?.trim() ? 'groq' : 'openai';
}

function resolveModel(provider: 'groq' | 'openai'): string {
  if (provider === 'groq') {
    return process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile';
  }
  return process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
}

function resolveApiUrl(provider: 'groq' | 'openai'): string {
  if (provider === 'groq') {
    return (
      process.env.GROQ_BASE_URL?.trim() ||
      'https://api.groq.com/openai/v1/chat/completions'
    );
  }
  return 'https://api.openai.com/v1/chat/completions';
}

function resolveApiKey(provider: 'groq' | 'openai'): string {
  if (provider === 'groq') {
    return process.env.GROQ_API_KEY!.trim();
  }
  return process.env.OPENAI_API_KEY!.trim();
}

/** Low-temperature JSON completion for NLU / slot extraction. */
export async function chatJsonCompletion(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<Record<string, unknown>> {
  if (!isDayxAiConfigured()) {
    throw new Error('DAYX_AI_UNAVAILABLE');
  }

  const provider = resolveProvider();
  const { data } = await axios.post<{
    choices?: { message?: { content?: string } }[];
  }>(
    resolveApiUrl(provider),
    {
      model: resolveModel(provider),
      temperature: 0.1,
      max_tokens: params.maxTokens ?? 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${resolveApiKey(provider)}`,
        'Content-Type': 'application/json',
      },
      timeout: 25000,
    }
  );

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty AI response');
  return JSON.parse(content) as Record<string, unknown>;
}

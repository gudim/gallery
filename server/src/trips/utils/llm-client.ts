import { serverVersion } from 'src/constants.js';
import { llmUrlRefusal } from 'src/trips/utils/llm-url.js';
import { TripTextPart, TripTextsError } from 'src/trips/utils/texts.js';

// One call to an OpenAI-compatible server (trips DECISIONS-LOG 2026-11-01): `/chat/completions` with a strict JSON
// schema, as travel-album's OpenAIClient.

export type TripLlmConfig = { url: string; model: string; key: string | null };

const TIMEOUT_MS = 10 * 60 * 1000;
// Answers a retry cannot change: a bad key or no access (DECISIONS-LOG 2026-11-01).
const SETTINGS_STATUSES = new Set([401, 403]);
// The geo services' User-Agent carries the operator's contact for OpenStreetMap; an LLM server gets only the name.
const USER_AGENT = `gallery-server/${serverVersion}`;

export const completeTripText = async (
  config: TripLlmConfig,
  request: { system: string; parts: TripTextPart[]; schema: object },
): Promise<unknown> => {
  const refusal = await llmUrlRefusal(config.url);
  if (refusal) {
    throw new TripTextsError(refusal, false);
  }
  const url = `${config.url.replace(/\/+$/, '')}/chat/completions`;
  const content = request.parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data.toString('base64')}` } },
  );
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  if (config.key) {
    headers.Authorization = `Bearer ${config.key}`;
  }
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'texts', strict: true, schema: request.schema } },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // A redirect could lead inside the server's network.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new TripTextsError(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The answer's body goes to the log only: whatever the URL points at, the user sees just the status.
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new TripTextsError(
      `${url}: HTTP ${response.status}`,
      !SETTINGS_STATUSES.has(response.status),
      text.slice(0, 500),
    );
  }

  let answerText: string;
  let finish: unknown;
  try {
    const data = (await response.json()) as {
      choices: Array<{ finish_reason: unknown; message: { content: string } }>;
    };
    finish = data.choices[0].finish_reason;
    answerText = data.choices[0].message.content;
  } catch {
    throw new TripTextsError(`${url}: unexpected answer of the server`);
  }
  if (finish !== 'stop') {
    throw new TripTextsError(`The model stopped: ${String(finish)}`);
  }
  try {
    return JSON.parse(answerText) as unknown;
  } catch (error) {
    throw new TripTextsError(`The model's answer is not JSON: ${(error as Error).message}`);
  }
};

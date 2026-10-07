import { BrainError, chat } from './brain.mjs';

export const SILENCE_PEAK = 0.005;

const MODEL = 'openai/gpt-audio-mini';
const NOTHING = 'NO_SPEECH';

const HALLUCINATIONS = new Set([
  'you', 'thank you', 'thanks for watching', 'thank you for watching', 'bye', 'okay', 'ok',
  'so', 'uh', 'um', 'hmm', 'mm', 'please subscribe',
]);

const FORMATS = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3',
                  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
                  'audio/flac': 'flac' };

const PROMPT = `You transcribe short spoken questions for a voice assistant used by an older adult.
Write down exactly what was said, in plain English with normal punctuation - nothing else.
Do not answer the question, translate, summarise, or add quotation marks or labels.
Older voices may be quiet, slow, or trail off; transcribe what you can make out.
If there is no intelligible speech at all - silence, breathing, background noise - reply with exactly ${NOTHING}.`;

export async function transcribe(bytes, mimeType) {
  const format = FORMATS[(mimeType || '').split(';')[0].trim().toLowerCase()] || 'wav';
  const msg = await chat([
    { role: 'system', content: PROMPT },
    { role: 'user', content: [
      { type: 'text', text: 'Transcribe this recording.' },
      { type: 'input_audio', input_audio: { data: Buffer.from(bytes).toString('base64'), format } },
    ] },
  ], { model: process.env.HACKCLUB_STT_MODEL || MODEL, temperature: 0, maxTokens: 300 });

  let text = (msg.content || '').trim().replace(/^["'“]+|["'”]+$/g, '').trim();
  if (!text || text.includes(NOTHING)) return '';
  const bare = text.toLowerCase().replace(/[^a-z0-9.\s]/g, '').trim().replace(/\.$/, '');
  if (HALLUCINATIONS.has(bare) || bare.length < 2) return '';
  return text;
}

export { BrainError };

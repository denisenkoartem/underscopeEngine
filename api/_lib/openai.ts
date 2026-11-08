// Shared OpenAI client, used for photo grading (Karthik's OpenAI credit).
// Files under api/_lib are not exposed as Vercel routes.
import OpenAI from 'openai';

export function openaiClient(): { ai: OpenAI; model: string } | null {
  const apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) return null;
  return { ai: new OpenAI({ apiKey }), model };
}

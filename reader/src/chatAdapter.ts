// Chat-completions adapter for the extraction call: lets the parser talk to any OpenAI-compatible
// server (vLLM, Ollama, a hosted LoRA endpoint) that serves /v1/chat/completions but not the
// Responses API. Used when PARSER_BASE_URL is set (src/parse.ts parseFreeText); the market call and
// the category scorers keep the hosted Responses API (they need web search or are not affected).
//
// It implements ParserClient.responses.create: the Responses request becomes a chat request
// (instructions -> system message, input -> user message, text.format json_schema ->
// response_format json_schema, max_output_tokens -> max_tokens; store and reasoning are dropped),
// and the chat reply becomes a Response with the fields the parser reads (output text or refusal,
// status, incomplete reason, usage).

import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { parserTimeoutMs, type ParserClient } from "./modelClient.js";

/** The one chat method the adapter uses; tests inject a fake. */
export interface ChatClient {
  chat: { completions: { create(body: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> } };
}

/** The chat request for a Responses request. Throws for what chat completions cannot express (tools, non-text input). */
export function toChatRequest(body: ResponseCreateParamsNonStreaming): ChatCompletionCreateParamsNonStreaming {
  if (body.tools && body.tools.length > 0) {
    throw new Error("the chat-completions adapter cannot send tools (web search needs the Responses API)");
  }
  if (typeof body.input !== "string") throw new Error("the chat-completions adapter only sends text input");
  const messages: ChatCompletionCreateParamsNonStreaming["messages"] = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  messages.push({ role: "user", content: body.input });
  const req: ChatCompletionCreateParamsNonStreaming = { model: String(body.model), messages };
  const format = body.text?.format;
  if (format?.type === "json_schema") {
    req.response_format = {
      type: "json_schema",
      json_schema: { name: format.name, schema: format.schema, ...(format.strict != null ? { strict: format.strict } : {}) },
    };
  } else if (format?.type === "json_object") {
    req.response_format = { type: "json_object" };
  }
  if (body.temperature != null) req.temperature = body.temperature;
  // max_tokens, not max_completion_tokens: local servers (Ollama, older vLLM) only read max_tokens.
  if (body.max_output_tokens != null) req.max_tokens = body.max_output_tokens;
  return req;
}

/** The Response the parser expects, built from a chat reply (first choice only). */
export function fromChatCompletion(c: ChatCompletion): Response {
  const choice = c.choices[0];
  const message = choice?.message;
  const content =
    message?.refusal != null && message.refusal !== ""
      ? [{ type: "refusal", refusal: message.refusal }]
      : [{ type: "output_text", text: message?.content ?? "", annotations: [] }];
  const finish = choice?.finish_reason;
  const incompleteReason = finish === "length" ? "max_output_tokens" : finish === "content_filter" ? "content_filter" : null;
  const u = c.usage;
  return {
    id: c.id,
    object: "response",
    created_at: c.created,
    model: c.model,
    status: incompleteReason ? "incomplete" : "completed",
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    error: null,
    output: [{ type: "message", id: `${c.id}_msg`, role: "assistant", status: "completed", content }],
    usage: {
      input_tokens: u?.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens: u?.completion_tokens ?? 0,
      output_tokens_details: { reasoning_tokens: u?.completion_tokens_details?.reasoning_tokens ?? 0 },
      total_tokens: u?.total_tokens ?? 0,
    },
  } as unknown as Response;
}

/** A ParserClient that sends every request as a chat completion. */
export function chatParserClient(chat: ChatClient): ParserClient {
  return {
    responses: {
      async create(body) {
        return fromChatCompletion(await chat.chat.completions.create(toChatRequest(body)));
      },
    },
  };
}

/**
 * The extraction client for PARSER_BASE_URL: an OpenAI SDK client pointed at that server, no SDK
 * retries (callModel retries once itself), the parser timeout. The key is PARSER_API_KEY, never
 * OPENAI_API_KEY (that key must not be sent to another host); local servers accept any string.
 */
export function createCompatClient(baseURL: string, env: NodeJS.ProcessEnv = process.env): ParserClient {
  const apiKey = env.PARSER_API_KEY || "none";
  return chatParserClient(new OpenAI({ apiKey, baseURL, timeout: parserTimeoutMs(env), maxRetries: 0 }));
}

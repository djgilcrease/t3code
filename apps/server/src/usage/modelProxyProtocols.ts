import { ModelProxyError, type ModelProxyProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ProxyPayload = Schema.Record(Schema.String, Schema.Unknown);
export type ProxyPayload = typeof ProxyPayload.Type;
const decodePayload = Schema.decodeUnknownSync(ProxyPayload);
const isPayload = Schema.is(ProxyPayload);
export function object(value: unknown): ProxyPayload {
  return isPayload(value) ? value : {};
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value)
    .map((part) => object(part).text ?? "")
    .join("");
}

export function proxyProviderForModel(model: string): ModelProxyProvider {
  const prefix = model.split("/")[0];
  if (["codex", "claude", "gemini", "antigravity", "kimi", "xai"].includes(prefix!))
    return prefix as ModelProxyProvider;
  if (model.startsWith("claude-")) return "claude";
  if (model.startsWith("gemini-")) return "gemini";
  if (model.startsWith("grok-")) return "xai";
  if (model.startsWith("kimi-")) return "kimi";
  return "codex";
}
export function unprefixProxyModel(model: string): string {
  const provider = proxyProviderForModel(model);
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

function chatToResponses(body: ProxyPayload): ProxyPayload {
  const instructions: string[] = [];
  const input = array(body.messages).flatMap((raw): ProxyPayload[] => {
    const message = object(raw);
    if (message.role === "system" || message.role === "developer") {
      instructions.push(text(message.content));
      return [];
    }
    if (message.role === "tool")
      return [
        {
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: text(message.content),
        },
      ];
    const result: ProxyPayload[] = [];
    if (message.content !== null && message.content !== undefined) {
      const content =
        typeof message.content === "string"
          ? [
              {
                type: message.role === "assistant" ? "output_text" : "input_text",
                text: message.content,
              },
            ]
          : array(message.content).map((rawPart) => {
              const part = object(rawPart);
              if (part.type === "image_url")
                return { type: "input_image", image_url: object(part.image_url).url };
              return { ...part, type: message.role === "assistant" ? "output_text" : "input_text" };
            });
      result.push({ role: message.role, content });
    }
    for (const rawCall of array(message.tool_calls)) {
      const call = object(rawCall);
      const fn = object(call.function);
      result.push({
        type: "function_call",
        call_id: call.id,
        name: fn.name,
        arguments: fn.arguments,
      });
    }
    return result;
  });
  return {
    model: body.model,
    input,
    instructions: instructions.join("\n\n"),
    ...(body.tools
      ? {
          tools: array(body.tools).map((raw) => {
            const tool = object(raw);
            return tool.type === "function" ? { type: "function", ...object(tool.function) } : tool;
          }),
        }
      : {}),
    ...(body.tool_choice
      ? {
          tool_choice:
            typeof body.tool_choice === "object"
              ? { type: "function", name: object(object(body.tool_choice).function).name }
              : body.tool_choice,
        }
      : {}),
    ...(body.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(body.reasoning_effort ? { reasoning: { effort: body.reasoning_effort } } : {}),
    ...(body.response_format ? { text: { format: body.response_format } } : {}),
    ...(body.service_tier ? { service_tier: body.service_tier } : {}),
    ...((body.max_tokens ?? body.max_completion_tokens)
      ? { max_output_tokens: body.max_tokens ?? body.max_completion_tokens }
      : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
  };
}
function chatToClaude(body: ProxyPayload): ProxyPayload {
  const system: unknown[] = [];
  const messages = array(body.messages).flatMap((raw): ProxyPayload[] => {
    const message = object(raw);
    if (message.role === "system" || message.role === "developer") {
      system.push({ type: "text", text: text(message.content) });
      return [];
    }
    if (message.role === "tool")
      return [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content: text(message.content),
            },
          ],
        },
      ];
    const content: unknown[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : array(message.content).map((part) => {
            const value = object(part);
            if (value.type !== "image_url") return value;
            const url = String(object(value.image_url).url ?? "");
            const match = /^data:([^;]+);base64,(.+)$/su.exec(url);
            return {
              type: "image",
              source: match
                ? { type: "base64", media_type: match[1], data: match[2] }
                : { type: "url", url },
            };
          });
    for (const rawCall of array(message.tool_calls)) {
      const call = object(rawCall);
      const fn = object(call.function);
      const input = typeof fn.arguments === "string" ? decodePayload(JSON.parse(fn.arguments)) : {};
      content.push({ type: "tool_use", id: call.id, name: fn.name, input });
    }
    return [{ role: message.role === "assistant" ? "assistant" : "user", content }];
  });
  return {
    model: body.model,
    messages,
    system,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8192,
    stream: body.stream ?? false,
    ...(body.tools
      ? {
          tools: array(body.tools).map((raw) => {
            const fn = object(object(raw).function);
            return { name: fn.name, description: fn.description, input_schema: fn.parameters };
          }),
        }
      : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.tool_choice
      ? {
          tool_choice:
            body.tool_choice === "required"
              ? { type: "any" }
              : body.tool_choice === "auto"
                ? { type: "auto" }
                : body.tool_choice === "none"
                  ? { type: "none" }
                  : { type: "tool", name: object(object(body.tool_choice).function).name },
        }
      : {}),
  };
}

function responsesToChat(body: ProxyPayload): ProxyPayload {
  const messages: ProxyPayload[] = body.instructions
    ? [{ role: "system", content: text(body.instructions) }]
    : [];
  const input =
    typeof body.input === "string" ? [{ role: "user", content: body.input }] : array(body.input);
  for (const raw of input) {
    const item = object(raw);
    if (item.type === "function_call")
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          },
        ],
      });
    else if (item.type === "function_call_output")
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
    else if (item.role)
      messages.push({
        role: item.role,
        content:
          typeof item.content === "string"
            ? item.content
            : array(item.content).map((rawPart) => {
                const part = object(rawPart);
                return part.type === "input_image"
                  ? { type: "image_url", image_url: { url: part.image_url } }
                  : { type: "text", text: part.text };
              }),
      });
  }
  return {
    ...body,
    messages,
    max_tokens: body.max_output_tokens,
    reasoning_effort: object(body.reasoning).effort,
    tools: array(body.tools).map((raw) => {
      const tool = object(raw);
      return {
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      };
    }),
    ...(typeof body.tool_choice === "object"
      ? { tool_choice: { type: "function", function: { name: object(body.tool_choice).name } } }
      : {}),
  };
}

function claudeToChat(body: ProxyPayload): ProxyPayload {
  const messages: ProxyPayload[] = body.system
    ? [{ role: "system", content: text(body.system) }]
    : [];
  for (const raw of array(body.messages)) {
    const message = object(raw);
    if (typeof message.content === "string") {
      messages.push(message);
      continue;
    }
    const content: unknown[] = [];
    const tools: unknown[] = [];
    for (const rawPart of array(message.content)) {
      const part = object(rawPart);
      if (part.type === "tool_result")
        messages.push({
          role: "tool",
          tool_call_id: part.tool_use_id,
          content: text(part.content),
        });
      else if (part.type === "tool_use")
        tools.push({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
      else if (part.type === "text") content.push({ type: "text", text: part.text });
      else if (part.type === "image") {
        const source = object(part.source);
        content.push({
          type: "image_url",
          image_url: {
            url:
              source.type === "url"
                ? source.url
                : `data:${source.media_type};base64,${source.data}`,
          },
        });
      }
    }
    if (content.length || tools.length)
      messages.push({
        role: message.role,
        content: content.length ? content : null,
        ...(tools.length ? { tool_calls: tools } : {}),
      });
  }
  const choice = object(body.tool_choice);
  return {
    model: body.model,
    messages,
    stream: body.stream,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    tools: array(body.tools).map((raw) => {
      const tool = object(raw);
      return {
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      };
    }),
    ...(choice.type
      ? {
          tool_choice:
            choice.type === "tool"
              ? { type: "function", function: { name: choice.name } }
              : choice.type === "any"
                ? "required"
                : choice.type,
        }
      : {}),
  };
}

function chatToGoogle(body: ProxyPayload): ProxyPayload {
  const system: unknown[] = [];
  const choice = object(body.tool_choice);
  const functionName = object(choice.function).name;
  const toolMode =
    body.tool_choice === "none"
      ? "NONE"
      : body.tool_choice === "auto"
        ? "AUTO"
        : body.tool_choice === "required" || choice.type === "function"
          ? "ANY"
          : undefined;
  const maxOutputTokens = body.max_tokens ?? body.max_completion_tokens;
  const toolNames = new Map<string, string>();
  const contents = array(body.messages).flatMap((raw): ProxyPayload[] => {
    const message = object(raw);
    if (message.role === "system" || message.role === "developer") {
      system.push({ text: text(message.content) });
      return [];
    }
    if (message.role === "tool")
      return [
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: toolNames.get(String(message.tool_call_id)) ?? "tool",
                response: { result: message.content },
              },
            },
          ],
        },
      ];
    const parts: unknown[] =
      typeof message.content === "string"
        ? [{ text: message.content }]
        : array(message.content).map((rawPart) => {
            const part = object(rawPart);
            if (part.type !== "image_url") return { text: part.text };
            const url = String(object(part.image_url).url);
            const match = /^data:([^;]+);base64,(.+)$/su.exec(url);
            return match
              ? { inlineData: { mimeType: match[1], data: match[2] } }
              : { fileData: { fileUri: url } };
          });
    for (const rawCall of array(message.tool_calls)) {
      const call = object(rawCall);
      const fn = object(call.function);
      toolNames.set(String(call.id), String(fn.name));
      parts.push({
        functionCall: {
          name: fn.name,
          args: typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : {},
        },
      });
    }
    return parts.length ? [{ role: message.role === "assistant" ? "model" : "user", parts }] : [];
  });
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: system } } : {}),
    generationConfig: {
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    },
    ...(array(body.tools).length
      ? {
          tools: [
            { functionDeclarations: array(body.tools).map((raw) => object(object(raw).function)) },
          ],
        }
      : {}),
    ...(toolMode
      ? {
          toolConfig: {
            functionCallingConfig: {
              mode: toolMode,
              ...(choice.type === "function" && typeof functionName === "string"
                ? { allowedFunctionNames: [functionName] }
                : {}),
            },
          },
        }
      : {}),
  };
}

/** Request shape sent upstream; the original protocol stays intact on native routes. */
export function prepareProxyRequest(
  provider: ModelProxyProvider,
  apiKey: boolean,
  path: string,
  payload: ProxyPayload,
) {
  const queryIndex = path.indexOf("?");
  const route = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : path.slice(queryIndex);
  const chat = route === "/v1/chat/completions";
  const body: ProxyPayload = {
    ...payload,
    ...(typeof payload.model === "string" ? { model: unprefixProxyModel(payload.model) } : {}),
  };
  const responses = route === "/v1/responses";
  const messages = route === "/v1/messages";
  const normalized = responses ? responsesToChat(body) : messages ? claudeToChat(body) : body;
  if (provider === "codex") {
    if (!responses && route !== "/v1/responses/compact" && !chat && !messages)
      throw new ModelProxyError({ operation: "unsupported" });
    const converted = chat || messages ? chatToResponses(normalized) : body;
    const translation = chat
      ? ("responses-chat" as const)
      : messages
        ? ("responses-claude" as const)
        : ("native" as const);
    if (apiKey)
      return {
        url: `https://api.openai.com${chat || messages ? "/v1/responses" : route + query}`,
        body: { ...converted, stream: body.stream ?? false },
        translation,
      };
    const {
      max_output_tokens: _max,
      temperature: _temperature,
      top_p: _topP,
      previous_response_id: _previous,
      ...supported
    } = converted;
    const compact = route.endsWith("/compact");
    return {
      url: `https://chatgpt.com/backend-api/codex/responses${compact ? "/compact" : ""}${translation === "native" ? query : ""}`,
      body: {
        ...supported,
        ...(typeof supported.input === "string"
          ? { input: [{ role: "user", content: [{ type: "input_text", text: supported.input }] }] }
          : {}),
        instructions: supported.instructions ?? "",
        store: false,
        ...(!compact ? { stream: true } : {}),
      },
      translation,
    };
  }
  if (provider === "claude" || provider === "kimi") {
    if (!messages && route !== "/v1/messages/count_tokens" && !chat && !responses)
      throw new ModelProxyError({ operation: "unsupported" });
    return {
      url: `${provider === "claude" ? "https://api.anthropic.com" : "https://api.kimi.com/coding"}${chat || responses ? "/v1/messages" : route + query}`,
      body: chat || responses ? chatToClaude(normalized) : body,
      translation: chat
        ? ("claude-chat" as const)
        : responses
          ? ("claude-responses" as const)
          : ("native" as const),
    };
  }
  if (provider === "xai") {
    if (!chat && !responses && !messages) throw new ModelProxyError({ operation: "unsupported" });
    return {
      url: `${apiKey ? "https://api.x.ai" : "https://cli-chat-proxy.grok.com"}${messages ? "/v1/chat/completions" : route + query}`,
      body: messages ? normalized : body,
      translation: messages ? ("chat-claude" as const) : ("native" as const),
    };
  }
  if (chat || responses || messages) {
    const model = String(body.model);
    const method = body.stream === true ? "streamGenerateContent?alt=sse" : "generateContent";
    const request = chatToGoogle(normalized);
    const translation = chat
      ? ("google-chat" as const)
      : responses
        ? ("google-responses" as const)
        : ("google-claude" as const);
    return {
      url: apiKey
        ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${method}`
        : `https://cloudcode-pa.googleapis.com/v1internal:${method}`,
      body: apiKey ? request : { model, request },
      translation,
    };
  }
  if (
    !route.startsWith("/v1beta/models/") ||
    !/:(?:generateContent|streamGenerateContent|countTokens)/u.test(route)
  )
    throw new ModelProxyError({ operation: "unsupported" });
  if (apiKey && provider === "gemini")
    return {
      url: `https://generativelanguage.googleapis.com${route}${query}`,
      body,
      translation: "native" as const,
    };
  const match = /\/models\/([^:]+):([^?]+)/u.exec(route);
  if (!match) throw new ModelProxyError({ operation: "unsupported" });
  return {
    url: `https://cloudcode-pa.googleapis.com/v1internal:${match[2]}${new URLSearchParams(query).get("alt") === "sse" ? "?alt=sse" : ""}`,
    body: { model: unprefixProxyModel(decodeURIComponent(match[1]!)), request: body },
    translation: "google-native" as const,
  };
}
type ProxyTranslation = ReturnType<typeof prepareProxyRequest>["translation"];

export function proxyChatResponse(
  translation: ProxyTranslation,
  raw: ProxyPayload,
  model: string,
): ProxyPayload {
  if (translation === "native") return raw;
  if (translation === "google-native") return object(raw.response);
  if (translation === "chat-claude") return chatToClient(raw, "claude", model);
  if (translation.startsWith("google-")) {
    const response = raw.response ? object(raw.response) : raw;
    const candidate = object(array(response.candidates)[0]);
    const parts = array(object(candidate.content).parts);
    const metadata = object(response.usageMetadata);
    const tools = parts
      .filter((part) => object(part).functionCall)
      .map((part, index) => {
        const fn = object(object(part).functionCall);
        return {
          id: `call_${index}`,
          type: "function",
          function: { name: fn.name, arguments: JSON.stringify(fn.args ?? {}) },
        };
      });
    const chat = {
      id: response.responseId ?? "t3-proxy",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: parts
              .filter((part) => !object(part).thought)
              .map((part) => object(part).text ?? "")
              .join(""),
            ...(tools.length ? { tool_calls: tools } : {}),
          },
          finish_reason: tools.length
            ? "tool_calls"
            : candidate.finishReason === "MAX_TOKENS"
              ? "length"
              : "stop",
        },
      ],
      usage: {
        prompt_tokens: metadata.promptTokenCount ?? 0,
        completion_tokens: metadata.candidatesTokenCount ?? 0,
        total_tokens: metadata.totalTokenCount ?? 0,
      },
    };
    return chatToClient(
      chat,
      translation.endsWith("-responses")
        ? "responses"
        : translation.endsWith("-claude")
          ? "claude"
          : "chat",
      model,
    );
  }
  const claude = translation.startsWith("claude-");
  const content = claude
    ? array(raw.content)
    : array(raw.output).flatMap((item) => array(object(item).content));
  const tools = claude
    ? array(raw.content).filter((item) => object(item).type === "tool_use")
    : array(raw.output).filter((item) => object(item).type === "function_call");
  const usage = object(raw.usage);
  const chat = {
    id: raw.id,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            content
              .filter((item) => ["text", "output_text"].includes(String(object(item).type)))
              .map((item) => object(item).text ?? "")
              .join("") || null,
          ...(tools.length
            ? {
                tool_calls: tools.map((rawTool) => {
                  const tool = object(rawTool);
                  return {
                    id: tool.call_id ?? tool.id,
                    type: "function",
                    function: {
                      name: tool.name,
                      arguments: claude ? JSON.stringify(tool.input) : tool.arguments,
                    },
                  };
                }),
              }
            : {}),
        },
        finish_reason: tools.length
          ? "tool_calls"
          : raw.stop_reason === "max_tokens"
            ? "length"
            : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0),
    },
  };
  return chatToClient(
    chat,
    translation.endsWith("-responses")
      ? "responses"
      : translation.endsWith("-claude")
        ? "claude"
        : "chat",
    model,
  );
}

function chatToClient(
  chat: ProxyPayload,
  target: "chat" | "claude" | "responses",
  model: string,
): ProxyPayload {
  if (target === "chat") return chat;
  const choice = object(array(chat.choices)[0]);
  const message = object(choice.message);
  const usage = object(chat.usage);
  const tools = array(message.tool_calls).map(object);
  if (target === "claude")
    return {
      id: chat.id,
      type: "message",
      role: "assistant",
      model,
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...tools.map((tool) => ({
          type: "tool_use",
          id: tool.id,
          name: object(tool.function).name,
          input: JSON.parse(String(object(tool.function).arguments ?? "{}")),
        })),
      ],
      stop_reason:
        choice.finish_reason === "tool_calls"
          ? "tool_use"
          : choice.finish_reason === "length"
            ? "max_tokens"
            : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
      },
    };
  return {
    id: chat.id,
    object: "response",
    status: choice.finish_reason === "length" ? "incomplete" : "completed",
    model,
    output: [
      ...(message.content
        ? [
            {
              id: `${chat.id}_message`,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: message.content, annotations: [] }],
            },
          ]
        : []),
      ...tools.map((tool) => ({
        id: `${tool.id}_item`,
        type: "function_call",
        status: "completed",
        call_id: tool.id,
        name: object(tool.function).name,
        arguments: object(tool.function).arguments,
      })),
    ],
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

/** One translator per request so tool indices and completion state cannot leak across streams. */
function makeChatStreamTranslator(translation: ProxyTranslation, model: string) {
  let id = "t3-proxy";
  let finished = false;
  let inputTokens = 0;
  const indices = new Map<string, number>();
  const chunk = (delta: ProxyPayload, finishReason: string | null = null, usage?: unknown) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`;
  return (event: ProxyPayload): string => {
    if (finished) return "";
    if (translation === "google-native")
      return `data: ${JSON.stringify(event.response ?? event)}\n\n`;
    if (translation.startsWith("responses-")) {
      if (event.type === "response.created") {
        id = String(object(event.response).id ?? id);
        return chunk({ role: "assistant" });
      }
      if (event.type === "response.output_text.delta") return chunk({ content: event.delta });
      if (
        event.type === "response.output_item.added" &&
        object(event.item).type === "function_call"
      ) {
        const item = object(event.item);
        const index = indices.size;
        indices.set(String(item.id), index);
        return chunk({
          tool_calls: [
            {
              index,
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: "" },
            },
          ],
        });
      }
      if (event.type === "response.function_call_arguments.delta")
        return chunk({
          tool_calls: [
            {
              index: indices.get(String(event.item_id)) ?? 0,
              function: { arguments: event.delta },
            },
          ],
        });
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        finished = true;
        const usage = object(object(event.response).usage);
        return `${chunk({}, event.type === "response.incomplete" ? "length" : indices.size ? "tool_calls" : "stop", { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 })}data: [DONE]\n\n`;
      }
      if (event.type === "response.failed" || event.type === "error") {
        finished = true;
        return `data: ${JSON.stringify({ error: event.error ?? object(event.response).error ?? { message: "Upstream generation failed." } })}\n\n`;
      }
      return "";
    }
    if (translation === "chat-claude") return `data: ${JSON.stringify(event)}\n\n`;
    if (translation.startsWith("google-")) {
      const response = event.response ? object(event.response) : event;
      const candidate = object(array(response.candidates)[0]);
      const parts = array(object(candidate.content).parts);
      const metadata = object(response.usageMetadata);
      if (response.responseId) id = String(response.responseId);
      let output = "";
      for (const raw of parts) {
        const part = object(raw);
        if (typeof part.text === "string" && !part.thought) output += chunk({ content: part.text });
        if (part.functionCall) {
          const fn = object(part.functionCall);
          const index = indices.size;
          indices.set(`call_${index}`, index);
          output += chunk({
            tool_calls: [
              {
                index,
                id: `call_${index}`,
                type: "function",
                function: { name: fn.name, arguments: JSON.stringify(fn.args ?? {}) },
              },
            ],
          });
        }
      }
      if (candidate.finishReason) {
        finished = true;
        output += `${chunk({}, indices.size ? "tool_calls" : candidate.finishReason === "MAX_TOKENS" ? "length" : "stop", { prompt_tokens: metadata.promptTokenCount ?? 0, completion_tokens: metadata.candidatesTokenCount ?? 0, total_tokens: metadata.totalTokenCount ?? 0 })}data: [DONE]\n\n`;
      }
      return output;
    }
    if (event.type === "message_start") {
      id = String(object(event.message).id ?? id);
      inputTokens = Number(object(object(event.message).usage).input_tokens ?? 0);
      return chunk({ role: "assistant" });
    }
    if (event.type === "content_block_start" && object(event.content_block).type === "tool_use") {
      const block = object(event.content_block);
      const index = indices.size;
      indices.set(String(event.index), index);
      return chunk({
        tool_calls: [
          { index, id: block.id, type: "function", function: { name: block.name, arguments: "" } },
        ],
      });
    }
    if (event.type === "content_block_delta") {
      const delta = object(event.delta);
      if (delta.type === "text_delta") return chunk({ content: delta.text });
      if (delta.type === "input_json_delta")
        return chunk({
          tool_calls: [
            {
              index: indices.get(String(event.index)) ?? 0,
              function: { arguments: delta.partial_json },
            },
          ],
        });
    }
    if (event.type === "message_delta")
      return chunk(
        {},
        object(event.delta).stop_reason === "tool_use"
          ? "tool_calls"
          : object(event.delta).stop_reason === "max_tokens"
            ? "length"
            : "stop",
        {
          prompt_tokens: inputTokens,
          completion_tokens: object(event.usage).output_tokens ?? 0,
          total_tokens: inputTokens + Number(object(event.usage).output_tokens ?? 0),
        },
      );
    if (event.type === "message_stop") {
      finished = true;
      return "data: [DONE]\n\n";
    }
    if (event.type === "error") {
      finished = true;
      return `data: ${JSON.stringify({ error: event.error })}\n\n`;
    }
    return "";
  };
}

/** Convert upstream events through chat chunks, keeping each CLI's native streaming protocol. */
export function makeProxyStreamTranslator(translation: ProxyTranslation, model: string) {
  const toChat = makeChatStreamTranslator(translation, model);
  const target = translation.endsWith("-responses")
    ? "responses"
    : translation.endsWith("-claude")
      ? "claude"
      : "chat";
  if (target === "chat") return toChat;
  const tools = new Map<number, { id: string; name: string; arguments: string; index: number }>();
  let id = "t3-proxy";
  let started = false;
  let textStarted = false;
  let textIndex = 0;
  let content = "";
  let sequence = 0;
  let nextIndex = 0;
  const emit = (type: string, value: ProxyPayload) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...value, ...(target === "responses" ? { sequence_number: sequence++ } : {}) })}\n\n`;
  return (event: ProxyPayload) => {
    const data = toChat(event);
    let output = "";
    for (const line of data.split("\n")) {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
      const chunk = object(JSON.parse(line.slice(6)));
      if (chunk.error) {
        output += emit("error", { error: chunk.error });
        continue;
      }
      id = String(chunk.id ?? id);
      if (!started) {
        started = true;
        output +=
          target === "claude"
            ? emit("message_start", {
                message: {
                  id,
                  type: "message",
                  role: "assistant",
                  model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              })
            : emit("response.created", {
                response: { id, object: "response", model, status: "in_progress", output: [] },
              });
      }
      const choice = object(array(chunk.choices)[0]);
      const delta = object(choice.delta);
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!textStarted) {
          textStarted = true;
          textIndex = nextIndex++;
          output +=
            target === "claude"
              ? emit("content_block_start", {
                  index: textIndex,
                  content_block: { type: "text", text: "" },
                })
              : emit("response.output_item.added", {
                  output_index: textIndex,
                  item: {
                    id: `${id}_message`,
                    type: "message",
                    status: "in_progress",
                    role: "assistant",
                    content: [],
                  },
                }) +
                emit("response.content_part.added", {
                  item_id: `${id}_message`,
                  output_index: textIndex,
                  content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                });
        }
        content += delta.content;
        output +=
          target === "claude"
            ? emit("content_block_delta", {
                index: textIndex,
                delta: { type: "text_delta", text: delta.content },
              })
            : emit("response.output_text.delta", {
                item_id: `${id}_message`,
                output_index: textIndex,
                content_index: 0,
                delta: delta.content,
              });
      }
      for (const rawCall of array(delta.tool_calls)) {
        const call = object(rawCall);
        const fn = object(call.function);
        const key = Number(call.index ?? 0);
        let tool = tools.get(key);
        if (!tool) {
          tool = { id: String(call.id), name: String(fn.name), arguments: "", index: nextIndex++ };
          tools.set(key, tool);
          output +=
            target === "claude"
              ? emit("content_block_start", {
                  index: tool.index,
                  content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
                })
              : emit("response.output_item.added", {
                  output_index: tool.index,
                  item: {
                    id: `${tool.id}_item`,
                    type: "function_call",
                    status: "in_progress",
                    call_id: tool.id,
                    name: tool.name,
                    arguments: "",
                  },
                });
        }
        const argumentsDelta = String(fn.arguments ?? "");
        tool.arguments += argumentsDelta;
        if (argumentsDelta)
          output +=
            target === "claude"
              ? emit("content_block_delta", {
                  index: tool.index,
                  delta: { type: "input_json_delta", partial_json: argumentsDelta },
                })
              : emit("response.function_call_arguments.delta", {
                  item_id: `${tool.id}_item`,
                  output_index: tool.index,
                  delta: argumentsDelta,
                });
      }
      if (choice.finish_reason) {
        const chat = {
          id,
          choices: [
            {
              message: {
                content,
                tool_calls: [...tools.values()].map((tool) => ({
                  id: tool.id,
                  function: { name: tool.name, arguments: tool.arguments || "{}" },
                })),
              },
              finish_reason: choice.finish_reason,
            },
          ],
          usage: chunk.usage ?? {},
        };
        const result = chatToClient(chat, target, model);
        if (target === "claude") {
          for (let index = 0; index < nextIndex; index++)
            output += emit("content_block_stop", { index });
          output +=
            emit("message_delta", {
              delta: { stop_reason: result.stop_reason, stop_sequence: null },
              usage: result.usage,
            }) + emit("message_stop", {});
        } else {
          const items = array(result.output).map(object);
          const ordered = items
            .map((item) => ({
              item,
              index:
                item.type === "message"
                  ? textIndex
                  : ([...tools.values()].find((tool) => tool.id === item.call_id)?.index ?? 0),
            }))
            .sort((left, right) => left.index - right.index);
          if (textStarted)
            output += emit("response.output_text.done", {
              item_id: `${id}_message`,
              output_index: textIndex,
              content_index: 0,
              text: content,
            });
          for (const { index, item } of ordered)
            output += emit("response.output_item.done", { output_index: index, item });
          output += emit(
            result.status === "incomplete" ? "response.incomplete" : "response.completed",
            { response: { ...result, output: ordered.map(({ item }) => item) } },
          );
        }
      }
    }
    return output;
  };
}

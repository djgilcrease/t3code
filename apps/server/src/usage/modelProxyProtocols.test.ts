import { describe, expect, it } from "@effect/vitest";
import {
  prepareProxyRequest,
  proxyChatResponse,
  makeProxyStreamTranslator,
  proxyProviderForModel,
} from "./modelProxyProtocols.ts";

describe("native model proxy protocols", () => {
  it("matches paths independently of query strings and preserves only native query options", () => {
    for (const provider of ["claude", "kimi"] as const) {
      for (const path of ["/v1/messages?beta=true", "/v1/messages/count_tokens?beta=true"]) {
        const request = prepareProxyRequest(provider, true, path, {
          model: "claude-sonnet-4-6",
          messages: [],
        });
        expect(request.translation).toBe("native");
        expect(request.url).toBe(
          `${provider === "claude" ? "https://api.anthropic.com" : "https://api.kimi.com/coding"}${path}`,
        );
      }
    }
    expect(
      prepareProxyRequest("codex", true, "/v1/responses?test=true", {
        model: "gpt-5.4",
        input: "Hello",
      }).url,
    ).toBe("https://api.openai.com/v1/responses?test=true");
    expect(
      prepareProxyRequest("claude", true, "/v1/chat/completions?test=true", {
        model: "claude-sonnet-4-6",
        messages: [],
      }).url,
    ).toBe("https://api.anthropic.com/v1/messages");
    expect(
      prepareProxyRequest("codex", true, "/v1/messages?beta=true", {
        model: "gpt-5.4",
        messages: [],
      }).url,
    ).toBe("https://api.openai.com/v1/responses");
    expect(
      prepareProxyRequest("xai", true, "/v1/responses?test=true", { model: "grok-4" }).url,
    ).toBe("https://api.x.ai/v1/responses?test=true");
    const googlePath =
      "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&prettyPrint=false";
    expect(prepareProxyRequest("gemini", true, googlePath, {}).url).toBe(
      `https://generativelanguage.googleapis.com${googlePath}`,
    );
    expect(prepareProxyRequest("gemini", false, googlePath, {}).url).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
  });
  it("preserves Gemini output limits and sampling options across client protocols", () => {
    for (const input of [
      {
        route: "/v1/chat/completions",
        body: { messages: [{ role: "user", content: "Hello" }], max_completion_tokens: 128 },
      },
      { route: "/v1/responses", body: { input: "Hello", max_output_tokens: 128 } },
      {
        route: "/v1/messages",
        body: { messages: [{ role: "user", content: "Hello" }], max_tokens: 128 },
      },
    ]) {
      const prepared = prepareProxyRequest("gemini", true, input.route, {
        model: "gemini-2.5-pro",
        ...input.body,
        temperature: 0,
        top_p: 0.7,
      });
      expect(prepared.body).toHaveProperty("generationConfig", {
        maxOutputTokens: 128,
        temperature: 0,
        topP: 0.7,
      });
    }
    expect(
      prepareProxyRequest("gemini", true, "/v1/chat/completions", {
        model: "gemini-2.5-pro",
        messages: [],
        max_tokens: 64,
        max_completion_tokens: 128,
        top_p: 0,
      }).body,
    ).toHaveProperty("generationConfig", { maxOutputTokens: 64, topP: 0 });
  });
  it("honors required, named, automatic, and disabled Gemini tool choices", () => {
    for (const choice of [
      { value: "required", expected: { mode: "ANY" } },
      { value: "auto", expected: { mode: "AUTO" } },
      { value: "none", expected: { mode: "NONE" } },
      {
        value: { type: "function", function: { name: "read" } },
        expected: { mode: "ANY", allowedFunctionNames: ["read"] },
      },
    ]) {
      const prepared = prepareProxyRequest("gemini", true, "/v1/chat/completions", {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "Read" }],
        tools: ["read", "write"].map((name) => ({
          type: "function",
          function: { name, parameters: { type: "object" } },
        })),
        tool_choice: choice.value,
      });
      expect(prepared.body).toHaveProperty("toolConfig", {
        functionCallingConfig: choice.expected,
      });
    }
    expect(
      prepareProxyRequest("gemini", true, "/v1/responses", {
        model: "gemini-2.5-pro",
        input: "Read",
        tool_choice: { type: "function", name: "read" },
      }).body,
    ).toHaveProperty("toolConfig", {
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read"] },
    });
    expect(
      prepareProxyRequest("gemini", false, "/v1/messages", {
        model: "gemini-2.5-pro",
        messages: [],
        tool_choice: { type: "tool", name: "read" },
      }).body,
    ).toMatchObject({
      request: {
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read"] } },
      },
    });
    expect(
      prepareProxyRequest("gemini", true, "/v1/chat/completions", {
        model: "gemini-2.5-pro",
        messages: [],
      }).body,
    ).not.toHaveProperty("toolConfig");
  });
  it("normalizes Responses string input only for Codex's subscription backend", () => {
    const payload = { model: "gpt-5.4", input: "Hello" };
    expect(prepareProxyRequest("codex", false, "/v1/responses", payload).body).toMatchObject({
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    });
    expect(prepareProxyRequest("codex", true, "/v1/responses", payload).body).toMatchObject({
      input: "Hello",
    });
  });
  it("maps a chat tool round trip to Codex Responses without losing call IDs", () => {
    const prepared = prepareProxyRequest("codex", false, "/v1/chat/completions", {
      model: "codex/gpt-5.4",
      messages: [
        { role: "system", content: "Do the task" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"a"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file text" },
      ],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      max_tokens: 1024,
    });
    expect(prepared.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(prepared.body).toMatchObject({
      model: "gpt-5.4",
      instructions: "Do the task",
      store: false,
      stream: true,
      input: [
        { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
        { type: "function_call_output", call_id: "call_1", output: "file text" },
      ],
    });
    expect(prepared.body).not.toHaveProperty("max_output_tokens");
  });
  it("converts Codex requests to Claude, including images and tool results", () => {
    const request = prepareProxyRequest("claude", true, "/v1/responses", {
      model: "claude-sonnet-4-6",
      instructions: "Help",
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,abc" }],
        },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "hello" },
      ],
    });
    expect(request.translation).toBe("claude-responses");
    expect(request.body).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
          ],
        },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "hello" }] },
      ],
    });
    expect(
      proxyChatResponse(
        "claude-responses",
        {
          id: "msg1",
          content: [
            { type: "text", text: "Done" },
            { type: "tool_use", id: "c2", name: "write", input: { ok: true } },
          ],
          usage: { input_tokens: 7, output_tokens: 9 },
        },
        "claude-sonnet-4-6",
      ),
    ).toMatchObject({
      object: "response",
      output: [
        { type: "message", content: [{ text: "Done" }] },
        { type: "function_call", call_id: "c2", arguments: '{"ok":true}' },
      ],
      usage: { input_tokens: 7, output_tokens: 9, total_tokens: 16 },
    });
  });
  it("maps Claude's tool history to Gemini function calls and results", () => {
    const request = prepareProxyRequest("gemini", false, "/v1/messages", {
      model: "gemini-2.5-pro",
      system: "Help",
      stream: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c", name: "read", input: { path: "a" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "hello" }] },
      ],
    });
    expect(request.url).toContain("streamGenerateContent?alt=sse");
    expect(request.body).toMatchObject({
      model: "gemini-2.5-pro",
      request: {
        contents: [
          { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a" } } }] },
          {
            role: "user",
            parts: [{ functionResponse: { name: "read", response: { result: "hello" } } }],
          },
        ],
      },
    });
  });
  it("streams Responses tool calls as Anthropic content blocks", () => {
    const translate = makeProxyStreamTranslator("responses-claude", "gpt-5.4");
    const output = [
      { type: "response.created", response: { id: "r" } },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "i", call_id: "c", name: "read" },
      },
      { type: "response.function_call_arguments.delta", item_id: "i", delta: '{"path":"a"}' },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]
      .map(translate)
      .join("");
    expect(output).toContain('"type":"message_start"');
    expect(output).toContain('"type":"tool_use","id":"c","name":"read"');
    expect(output).toContain('"type":"input_json_delta"');
    expect(output).toContain('"stop_reason":"tool_use"');
    expect(output).toContain('"input_tokens":10,"output_tokens":5');
    expect(output).toContain("event: message_stop");
  });
  it("keeps tool indices isolated between simultaneous streams", () => {
    const first = makeProxyStreamTranslator("responses-chat", "gpt-5.4");
    const second = makeProxyStreamTranslator("responses-chat", "gpt-5.4");
    const tool = (id: string) => ({
      type: "response.output_item.added",
      item: { type: "function_call", id, call_id: id, name: "read" },
    });
    first(tool("first"));
    expect(first(tool("other"))).toContain('"index":1');
    expect(second(tool("second"))).toContain('"index":0');
    expect(
      second({ type: "response.failed", response: { error: { message: "Failure" } } }),
    ).toContain('"error"');
    expect(second({ type: "response.output_text.delta", delta: "late" })).toBe("");
  });
  it("uses explicit model prefixes to select the provider", () => {
    expect(proxyProviderForModel("antigravity/gemini-2.5-pro")).toBe("antigravity");
    expect(proxyProviderForModel("xai/grok-4")).toBe("xai");
    expect(() => prepareProxyRequest("codex", false, "/v1/unknown", { model: "gpt-5.4" })).toThrow(
      "not supported",
    );
  });
});

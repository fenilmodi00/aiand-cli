import assert from "node:assert/strict";
import test, { describe } from "node:test";

const { describeEmptyResponse } = await import("../dist/api/inference.js");

describe("describeEmptyResponse", () => {
  test("prefers the server's own reason when it sends one", () => {
    const message = describeEmptyResponse({
      meta: { emptyCompletion: "reasoning_only" },
      finishReason: "stop",
    });
    assert.match(message, /reasoned/i);
  });

  test("explains a budget exhausted inside reasoning, with no header to go on", () => {
    const message = describeEmptyResponse({
      meta: {},
      finishReason: "length",
      usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 40 } },
    });
    assert.match(message, /40 reasoning tokens/);
    assert.match(message, /--max-tokens/);
  });

  test("distinguishes plain truncation from truncation inside reasoning", () => {
    const message = describeEmptyResponse({
      meta: {},
      finishReason: "length",
      usage: { completion_tokens: 40 },
    });
    assert.match(message, /token limit/i);
    assert.doesNotMatch(message, /reasoning/i);
  });

  test("explains a model that reasoned then stopped without truncating", () => {
    const message = describeEmptyResponse({
      meta: {},
      finishReason: "stop",
      usage: { completion_tokens_details: { reasoning_tokens: 12 } },
    });
    assert.match(message, /12 tokens/);
  });

  test("always returns something actionable, even with no evidence at all", () => {
    const message = describeEmptyResponse({ meta: {} });
    assert.ok(message.length > 0);
    assert.doesNotMatch(message, /undefined|NaN/);
  });
});

describe("SSE reading", () => {
  const originalFetch = globalThis.fetch;

  function stubStream(chunks) {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream", "X-Model": "m" } },
      );
  }

  async function collect(chunks) {
    const { streamChatCompletion } = await import("../dist/api/inference.js");
    stubStream(chunks);
    try {
      const { meta, chunks: stream } = await streamChatCompletion(
        {
          profile: { name: "t", apiUrl: "https://example.invalid" },
          token: "sk-x",
          credential: null,
        },
        { model: "m", messages: [] },
      );
      const out = [];
      for await (const c of stream) out.push(c);
      return { meta, out };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("assembles content deltas in order and stops at [DONE]", async () => {
    const { out } = await collect([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      "data: [DONE]\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ignored" } }] })}\n\n`,
    ]);
    assert.equal(out.map((c) => c.text ?? "").join(""), "Hello");
  });

  test("reassembles an event split across network chunks", async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: "split" } }] });
    const { out } = await collect([
      `data: ${payload.slice(0, 10)}`,
      `${payload.slice(10)}\n\n`,
      "data: [DONE]\n\n",
    ]);
    assert.equal(out.map((c) => c.text ?? "").join(""), "split");
  });

  test("ignores keep-alives and unparseable frames instead of throwing", async () => {
    const { out } = await collect([
      ": keep-alive\n\n",
      "data: {not json\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    assert.equal(out.map((c) => c.text ?? "").join(""), "ok");
  });

  test("surfaces reasoning deltas separately from content", async () => {
    const { out } = await collect([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "say" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    assert.equal(out.find((c) => c.reasoning)?.reasoning, "think");
    assert.equal(out.find((c) => c.text)?.text, "say");
  });

  test("carries finish_reason and usage off the final frame", async () => {
    const { out } = await collect([
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "length" }],
        usage: { completion_tokens: 7 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const last = out.at(-1);
    assert.equal(last.finishReason, "length");
    assert.equal(last.usage.completion_tokens, 7);
  });

  test("reads the resolved model from headers, available before the body", async () => {
    const { meta } = await collect(["data: [DONE]\n\n"]);
    assert.equal(meta.model, "m");
  });

  test("tolerates CRLF line endings", async () => {
    const { out } = await collect([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })}\r\n\r\n`,
      "data: [DONE]\r\n\r\n",
    ]);
    assert.equal(out.map((c) => c.text ?? "").join(""), "crlf");
  });

  // #104: a gateway cutting the body mid-stream must classify as a retryable
  // network failure (ApiError, exit 1), not escape as a raw undici
  // `TypeError: terminated` that the top-level handler reports as exit 70.
  test("classifies a mid-stream connection cut as unreachable, not a raw crash", async () => {
    const { streamChatCompletion } = await import("../dist/api/inference.js");
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`,
              ),
            );
            // Body cut without close: the undici/undici-like reader throws
            // TypeError("terminated") / fetch failed on the next pull.
            controller.error(new TypeError("terminated"));
          },
        }),
        {
          status: 200,
          url: "https://example.invalid/v1/chat/completions",
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    try {
      const { chunks: stream } = await streamChatCompletion(
        {
          profile: { name: "t", apiUrl: "https://example.invalid" },
          token: "sk-x",
          credential: null,
        },
        { model: "m", messages: [] },
      );
      await assert.rejects(
        async () => {
          for await (const _c of stream) _c;
        },
        (error) => {
          assert.equal(error.name, "ApiError");
          assert.equal(error.exitCode, 1);
          assert.match(error.message, /connection (to \S+ )?was lost mid-response/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // #104 regression guard: Ctrl-C mid-stream still maps to cancelled()
  // (exit 130), not to the network classification.
  test("still maps a mid-stream Ctrl-C abort to cancelled (exit 130)", async () => {
    const { streamChatCompletion } = await import("../dist/api/inference.js");
    const abort = new DOMException("The operation was aborted.", "AbortError");
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
            controller.error(abort);
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    try {
      const { chunks: stream } = await streamChatCompletion(
        {
          profile: { name: "t", apiUrl: "https://example.invalid" },
          token: "sk-x",
          credential: null,
        },
        { model: "m", messages: [] },
      );
      await assert.rejects(
        async () => {
          for await (const _c of stream) _c;
        },
        (error) => {
          assert.equal(error.exitCode, 130);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

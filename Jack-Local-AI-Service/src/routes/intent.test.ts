import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { intentRouter } from "./intent.ts";
import type { JackChatRequest, JackChatResponse, LlmProvider, ProviderStatus } from "../types/jack.ts";

// Coverage for the latency-fix milestone's Part 4 requirement: deterministic
// commands (next/previous/pause/continue/stop/take over/"I'll take it from
// here", ...) must never wait on the LLM. matchDeterministicCommand's own
// pattern coverage is already tested directly in commandRouter.test.ts; this
// file proves the ROUTE actually short-circuits before ever calling the LLM
// provider for those phrases, using a fake LlmProvider that records whether
// chat() was invoked at all.

class RecordingLlmProvider implements LlmProvider {
  chatCallCount = 0;

  async checkHealth(): Promise<ProviderStatus> {
    return "available";
  }

  async chat(_req: JackChatRequest): Promise<JackChatResponse> {
    this.chatCallCount++;
    return { content: '{"type":"unknown"}', model: "fake", latencyMs: 1, raw: null };
  }
}

async function withServer(llm: LlmProvider, fn: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(intentRouter(llm));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("deterministic commands (next/previous/pause/continue/stop/take over/handoff) never call the LLM", async () => {
  const llm = new RecordingLlmProvider();
  const phrases = [
    "Next.",
    "Previous.",
    "Pause.",
    "Continue.",
    "Stop.",
    "Jack, take over.",
    "I'll take it from here.",
  ];
  await withServer(llm, async (base) => {
    for (const text of phrases) {
      const res = await fetch(`${base}/jack/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      assert.equal(res.status, 200, `expected 200 for "${text}"`);
      const body = await res.json();
      assert.equal(body.source, "deterministic", `expected a deterministic match for "${text}"`);
    }
    assert.equal(llm.chatCallCount, 0, "the LLM must never be called for phrases matchDeterministicCommand already resolves");
  });
});

test("a genuinely ambiguous phrase (no deterministic match) DOES fall through to the LLM", async () => {
  const llm = new RecordingLlmProvider();
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "What does the pricing slide say about the enterprise tier?" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, "llm");
    assert.equal(llm.chatCallCount, 1);
  });
});

// WHISPER SAFETY CORRECTION milestone, Part 16/17/27: the LLM-fallback
// destructive-action confidence gate. A ScriptedLlmProvider always returns
// the same action regardless of input, isolating the assertion to the
// gate's own logic (classifyAddress + hasSuspiciousRepetition), not to
// whether a real model would have proposed that action in the first place.
class ScriptedLlmProvider implements LlmProvider {
  constructor(private readonly action: string) {}

  async checkHealth(): Promise<ProviderStatus> {
    return "available";
  }

  async chat(_req: JackChatRequest): Promise<JackChatResponse> {
    return {
      content: JSON.stringify({ type: "action", action: this.action }),
      model: "fake",
      latencyMs: 1,
      raw: null,
    };
  }
}

test("Codex's reproduced incident: a hallucinated repeated-'Jack' transcript proposing stop_presentation is downgraded to conversation", async () => {
  const llm = new ScriptedLlmProvider("stop_presentation");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Jack, stop. Jack, stop. Jack, stop." }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, "llm");
    assert.equal(body.type, "conversation", "must NOT execute the destructive action from a suspicious repeated-address transcript");
    assert.equal(body.action, undefined);
    assert.equal(body.downgradedFrom, "stop_presentation");
  });
});

test("a genuine urgent repeated command word (name said once) is NOT penalized by the repetition guard", async () => {
  const llm = new ScriptedLlmProvider("stop_presentation");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Jack, stop, stop, stop!" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "action");
    assert.equal(body.action, "stop_presentation");
    assert.equal(body.downgradedFrom, undefined);
  });
});

test("an incidental mention of Jack proposing a destructive action is downgraded to conversation", async () => {
  const llm = new ScriptedLlmProvider("stop_presentation");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "The next slide explains why Jack stopped." }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "conversation");
    assert.equal(body.action, undefined);
    assert.equal(body.downgradedFrom, "stop_presentation");
  });
});

test("a direct, non-repeated address proposing a destructive action is allowed through", async () => {
  const llm = new ScriptedLlmProvider("pause_presentation");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Jack, could you pause for a second?" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "action");
    assert.equal(body.action, "pause_presentation");
  });
});

// WHISPER FALSE-DESTRUCTIVE-COMMAND ROOT-CAUSE milestone: pause_presentation/
// resume_presentation were briefly excluded from HIGH_IMPACT_ACTIONS, then
// put back after an independent attack review pointed out that Jack
// presents unattended -- an ungated false pause produces silent dead air
// with nobody watching to notice, unlike a false next_slide.
test("pause_presentation IS downgraded from a mention-only utterance (re-added to the high-impact set)", async () => {
  const llm = new ScriptedLlmProvider("pause_presentation");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "This graph shows what Jack described." }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "conversation");
    assert.equal(body.downgradedFrom, "pause_presentation");
  });
});

test("explain_slide (not high-impact) is never downgraded, even from a mention-only utterance", async () => {
  const llm = new ScriptedLlmProvider("explain_slide");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "This graph shows what Jack described." }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "action");
    assert.equal(body.action, "explain_slide");
    assert.equal(body.downgradedFrom, undefined);
  });
});

// Council engineering audit finding: "start from slide no.7." typed directly
// into the presenter's own command box (no name, no microphone anywhere in
// its path) was being downgraded exactly like an ambiguous mic capture --
// confirmed live, Jack summarized slide 7 instead of navigating to it. The
// address-check protects against ambient noise/ASR hallucination reaching a
// high-impact action; neither risk exists once a human is deliberately
// typing, so inputSource: "typed" must skip the check entirely.
test("inputSource: \"typed\" skips the high-impact downgrade entirely, even for unaddressed text", async () => {
  const llm = new ScriptedLlmProvider("jump_to_slide");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "start from slide no.7", inputSource: "typed" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "action");
    assert.equal(body.action, "jump_to_slide");
    assert.equal(body.downgradedFrom, undefined);
  });
});

test("the same unaddressed text WITHOUT inputSource: \"typed\" is still downgraded (default stays protected)", async () => {
  const llm = new ScriptedLlmProvider("jump_to_slide");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "start from slide no.7" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "conversation");
    assert.equal(body.action, undefined);
    assert.equal(body.downgradedFrom, "jump_to_slide");
  });
});

test("inputSource: \"voice\" and \"interruption\" both keep the protected (downgraded) behavior, unlike \"typed\"", async () => {
  const llm = new ScriptedLlmProvider("jump_to_slide");
  await withServer(llm, async (base) => {
    for (const inputSource of ["voice", "interruption"]) {
      const res = await fetch(`${base}/jack/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "start from slide no.7", inputSource }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.type, "conversation", `inputSource "${inputSource}" must still be downgraded`);
      assert.equal(body.downgradedFrom, "jump_to_slide");
    }
  });
});

test("an invalid/unrecognized inputSource value is ignored, not rejected -- falls back to the protected default", async () => {
  const llm = new ScriptedLlmProvider("jump_to_slide");
  await withServer(llm, async (base) => {
    const res = await fetch(`${base}/jack/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "start from slide no.7", inputSource: "carrier-pigeon" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "conversation");
    assert.equal(body.downgradedFrom, "jump_to_slide");
  });
});

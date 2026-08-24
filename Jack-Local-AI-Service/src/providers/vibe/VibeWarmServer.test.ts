import assert from "node:assert/strict";
import test from "node:test";
import { VibeWarmServer } from "./VibeWarmServer.ts";

test("stop is terminal and idempotent; later work cannot respawn", async () => {
  const server = new VibeWarmServer("missing.exe", "vae.gguf", "lm.gguf", 4, undefined, 10, 10);
  server.stop();
  server.stop();
  await assert.rejects(server.transcribe("audio.wav"), /shutting down/);
});

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { credentialsRouter } from "./credentials.ts";
import type { CredentialStore } from "../lib/credentialStore.ts";
import type { CredentialProviderId, CredentialStatusReport } from "../types/jack.ts";

// Route-level tests use a stubbed store (CredentialStore's own internals are
// covered by credentialStore.test.ts) so this file focuses purely on the
// route's validation, status-code mapping, and no-leak discipline.
class StubStore {
  private readonly data = new Map<CredentialProviderId, CredentialStatusReport>();

  async status(provider: CredentialProviderId): Promise<CredentialStatusReport> {
    return this.data.get(provider) ?? { provider, status: "not_configured" };
  }

  async set(provider: CredentialProviderId, apiKey: string): Promise<CredentialStatusReport> {
    const report: CredentialStatusReport = {
      provider,
      status: "connected",
      lastFour: apiKey.slice(-4),
      updatedAt: new Date().toISOString(),
    };
    this.data.set(provider, report);
    return report;
  }

  async remove(provider: CredentialProviderId): Promise<void> {
    this.data.delete(provider);
  }

  async testConnection(provider: CredentialProviderId): Promise<CredentialStatusReport> {
    return this.data.get(provider) ?? { provider, status: "not_configured" };
  }
}

async function withServer(store: StubStore, fn: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(credentialsRouter(store as unknown as CredentialStore));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /jack/credentials reports not_configured for both providers by default", async () => {
  await withServer(new StubStore(), async (base) => {
    const res = await fetch(`${base}/jack/credentials`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.openai.status, "not_configured");
    assert.equal(body.anthropic.status, "not_configured");
  });
});

test("POST /jack/credentials/:provider saves a key and NEVER echoes the raw value back", async () => {
  await withServer(new StubStore(), async (base) => {
    const testKey = "sk-super-secret-test-key-should-never-leak-12345";
    const res = await fetch(`${base}/jack/credentials/openai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: testKey }),
    });
    assert.equal(res.status, 200);
    const bodyText = await res.text();
    assert.equal(bodyText.includes(testKey), false, "the raw key must never appear in the response body");
    const body = JSON.parse(bodyText);
    assert.equal(body.status, "connected");
    assert.equal(body.lastFour, "2345");
  });
});

test("POST with an empty apiKey -> 400, and the (empty) value never appears in the response", async () => {
  await withServer(new StubStore(), async (base) => {
    const res = await fetch(`${base}/jack/credentials/openai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });
    assert.equal(res.status, 400);
  });
});

test("POST with a missing apiKey field -> 400", async () => {
  await withServer(new StubStore(), async (base) => {
    const res = await fetch(`${base}/jack/credentials/openai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("an invalid :provider is rejected with 400 on every verb, not silently accepted", async () => {
  await withServer(new StubStore(), async (base) => {
    const post = await fetch(`${base}/jack/credentials/bogus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-x" }),
    });
    assert.equal(post.status, 400);

    const del = await fetch(`${base}/jack/credentials/bogus`, { method: "DELETE" });
    assert.equal(del.status, 400);

    const test = await fetch(`${base}/jack/credentials/bogus/test`, { method: "POST" });
    assert.equal(test.status, 400);
  });
});

test("DELETE removes a configured key and reports not_configured", async () => {
  await withServer(new StubStore(), async (base) => {
    await fetch(`${base}/jack/credentials/openai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-to-remove" }),
    });
    const res = await fetch(`${base}/jack/credentials/openai`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "not_configured");
  });
});

test("POST /jack/credentials/:provider/test re-checks the already-stored key without a body", async () => {
  await withServer(new StubStore(), async (base) => {
    await fetch(`${base}/jack/credentials/anthropic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-stored" }),
    });
    const res = await fetch(`${base}/jack/credentials/anthropic/test`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "connected");
  });
});
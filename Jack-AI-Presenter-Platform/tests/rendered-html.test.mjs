import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const request = new Request("http://localhost/", {
    headers: { accept: "text/html" },
  });

  // The App Router build (dist/server/index.js) can export either a plain
  // handler function or a Worker-style { fetch(request, env, ctx) } object —
  // see vinext's own resolveAppRouterHandler for the same dual-shape contract.
  const response =
    typeof worker === "function"
      ? await worker(request)
      : await worker.fetch(
          request,
          {
            ASSETS: {
              fetch: async () => new Response("Not found", { status: 404 }),
            },
          },
          {
            waitUntil() {},
            passThroughOnException() {},
          },
        );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

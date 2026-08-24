import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("PPTX admission is installed before its route-local raw body parser", async () => {
  const routeSource = await readFile(fileURLToPath(new URL("./pptxConvert.ts", import.meta.url)), "utf8");
  const admission = routeSource.indexOf("createPptxAdmissionMiddleware(),");
  const parser = routeSource.indexOf("raw({ type: PPTX_CONTENT_TYPE");
  assert.ok(admission >= 0 && parser > admission);

  const indexSource = await readFile(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(indexSource, /express\.raw\([^)]*presentationml\.presentation/);
});

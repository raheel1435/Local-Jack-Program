import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractConversionFailure } from "./pptxConvert.ts";

test("PPTX admission is installed before its route-local raw body parser", async () => {
  const routeSource = await readFile(fileURLToPath(new URL("./pptxConvert.ts", import.meta.url)), "utf8");
  const admission = routeSource.indexOf("createPptxAdmissionMiddleware(),");
  const parser = routeSource.indexOf("raw({ type: PPTX_CONTENT_TYPE");
  assert.ok(admission >= 0 && parser > admission);

  const indexSource = await readFile(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(indexSource, /express\.raw\([^)]*presentationml\.presentation/);
});

// PPTX conversion root-cause investigation: a raw COM/automation exception
// was confirmed live to flow UNCHANGED (full "Command failed: <cmdline with
// temp paths>\n<stderr>" message, PLUS PowerShell's own verbose uncaught-
// exception "At line X char Y / CategoryInfo / FullyQualifiedErrorId"
// trailer) all the way into the presentation UI, where it rendered as if it
// were slide content. extractConversionFailure is the choke point that
// must always hand back a short, clean {stage, detail} pair -- and the
// specific stage the convert-pptx-to-pdf.ps1 script confirmed it now tags
// (STAGE:<id>|<message>, see that file) must survive the round trip intact.

test("parses the script's STAGE:<id>|<message> tag out of stderr into {stage, detail}", () => {
  const fakeError = Object.assign(new Error("Command failed: powershell.exe -File C:\\...\\convert-pptx-to-pdf.ps1"), {
    stderr: "STAGE:presentation_open|PowerPoint could not open the uploaded presentation.",
  });
  const failure = extractConversionFailure(fakeError);
  assert.equal(failure.stage, "presentation_open");
  assert.equal(failure.detail, "PowerPoint could not open the uploaded presentation.");
});

test("prefers stderr over the generic execFile 'Command failed: <cmdline>' message, and never leaks the temp paths", () => {
  const fakeError = Object.assign(new Error("Command failed: powershell.exe -File C:\\...\\convert-pptx-to-pdf.ps1 -InputPath C:\\Users\\shani\\AppData\\Local\\Temp\\jack-pptx-abc.pptx"), {
    stderr: "STAGE:com_activation|PowerPoint automation needs an active interactive Windows desktop session.",
  });
  const failure = extractConversionFailure(fakeError);
  assert.equal(failure.stage, "com_activation");
  assert.equal(failure.detail, "PowerPoint automation needs an active interactive Windows desktop session.");
  assert.doesNotMatch(failure.detail, /Command failed/);
  assert.doesNotMatch(failure.detail, /Temp\\jack-pptx/);
});

test("detects a Node-level execFile timeout as its own stage, distinct from any script-reported stage", () => {
  const timeoutError = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
  const failure = extractConversionFailure(timeoutError);
  assert.equal(failure.stage, "timeout");
  assert.match(failure.detail, /did not finish within/);
});

test("falls back to stage 'unknown' when stderr has no STAGE: tag (e.g. an ENOENT-style execFile failure)", () => {
  const failure = extractConversionFailure(new Error("Conversion did not produce an output file."));
  assert.equal(failure.stage, "unknown");
  assert.equal(failure.detail, "Conversion did not produce an output file.");
});

test("takes only the first line of a multi-line stderr, never the whole dump", () => {
  const fakeError = Object.assign(new Error("Command failed"), {
    stderr: "STAGE:pdf_save|some reason\nHämtningen av COM-klassfabriken ...\nfel: 80070520\nEn angiven inloggningssession finns inte.",
  });
  const failure = extractConversionFailure(fakeError);
  assert.equal(failure.stage, "pdf_save");
  assert.equal(failure.detail, "some reason");
  assert.doesNotMatch(failure.detail, /\n/);
});

test("caps an unexpectedly long single-line message instead of forwarding it whole", () => {
  const fakeError = Object.assign(new Error("Command failed"), { stderr: `STAGE:unknown|${"x".repeat(1000)}` });
  const failure = extractConversionFailure(fakeError);
  assert.ok(failure.detail.length <= 303); // 300 + "..."
  assert.ok(failure.detail.endsWith("..."));
});

test("never returns an empty detail, even for a non-Error/blank failure", () => {
  const failure = extractConversionFailure("");
  assert.equal(failure.stage, "unknown");
  assert.equal(failure.detail, "PowerPoint conversion failed for an unknown reason.");
});

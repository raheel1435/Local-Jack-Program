# Local Jack Architecture

This is the authoritative first-party architecture and integration guide for
the current Local Jack repository. It describes the code as it exists now.
Third-party repositories under `runtime-dependencies/` retain their own
upstream documentation.

## 1. What Local Jack Is

Local Jack is a presentation application with two first-party programs:

- `Jack-AI-Presenter-Platform/` is the React browser application. It owns the
  screens, uploaded-document state, microphone capture, slide rendering, and
  audio playback.
- `Jack-Local-AI-Service/` is a local Express gateway. It validates browser
  requests, selects adapters, protects credentials, controls concurrency, and
  talks to local executables, local HTTP services, or cloud SDKs.

The browser does not call an AI engine directly:

```text
React UI
  -> app/lib/jackApi.ts
  -> Local gateway (127.0.0.1:43110 by default)
  -> Express route
  -> provider adapter
  -> local runtime, local executable, or cloud SDK
  -> normalized gateway response
  -> React UI
```

This boundary keeps provider-specific details out of the frontend.

## 2. Frontend Responsibilities

- **Presentation UI:** `ProductApp.tsx` and `app/stages/` select Upload,
  Analysis, Mode Select, Practice, Present, and Ask Jack experiences.
- **Document upload and parsing:** `UploadStage.tsx`, `AnalysisStage.tsx`, and
  `app/lib/parsers/` validate and parse PDF, DOCX, PPTX, and TXT files.
- **Session state:** `SessionContext.tsx`, `sessionReducer.ts`, and
  `session/types.ts` hold files, parsed documents, stage, and presentation
  state.
- **Microphone capture:** `useLocalRecorder.ts` uses `getUserMedia`, Web Audio,
  an `AudioWorklet`, PCM samples, and WAV encoding.
- **Provider selection:** `AiProviderSelector.tsx`,
  `aiProviderSettings.ts`, `AsrProviderSelector.tsx`, and
  `asrProviderSettings.ts` maintain two independent choices: AI brain and
  speech recognition.
- **Jack orchestration:** `JackProvider.tsx` coordinates health, recording,
  transcription, addressing, intent detection, presentation actions,
  narration, and speech playback.
- **Narration and questions:** `narration.ts`, `presentationContext.ts`, and
  `deckRetrieval.ts` build grounded prompts from the active material.
- **Presentation commands:** each stage registers a
  `PresentationController`; `presentationController.ts` defines its common
  action contract.
- **Speech playback:** `jackSpeechPlayer.ts` decodes gateway audio with Web
  Audio. `useSpeech.ts` supplies an optional, explicitly enabled browser
  speech-synthesis fallback.
- **Slide visuals:** `SlideVisual.tsx` and the PDF parser render PDF pages and
  PowerPoint-converted pages to canvas.
- **Gateway client:** `jackApi.ts` owns all `/health` and `/jack/*` requests.

## 3. Backend Responsibilities

`src/index.ts` constructs every adapter, chooses the configured local LLM,
registers routes, limits CORS to configured browser origins, listens on
loopback by default, and stops Vibe's child process during gateway shutdown.

The gateway provides:

- API endpoints for health, chat, intent, transcription, speech, credentials,
  and PPTX conversion;
- request shape and size validation through route checks and
  `lib/requestValidation.ts`;
- exclusive per-request AI-brain selection and independent ASR selection;
- adapter classes that normalize different provider protocols;
- temporary WAV/PPTX/PDF files in the operating-system temp directory, removed
  in route cleanup paths;
- BYOK credential storage through `CredentialStore` and Windows DPAPI;
- concurrency and queue limits through `AdmissionGate`;
- direct execution of Whisper and PowerPoint conversion commands;
- a persistent Vibe child process started on demand;
- loopback HTTP calls to llama.cpp, Colibri, and Kokoro;
- official OpenAI and Anthropic SDK calls; and
- stable public failures through `providerErrors.ts` without exposing cloud
  error internals or credentials.

## 4. What Is a Provider Adapter?

A provider adapter is a translator between Jack's common request shape and one
provider's particular protocol. For example, the transcription route only
needs an object with `checkHealth()` and `transcribe()`. `WhisperProvider`
knows which executable and arguments Whisper requires.

```text
Jack transcription request
  -> common AsrProvider interface
  -> WhisperProvider
  -> whisper-cli command and stdout
  -> common JackTranscribeResponse
```

Because Whisper, Vibe, and OpenAI Speech implement the same interface, the
route can switch providers without teaching the frontend their internals. The
same idea applies to local, OpenAI, and Anthropic AI brains through
`LlmProvider`.

## 5. Active Third-Party Repositories

All active vendored sources live under `runtime-dependencies/`. They are
flattened upstream snapshots rather than nested Git repositories.

### llama.cpp

- **Purpose:** the default local AI brain runtime.
- **Location:** `runtime-dependencies/llama.cpp/`.
- **Integration:** an externally started `llama-server`, reached over its
  OpenAI-compatible HTTP API.
- **Adapter:** `src/providers/llamacpp/LlamaCppProvider.ts`.
- **Methods:** `checkHealth()` calls `GET /health`; `chat()` calls
  `POST /v1/chat/completions`.
- **Trigger:** AI provider is `local` and gateway boot configuration
  `JACK_LLM_PROVIDER` is `llamacpp` or omitted.
- **Default URL:** `http://127.0.0.1:8081`.

```text
jackApi.chat()
  -> POST /jack/chat with aiProvider="local"
  -> chatRouter
  -> configured local LlmProvider
  -> LlamaCppProvider.chat()
  -> llama-server /v1/chat/completions
  -> normalized text response
```

Jack does not start `llama-server`. If it is unavailable or its request fails,
the gateway checks Colibri and retries once when healthy. This is request-level:
`JACK_LLM_PROVIDER` remains `llamacpp`. If both fail, the gateway returns a
structured error; it never selects a cloud brain automatically.

### Colibri

- **Purpose:** an alternative local AI brain, never a simultaneous second
  active brain.
- **Location:** `runtime-dependencies/colibri/`.
- **Integration:** an externally started OpenAI-compatible HTTP service.
- **Adapter:** `src/providers/colibri/ColibriProvider.ts`.
- **Methods:** `checkHealth()` calls `GET /v1/models`; `chat()` calls
  `POST /v1/chat/completions` using the configured model ID.
- **Trigger:** AI provider is `local` and `JACK_LLM_PROVIDER=colibri` when the
  gateway starts.
- **Defaults:** `http://127.0.0.1:8000`, model ID `colibri`.

Jack does not start Colibri. If configured as primary and unavailable or failed,
the gateway checks llama.cpp and retries once when healthy. It never enters
cloud AI automatically and never rewrites `JACK_LLM_PROVIDER`.

### whisper.cpp

- **Purpose:** approved and default local automatic speech recognition (ASR).
- **Location:** `runtime-dependencies/whisper.cpp/`.
- **Integration:** one CLI process per request, not a continuously running
  HTTP server.
- **Adapter/config:** `WhisperProvider.ts` and
  `config/whisperApprovedConfig.ts`.
- **Methods:** `checkHealth()` verifies the executable and model; `transcribe()`
  executes `whisper-cli` with the model, WAV path, four threads, optional
  language, and a word-list decoder prompt, then reads stdout.
- **Trigger:** ASR provider is `whisper`, or the request omits the ASR provider.

```text
uploaded WAV -> temporary .wav -> WhisperProvider.transcribe()
  -> whisper-cli.exe -> stdout -> normalized transcript
```

Missing configuration or a failed CLI returns a structured error. Whisper is
the automatic local fallback for Vibe. OpenAI Speech→Whisper is offered as a
current-request retry and requires user consent.

### VibeASR.cpp / VibeVoice

- **Purpose:** optional experimental ASR for explicit comparison/testing.
- **Location:** `runtime-dependencies/VibeASR.cpp/`; its embedded
  `3rdparty/llama.cpp/` fork is required by Vibe and must remain with it.
- **Adapter/config:** `VibeAsrProvider.ts`, `VibeWarmServer.ts`, and
  `config/vibeVoiceTestConfig.ts`.
- **Trigger:** a transcription request explicitly selects `vibevoice`.

The current `warmRuntime` setting is `true`. `VibeAsrProvider` constructs a
wrapper at gateway startup, but `asr_stream_server.exe` itself starts lazily on
the first Vibe transcription. The models load once; requests are serialized by
writing one audio path per line to stdin, and transcript lines end with
`---END---` on stdout. The child is restarted after a crash when possible and
is stopped on gateway `SIGINT` or `SIGTERM`.

The source also retains a one-shot `asr_infer.exe` cold implementation for use
only if `warmRuntime` is disabled. It is not a request-time fallback from the
warm path. Missing binaries/models or runtime failures are reported to the
caller. When the selected Vibe service/model/startup/runtime request fails,
the transcription route makes one automatic local retry through Whisper and
returns `requestedProvider`, `actualProvider`, and `fallbackUsed` metadata.

### Kokoro-FastAPI

- **Purpose:** primary local text-to-speech (TTS).
- **Location:** `runtime-dependencies/Kokoro-FastAPI/`.
- **Integration:** an externally started loopback HTTP service.
- **Adapter/route:** `KokoroProvider.ts` and `routes/speech.ts`.
- **Methods:** `checkHealth()` calls `GET /v1/audio/voices`; `speak()` calls
  `POST /v1/audio/speech`.
- **Default URL:** `http://127.0.0.1:8880`.

```text
generated text -> jackApi.speak() -> POST /jack/speak -> speechRouter
  -> KokoroProvider.speak() -> Kokoro /v1/audio/speech
  -> WAV bytes -> JackSpeechPlayer -> speakers
```

The current adapter explicitly requests `response_format: "wav"`; it does not
request MP3. Jack expects Kokoro to be running and does not start it. Browser
speech synthesis is only used when the user has explicitly enabled that
fallback and Kokoro is unreachable.

## 6. Third-Party Runtime Trigger Table

| Runtime | Purpose | Trigger | Jack adapter | Communication | Output |
|---|---|---|---|---|---|
| llama.cpp | Default/alternate local AI | `local` brain; primary or one fallback according to `JACK_LLM_PROVIDER` | `LlamaCppProvider` | HTTP | AI text + actual-runtime metadata |
| Colibri | Primary/alternate local AI | `local` brain; primary or one fallback according to `JACK_LLM_PROVIDER` | `ColibriProvider` | HTTP | AI text + actual-runtime metadata |
| whisper.cpp | Default/fallback ASR | Whisper selected/omitted, or one automatic Vibe fallback | `WhisperProvider` | Per-request CLI | Transcript + actual-provider metadata |
| VibeASR.cpp | Experimental ASR | Vibe explicitly selected | `VibeAsrProvider`/`VibeWarmServer` | Persistent child stdin/stdout; cold CLI if configured off | Transcript |
| Kokoro-FastAPI | Primary TTS | Jack speaks | `KokoroProvider` | HTTP | WAV audio |

## 7. Cloud Integrations

Cloud providers are SDK dependencies, not vendored source repositories.

### OpenAI AI brain

When `aiProvider: "openai"` reaches `/jack/chat` or the LLM fallback in
`/jack/intent`, the route selects `OpenAiProvider`. It obtains the OpenAI key
from `CredentialStore` and calls the official `openai` SDK's chat completions
API. The configured default model is `gpt-4o-mini` unless overridden by the
gateway environment.

### OpenAI Speech ASR

When the independently selected ASR provider is `openai`,
`transcriptionRouter` selects `OpenAiSpeechProvider`. It decrypts the same
stored OpenAI key and sends the temporary WAV to the official SDK's audio
transcription API. The default transcription model is
`gpt-4o-mini-transcribe`.

### Anthropic AI brain

When `aiProvider: "anthropic"` reaches chat or intent fallback, the route
selects `AnthropicProvider`. It decrypts the Anthropic key and uses the
official `@anthropic-ai/sdk` Messages API. The default is
`claude-haiku-4-5`; system messages are converted to Anthropic's top-level
`system` field.

AI brain and ASR are independent axes. Valid combinations include Whisper +
OpenAI brain, OpenAI Speech + Local brain, and Vibe + Anthropic brain. Exactly
one AI brain handles each attempt. Provider failures return structured fields
(`code`, `provider`, `fallbackOptions`, `requiresConsent`) rather than requiring
the frontend to parse error prose. A selected cloud brain never calls Local
automatically; the frontend may offer a one-request Local retry. Likewise, a
failed Local request may offer only credentialed OpenAI/Anthropic choices, and
no cloud call occurs before the user chooses one.

Availability is also separate from activity: `/health` checks all providers so
the UI can show what is installed/reachable, while `brainStatus.ts` derives the
visible active-brain label only from the selected provider.

### Fallback and consent policy

Automatic fallback is limited to providers that remain local:

- Vibe → Whisper, once per transcription request.
- llama.cpp ↔ Colibri, once per AI request, with the configured runtime still
  remaining primary for future requests.

Every boundary into cloud requires explicit consent. Whisper failure may offer
OpenAI Speech only when an OpenAI key is configured; otherwise the UI directs
the user to credential settings. OpenAI Speech failure may offer Whisper, but
still asks because it changes the selected request path. When both local AI
runtimes fail, configured OpenAI and/or Anthropic may be offered. OpenAI or
Anthropic failure may offer Local. These are one-request retries and do not
change saved ASR/AI selections.

No retry recursively invokes the fallback workflow: one automatic local retry
and one user-approved retry are the bounds. Status UI keeps the selected
provider visible and adds the actual provider/runtime plus a fallback marker,
so availability is never confused with which provider handled the request.

## 8. Microphone / ASR Flow

ASR means **Automatic Speech Recognition**: converting speech into text.

```text
Microphone
  -> navigator.mediaDevices.getUserMedia()
  -> AudioContext
  -> public/audio-worklet/pcm-recorder-processor.js
  -> PCM sample chunks
  -> WAV Blob
  -> jackApi.transcribeAudio()
  -> POST /jack/transcribe?provider=...
  -> selected AsrProvider
  -> transcript
  -> self-echo/addressing checks
  -> intent and command handling
```

`useLocalRecorder.ts` owns browser capture. `JackProvider.tsx` sends the WAV
and applies recent-speech/self-echo and address logic. The gateway validates a
maximum 25 MB WAV, checks per-provider admission, creates a uniquely named temp
file, invokes only the selected ASR adapter, and deletes the temp file in a
`finally` path.

## 9. AI Command Flow

```text
spoken or typed text
  -> jackApi.detectIntent()
  -> POST /jack/intent
  -> matchDeterministicCommand() first
     -> recognized command: return immediately; no LLM
     -> no match: selected AI brain classifies constrained intent
  -> validate type/action against the server allowlist
  -> address/repetition safety checks for inferred high-impact voice actions
  -> JackProvider dispatch
  -> active stage's PresentationController
  -> UI action and result
```

`commandRouter.ts` provides the fast deterministic patterns.
`actionGrammar.ts` defines allowed model output; `routes/intent.ts` validates it
again in code. `addressing.ts` handles direct address, negation, and suspicious
repetition. `presentationController.ts` ensures every stage returns explicit
success or failure instead of silently assuming an action worked.

## 10. AI Question / Chat Flow

```text
question + presentation context
  -> deckRetrieval.ts selects relevant local text
  -> narration.ts builds a grounded prompt
  -> jackApi.chat(..., aiProvider)
  -> POST /jack/chat
  -> exactly the selected local/OpenAI/Anthropic adapter
  -> answer text
  -> UI caption and optional TTS
```

Retrieval is deterministic and browser-local; there is no vector database.
`AskJackStage.tsx` also has a local-search answer path for its uploaded material.
Generated answers are instructed to use supplied deck material and avoid
inventing unsupported facts.

## 11. TTS Flow

TTS means **Text To Speech**: converting text into playable audio.

The primary path is text -> `jackApi.speak()` -> `/jack/speak` ->
`KokoroProvider.speak()` -> Kokoro WAV -> `JackSpeechPlayer` -> Web Audio
speakers. Playback is single-stream: a new clip cancels the previous clip.

The browser's built-in `speechSynthesis` path is optional and disabled by
default. It may be used only when the user explicitly enables fallback and the
Kokoro path is unavailable; it is not an automatic hidden replacement.

## 12. Document Parsing

The browser parses documents because it already owns the selected `File`, can
update analysis state immediately, and can build local presentation context
without sending document contents to an unrelated cloud service.

- PDF -> `pdfjs-dist` extracts page text and can render pages to canvas.
- DOCX -> Mammoth converts Word content to HTML, then the browser extracts
  headings and paragraphs.
- PPTX semantic content -> JSZip opens the package and `DOMParser` reads slide
  and notes XML.
- TXT -> `File.text()` reads plain text.

`app/lib/parsers/index.ts` selects the parser and returns a common
`ParsedDocument`.

## 13. PPTX: Two Different Pipelines

PowerPoint needs two pipelines because understanding slide words and showing
the original design are different jobs.

### A. Semantic understanding

```text
PPTX -> JSZip/XML -> slide text + notes -> ParsedDocument -> Jack context
```

This gives Jack searchable words and speaker notes but does not reproduce the
original PowerPoint layout.

### B. Visual fidelity

```text
PPTX -> jackApi.convertPptxToPdf()
  -> POST /jack/convert-pptx
  -> PowerShell convert-pptx-to-pdf.ps1
  -> PowerPoint COM automation
  -> PDF bytes
  -> pdfjs-dist
  -> canvas
```

The backend uses unique temp PPTX/PDF paths, a three-request admission limit,
and cleanup paths. This pipeline requires desktop PowerPoint and an interactive
Windows session. If conversion fails, the frontend can show its simplified
semantic slide view.

## 14. API Key Security

BYOK means **Bring Your Own Key**. The user enters an OpenAI or Anthropic key in
settings, but the frontend never receives a stored full key back.

```text
Settings UI
  -> /jack/credentials/:provider
  -> CredentialStore
  -> dpapi-protect.ps1
  -> Windows DPAPI CurrentUser encryption
  -> %APPDATA%\jack-local-ai\credentials\{provider}.dat
```

A separate metadata file contains only status, update time, and the last four
characters. When a cloud adapter runs, it asks `CredentialStore` to decrypt the
key internally, constructs the official SDK client, and returns only the model
result. Credential routes support status, save, remove, and connection test.

## 15. What Must Be Running

| Service/runtime | Must already run? | Started by Jack? | Default address/process |
|---|---|---|---|
| React frontend | Yes, for the UI | Started manually with `npm run dev` | Vite default `http://localhost:5173` |
| Express gateway | Yes | Started manually with `npm run dev` or built `npm start` | `http://127.0.0.1:43110` |
| llama.cpp | Yes when configured Local runtime | No | external `llama-server`, `http://127.0.0.1:8081` |
| Colibri | Yes when configured Local runtime | No | external service, `http://127.0.0.1:8000` |
| Kokoro | Yes for primary TTS | No | external HTTP service, `http://127.0.0.1:8880` |
| Whisper | No server | Gateway starts one CLI per request | configured `whisper-cli.exe` |
| Vibe | No pre-running server | Gateway lazily starts persistent child on first Vibe request | configured `asr_stream_server.exe`; cold `asr_infer.exe` only when warm mode is disabled |
| PowerPoint COM | PowerPoint must be installed; interactive desktop required | Conversion script creates COM application per request | local `PowerPoint.Application` |
| OpenAI | Remote API reachable when selected | No local process; official SDK calls cloud | HTTPS cloud API |
| Anthropic | Remote API reachable when selected | No local process; official SDK calls cloud | HTTPS cloud API |

An **HTTP service** listens for requests, a **CLI executable** runs for one
command, a **persistent child process** stays alive under the gateway and
handles multiple requests, and a **cloud API** runs outside the local machine.

Local setup requires Node.js `>=22.13.0`, dependencies installed in both
first-party packages, `Jack-Local-AI-Service/.env` based on `.env.example`, and
the relevant binaries/models for the providers the user selects.

## 16. What Is Not Integrated

This cleanup removed:

- `Deletable/awesome-llm-apps/`
- `Deletable/voxel-video-file-format/`

They were standalone reference/experimental repositories. Searches of current
first-party source, imports, package manifests, scripts, configs, tests, and
build/workflow files found no runtime, build, or test consumer. They were not
part of the active Local Jack request graph, so removing them does not alter
application behavior. Historical purpose cannot be conclusively established
from Git/source evidence.

## 17. Frontend/Backend File Map

### Frontend

- `app/jack/JackProvider.tsx` - Central browser orchestrator for health,
  microphone sessions, commands, narration, speech, and provider selections.
- `app/lib/jackApi.ts` - Typed HTTP boundary between browser and gateway.
- `app/hooks/useLocalRecorder.ts` - Captures microphone PCM through an
  AudioWorklet and returns WAV audio.
- `app/jack/narration.ts` - Builds grounded narration and question prompts and
  asks the selected AI brain.
- `app/jack/presentationContext.ts` - Normalizes current deck and slide context
  for prompts.
- `app/jack/deckRetrieval.ts` - Finds relevant deck passages locally without a
  vector database.
- `app/jack/presentationController.ts` - Contract implemented by presentation
  modes for navigation, state, notes, search, and control.
- `app/jack/jackSpeechPlayer.ts` - Single-stream Web Audio playback and
  cancellation.
- `app/components/AiProviderSelector.tsx` and
  `AsrProviderSelector.tsx` - Independent AI-brain and ASR controls.
- `app/components/SlideVisual.tsx` - Displays PDF pages and PowerPoint-converted
  pages, with semantic fallback.

### Backend core and routes

- `src/index.ts` - Express composition root, adapter construction, routing,
  CORS, listen address, and shutdown hooks.
- `src/config/services.ts` - Reads validated gateway settings, provider URLs,
  executable/model paths, and cloud model defaults.
- `src/types/jack.ts` - Common provider interfaces and normalized request,
  response, status, and selector types.
- `src/routes/chat.ts` - Validates chat, invokes the selected AI class, and
  permits one alternate local-runtime attempt within the Local selection.
- `src/routes/intent.ts` - Deterministic commands first, then selected-brain
  classification with action safety validation.
- `src/routes/transcription.ts` - Validates WAV input, manages temp files and
  admission, and permits one Vibe-to-Whisper local fallback attempt.
- `src/routes/speech.ts` - Validates text/voice, checks Kokoro, and returns
  audio bytes.
- `src/routes/health.ts` - Checks all adapters and reports availability plus
  the configured local LLM implementation.
- `src/routes/credentials.ts` - Reports, saves, removes, and tests BYOK keys
  without returning full secrets.
- `src/routes/pptxConvert.ts` - Controls bounded PPTX-to-PDF COM conversion and
  temp-file cleanup.

### Backend providers, libraries, intent, and scripts

- `providers/llamacpp/LlamaCppProvider.ts` - llama-server HTTP adapter.
- `providers/colibri/ColibriProvider.ts` - Colibri HTTP adapter.
- `providers/whisper/WhisperProvider.ts` - Whisper CLI adapter and safe decoder
  argument builder.
- `providers/vibe/VibeAsrProvider.ts` and `VibeWarmServer.ts` - Vibe adapter,
  persistent process protocol, serialization, restart, and shutdown.
- `providers/kokoro/KokoroProvider.ts` - Kokoro HTTP voice/health adapter.
- `providers/openai/OpenAiProvider.ts` - Official-SDK OpenAI AI-brain adapter.
- `providers/openai/OpenAiSpeechProvider.ts` - Official-SDK OpenAI ASR adapter.
- `providers/anthropic/AnthropicProvider.ts` - Official-SDK Anthropic brain
  adapter and message-shape translation.
- `lib/credentialStore.ts` - DPAPI-encrypted cloud-key storage outside Git.
- `lib/admission.ts` - Bounded concurrency and queues for expensive work.
- `lib/providerErrors.ts` - Safe public provider/authentication errors.
- `lib/requestValidation.ts` - Shared request length and type limits.
- `intent/commandRouter.ts` - Deterministic command and safe conversation
  matching.
- `intent/addressing.ts` - Direct-address, negation, and repetition signals.
- `intent/actionGrammar.ts` - Constrained AI action vocabulary and prompt.
- `scripts/dpapi-protect.ps1` / `dpapi-unprotect.ps1` - Windows CurrentUser
  secret encryption/decryption.
- `scripts/convert-pptx-to-pdf.ps1` - PowerPoint COM conversion with staged
  error reporting and COM cleanup.

## 18. Beginner Explanation

Think of the React app as the control panel and the Express gateway as a
translator/security desk. The browser captures files, clicks, and microphone
audio. It sends a clear request to the gateway. The gateway checks the request,
chooses only the provider the user selected, translates the request into that
provider's language, and sends a common result back. This lets the UI stay the
same whether the selected brain runs locally or in a cloud service.

## 19. College / Viva Explanation

### 20-second explanation

Local Jack is a React presentation frontend connected to a local Express
gateway. The gateway uses provider adapters to route chat, speech recognition,
and text-to-speech to local runtimes or explicitly selected cloud APIs. The
frontend handles documents and presentation state; the backend handles secure
credentials, validation, concurrency, and provider protocols.

### 60-second explanation

The browser application imports PDF, DOCX, PPTX, and TXT files, extracts their
content, renders slides, records microphone audio, and controls presentation
state. Every external capability goes through `jackApi.ts` to the local Express
gateway. The gateway exposes separate routes for chat, intent, transcription,
speech, credentials, health, and PowerPoint conversion. Adapter classes hide
the differences between llama.cpp, Colibri, Whisper, Vibe, Kokoro, OpenAI, and
Anthropic. AI-brain selection is independent from speech-recognition selection,
and failures never silently switch the selected brain. Cloud keys are protected
with Windows DPAPI and never returned to the browser.

### 2-minute technical explanation

Local Jack separates interaction from integration. React owns files and UI
state. Browser parsers use pdfjs, Mammoth, and JSZip/XML to produce a common
document model; PPTX additionally has a backend PowerPoint-COM-to-PDF path for
visual fidelity. `useLocalRecorder` turns microphone PCM into WAV, and
`JackProvider` sends it to `/jack/transcribe` with the independently selected
ASR provider. The gateway writes a temporary WAV and invokes Whisper as a
per-request CLI, Vibe through a lazily started persistent child, or OpenAI
Speech through its SDK.

Commands go to `/jack/intent`. A deterministic router handles known commands
without model latency. Ambiguous input reaches exactly the selected Local,
OpenAI, or Anthropic brain, after which the server validates the result against
an allowed action vocabulary and applies addressing safeguards. Questions use
browser-side deck retrieval and grounded prompts, then `/jack/chat`. Speech
uses `/jack/speak`, Kokoro's loopback API, and Web Audio playback. The gateway
adds input limits, admission gates, health checks, stable errors, timeouts, and
DPAPI credential protection. Local HTTP engines are expected to be started
externally; Whisper runs per request; Vibe is managed as a gateway child; cloud
providers are remote APIs.

## 20. Terminology Cheat Sheet

- **Frontend:** the browser UI the user sees and interacts with.
- **Backend:** server-side code that validates work and talks to services.
- **Gateway:** the backend entry point that routes common Jack requests.
- **API:** a defined way for programs to exchange requests and responses.
- **API endpoint:** one address and method, such as `POST /jack/chat`.
- **Provider:** an engine or service that supplies AI, ASR, or TTS.
- **Provider adapter:** code translating Jack's common interface to a specific
  provider protocol.
- **ASR:** Automatic Speech Recognition; speech to text.
- **TTS:** Text To Speech; text to audio.
- **LLM:** Large Language Model; generates or classifies language.
- **HTTP:** the request/response protocol used by browsers and local services.
- **CLI:** Command-Line Interface; an executable invoked with arguments.
- **SDK:** a provider-maintained software library for calling its API.
- **DPAPI:** Windows Data Protection API for user-bound encryption.
- **COM:** Windows component automation used here to control PowerPoint.
- **PCM:** raw sampled audio values.
- **WAV:** an audio container used for captured and generated audio here.
- **JSON:** a structured text format used in API messages.
- **React hook:** a function that adds reusable stateful behavior to a React
  component.
- **React component:** a reusable unit that renders part of the UI.
- **Route:** backend code handling an endpoint.
- **Environment variable:** machine-specific configuration read at startup.
- **localhost / loopback:** a network address reachable only on the same
  machine, commonly `127.0.0.1`.

export const config = {
  port: Number(process.env.JACK_LOCAL_PORT ?? 43110),

  colibriBaseUrl: process.env.COLIBRI_BASE_URL ?? "http://127.0.0.1:8000",
  kokoroBaseUrl: process.env.KOKORO_BASE_URL ?? "http://127.0.0.1:8880",

  whisperExecutablePath: process.env.WHISPER_EXECUTABLE_PATH ?? "",
  whisperModelPath: process.env.WHISPER_MODEL_PATH ?? "",
};

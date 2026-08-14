/**
 * JackAttentionState is a single enum, not a set of independent booleans —
 * that is what makes states like "sleeping AND listening" structurally
 * unrepresentable instead of merely disallowed by convention.
 */
export type JackAttentionState =
  | "sleeping"
  | "standby"
  | "listening"
  | "thinking"
  | "speaking"
  | "paused"
  | "muted"
  | "acting"
  | "alert"
  | "disconnected"
  | "error";

export type ConnectionStatus =
  | "not_configured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export type MicPipelineStatus =
  | "off"
  | "requesting"
  | "listening"
  | "muted"
  | "denied"
  | "unavailable"
  | "error";

export type ControlMode = "presenterLeads" | "jackLeads" | "shared";
export type ControlOwner = "presenter" | "jack";

export type AudienceQuestionPolicy =
  | "askPresenterFirst"
  | "jackAnswers"
  | "presenterAnswers"
  | "moderatedQueue";

export interface TranscriptEntry {
  id: string;
  role: "presenter" | "jack";
  text: string;
  final: boolean;
  timestamp: number;
}

export interface QueuedQuestion {
  id: string;
  text: string;
  status: "pending" | "answered" | "deferred";
  timestamp: number;
}

export interface JackSessionSnapshot {
  attentionState: JackAttentionState;
  connectionStatus: ConnectionStatus;
  micStatus: MicPipelineStatus;
  micLevel: number;
  /** True only when audio is genuinely flowing to OpenAI right now — never just because the mic is open. */
  sendingAudioToOpenAI: boolean;
  transcript: TranscriptEntry[];
  currentCaption: string;
  lastError: string | null;
  controlMode: ControlMode;
  controlOwner: ControlOwner;
  audienceQuestionPolicy: AudienceQuestionPolicy;
  humourEnabled: boolean;
  humourUsed: boolean;
  language: string;
  questions: QueuedQuestion[];
  wakeWordMode: "local-wake-word" | "push-to-talk";
  wakeWordAvailable: boolean;
}

export type JackEvent =
  | { type: "CONNECT_REQUESTED" }
  | { type: "CONNECTED" }
  | { type: "CONNECT_FAILED"; message: string }
  | { type: "DISCONNECTED" }
  | { type: "WAKE" }
  | { type: "SLEEP" }
  | { type: "MIC_REQUESTING" }
  | { type: "MIC_GRANTED" }
  | { type: "MIC_DENIED" }
  | { type: "MIC_UNAVAILABLE" }
  | { type: "MIC_ERROR"; message: string }
  | { type: "MUTE" }
  | { type: "UNMUTE" }
  | { type: "USER_SPEECH_DETECTED" }
  | { type: "RESPONSE_REQUESTED" }
  | { type: "AUDIO_START" }
  | { type: "AUDIO_STOPPED" }
  | { type: "AUDIO_INTERRUPTED" }
  | { type: "TOOL_START" }
  | { type: "TOOL_END" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "ERROR"; message: string };

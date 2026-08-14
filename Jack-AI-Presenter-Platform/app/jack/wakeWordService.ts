export type WakeWordMode = "local-wake-word" | "push-to-talk";

export interface WakeWordService {
  readonly mode: WakeWordMode;
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** Starts listening for the wake condition. For push-to-talk this simply invokes `onWake` immediately. */
  start(onWake: () => void): void;
  stop(): void;
}

/**
 * The only real, working wake mechanism in this build: the user presses the
 * Jack orb, the microphone button, or a keyboard shortcut. No audio is sent
 * anywhere until this fires.
 */
export class PushToTalkWakeWordService implements WakeWordService {
  readonly mode: WakeWordMode = "push-to-talk";
  readonly available = true;

  start(onWake: () => void): void {
    onWake();
  }

  stop(): void {
    // Nothing to tear down — activation is a single explicit user action.
  }
}

/**
 * Stub for a future on-device keyword-spotting engine. Intentionally not
 * implemented: a basic text/string comparison would not be true local wake-word
 * detection, and this app never sends continuous room audio to OpenAI just to
 * detect a name. Kept as a real interface implementation (not a fake success
 * path) so a real engine can be dropped in later without touching call sites.
 */
export class LocalWakeWordService implements WakeWordService {
  readonly mode: WakeWordMode = "local-wake-word";
  readonly available = false;
  readonly unavailableReason = "Requires local wake-word engine";

  start(): void {
    throw new Error("LocalWakeWordService is not available in this build: " + this.unavailableReason);
  }

  stop(): void {
    // no-op
  }
}

export function createWakeWordService(): WakeWordService {
  return new PushToTalkWakeWordService();
}

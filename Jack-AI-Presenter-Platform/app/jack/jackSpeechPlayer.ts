/**
 * Single source of truth for Jack's audio output. Only one clip plays at a
 * time; starting a new one always stops whatever was playing first.
 * Cancellation (stop()) is distinguished from natural completion (onEnded)
 * so callers -- the autonomous narration loop above all -- can tell "this
 * finished, safe to advance" from "this was cut off, do NOT advance".
 */
export interface JackSpeechPlayer {
  play(audio: Blob, onEnded: () => void): void;
  /** Stops playback immediately. Does NOT invoke the pending onEnded callback. */
  stop(): void;
  isSpeaking(): boolean;
}

export function createJackSpeechPlayer(): JackSpeechPlayer {
  let currentAudio: HTMLAudioElement | null = null;
  let currentUrl: string | null = null;
  let speaking = false;

  const cleanup = () => {
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
    speaking = false;
  };

  return {
    play(audio, onEnded) {
      cleanup(); // only one active playback at a time
      const url = URL.createObjectURL(audio);
      const element = new Audio(url);
      currentAudio = element;
      currentUrl = url;
      speaking = true;
      element.onended = () => {
        cleanup();
        onEnded();
      };
      element.onerror = () => {
        cleanup();
        // Playback failure is not "completed normally" -- callers must not
        // treat it as a green light to advance. No onEnded call here.
      };
      void element.play().catch(() => {
        cleanup();
      });
    },
    stop() {
      cleanup(); // cleanup() alone never calls onEnded -- this is the cancel path
    },
    isSpeaking() {
      return speaking;
    },
  };
}

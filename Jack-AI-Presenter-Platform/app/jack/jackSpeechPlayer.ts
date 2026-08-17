/**
 * Single source of truth for Jack's audio output. Only one clip plays at a
 * time; starting a new one always stops whatever was playing first.
 * Cancellation (stop()) is distinguished from natural completion (onEnded)
 * so callers -- the autonomous narration loop above all -- can tell "this
 * finished, safe to advance" from "this was cut off, do NOT advance".
 *
 * Built on the Web Audio API rather than `new Audio().play()`. Root cause of
 * Jack's narration/greeting/acknowledgements silently never being heard
 * (confirmed live): every one of those is triggered from an async chain --
 * click -> await jack/intent -> await jack/chat -> await jack/speak -> THEN
 * play() -- and by the time that chain resolves (hundreds of ms to a couple
 * seconds later), Chrome's autoplay policy no longer considers it part of
 * the original user gesture, so `HTMLAudioElement.play()` silently rejects.
 * The old code caught that rejection and called cleanup() with no visible
 * effect -- Jack "said" something that was never actually audible, and nothing
 * on screen indicated a failure. An AudioContext resumed synchronously
 * inside a real user gesture (see unlock()) stays in "running" state and can
 * start new buffer sources at any later time without needing a fresh gesture
 * for each one, which is what actually fixes this.
 */
export interface JackSpeechPlayer {
  /**
   * Resumes (creating if needed) the shared AudioContext. MUST be called
   * synchronously from inside a real user gesture (click/submit/keydown)
   * before any Jack speech triggered by that gesture is expected to be
   * audible -- see the class-level comment. Cheap and safe to call on every
   * relevant gesture; resuming an already-running context is a no-op.
   */
  unlock(): void;
  play(audio: Blob, onEnded: () => void): void;
  /** Stops playback immediately. Does NOT invoke the pending onEnded callback. */
  stop(): void;
  isSpeaking(): boolean;
}

interface WebkitAudioContextWindow {
  webkitAudioContext?: typeof AudioContext;
}

export function createJackSpeechPlayer(): JackSpeechPlayer {
  let audioContext: AudioContext | null = null;
  let currentSource: AudioBufferSourceNode | null = null;
  // Identity token for the in-flight play() attempt -- lets a stale decode
  // (superseded by a newer play() or an explicit stop() while still
  // fetching/decoding) detect it's no longer current and no-op, without a
  // shared boolean flag that a second overlapping call could stomp on.
  let activeToken: object | null = null;
  let speaking = false;

  function ensureContext(): AudioContext {
    if (!audioContext) {
      const Ctor = window.AudioContext ?? (window as unknown as WebkitAudioContextWindow).webkitAudioContext;
      if (!Ctor) throw new Error("This browser doesn't support the Web Audio API.");
      audioContext = new Ctor();
    }
    return audioContext;
  }

  const cleanup = () => {
    activeToken = null;
    if (currentSource) {
      currentSource.onended = null;
      try {
        currentSource.stop();
      } catch {
        // already stopped, or never started -- fine either way
      }
      currentSource.disconnect();
      currentSource = null;
    }
    speaking = false;
  };

  return {
    unlock() {
      try {
        const ctx = ensureContext();
        if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      } catch {
        // Web Audio unsupported here -- play() will surface that when actually needed
      }
    },
    play(audioBlob, onEnded) {
      cleanup(); // only one active playback at a time
      let ctx: AudioContext;
      try {
        ctx = ensureContext();
      } catch (err) {
        console.error("[jack-voice] Web Audio unavailable", err);
        return;
      }
      const token = {};
      activeToken = token;
      speaking = true;
      void (async () => {
        try {
          // Belt-and-suspenders: unlock() should already have done this from
          // the originating gesture, but resume() is a harmless no-op if so.
          if (ctx.state === "suspended") await ctx.resume();
          const arrayBuffer = await audioBlob.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          if (activeToken !== token) return; // superseded while decoding
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);
          currentSource = source;
          source.onended = () => {
            if (activeToken !== token) return; // already stopped/replaced -- stop() itself fires onended
            cleanup();
            onEnded();
          };
          source.start();
        } catch (err) {
          if (activeToken === token) {
            cleanup();
            console.error("[jack-voice] playback failed", err);
          }
          // Playback failure is not "completed normally" -- callers must not
          // treat it as a green light to advance. No onEnded call here.
        }
      })();
    },
    stop() {
      cleanup(); // cleanup() alone never calls onEnded -- this is the cancel path
    },
    isSpeaking() {
      return speaking;
    },
  };
}

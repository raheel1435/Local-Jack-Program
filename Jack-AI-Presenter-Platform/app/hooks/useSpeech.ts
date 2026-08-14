"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseSpeechResult {
  speak(text: string, onSentence?: (sentence: string, index: number) => void): void;
  pause(): void;
  resume(): void;
  stop(): void;
  replay(): void;
  isSpeaking: boolean;
  isPaused: boolean;
  currentSentence: string;
  supported: boolean;
  error: string | null;
  rate: number;
  setRate(n: number): void;
  volume: number;
  setVolume(n: number): void;
  voices: SpeechSynthesisVoice[];
  voiceURI: string | null;
  setVoiceURI(uri: string): void;
}

function splitIntoSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function useSpeech(): UseSpeechResult {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentSentence, setCurrentSentence] = useState("");
  const [error, setError] = useState<string | null>(supported ? null : "Speech synthesis isn't available in this browser.");
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string | null>(null);

  const sentencesRef = useRef<string[]>([]);
  const indexRef = useRef(0);
  const onSentenceRef = useRef<((s: string, i: number) => void) | undefined>(undefined);
  const rateRef = useRef(rate);
  const volumeRef = useRef(volume);
  const voiceURIRef = useRef<string | null>(voiceURI);
  const lastTextRef = useRef("");
  const speakNextRef = useRef<() => void>(() => {});

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);
  useEffect(() => {
    voiceURIRef.current = voiceURI;
  }, [voiceURI]);

  useEffect(() => {
    if (!supported) return;
    const loadVoices = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length > 0) {
        setVoices(list);
        setVoiceURI((current) => current ?? list[0]?.voiceURI ?? null);
      }
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, [supported]);

  const speakNext = useCallback(() => {
    if (!supported) return;
    const i = indexRef.current;
    const sentences = sentencesRef.current;
    if (i >= sentences.length) {
      setIsSpeaking(false);
      setIsPaused(false);
      setCurrentSentence("");
      return;
    }
    const sentence = sentences[i];
    setCurrentSentence(sentence);
    onSentenceRef.current?.(sentence, i);

    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.rate = rateRef.current;
    utterance.volume = volumeRef.current;
    const voice = voices.find((v) => v.voiceURI === voiceURIRef.current);
    if (voice) utterance.voice = voice;

    utterance.onend = () => {
      indexRef.current += 1;
      speakNextRef.current();
    };
    utterance.onerror = (event) => {
      if (event.error === "interrupted" || event.error === "canceled") return;
      setError(`Speech playback error: ${event.error}`);
      setIsSpeaking(false);
      setIsPaused(false);
    };

    window.speechSynthesis.speak(utterance);
  }, [supported, voices]);

  useEffect(() => {
    speakNextRef.current = speakNext;
  }, [speakNext]);

  const speak = useCallback(
    (text: string, onSentence?: (s: string, i: number) => void) => {
      if (!supported) return;
      window.speechSynthesis.cancel();
      const sentences = splitIntoSentences(text);
      sentencesRef.current = sentences;
      indexRef.current = 0;
      onSentenceRef.current = onSentence;
      lastTextRef.current = text;
      setError(null);
      if (sentences.length === 0) return;
      setIsSpeaking(true);
      setIsPaused(false);
      speakNext();
    },
    [supported, speakNext],
  );

  const pause = useCallback(() => {
    if (!supported || !isSpeaking) return;
    window.speechSynthesis.pause();
    setIsPaused(true);
  }, [supported, isSpeaking]);

  const resume = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.resume();
    setIsPaused(false);
  }, [supported]);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    indexRef.current = sentencesRef.current.length;
    setIsSpeaking(false);
    setIsPaused(false);
    setCurrentSentence("");
  }, [supported]);

  const replay = useCallback(() => {
    if (!lastTextRef.current) return;
    speak(lastTextRef.current, onSentenceRef.current);
  }, [speak]);

  useEffect(() => {
    return () => {
      if (supported) window.speechSynthesis.cancel();
    };
  }, [supported]);

  return {
    speak, pause, resume, stop, replay,
    isSpeaking, isPaused, currentSentence, supported, error,
    rate, setRate, volume, setVolume,
    voices, voiceURI, setVoiceURI,
  };
}

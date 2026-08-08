import { useCallback, useEffect, useMemo, useRef, useState } from "react";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export type AudioEffectsSettings = {
  enabled: boolean;
  loudnessNormalization: boolean;
  outputGain: number;
  spatial: boolean;
  limiter: boolean;
  proToolsEnabled: boolean;
  eq: number[];
};

export const EQ_BANDS = [
  { label: "31Hz", type: "lowshelf" as BiquadFilterType, frequency: 31 },
  { label: "62Hz", type: "peaking" as BiquadFilterType, frequency: 62 },
  { label: "125Hz", type: "peaking" as BiquadFilterType, frequency: 125 },
  { label: "250Hz", type: "peaking" as BiquadFilterType, frequency: 250 },
  { label: "500Hz", type: "peaking" as BiquadFilterType, frequency: 500 },
  { label: "1k", type: "peaking" as BiquadFilterType, frequency: 1000 },
  { label: "2k", type: "peaking" as BiquadFilterType, frequency: 2000 },
  { label: "4k", type: "peaking" as BiquadFilterType, frequency: 4000 },
  { label: "8k", type: "peaking" as BiquadFilterType, frequency: 8000 },
  { label: "16k", type: "highshelf" as BiquadFilterType, frequency: 16000 },
];

export const AUDIO_EFFECT_PRESETS = [
  { label: "平直", eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { label: "流行", eq: [2, 3, 2, 0, -1, 1, 2, 3, 3, 2] },
  { label: "摇滚", eq: [4, 4, 3, 1, -1, 1, 3, 4, 4, 3] },
  { label: "人声", eq: [-2, -1, 0, 1, 2, 3, 3, 2, 1, 0] },
  { label: "低音", eq: [6, 5, 4, 2, 0, -1, -1, 0, 1, 1] },
  { label: "清亮", eq: [-2, -1, 0, 0, 1, 2, 3, 4, 5, 4] },
];

export const DEFAULT_AUDIO_EFFECTS: AudioEffectsSettings = {
  enabled: false,
  loudnessNormalization: false,
  outputGain: 1,
  spatial: false,
  limiter: true,
  proToolsEnabled: false,
  eq: AUDIO_EFFECT_PRESETS[0].eq,
};

const STORAGE_KEY = "music-player-audio-effects";

export function clampDb(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-12, Math.min(12, value));
}

export function clampOutputGain(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.5, Math.min(1.8, value));
}

function readStoredAudioEffects(): AudioEffectsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AUDIO_EFFECTS;
    const parsed = JSON.parse(raw) as Partial<AudioEffectsSettings>;
    return {
      enabled: Boolean(parsed.enabled),
      loudnessNormalization: Boolean(parsed.loudnessNormalization),
      outputGain: clampOutputGain(Number(parsed.outputGain ?? DEFAULT_AUDIO_EFFECTS.outputGain)),
      spatial: Boolean(parsed.spatial),
      limiter: parsed.limiter === undefined ? DEFAULT_AUDIO_EFFECTS.limiter : Boolean(parsed.limiter),
      proToolsEnabled: Boolean(parsed.proToolsEnabled),
      eq: Array.isArray(parsed.eq)
        ? EQ_BANDS.map((_, index) => clampDb(Number(parsed.eq?.[index] ?? 0)))
        : DEFAULT_AUDIO_EFFECTS.eq,
    };
  } catch {
    return DEFAULT_AUDIO_EFFECTS;
  }
}

type AudioEffectsController = {
  audio: HTMLAudioElement;
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  eqNodes: BiquadFilterNode[];
  compressor: DynamicsCompressorNode;
  panner: StereoPannerNode | null;
  analyser: AnalyserNode;
  outputGain: GainNode;
  masterGain: GainNode;
};

export type MelBandFrame = {
  melBands: number[];
  waveform: number[];
  spectrumHistory: number[][];
  energyHistory: Array<{ low: number; mid: number; high: number }>;
  rms: number;
  peak: number;
  lufs: number;
  bpm: number;
  clipping: number;
  centroidHz: number;
  lowEnergy: number;
  midEnergy: number;
  highEnergy: number;
  dynamicRange: number;
};

type AudioEffectsStatus =
  | "原生播放中"
  | "音效链路待应用"
  | "实时音效已接入"
  | "该音源不支持实时音效"
  | "浏览器不支持 Web Audio"
  | "请先播放一首歌";

const MEL_BAND_COUNT = 24;
const WAVEFORM_COUNT = 96;
const HISTORY_FRAME_COUNT = 72;
const ANALYSER_UPDATE_INTERVAL_MS = 1000 / 15;
const AudioContextConstructor = () => window.AudioContext || window.webkitAudioContext;

function createSpectrumHistory(): number[][] {
  return Array.from({ length: HISTORY_FRAME_COUNT }, () => Array.from({ length: MEL_BAND_COUNT }, () => 0));
}

function createEnergyHistory(): Array<{ low: number; mid: number; high: number }> {
  return Array.from({ length: HISTORY_FRAME_COUNT }, () => ({ low: 0, mid: 0, high: 0 }));
}

function createEmptyMelFrame(): MelBandFrame {
  return {
    melBands: Array.from({ length: MEL_BAND_COUNT }, () => 0),
    waveform: Array.from({ length: WAVEFORM_COUNT }, () => 0),
    spectrumHistory: createSpectrumHistory(),
    energyHistory: createEnergyHistory(),
    rms: 0,
    peak: 0,
    lufs: -Infinity,
    bpm: 0,
    clipping: 0,
    centroidHz: 0,
    lowEnergy: 0,
    midEnergy: 0,
    highEnergy: 0,
    dynamicRange: 0,
  };
}

function disconnectAudioNode(node: AudioNode | null) {
  try {
    node?.disconnect();
  } catch {
    /* best effort cleanup */
  }
}

function disposeController(controller: AudioEffectsController) {
  disconnectAudioNode(controller.source);
  controller.eqNodes.forEach(disconnectAudioNode);
  disconnectAudioNode(controller.compressor);
  disconnectAudioNode(controller.panner);
  disconnectAudioNode(controller.analyser);
  disconnectAudioNode(controller.outputGain);
  disconnectAudioNode(controller.masterGain);
  try {
    void controller.context.close().catch(() => undefined);
  } catch {
    /* best effort cleanup */
  }
}

export function isAudioEffectsSourceAllowed(audio: HTMLAudioElement | null): boolean {
  if (!audio?.currentSrc) return false;
  return isAudioEffectsUrlAllowed(audio.currentSrc);
}

export function isAudioEffectsUrlAllowed(url: string): boolean {
  if (!url) return false;
  try {
    const src = new URL(url, window.location.href);
    if (src.origin === window.location.origin) return true;
    if (src.hostname === "127.0.0.1" || src.hostname === "localhost" || src.hostname === "::1") return true;
    return src.pathname.startsWith("/api/stream") || src.pathname.startsWith("/api/audio-proxy");
  } catch {
    return false;
  }
}

function createController(audio: HTMLAudioElement, initialVolume = 100): AudioEffectsController | null {
  const Ctor = AudioContextConstructor();
  if (!Ctor) return null;

  const context = new Ctor();
  let source: MediaElementAudioSourceNode;
  try {
    source = context.createMediaElementSource(audio);
  } catch {
    void context.close().catch(() => undefined);
    return null;
  }
  const eqNodes = EQ_BANDS.map((band) => {
    const filter = context.createBiquadFilter();
    filter.type = band.type;
    filter.frequency.value = band.frequency;
    filter.Q.value = band.type === "peaking" ? 1 : Math.SQRT1_2;
    filter.gain.value = 0;
    return filter;
  });
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = 0;
  compressor.knee.value = 0;
  compressor.ratio.value = 1;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  const panner = "createStereoPanner" in context ? context.createStereoPanner() : null;
  if (panner) panner.pan.value = 0;
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.75;
  const outputGain = context.createGain();
  outputGain.gain.value = 1;
  const masterGain = context.createGain();
  masterGain.gain.value = clampVolumePercent(initialVolume) / 100;

  let node: AudioNode = source;
  for (const filter of eqNodes) {
    node.connect(filter);
    node = filter;
  }
  node.connect(compressor);
  if (panner) {
    compressor.connect(panner);
    panner.connect(analyser);
  } else {
    compressor.connect(analyser);
  }
  analyser.connect(outputGain);
  outputGain.connect(masterGain);
  masterGain.connect(context.destination);

  return { audio, context, source, eqNodes, compressor, panner, analyser, outputGain, masterGain };
}

function applySettings(controller: AudioEffectsController, settings: AudioEffectsSettings) {
  const eqEnabled = settings.enabled;
  controller.eqNodes.forEach((node, index) => {
    node.gain.value = eqEnabled ? clampDb(settings.eq[index] ?? 0) : 0;
  });

  if (settings.enabled && settings.loudnessNormalization) {
    controller.compressor.threshold.value = -18;
    controller.compressor.knee.value = 18;
    controller.compressor.ratio.value = 4;
  } else if (settings.enabled && settings.limiter) {
    controller.compressor.threshold.value = -6;
    controller.compressor.knee.value = 4;
    controller.compressor.ratio.value = 12;
  } else {
    controller.compressor.threshold.value = 0;
    controller.compressor.knee.value = 0;
    controller.compressor.ratio.value = 1;
  }
  controller.compressor.attack.value = settings.enabled && settings.limiter ? 0.002 : 0.003;
  controller.compressor.release.value = settings.enabled && settings.limiter ? 0.12 : 0.25;

  if (controller.panner) {
    controller.panner.pan.value = settings.enabled && settings.spatial ? 0.08 : 0;
  }

  const boost = settings.enabled ? clampOutputGain(settings.outputGain) : 1;
  const makeup = settings.enabled && settings.loudnessNormalization ? 1.08 : 1;
  controller.outputGain.gain.value = Math.min(1.8, boost * makeup);
}

function clampVolumePercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, value));
}

function applyMasterVolume(controller: AudioEffectsController, volumePercent: number) {
  const safeGain = clampVolumePercent(volumePercent) / 100;
  const now = controller.context.currentTime;
  controller.masterGain.gain.cancelScheduledValues(now);
  controller.masterGain.gain.setValueAtTime(safeGain, now);
}

function restoreNativeElementVolumeForWebAudio(audio: HTMLAudioElement) {
  audio.muted = false;
  try {
    audio.volume = 1;
  } catch {
    /* Some Safari targets expose volume as read-only; Web Audio gain handles it. */
  }
}

function hasConfiguredEffects(settings: AudioEffectsSettings): boolean {
  return (
    settings.enabled ||
    settings.loudnessNormalization ||
    settings.spatial ||
    settings.proToolsEnabled ||
    settings.eq.some((value) => Math.abs(value) >= 0.1)
  );
}

function statusForController(settings: AudioEffectsSettings): AudioEffectsStatus {
  return hasConfiguredEffects(settings) ? "实时音效已接入" : "原生播放中";
}

export function useAudioEffects(visualizerActive = true) {
  const [settings, setSettings] = useState<AudioEffectsSettings>(readStoredAudioEffects);
  const [status, setStatus] = useState<AudioEffectsStatus>("原生播放中");
  const [melFrame, setMelFrame] = useState<MelBandFrame>(createEmptyMelFrame);
  const controllerRef = useRef<AudioEffectsController | null>(null);
  const masterVolumeRef = useRef(100);
  const analyserRafRef = useRef<number | null>(null);
  const [analyserAttachVersion, setAnalyserAttachVersion] = useState(0);
  const lastBpmBeatMsRef = useRef(0);
  const lowBand300SmoothedRef = useRef(0);
  const beatTimesRef = useRef<number[]>([]);
  const spectrumHistoryRef = useRef<number[][]>(createSpectrumHistory());
  const energyHistoryRef = useRef<Array<{ low: number; mid: number; high: number }>>(createEnergyHistory());
  const historyFrameRef = useRef(0);

  const stopAnalyserLoop = useCallback(() => {
    if (analyserRafRef.current !== null) {
      cancelAnimationFrame(analyserRafRef.current);
      analyserRafRef.current = null;
    }
  }, []);

  const resetAnalyserState = useCallback(() => {
    lastBpmBeatMsRef.current = 0;
    lowBand300SmoothedRef.current = 0;
    beatTimesRef.current = [];
    spectrumHistoryRef.current = createSpectrumHistory();
    energyHistoryRef.current = createEnergyHistory();
    historyFrameRef.current = 0;
    setMelFrame(createEmptyMelFrame());
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const expectedStatus = useMemo(() => {
    return hasConfiguredEffects(settings) ? "音效链路待应用" : "原生播放中";
  }, [settings]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (controller) {
      applySettings(controller, settings);
      applyMasterVolume(controller, masterVolumeRef.current);
      setStatus(statusForController(settings));
      return;
    }
    setStatus(expectedStatus);
  }, [expectedStatus, settings]);

  const disposeCurrentController = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controllerRef.current = null;
    disposeController(controller);
    stopAnalyserLoop();
    resetAnalyserState();
    setAnalyserAttachVersion((prev) => prev + 1);
  }, [resetAnalyserState, stopAnalyserLoop]);

  const createOrReuseController = useCallback((audio: HTMLAudioElement): AudioEffectsController | null => {
    let controller = controllerRef.current;
    if (controller && controller.audio !== audio) {
      disposeCurrentController();
      controller = null;
    }
    if (!controller) {
      controller = createController(audio, masterVolumeRef.current);
      if (!controller) return null;
      controllerRef.current = controller;
      setAnalyserAttachVersion((prev) => prev + 1);
    }
    restoreNativeElementVolumeForWebAudio(audio);
    return controller;
  }, [disposeCurrentController]);

  const setMasterVolume = useCallback((nextVolume: number) => {
    const safe = clampVolumePercent(nextVolume);
    masterVolumeRef.current = safe;
    const controller = controllerRef.current;
    if (controller) {
      restoreNativeElementVolumeForWebAudio(controller.audio);
      applyMasterVolume(controller, safe);
    }
  }, []);

  const applyWebAudioVolume = useCallback(async (audio: HTMLAudioElement | null, nextVolume: number) => {
    setMasterVolume(nextVolume);
    if (!audio) return false;
    if (!isAudioEffectsSourceAllowed(audio)) return false;

    const controller = createOrReuseController(audio);
    if (!controller) {
      setStatus("浏览器不支持 Web Audio");
      return false;
    }

    applySettings(controller, settings);
    applyMasterVolume(controller, masterVolumeRef.current);
    if (controller.context.state === "suspended") {
      await controller.context.resume();
    }
    setStatus(statusForController(settings));
    return true;
  }, [createOrReuseController, setMasterVolume, settings]);

  const resumeAudioEffects = useCallback(async (audio: HTMLAudioElement | null) => {
    if (!audio) {
      setStatus("请先播放一首歌");
      return false;
    }
    if (!isAudioEffectsSourceAllowed(audio)) {
      setStatus("该音源不支持实时音效");
      return false;
    }

    const controller = createOrReuseController(audio);
    if (!controller) {
      setStatus("浏览器不支持 Web Audio");
      return false;
    }

    applySettings(controller, settings);
    applyMasterVolume(controller, masterVolumeRef.current);
    if (controller.context.state === "suspended") {
      await controller.context.resume();
    }
    setStatus("实时音效已接入");
    return true;
  }, [createOrReuseController, settings]);

  const releaseAudioEffects = useCallback(() => {
    disposeCurrentController();
    setStatus("音效链路待应用");
  }, [disposeCurrentController]);

  useEffect(() => {
    return () => {
      stopAnalyserLoop();
      const controller = controllerRef.current;
      if (!controller) return;
      controllerRef.current = null;
      disposeController(controller);
    };
  }, [stopAnalyserLoop]);

  const isAttachedTo = useCallback((audio: HTMLAudioElement | null) => {
    return Boolean(audio && controllerRef.current?.audio === audio);
  }, []);

  useEffect(() => {
    if (!settings.proToolsEnabled || !visualizerActive) {
      stopAnalyserLoop();
      const resetRaf = requestAnimationFrame(resetAnalyserState);
      return () => cancelAnimationFrame(resetRaf);
    }
    const controller = controllerRef.current;
    if (!controller) return;

    const freqData = new Uint8Array(controller.analyser.frequencyBinCount);
    const timeData = new Uint8Array(controller.analyser.fftSize);
    const sampleRate = controller.context.sampleRate;
    const nyquist = sampleRate / 2;
    const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
    const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);
    const maxMel = hzToMel(nyquist);
    const bandEdges = Array.from({ length: MEL_BAND_COUNT + 1 }, (_, index) => {
      const mel = (index / MEL_BAND_COUNT) * maxMel;
      return melToHz(mel);
    });
    let lastAnalysisFrameAt = 0;

    const tick = (frameNow: number) => {
      const active = controllerRef.current;
      if (!active || !settings.proToolsEnabled || !visualizerActive) {
        analyserRafRef.current = null;
        return;
      }
      if (active.audio.paused || active.audio.ended || document.visibilityState === "hidden") {
        analyserRafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (frameNow - lastAnalysisFrameAt < ANALYSER_UPDATE_INTERVAL_MS) {
        analyserRafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastAnalysisFrameAt = frameNow;

      active.analyser.getByteFrequencyData(freqData);
      active.analyser.getByteTimeDomainData(timeData);
      const melBands = Array.from({ length: MEL_BAND_COUNT }, (_, bandIndex) => {
        const startHz = bandEdges[bandIndex];
        const endHz = bandEdges[bandIndex + 1];
        const startBin = Math.max(0, Math.floor((startHz / nyquist) * freqData.length));
        const endBin = Math.max(startBin + 1, Math.ceil((endHz / nyquist) * freqData.length));
        let sum = 0;
        let count = 0;
        for (let i = startBin; i < endBin && i < freqData.length; i += 1) {
          sum += freqData[i];
          count += 1;
        }
        return count ? sum / count / 255 : 0;
      });

      let peak = 0;
      let rmsSum = 0;
      let clippingCount = 0;
      for (const sample of timeData) {
        const normalized = (sample - 128) / 128;
        const absValue = Math.abs(normalized);
        if (absValue > peak) peak = absValue;
        if (absValue >= 0.98) clippingCount += 1;
        rmsSum += normalized * normalized;
      }
      const rms = Math.sqrt(rmsSum / Math.max(1, timeData.length));
      const dynamicRange = Math.min(1, Math.max(0, peak - rms));
      const lufs = rms > 0.00001 ? Math.max(-70, 20 * Math.log10(rms) - 0.691) : -Infinity;
      const clipping = clippingCount / Math.max(1, timeData.length);
      const waveform = Array.from({ length: WAVEFORM_COUNT }, (_, index) => {
        const start = Math.floor((index / WAVEFORM_COUNT) * timeData.length);
        const end = Math.max(start + 1, Math.floor(((index + 1) / WAVEFORM_COUNT) * timeData.length));
        let min = 1;
        let max = -1;
        for (let i = start; i < end && i < timeData.length; i += 1) {
          const normalized = (timeData[i] - 128) / 128;
          if (normalized < min) min = normalized;
          if (normalized > max) max = normalized;
        }
        return (min + max) / 2;
      });

      let weightedFreq = 0;
      let weightedMag = 0;
      for (let i = 0; i < freqData.length; i += 1) {
        const magnitude = freqData[i] / 255;
        if (magnitude <= 0) continue;
        const freq = (i / Math.max(1, freqData.length - 1)) * nyquist;
        weightedFreq += freq * magnitude;
        weightedMag += magnitude;
      }
      const centroidHz = weightedMag > 0 ? weightedFreq / weightedMag : 0;

      const midEnergy = melBands.slice(6, 16).reduce((sum, value) => sum + value, 0) / 10;
      const highEnergy = melBands.slice(16).reduce((sum, value) => sum + value, 0) / 8;

      // 0-300Hz 区间能量，用于低频读数和 BPM 候选检测。
      const low300EndBin = Math.max(1, Math.floor((300 / nyquist) * freqData.length));
      let low300Sum = 0;
      let low300Max = 0;
      for (let i = 0; i <= low300EndBin && i < freqData.length; i += 1) {
        const normalized = freqData[i] / 255;
        low300Sum += freqData[i];
        if (normalized > low300Max) low300Max = normalized;
      }
      const low300Instant = low300Sum / ((Math.min(low300EndBin, freqData.length - 1) + 1) * 255);
      const low300Smoothed = lowBand300SmoothedRef.current * 0.72 + low300Instant * 0.28;
      lowBand300SmoothedRef.current = low300Smoothed;

      const bpmTriggered =
        (low300Max >= 0.72 || (low300Instant >= 0.54 && low300Instant > low300Smoothed * 1.08)) &&
        frameNow - lastBpmBeatMsRef.current > 320;
      if (bpmTriggered) {
        lastBpmBeatMsRef.current = frameNow;
        beatTimesRef.current = [...beatTimesRef.current, frameNow].filter((value) => frameNow - value <= 16000).slice(-16);
      }
      const beatIntervals = beatTimesRef.current
        .slice(1)
        .map((value, index) => value - beatTimesRef.current[index])
        .filter((value) => value >= 300 && value <= 2000);
      const bpm =
        beatIntervals.length >= 2
          ? Math.round(60000 / (beatIntervals.reduce((sum, value) => sum + value, 0) / beatIntervals.length))
          : 0;

      historyFrameRef.current += 1;
      if (historyFrameRef.current % 4 === 0) {
        spectrumHistoryRef.current = [...spectrumHistoryRef.current.slice(1), melBands];
        energyHistoryRef.current = [
          ...energyHistoryRef.current.slice(1),
          {
            low: Math.max(0, Math.min(1, low300Smoothed)),
            mid: Math.max(0, Math.min(1, midEnergy)),
            high: Math.max(0, Math.min(1, highEnergy)),
          },
        ];
      }

      setMelFrame({
        melBands,
        waveform,
        spectrumHistory: spectrumHistoryRef.current,
        energyHistory: energyHistoryRef.current,
        rms: Math.max(0, Math.min(1, rms * 1.8)),
        peak: Math.max(0, Math.min(1, peak)),
        lufs,
        bpm,
        clipping,
        centroidHz,
        lowEnergy: Math.max(low300Smoothed, low300Max * 0.9),
        midEnergy,
        highEnergy,
        dynamicRange,
      });
      analyserRafRef.current = requestAnimationFrame(tick);
    };

    analyserRafRef.current = requestAnimationFrame(tick);
    return () => {
      stopAnalyserLoop();
    };
  }, [
    analyserAttachVersion,
    resetAnalyserState,
    settings.enabled,
    settings.proToolsEnabled,
    stopAnalyserLoop,
    visualizerActive,
  ]);

  return {
    settings,
    setSettings,
    status,
    melFrame,
    resumeAudioEffects,
    releaseAudioEffects,
    isAttachedTo,
    setMasterVolume,
    applyWebAudioVolume,
  };
}

import { useEffect, useMemo, useRef } from "react";
import type { MelBandFrame } from "../audioEffects";

type ProAudioToolsPanelProps = {
  enabled: boolean;
  melFrame: MelBandFrame;
  status: string;
  onToggle: (value: boolean) => void;
};

function prepareCanvas(canvas: HTMLCanvasElement, fallbackWidth: number, fallbackHeight: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || fallbackWidth;
  const height = canvas.clientHeight || fallbackHeight;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

export function ProAudioToolsPanel({ enabled, melFrame, status, onToggle }: ProAudioToolsPanelProps) {
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waterfallCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const energyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const peakHoldRef = useRef<number[]>([]);
  const rmsPercent = useMemo(() => Math.round(melFrame.rms * 100), [melFrame.rms]);
  const peakPercent = useMemo(() => Math.round(melFrame.peak * 100), [melFrame.peak]);
  const dynamicPercent = useMemo(() => Math.round(melFrame.dynamicRange * 100), [melFrame.dynamicRange]);
  const centroidText = useMemo(() => `${Math.round(melFrame.centroidHz)} Hz`, [melFrame.centroidHz]);
  const lufsText = useMemo(() => (Number.isFinite(melFrame.lufs) ? `${melFrame.lufs.toFixed(1)} LUFS` : "-inf LUFS"), [melFrame.lufs]);
  const bpmText = useMemo(() => (melFrame.bpm > 0 ? `${melFrame.bpm} BPM` : "-- BPM"), [melFrame.bpm]);
  const clippingText = useMemo(() => {
    const clippingPercent = melFrame.clipping * 100;
    return clippingPercent >= 0.1 ? `${clippingPercent.toFixed(1)}%` : "Clean";
  }, [melFrame.clipping]);
  const lowPercent = useMemo(() => Math.round(melFrame.lowEnergy * 100), [melFrame.lowEnergy]);
  const midPercent = useMemo(() => Math.round(melFrame.midEnergy * 100), [melFrame.midEnergy]);
  const highPercent = useMemo(() => Math.round(melFrame.highEnergy * 100), [melFrame.highEnergy]);
  const hasSignal = useMemo(() => melFrame.melBands.some((value) => value > 0.02), [melFrame.melBands]);
  const safeStatus = (status || "").trim();
  const emptyHint =
    safeStatus === "实时音效已接入"
      ? "当前音频已经接入分析链路，但这一刻频谱值仍接近 0。"
      : safeStatus
        ? `当前状态：${safeStatus}`
        : "请先在“音效”里点击“应用到当前播放”，然后保持歌曲继续播放。";

  useEffect(() => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas(canvas, 560, 260);
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const footerHeight = 24;
    const chartHeight = height - footerHeight;

    ctx.clearRect(0, 0, width, height);
    const bgGradient = ctx.createLinearGradient(0, 0, 0, chartHeight);
    bgGradient.addColorStop(0, "#070a13");
    bgGradient.addColorStop(1, "#03060c");
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, chartHeight);
    ctx.fillStyle = "rgba(7, 10, 18, 0.94)";
    ctx.fillRect(0, chartHeight, width, footerHeight);

    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    for (let row = 1; row < 4; row += 1) {
      const y = (chartHeight / 4) * row;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const bars = melFrame.melBands;
    if (peakHoldRef.current.length !== bars.length) {
      peakHoldRef.current = Array.from({ length: bars.length }, () => 0);
    }
    const gap = 3;
    const barWidth = (width - gap * (bars.length - 1)) / bars.length;
    const contourPoints: Array<{ x: number; y: number }> = [];

    bars.forEach((value, index) => {
      const x = index * (barWidth + gap);
      const h = Math.max(4, value * (chartHeight - 16));
      const y = chartHeight - h;
      const peakHold = Math.max(value, peakHoldRef.current[index] * 0.965);
      peakHoldRef.current[index] = peakHold;
      const peakY = chartHeight - Math.max(3, peakHold * (chartHeight - 16));

      const hue = 20 + (index / Math.max(1, bars.length - 1)) * 170;
      const barGradient = ctx.createLinearGradient(0, y, 0, chartHeight);
      barGradient.addColorStop(0, `hsla(${hue}, 88%, 64%, ${0.64 + value * 0.36})`);
      barGradient.addColorStop(1, `hsla(${hue}, 72%, 38%, ${0.82 + value * 0.18})`);
      ctx.fillStyle = barGradient;
      ctx.fillRect(x, y, barWidth, h);

      ctx.fillStyle = "rgba(255, 232, 189, 0.86)";
      ctx.fillRect(x, peakY, barWidth, 2);

      contourPoints.push({ x: x + barWidth / 2, y });
    });

    if (contourPoints.length > 1) {
      ctx.beginPath();
      ctx.moveTo(contourPoints[0].x, contourPoints[0].y);
      for (let i = 1; i < contourPoints.length; i += 1) {
        const prev = contourPoints[i - 1];
        const curr = contourPoints[i];
        const cx = (prev.x + curr.x) / 2;
        ctx.quadraticCurveTo(prev.x, prev.y, cx, (prev.y + curr.y) / 2);
      }
      const last = contourPoints[contourPoints.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.strokeStyle = "rgba(203, 241, 255, 0.5)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }

    const ticks = [
      { index: 0, label: "60" },
      { index: 5, label: "250" },
      { index: 11, label: "1k" },
      { index: 17, label: "4k" },
      { index: 23, label: "12k" },
    ];
    ctx.fillStyle = "rgba(186, 196, 218, 0.74)";
    ctx.font = '11px "Avenir Next", "PingFang SC", sans-serif';
    ctx.textAlign = "center";
    ticks.forEach(({ index, label }) => {
      const x = index * (barWidth + gap) + barWidth / 2;
      ctx.fillText(label, x, chartHeight + 16);
    });
  }, [melFrame]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas(canvas, 420, 150);
    if (!prepared) return;
    const { ctx, width, height } = prepared;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#061018";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    const points = melFrame.waveform;
    if (points.length > 1) {
      ctx.beginPath();
      points.forEach((value, index) => {
        const x = (index / Math.max(1, points.length - 1)) * width;
        const y = height / 2 - value * (height * 0.42);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#48d7ff");
      gradient.addColorStop(0.5, "#fff1a8");
      gradient.addColorStop(1, "#ff7a9a");
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [melFrame.waveform]);

  useEffect(() => {
    const canvas = waterfallCanvasRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas(canvas, 420, 150);
    if (!prepared) return;
    const { ctx, width, height } = prepared;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#050912";
    ctx.fillRect(0, 0, width, height);

    const rows = melFrame.spectrumHistory.length;
    const bands = melFrame.melBands.length;
    const rowHeight = height / Math.max(1, rows);
    const colWidth = width / Math.max(1, bands);
    melFrame.spectrumHistory.forEach((history, rowIndex) => {
      const y = rowIndex * rowHeight;
      history.forEach((bandWeight, bandIndex) => {
        const hue = 205 - bandWeight * 170 + bandIndex * 1.6;
        ctx.fillStyle = `hsla(${hue}, 88%, ${18 + bandWeight * 48}%, ${0.18 + bandWeight * 0.78})`;
        ctx.fillRect(bandIndex * colWidth, y, Math.ceil(colWidth), Math.ceil(rowHeight));
      });
    });
  }, [melFrame.spectrumHistory, melFrame.melBands.length]);

  useEffect(() => {
    const canvas = energyCanvasRef.current;
    if (!canvas) return;
    const prepared = prepareCanvas(canvas, 420, 150);
    if (!prepared) return;
    const { ctx, width, height } = prepared;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#081016";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let row = 1; row < 3; row += 1) {
      const y = (height / 3) * row;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const drawLine = (key: "low" | "mid" | "high", color: string) => {
      const points = melFrame.energyHistory;
      ctx.beginPath();
      points.forEach((value, index) => {
        const x = (index / Math.max(1, points.length - 1)) * width;
        const y = height - value[key] * (height - 12) - 6;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    drawLine("low", "#ffb45f");
    drawLine("mid", "#64e0c2");
    drawLine("high", "#7db7ff");
  }, [melFrame.energyHistory]);

  return (
    <div className="settings-card pro-audio-card">
      <div className="audio-effects-row">
        <div className="audio-effects-label">
          <strong>专业工具</strong>
          <span>打开后显示 Mel 频谱、波形、瀑布图、响度和频段分析</span>
        </div>
        <label className="audio-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
          <span />
        </label>
      </div>
      {enabled && (
        <div className="pro-audio-body">
          <div className="pro-audio-meta">
            <strong>Mel 频谱</strong>
            <span>实时频域分析 · 峰值保持</span>
          </div>
          <div className="mel-spectrum-shell">
            <canvas ref={spectrumCanvasRef} className="mel-spectrum-canvas" />
            {!hasSignal && (
              <div className="mel-spectrum-empty">
                <strong>等待频谱数据</strong>
                <span>{emptyHint}</span>
              </div>
            )}
          </div>
          <div className="pro-audio-scopes">
            <div className="pro-scope-card">
              <div className="pro-scope-head">
                <strong>波形示波器</strong>
                <span>实时振幅</span>
              </div>
              <canvas ref={waveformCanvasRef} className="pro-scope-canvas" />
            </div>
            <div className="pro-scope-card">
              <div className="pro-scope-head">
                <strong>频谱瀑布图</strong>
                <span>能量轨迹</span>
              </div>
              <canvas ref={waterfallCanvasRef} className="pro-scope-canvas" />
            </div>
            <div className="pro-scope-card">
              <div className="pro-scope-head">
                <strong>频段能量历史</strong>
                <span>Low / Mid / High</span>
              </div>
              <canvas ref={energyCanvasRef} className="pro-scope-canvas" />
              <div className="energy-legend">
                <span className="low">Low</span>
                <span className="mid">Mid</span>
                <span className="high">High</span>
              </div>
            </div>
          </div>
          <div className="pro-audio-metrics">
            <div className="pro-metric-card">
              <small>RMS</small>
              <strong>{rmsPercent}%</strong>
            </div>
            <div className="pro-metric-card">
              <small>Peak</small>
              <strong>{peakPercent}%</strong>
            </div>
            <div className="pro-metric-card">
              <small>Dynamic</small>
              <strong>{dynamicPercent}%</strong>
            </div>
            <div className="pro-metric-card">
              <small>Centroid</small>
              <strong>{centroidText}</strong>
            </div>
            <div className="pro-metric-card">
              <small>LUFS</small>
              <strong>{lufsText}</strong>
            </div>
            <div className="pro-metric-card">
              <small>BPM</small>
              <strong>{bpmText}</strong>
            </div>
            <div className={melFrame.clipping >= 0.001 ? "pro-metric-card warning" : "pro-metric-card"}>
              <small>Clipping</small>
              <strong>{clippingText}</strong>
            </div>
            <div className="pro-metric-card">
              <small>Low / Mid / High</small>
              <strong>{`${lowPercent}% / ${midPercent}% / ${highPercent}%`}</strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

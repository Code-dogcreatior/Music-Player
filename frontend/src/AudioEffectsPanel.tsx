import { useMemo } from "react";
import {
  AUDIO_EFFECT_PRESETS,
  DEFAULT_AUDIO_EFFECTS,
  EQ_BANDS,
  clampDb,
  clampOutputGain,
  type AudioEffectsSettings,
} from "./audioEffects";
import "./AudioEffectsPanel.css";

type AudioEffectsPanelProps = {
  settings: AudioEffectsSettings;
  status: string;
  onChange: (settings: AudioEffectsSettings) => void;
  onResume: () => void;
};

function isDefaultEq(eq: number[]): boolean {
  return eq.every((value) => Math.abs(value) < 0.1);
}

export function AudioEffectsPanel({ settings, status, onChange, onResume }: AudioEffectsPanelProps) {
  const eqIsFlat = useMemo(() => isDefaultEq(settings.eq), [settings.eq]);

  function patch(next: Partial<AudioEffectsSettings>) {
    onChange({ ...settings, ...next });
  }

  function setEqBand(index: number, value: number) {
    const nextEq = [...settings.eq];
    nextEq[index] = clampDb(value);
    patch({ enabled: true, eq: nextEq });
  }

  return (
    <div className="settings-card audio-effects-card" onPointerDown={onResume}>
      <div className="audio-effects-head">
        <div>
          <h2 className="settings-card-title">音效</h2>
          <p className="settings-card-desc">调整 EQ 和响度归一化，播放途中会实时改变听感。</p>
        </div>
        <div className="audio-effects-status">{status}</div>
      </div>

      <div className="audio-effects-grid">
        <div className="audio-effects-row">
          <div className="audio-effects-label">
            <strong>启用音效链路</strong>
            <span>{settings.enabled ? "EQ 与响度处理已接入播放链路" : "保持接近原始播放"}</span>
          </div>
          <label className="audio-toggle">
            <input type="checkbox" checked={settings.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
            <span />
          </label>
        </div>

        <div className="audio-effects-row">
          <div className="audio-effects-label">
            <strong>响度归一化</strong>
            <span>轻微抬升小音量片段，并压住突然过响的峰值</span>
          </div>
          <label className="audio-toggle">
            <input
              type="checkbox"
              checked={settings.loudnessNormalization}
              onChange={(event) => patch({ enabled: true, loudnessNormalization: event.target.checked })}
            />
            <span />
          </label>
        </div>

        <div className="audio-effects-row">
          <div className="audio-effects-label">
            <strong>限制保护</strong>
            <span>限制突发峰值，降低音量增强后的爆音风险</span>
          </div>
          <label className="audio-toggle">
            <input
              type="checkbox"
              checked={settings.limiter}
              onChange={(event) => patch({ enabled: true, limiter: event.target.checked })}
            />
            <span />
          </label>
        </div>

        <div className="audio-effects-row">
          <div className="audio-effects-label">
            <strong>简单空间感</strong>
            <span>轻微扩展声像，适合耳机低强度使用</span>
          </div>
          <label className="audio-toggle">
            <input
              type="checkbox"
              checked={settings.spatial}
              onChange={(event) => patch({ enabled: true, spatial: event.target.checked })}
            />
            <span />
          </label>
        </div>

        <div>
          <div className="audio-effects-label">
            <strong>音量增强</strong>
            <span>在播放器音量之外增加输出增益，过高可能产生失真</span>
          </div>
          <label className="audio-boost">
            <input
              type="range"
              min={0.5}
              max={1.8}
              step={0.05}
              value={settings.outputGain}
              onChange={(event) => patch({ enabled: true, outputGain: clampOutputGain(Number(event.target.value)) })}
            />
            <span>{settings.outputGain.toFixed(2)}x</span>
          </label>
        </div>

        <div>
          <div className="audio-effects-label">
            <strong>10 段均衡器</strong>
            <span>{eqIsFlat ? "当前为平直 EQ" : "EQ 调整已实时应用"}</span>
          </div>
          <div className="audio-presets">
            {AUDIO_EFFECT_PRESETS.map((preset) => (
              <button
                className="audio-preset-btn"
                type="button"
                key={preset.label}
                onClick={() => patch({ enabled: preset.label !== "平直" || settings.enabled, eq: preset.eq })}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="eq-panel">
            {EQ_BANDS.map((band, index) => (
              <label className="eq-band" key={band.label}>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={settings.eq[index] ?? 0}
                  onChange={(event) => setEqBand(index, Number(event.target.value))}
                />
                <span className="eq-band-name">{band.label}</span>
                <span className="eq-band-value">{settings.eq[index] ?? 0} dB</span>
              </label>
            ))}
          </div>
        </div>

        <div className="audio-effects-actions">
          <button className="audio-effects-btn primary" type="button" onClick={onResume}>
            应用到当前播放
          </button>
          <button className="audio-effects-btn" type="button" onClick={() => patch({ eq: DEFAULT_AUDIO_EFFECTS.eq })}>
            EQ 归零
          </button>
          <button className="audio-effects-btn" type="button" onClick={() => onChange(DEFAULT_AUDIO_EFFECTS)}>
            全部关闭
          </button>
        </div>
      </div>
    </div>
  );
}

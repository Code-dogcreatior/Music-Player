import { AudioEffectsPanel } from "../AudioEffectsPanel";
import { AppUpdatePanel } from "./AppUpdatePanel";
import { ProAudioToolsPanel } from "./ProAudioToolsPanel";
import type { AudioEffectsSettings, MelBandFrame } from "../audioEffects";
import type { AppUpdateController } from "../hooks/useAppUpdate";
import type { LyricsDisplayMode, TranslateProvider } from "../types";

type SettingsPageProps = {
  lyricsDisplayMode: LyricsDisplayMode;
  showFpsDebug: boolean;
  translateProvider: TranslateProvider;
  audioEffectsSettings: AudioEffectsSettings;
  audioEffectsStatus: string;
  audioEffectsMelFrame: MelBandFrame;
  showSourceColumns: boolean;
  appUpdate: AppUpdateController;
  onLyricsDisplayModeChange: (mode: LyricsDisplayMode) => void;
  onShowFpsDebugChange: (value: boolean) => void;
  onTranslateProviderChange: (provider: TranslateProvider) => void;
  onShowSourceColumnsChange: (value: boolean) => void;
  onAudioEffectsChange: (settings: AudioEffectsSettings) => void;
  onResumeAudioEffects: () => void;
  onToggleProAudioTools: (value: boolean) => void;
};

export function SettingsPage({
  lyricsDisplayMode,
  showFpsDebug,
  translateProvider,
  audioEffectsSettings,
  audioEffectsStatus,
  audioEffectsMelFrame,
  showSourceColumns,
  appUpdate,
  onLyricsDisplayModeChange,
  onShowFpsDebugChange,
  onTranslateProviderChange,
  onShowSourceColumnsChange,
  onAudioEffectsChange,
  onResumeAudioEffects,
  onToggleProAudioTools,
}: SettingsPageProps) {
  return (
    <section className="settings-page" aria-labelledby="settings-lyrics-heading">
      <AppUpdatePanel update={appUpdate} />
      <div className="settings-card">
        <h2 id="settings-lyrics-heading" className="settings-card-title">
          歌词展示
        </h2>
        <p className="settings-card-desc">控制全屏播放页歌词与背景的动效强度。由你手动选择。</p>
        <div className="lyrics-mode-toggle" role="group" aria-label="歌词展示模式">
          <button
            type="button"
            className={lyricsDisplayMode === "full" ? "mode-btn active" : "mode-btn"}
            onClick={() => onLyricsDisplayModeChange("full")}
          >
            满血版
          </button>
          <button
            type="button"
            className={lyricsDisplayMode === "performance" ? "mode-btn active" : "mode-btn"}
            onClick={() => onLyricsDisplayModeChange("performance")}
          >
            性能版
          </button>
        </div>
        <div className="settings-toggle-row" style={{ marginTop: "14px" }}>
          <span>
            <strong>显示右下角 Debug</strong>
            <small>关闭后不渲染 FPS Debug 面板，减少干扰。</small>
          </span>
          <input type="checkbox" checked={showFpsDebug} onChange={(e) => onShowFpsDebugChange(e.target.checked)} />
        </div>
      </div>
      <div className="settings-card">
        <h2 className="settings-card-title">列表显示</h2>
        <p className="settings-card-desc">控制搜索结果和本地曲库是否显示来源、解析源。</p>
        <div className="settings-toggle-row">
          <span>
            <strong>显示来源和解析源</strong>
            <small>关闭后隐藏“来源”和“解析源”列，列表更简洁。</small>
          </span>
          <input type="checkbox" checked={showSourceColumns} onChange={(e) => onShowSourceColumnsChange(e.target.checked)} />
        </div>
      </div>
      <div className="settings-card">
        <h2 className="settings-card-title">歌词翻译</h2>
        <p className="settings-card-desc">设置“翻译中文”按钮使用的服务；阿里云失败时后端会自动降级到 DeepSeek。</p>
        <div className="lyrics-mode-toggle" role="group" aria-label="歌词翻译服务">
          <button
            type="button"
            className={translateProvider === "ali" ? "mode-btn active" : "mode-btn"}
            onClick={() => onTranslateProviderChange("ali")}
          >
            阿里云百炼
          </button>
          <button
            type="button"
            className={translateProvider === "dp" ? "mode-btn active" : "mode-btn"}
            onClick={() => onTranslateProviderChange("dp")}
          >
            DeepSeek
          </button>
        </div>
      </div>
      <AudioEffectsPanel
        settings={audioEffectsSettings}
        status={audioEffectsStatus}
        onChange={onAudioEffectsChange}
        onResume={onResumeAudioEffects}
      />
      <ProAudioToolsPanel
        enabled={audioEffectsSettings.proToolsEnabled}
        melFrame={audioEffectsMelFrame}
        status={audioEffectsStatus}
        onToggle={onToggleProAudioTools}
      />
    </section>
  );
}

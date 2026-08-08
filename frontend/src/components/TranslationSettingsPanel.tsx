import { useEffect, useState } from "react";
import { IoEyeOffOutline, IoEyeOutline, IoKeyOutline, IoRefreshOutline, IoSaveOutline } from "react-icons/io5";
import { errorMessage, requestJson } from "../api";
import type { TranslateProvider } from "../types";

type TranslationSettings = {
  env_path: string;
  env_exists: boolean;
  ali_api_key: string;
  ali_model: string;
  ali_source: "env_file" | "system" | "none";
  deepseek_api_key: string;
  deepseek_model: string;
  deepseek_source: "env_file" | "system" | "none";
  message?: string;
};

type TranslationSettingsPanelProps = {
  translateProvider: TranslateProvider;
  onTranslateProviderChange: (provider: TranslateProvider) => void;
};

const EMPTY_SETTINGS: TranslationSettings = {
  env_path: ".env",
  env_exists: false,
  ali_api_key: "",
  ali_model: "deepseek-v4-flash",
  ali_source: "none",
  deepseek_api_key: "",
  deepseek_model: "deepseek-v4-flash",
  deepseek_source: "none",
};

function sourceLabel(source: TranslationSettings["ali_source"]): string {
  if (source === "env_file") return "已读取 .env";
  if (source === "system") return "系统环境变量";
  return "未配置";
}

export function TranslationSettingsPanel({
  translateProvider,
  onTranslateProviderChange,
}: TranslationSettingsPanelProps) {
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAliKey, setShowAliKey] = useState(false);
  const [showDeepSeekKey, setShowDeepSeekKey] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void requestJson<TranslationSettings>("/api/translation-settings", { signal: controller.signal })
      .then(({ data }) => {
        setSettings(data);
        setError("");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason, "读取翻译配置失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function reloadSettings() {
    if (loading || saving) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const { data } = await requestJson<TranslationSettings>("/api/translation-settings/reload", {
        method: "POST",
      });
      setSettings(data);
      setNotice(data.message || "已重新读取本机 .env");
    } catch (reason) {
      setError(errorMessage(reason, "重新读取翻译配置失败"));
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    if (loading || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const { data } = await requestJson<TranslationSettings>("/api/translation-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ali_api_key: settings.ali_api_key,
          ali_model: settings.ali_model,
          deepseek_api_key: settings.deepseek_api_key,
          deepseek_model: settings.deepseek_model,
        }),
      });
      setSettings(data);
      setNotice(data.message || "翻译配置已保存");
    } catch (reason) {
      setError(errorMessage(reason, "保存翻译配置失败"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card translation-settings-card">
      <div className="translation-settings-heading">
        <div>
          <h2 className="settings-card-title">歌词翻译</h2>
          <p className="settings-card-desc">选择翻译服务，并管理当前程序实际读取的本机配置。</p>
        </div>
        <span className={settings.env_exists ? "env-status-badge ready" : "env-status-badge"}>
          <span aria-hidden />
          {settings.env_exists ? "ENV 已连接" : "等待 ENV"}
        </span>
      </div>

      <div className="translation-provider-row">
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
        <div className="env-path" title={settings.env_path}>
          <IoKeyOutline aria-hidden />
          <span>{settings.env_path}</span>
        </div>
      </div>

      <div className={loading ? "translation-env-grid loading" : "translation-env-grid"} aria-busy={loading}>
        <div className="translation-env-provider">
          <div className="translation-env-provider-head">
            <strong>阿里云百炼</strong>
            <small className={settings.ali_api_key ? "configured" : ""}>{sourceLabel(settings.ali_source)}</small>
          </div>
          <label className="translation-field">
            <span>API Key</span>
            <div className="secret-input-shell">
              <input
                type={showAliKey ? "text" : "password"}
                value={settings.ali_api_key}
                onChange={(event) => setSettings((current) => ({ ...current, ali_api_key: event.target.value }))}
                placeholder="填写 ALI_TRANSLATE_API_KEY"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" onClick={() => setShowAliKey((value) => !value)} aria-label={showAliKey ? "隐藏阿里云 Key" : "显示阿里云 Key"}>
                {showAliKey ? <IoEyeOffOutline /> : <IoEyeOutline />}
              </button>
            </div>
          </label>
          <label className="translation-field">
            <span>模型</span>
            <input
              type="text"
              value={settings.ali_model}
              onChange={(event) => setSettings((current) => ({ ...current, ali_model: event.target.value }))}
              spellCheck={false}
            />
          </label>
        </div>

        <div className="translation-env-provider">
          <div className="translation-env-provider-head">
            <strong>DeepSeek</strong>
            <small className={settings.deepseek_api_key ? "configured" : ""}>{sourceLabel(settings.deepseek_source)}</small>
          </div>
          <label className="translation-field">
            <span>API Key</span>
            <div className="secret-input-shell">
              <input
                type={showDeepSeekKey ? "text" : "password"}
                value={settings.deepseek_api_key}
                onChange={(event) => setSettings((current) => ({ ...current, deepseek_api_key: event.target.value }))}
                placeholder="填写 DEEPSEEK_API_KEY"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowDeepSeekKey((value) => !value)}
                aria-label={showDeepSeekKey ? "隐藏 DeepSeek Key" : "显示 DeepSeek Key"}
              >
                {showDeepSeekKey ? <IoEyeOffOutline /> : <IoEyeOutline />}
              </button>
            </div>
          </label>
          <label className="translation-field">
            <span>模型</span>
            <input
              type="text"
              value={settings.deepseek_model}
              onChange={(event) => setSettings((current) => ({ ...current, deepseek_model: event.target.value }))}
              spellCheck={false}
            />
          </label>
        </div>
      </div>

      <div className="translation-settings-footer">
        <div className={error ? "translation-settings-message error" : "translation-settings-message"} role="status">
          {error || notice || "Key 仅写入本机 .env，不会进入 Git。保存后立即用于新的翻译任务。"}
        </div>
        <div className="translation-settings-actions">
          <button type="button" className="settings-secondary-btn" disabled={loading || saving} onClick={() => void reloadSettings()}>
            <IoRefreshOutline aria-hidden className={loading ? "spinning" : ""} />
            重新读取
          </button>
          <button type="button" className="settings-save-btn" disabled={loading || saving} onClick={() => void saveSettings()}>
            <IoSaveOutline aria-hidden />
            {saving ? "保存中…" : "保存到 ENV"}
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Globe2, KeyRound, Layers, LogOut, Server, ShieldCheck } from "lucide-react";
import { api, json } from "@/lib/api";
import { healthSchema, sessionSchema, settingsSchema, type Locale } from "@/lib/schema";
import { statusText, type CopyKey } from "@/lib/i18n";
import { useAction, useWorkspace } from "./providers";
import { Badge, Button, ErrorState, Loading, Modal, Panel } from "./ui";
import { ThemePreferenceControl } from "./theme-controls";
import { mediaCapabilities } from "@/lib/media";
import { MediaCapabilities, MediaRuntime } from "./media-details";

export function useHealth() { return useQuery({ queryKey: ["health"], queryFn: ({ signal }) => api("/health", healthSchema, { signal }), refetchInterval: 30000 }); }
export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const { t, locale, setLocale } = useWorkspace();
  return <label className={compact ? "language-select" : "field"}><span className={compact ? "sr-only" : ""}>{t("language")}</span>{compact && <Globe2 size={14} />}<select aria-label={t("language")} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}><option value="ru">{compact ? "RU" : "Русский"}</option><option value="kk">{compact ? "KK" : "Қазақша"}</option><option value="en">{compact ? "EN" : "English"}</option></select></label>;
}
export function LoginDialog() {
  const { t, loginOpen, setLoginOpen, session } = useWorkspace();
  const [code, setCode] = useState("");
  const { pending, run } = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run(() => api("/session", sessionSchema, json("POST", { code })), t("signedIn"), false);
    if (result?.authenticated) { setCode(""); setLoginOpen(false); }
  };
  return <Modal open={loginOpen} onOpenChange={(open) => { setLoginOpen(open); if (!open) setCode(""); }} title={t("adminAccess")} description={t("loginDescription")}>
    {session.isError ? <ErrorState error={session.error} retry={() => session.refetch()} /> : session.isPending ? <Loading /> : !session.data?.login_enabled ? <p className="notice">{t("loginDisabled")}</p> : <form onSubmit={submit} className="form-stack"><label className="field"><span>{t("adminCode")}</span><input type="password" autoComplete="current-password" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={256} autoFocus /></label><Button type="submit" variant="primary" busy={pending}><KeyRound size={16} />{t("login")}</Button></form>}
  </Modal>;
}
function CapabilityValue({ value }: { value: unknown }) {
  const { t } = useWorkspace();
  if (typeof value === "boolean") return <Badge tone={value ? "low" : "neutral"}>{t(value ? "enabled" : "disabled")}</Badge>;
  if (typeof value === "string") return <span className="capability-value">{value === "configured" ? t("configuredValue") : statusText(value, t)}</span>;
  if (Array.isArray(value)) return <span>{value.map(String).join(", ")}</span>;
  return <code className="capability-json">{value == null ? t("unknown") : JSON.stringify(value)}</code>;
}
export function SettingsScreen() {
  const { t, session, canManage, setLoginOpen, mode } = useWorkspace();
  const health = useHealth();
  const settings = useQuery({ queryKey: ["settings"], queryFn: ({ signal }) => api("/settings", settingsSchema, { signal }), refetchInterval: 30000 });
  const { run, pending } = useAction();
  const cap = settings.data?.capabilities;
  const capabilityKeys = ["llm", "browser", "browser_use", "official_youtube_api", "video_analysis", "audio_transcription", "media_processing", "live_stream", "screenshots", "languages", "automatic_legal_verdicts"];
  const row = (label: string, value: ReactNode, icon?: ReactNode) => <div className="setting-row" key={label}><dt>{icon}{label}</dt><dd>{value}</dd></div>;
  return <div className="settings-grid"><div className="screen-stack"><Panel title={t("adminAccess")}><div className="access-card"><div className="access-icon"><ShieldCheck size={24} /></div><div><h3>{t(canManage ? "authenticated" : "visitor")}</h3><p>{canManage && !session.data?.login_enabled ? t("localAdmin") : t(canManage ? "operator" : "readonly")}</p></div></div>{session.isError && <ErrorState error={session.error} retry={() => session.refetch()} />}<div className="settings-actions">{canManage ? session.data?.login_enabled && <Button busy={pending} onClick={() => run(() => api("/session", sessionSchema, json("DELETE")), t("signedOut"), false)}><LogOut size={16} />{t("logout")}</Button> : <Button onClick={() => setLoginOpen(true)} variant="primary"><KeyRound size={16} />{t("login")}</Button>}</div></Panel>
    <Panel title={t("health")} aside={<Button variant="ghost" onClick={() => health.refetch()}>{t("refresh")}</Button>}>
      {health.isPending && <Loading />}{health.isError && <ErrorState error={health.error} retry={() => health.refetch()} stale={!!health.data} />}{health.data && <dl className="settings-list">{row(t("status"), <Badge tone={health.data.status === "ok" ? "low" : "medium"}>{health.data.status}</Badge>, <Server size={16} />)}{row(t("database"), <CapabilityValue value={health.data.database} />, <Database size={16} />)}{row(t("queue"), <CapabilityValue value={health.data.queue} />, <Layers size={16} />)}{row(t("llm"), <CapabilityValue value={health.data.llm} />)}{row(t("browser"), <CapabilityValue value={health.data.browser} />)}{row(t("version"), <code>{health.data.version}</code>)}</dl>}
      {health.data && <div className="settings-media"><MediaCapabilities capabilities={mediaCapabilities(health.isError ? undefined : health.data)} t={t} /></div>}
    </Panel></div><div className="screen-stack"><Panel title={t("settings")}><div className="settings-preferences"><ThemePreferenceControl /><LanguageSelect /><dl className="settings-list">{row(t("mode"), <Badge>{mode.toUpperCase()}</Badge>)}{row(t("retention"), settings.data ? `${settings.data.retention_days} ${t("days")}` : "—")}</dl></div></Panel><Panel title={t("capabilities")} description={t("settingsReadonly")}>
      {settings.isPending && <Loading />}{settings.isError && <ErrorState error={settings.error} retry={() => settings.refetch()} stale={!!settings.data} />}{cap && typeof cap === "object" && !Array.isArray(cap) ? <dl className="settings-list">{Object.entries(cap).map(([key, value]) => row(capabilityKeys.includes(key) ? t(key as CopyKey) : key, key === "media_processing" ? <MediaRuntime value={value} t={t} /> : <CapabilityValue value={value} />))}</dl> : settings.data && <div className="p-5"><CapabilityValue value={cap} /></div>}
    </Panel></div></div>;
}

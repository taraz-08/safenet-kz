"use client";
import { useState, type FormEvent } from "react";
import { FileText, FileVideo, Globe2, Link2, ScanLine, ShieldCheck, Sparkles } from "lucide-react";
import { api, json } from "@/lib/api";
import { safeHref, scanSchema, type Locale } from "@/lib/schema";
import { useAction, useWorkspace } from "./providers";
import { Badge, Button, Panel, PermissionNotice } from "./ui";
import { ScanDetails } from "./scan-detail";
import { MEDIA_ACCEPT, mediaCapabilities, mediaFileError, mediaUpload } from "@/lib/media";
import { MediaCapabilities } from "./media-details";
import { useHealth } from "./settings";

// Authored fictional samples are available only after selecting Demo. Never injected into Live.
const demoSamples: Record<Locale, Record<string, string>> = {
  ru: { investment: "Демонстрационный пример. Инвестируйте 50 000 тенге сегодня! Гарантируем 30% дохода каждый месяц без риска. Пригласите троих друзей и получайте доход с их взносов. Осталось только 3 места — переведите деньги прямо сейчас!", safe: "Демонстрационный пример. В городской библиотеке в субботу состоится бесплатная лекция по финансовой грамотности. Обсудим риски инвестиций и способы проверки источников. Участие бесплатно, взносы не требуются." },
  kk: { investment: "Демонстрациялық мысал. Бүгін 50 000 теңге салыңыз! Ай сайын тәуекелсіз 30% табысқа кепілдік береміз. Үш досыңызды шақырып, олардың жарнасынан табыс алыңыз. Тек 3 орын қалды — ақшаны қазір аударыңыз!", safe: "Демонстрациялық мысал. Сенбі күні қалалық кітапханада қаржылық сауаттылық бойынша тегін дәріс өтеді. Инвестиция тәуекелдері мен дереккөздерді тексеру жолдарын талқылаймыз. Қатысу тегін, жарна қажет емес." },
  en: { investment: "Fictional demonstration. Invest 50,000 tenge today! Guaranteed 30% monthly returns with no risk. Invite three friends and earn from their deposits. Only 3 places left — transfer the money now!", safe: "Fictional demonstration. The city library is hosting a free financial literacy lecture on Saturday. We will discuss investment risks and how to verify sources. Attendance is free; no payment is required." },
};
export function ScannerScreen() {
  const { t, mode, locale, canManage, notify } = useWorkspace();
  const [kind, setKind] = useState<"url" | "text" | "media">(mode === "demo" ? "text" : "url");
  const health = useHealth();
  const processors = mediaCapabilities(health.data).media_processing;
  const mediaDisabled = processors != null && typeof processors === "object" && "enabled" in processors && processors.enabled === false;
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [sample, setSample] = useState("");
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState<"file" | "sourceUrl" | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const { run, pending } = useAction();
  const selectKind = (next: typeof kind) => {
    if (next !== kind) { setFile(null); setError(""); setInvalidField(null); setKind(next); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setInvalidField(null);
    if (kind === "media") {
      const fileError = mediaFileError(file);
      if (fileError) { setError(t(fileError)); setInvalidField("file"); return; }
      if (sourceUrl.trim() && (!safeHref(sourceUrl.trim()) || sourceUrl.length > 2048)) { setError(t("invalidUrl")); setInvalidField("sourceUrl"); return; }
      const result = await run(() => api("/media/scans", scanSchema, mediaUpload(file!, mode, locale, sourceUrl)));
      if (result) { setScanId(result.id); notify(t("scanQueued")); }
      return;
    }
    if (!(kind === "url" ? url.trim() : text.trim())) { setError(t("inputRequired")); return; }
    if (kind === "url" && (!safeHref(url.trim()) || url.length > 2048)) { setError(t("invalidUrl")); return; }
    const result = await run(() => api("/scans", scanSchema, json("POST", { ...(kind === "url" ? { url: url.trim() } : { text: text.trim(), platform: "manual" }), mode, locale })));
    if (result) { setScanId(result.id); notify(t("scanQueued")); }
  };
  return <div className="screen-stack"><PermissionNotice /><div className="scanner-grid"><Panel title={t("scanner")} aside={<Badge tone={mode === "demo" ? "medium" : "low"}>{mode.toUpperCase()}</Badge>}>
    <form className="scanner-form" onSubmit={submit}>
      <div className="segmented scanner-tabs" role="group" aria-label={t("source")}><button type="button" aria-pressed={kind === "url"} disabled={mode === "demo" || pending} onClick={() => selectKind("url")}><Link2 size={16} />{t("url")}</button><button type="button" aria-pressed={kind === "text"} disabled={pending} onClick={() => selectKind("text")}><FileText size={16} />{t("text")}</button><button type="button" aria-pressed={kind === "media"} disabled={pending} onClick={() => selectKind("media")}><FileVideo size={16} />{t("mediaTab")}</button></div>
      {mode === "demo" && kind === "text" && <label className="field"><span><Sparkles size={14} />{t("sample")}</span><select value={sample} onChange={(event) => { setSample(event.target.value); setText(demoSamples[locale][event.target.value] || ""); }}><option value="">{t("sampleSelect")}</option><option value="investment">{t("sampleInvestment")}</option><option value="safe">{t("sampleSafe")}</option></select></label>}
      {kind === "url" && <label className="field"><span>{t("url")}</span><input type="url" autoComplete="url" inputMode="url" placeholder="https://…" required maxLength={2048} value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby="scan-input-help scan-coverage-note" aria-invalid={!!error} /><small id="scan-input-help">{t("urlHint")}</small></label>}
      {kind === "text" && <label className="field"><span>{t("text")}<small className="mono">{text.length.toLocaleString()} / 20 000</small></span><textarea rows={8} placeholder={t("textHint")} maxLength={20000} required value={text} onChange={(e) => { setText(e.target.value); setSample(""); }} aria-describedby="scan-input-help" /><small id="scan-input-help">{t("manualNotice")}</small></label>}
      {kind === "media" && <>
        {mediaDisabled && <p className="notice">{t("mediaLocalOnly")} <a href="http://127.0.0.1:3000/scanner" target="_blank" rel="noreferrer">{t("mediaOpenLocal")}</a></p>}
        <label className="field media-file-field"><span>{t("mediaFile")}</span><input type="file" accept={MEDIA_ACCEPT} disabled={pending || !canManage} required onChange={(event) => { const nextFile = event.target.files?.[0] || null; setFile(nextFile); const issue = mediaFileError(nextFile); setError(issue ? t(issue) : ""); setInvalidField(issue ? "file" : null); }} aria-describedby={`media-file-help media-limits${invalidField === "file" ? " scan-input-error" : ""}`} aria-invalid={invalidField === "file"} /><small id="media-file-help">{t("mediaFormats")}</small>{file && <small className="media-filename">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MiB</small>}</label>
        <p className="notice subtle" id="media-limits">{t("mediaLimits")}</p>
        <label className="field"><span>{t("originalUrl")}</span><input type="url" placeholder="https://…" maxLength={2048} disabled={pending} value={sourceUrl} onChange={(event) => { setSourceUrl(event.target.value); if (invalidField === "sourceUrl") { setInvalidField(null); setError(""); } }} aria-describedby={`media-source-help${invalidField === "sourceUrl" ? " scan-input-error" : ""}`} aria-invalid={invalidField === "sourceUrl"} /><small id="media-source-help">{t("originalUrlHint")}</small></label>
        <p className="notice subtle">{t("uploadedMediaNotice")}</p>
      </>}
      {kind === "url" && <p className="notice subtle" id="scan-coverage-note">{t("mediaUrlCoverage")} {t("mediaLimits")}</p>}
      {kind !== "text" && <MediaCapabilities capabilities={mediaCapabilities(health.isError ? undefined : health.data)} t={t} />}
      {error && <p className="form-error" id="scan-input-error" role="alert">{error}</p>}
      {kind === "media" && pending && <p role="status" className="muted">{t("mediaUploading")}</p>}
      <Button className="w-full" type="submit" variant="primary" busy={pending} disabled={!canManage || (kind === "media" && mediaDisabled)}><ScanLine size={17} />{t(kind === "url" ? "analyze" : kind === "media" ? "analyzeMedia" : "analyzeText")}</Button>
      <p className="scanner-footnote"><ShieldCheck size={16} />{t(kind === "media" ? "scoreNotice" : "publicOnly")}</p>
    </form>
  </Panel><div className="scanner-guide"><div className="scan-reticle"><Globe2 size={56} strokeWidth={0.9} /><span /><i /></div><span className="eyebrow">SAFENET INTELLIGENCE</span><h2>{t("scanReady")}</h2><p>{t("scanReadyDesc")}</p><div className="scan-steps"><span>01 / {t("source")}</span><span>02 / {t("evidence")}</span><span>03 / {t("review")}</span></div></div></div>
    {scanId && <Panel title={t("inspect")}><div className="inline-result"><ScanDetails key={scanId} id={scanId} /></div></Panel>}
  </div>;
}

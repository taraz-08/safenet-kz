"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Bot, MessageSquare, ShieldCheck, User } from "lucide-react";
import { z } from "zod";
import { api, json } from "@/lib/api";
import { assistantSchema } from "@/lib/schema";
import { statusText } from "@/lib/i18n";
import { scanListSchema } from "./dashboard";
import { useAction, useWorkspace } from "./providers";
import { Badge, Button, ErrorState, ExternalLink, PermissionNotice } from "./ui";
import { useScan } from "./scan-detail";

type Message = { role: "user" | "assistant"; text: string; context?: string; result?: z.infer<typeof assistantSchema> };
export function AssistantScreen() {
  const { mode, locale, t, canManage, openScan } = useWorkspace();
  const params = useSearchParams();
  const [context, setContext] = useState(params.get("scan") || "");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const { pending, run } = useAction();
  const scans = useQuery({ queryKey: ["chat-scans", mode], queryFn: ({ signal }) => api("/scans?mode=" + mode + "&limit=100", scanListSchema, { signal }), refetchInterval: 10000 });
  const selected = useScan(context || null);
  const contextValid = !context || (selected.data?.mode === mode && selected.data?.status === "completed");
  useEffect(() => { end.current?.scrollIntoView({ behavior: "instant", block: "nearest" }); }, [messages, pending]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = question.trim();
    if (!value || !contextValid) return;
    const response = await run(() => api("/assistant", assistantSchema, { ...json("POST", { question: value, ...(context ? { scan_id: context } : {}), locale }), timeoutMs: 90000 }));
    if (response) {
      setMessages((items) => [...items, { role: "user", text: value, context }, { role: "assistant", text: response.answer, result: response, context }]);
      setQuestion("");
    }
  };
  const completed = scans.data?.items.filter((scan) => scan.status === "completed") || [];
  return <div className="screen-stack"><PermissionNotice />
    <section className="chat-panel">
      <div className="chat-header"><div className="assistant-avatar"><Bot size={22} /></div><div><h2>SafeNet AI</h2><p>{t("assistantDesc")}</p></div><Badge tone="neutral">{mode.toUpperCase()}</Badge></div>
      <div className="chat-context"><label htmlFor="chat-context">{t("chatContext")}</label>
        <select id="chat-context" value={context} disabled={pending} onChange={(e) => setContext(e.target.value)}>
          <option value="">{t("noContext")}</option>
          {context && !completed.some((scan) => scan.id === context) && <option value={context}>#{context.slice(0, 8)}</option>}
          {completed.map((scan) => <option key={scan.id} value={scan.id}>{scan.title || scan.url || t("manual") + " #" + scan.id.slice(0, 8)} · {scan.score}/100</option>)}
        </select>
        {context && contextValid && <Button variant="ghost" onClick={() => openScan(context)}>{t("inspect")}</Button>}
      </div>
      {scans.isError && <ErrorState error={scans.error} retry={() => scans.refetch()} stale={!!scans.data} />}
      {selected.isError && context && <ErrorState error={selected.error} retry={() => selected.refetch()} />}
      {context && selected.data && !contextValid && <p className="notice">{t("noContext")} · {mode.toUpperCase()}</p>}
      <div className="chat-messages" role="log" aria-live="polite" aria-label={t("assistant")}>
        {!messages.length ? <div className="chat-welcome"><div className="chat-mark"><MessageSquare size={32} strokeWidth={1.4} /></div><h2>{t("chatWelcome")}</h2><p>{t("chatWelcomeDesc")}</p><div className="suggestions">{(["promptWhy", "promptNext", "promptSafe"] as const).map((key) => <button type="button" key={key} onClick={() => setQuestion(t(key))}>{t(key)}<ArrowUp size={15} /></button>)}</div></div> : messages.map((message, i) => <article className={"chat-message message-" + message.role} key={i}>
          <div className="message-avatar">{message.role === "assistant" ? <Bot size={18} /> : <User size={18} />}</div>
          <div className="message-body"><strong>{message.role === "assistant" ? "SafeNet AI" : t("operator")}</strong><p>{message.text}</p>
            {message.result && <><div className="message-meta"><Badge>{message.result.provider === "evidence_assistant" ? t("rules") : message.result.provider}</Badge><span>{statusText(message.result.status, t)}</span>{message.context && <button onClick={() => openScan(message.context!)}>#{message.context.slice(0, 8)}</button>}</div>
              {!!message.result.citations.length && <div className="message-citations"><span>{t("citations")}</span>{message.result.citations.map((url, index) => <ExternalLink key={index} href={url}>{url}</ExternalLink>)}</div>}
            </>}
          </div>
        </article>)}
        {pending && <div className="thinking" role="status"><span className="pulse live-dot" />{t("thinking")}</div>}<div ref={end} />
      </div>
      <form className="chat-compose" onSubmit={submit}><label className="sr-only" htmlFor="question">{t("question")}</label><textarea id="question" rows={2} placeholder={t("askPlaceholder")} value={question} maxLength={2000} required onChange={(e) => setQuestion(e.target.value)} disabled={pending} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><Button type="submit" variant="primary" busy={pending} disabled={!canManage || !question.trim() || !contextValid} aria-label={t("send")}><ArrowUp size={20} /></Button></form>
      <p className="chat-disclaimer"><ShieldCheck size={14} />{t("scoreNotice")}</p>
    </section>
  </div>;
}
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { overviewSchema, sessionSchema, type Locale, type Mode } from "@/lib/schema";
import { translator, type Translate } from "@/lib/i18n";
import { ThemeProvider } from "./theme-provider";

type Toast = { id: number; message: string; error: boolean };
function useSession() { return useQuery({ queryKey: ["session"], queryFn: ({ signal }) => api("/session", sessionSchema, { signal }), refetchInterval: 30000, retry: 1 }); }
function useLiveOverview(mode: Mode) {
  const client = useQueryClient();
  const [connection, setConnection] = useState<"connecting" | "live" | "polling">("connecting");
  const query = useQuery({ queryKey: ["overview", mode], queryFn: ({ signal }) => api(`/overview?mode=${mode}`, overviewSchema, { signal }), refetchInterval: connection === "live" ? 30000 : 5000, retry: 1 });
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;
    let receivedAt = 0;
    setConnection("connecting");
    const connect = () => {
      if (disposed) return;
      try {
        const url = new URL(process.env.NEXT_PUBLIC_WS_URL || "ws://127.0.0.1:8100/events");
        if (!["ws:", "wss:"].includes(url.protocol) || (location.protocol === "https:" && url.protocol === "ws:")) throw new Error("Websocket configuration");
        url.searchParams.set("mode", mode);
        socket = new WebSocket(url.href);
        receivedAt = Date.now();
        socket.onmessage = (event) => {
          if (disposed) return;
          try {
            const message = JSON.parse(event.data);
            if (message.type !== "snapshot") return;
            const snapshot = overviewSchema.safeParse(message.data);
            if (!snapshot.success || snapshot.data.mode !== mode) return;
            receivedAt = Date.now(); attempts = 0;
            client.setQueryData(["overview", mode], snapshot.data);
            setConnection("live");
          } catch { /* Invalid snapshots never replace validated API data. */ }
        };
        socket.onerror = () => { if (!disposed) setConnection("polling"); socket?.close(); };
        socket.onclose = () => {
          if (disposed) return;
          setConnection("polling");
          if (reconnect) clearTimeout(reconnect);
          reconnect = setTimeout(connect, Math.min(30000, 1500 * 2 ** Math.min(attempts++, 5)));
        };
      } catch { setConnection("polling"); }
    };
    connect();
    watchdog = setInterval(() => { if (socket && socket.readyState < WebSocket.CLOSING && Date.now() - receivedAt > 10000) { setConnection("polling"); socket.close(); } }, 5000);
    return () => { disposed = true; if (reconnect) clearTimeout(reconnect); if (watchdog) clearInterval(watchdog); socket?.close(); };
  }, [client, mode]);
  return { ...query, connection };
}

type Workspace = {
  locale: Locale; setLocale: (locale: Locale) => void; t: Translate;
  mode: Mode; setMode: (mode: Mode) => void;
  session: ReturnType<typeof useSession>; canManage: boolean;
  overview: ReturnType<typeof useLiveOverview>;
  loginOpen: boolean; setLoginOpen: (open: boolean) => void;
  selectedScan: string | null; openScan: (id: string | null) => void;
  notify: (message: string, error?: boolean) => void;
};
const Context = createContext<Workspace | null>(null);
export function useWorkspace() { const value = useContext(Context); if (!value) throw new Error("Missing workspace provider"); return value; }
export function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return t("loginRequired");
    if (error.kind === "schema") return t("schemaError");
    if (error.kind === "network") return t(error.message === "timeout" ? "timeout" : "networkError");
  }
  return error instanceof Error ? error.message : t("error");
}
function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>("ru");
  const [mode, updateMode] = useState<Mode>("live");
  const [loginOpen, setLoginOpen] = useState(false);
  const [selectedScan, openScan] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toastId = useRef(0);
  const session = useSession();
  const overview = useLiveOverview(mode);
  const t = useMemo(() => translator(locale), [locale]);
  useEffect(() => { try { const stored = localStorage.getItem("safenet-locale"); if (stored === "ru" || stored === "kk" || stored === "en") updateLocale(stored); if (sessionStorage.getItem("safenet-mode") === "demo") updateMode("demo"); } catch { /* Storage may be disabled. */ } }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => () => toastTimers.current.forEach(clearTimeout), []);
  const setLocale = (value: Locale) => { updateLocale(value); try { localStorage.setItem("safenet-locale", value); } catch { /* Session-only preference. */ } };
  const setMode = (value: Mode) => { openScan(null); updateMode(value); try { sessionStorage.setItem("safenet-mode", value); } catch { /* In-memory mode remains available. */ } };
  const notify = useCallback((message: string, error = false) => {
    const id = ++toastId.current;
    setToasts((items) => [...items.slice(-3), { id, message, error }]);
    const timer = setTimeout(() => { setToasts((items) => items.filter((item) => item.id !== id)); toastTimers.current = toastTimers.current.filter((entry) => entry !== timer); }, error ? 10000 : 5000);
    toastTimers.current.push(timer);
  }, []);
  return <Context.Provider value={{ locale, setLocale, t, mode, setMode, session, canManage: session.data?.authenticated === true, overview, loginOpen, setLoginOpen, selectedScan, openScan, notify }}>
    {children}
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => <div className={`toast ${toast.error ? "toast-error" : ""}`} key={toast.id} role={toast.error ? "alert" : "status"}>
        {toast.error ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}<span>{toast.message}</span>
        <button className="icon-button" aria-label={t("close")} onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><X size={16} /></button>
      </div>)}
    </div>
  </Context.Provider>;
}
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 3000, retry: 1, refetchOnWindowFocus: true }, mutations: { retry: false } } }));
  return <ThemeProvider><QueryClientProvider client={client}><MotionConfig reducedMotion="user"><WorkspaceProvider>{children}</WorkspaceProvider></MotionConfig></QueryClientProvider></ThemeProvider>;
}
export function useAction() {
  const { canManage, setLoginOpen, notify, t } = useWorkspace();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const run = async <T,>(action: () => Promise<T>, success?: string, protectedAction = true): Promise<T | undefined> => {
    if (lock.current) return;
    if (protectedAction && !canManage) { setLoginOpen(true); return; }
    lock.current = true; setPending(true);
    try {
      const result = await action();
      void client.invalidateQueries();
      if (success) notify(success);
      return result;
    } catch (error) {
      notify(errorMessage(error, t), true);
      if (error instanceof ApiError && [401, 403].includes(error.status)) { await client.invalidateQueries({ queryKey: ["session"] }); setLoginOpen(true); }
    } finally { lock.current = false; setPending(false); }
  };
  return { run, pending };
}

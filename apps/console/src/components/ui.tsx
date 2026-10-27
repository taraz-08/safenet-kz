"use client";

import { forwardRef, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ArrowUpRight, CircleAlert, LoaderCircle, Radar, X } from "lucide-react";
import { useWorkspace, errorMessage } from "./providers";
import { levelText, statusText } from "@/lib/i18n";
import { safeHref } from "@/lib/schema";
import { networkCopy } from "@/lib/networks-i18n";

export function cn(...values: ClassValue[]) { return twMerge(clsx(values)); }
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; busy?: boolean };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", busy, className, children, disabled, type = "button", ...props }, ref) {
  return <button ref={ref} type={type} className={cn("button", `button-${variant}`, className)} disabled={disabled || busy} aria-busy={busy || undefined} {...props}>{busy && <LoaderCircle size={16} className="spin" />}{children}</button>;
});
export function Panel({ children, className, title, aside, description }: { children: ReactNode; className?: string; title?: ReactNode; aside?: ReactNode; description?: string }) {
  return <section className={cn("panel", className)}>{title && <div className="panel-heading"><div><h2>{title}</h2>{description && <p className="muted text-xs mt-1">{description}</p>}</div>{aside}</div>}{children}</section>;
}
export function Modal({ open, onOpenChange, title, description, children, wide = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  const { t } = useWorkspace();
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={cn("dialog-content", wide && "dialog-wide")} aria-describedby={description ? undefined : undefined} onOpenAutoFocus={() => { returnFocus.current = document.activeElement as HTMLElement; }} onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }}>
    <header className="dialog-heading"><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div><Dialog.Close className="icon-button" aria-label={t("close")}><X size={20} /></Dialog.Close></header>{children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: string; className?: string }) { return <span className={cn("badge", `badge-${tone}`, className)}>{children}</span>; }
export function RiskBadge({ level, score }: { level: string | null; score?: number | null }) { const { t } = useWorkspace(); return <Badge tone={level || "neutral"}><span className="status-dot" />{score != null && <strong className="tabular-nums">{score}</strong>}{levelText(level, t)}</Badge>; }
export function StatusBadge({ status }: { status: string }) { const { t } = useWorkspace(); return <Badge tone={status}><span className={cn("status-dot", status === "running" && "pulse")} />{statusText(status, t)}</Badge>; }
export function EmptyState({ title, description, action, compact = false, icon }: { title?: string; description?: string; action?: ReactNode; compact?: boolean; icon?: ReactNode }) {
  const { t } = useWorkspace();
  return <div className={cn("empty-state", compact && "empty-compact")}><div className="empty-icon">{icon || <Radar size={26} strokeWidth={1.4} />}</div><h3>{title || t("noScans")}</h3>{description && <p>{description}</p>}{action}</div>;
}
export function Loading({ rows = 3 }: { rows?: number }) { const { t } = useWorkspace(); return <div className="loading-skeleton" aria-busy="true" role="status"><span className="sr-only">{t("loading")}</span>{Array.from({ length: rows }, (_, i) => <div className="skeleton" key={i} />)}</div>; }
export function ErrorState({ error, retry, stale = false }: { error: unknown; retry?: () => void; stale?: boolean }) {
  const { t } = useWorkspace();
  return <div className="error-state" role="alert"><CircleAlert size={18} /><div><strong>{stale ? t("stale") : t("error")}</strong><p>{errorMessage(error, t)}</p></div>{retry && <Button variant="ghost" onClick={retry}>{t("retry")}</Button>}</div>;
}
export function ExternalLink({ href, children, className }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  const safe = safeHref(href);
  return safe ? <a className={cn("external-link", className)} href={safe} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={14} aria-hidden="true" /></a> : <span className={className}>{children}</span>;
}
export function PlatformIcon({ platform, size = "normal" }: { platform: string; size?: "normal" | "small" }) {
  const letter = ({ tiktok: "♪", instagram: "◎", youtube: "▶", threads: "@", telegram: "↗", manual: "T", web: "↗" } as Record<string, string>)[platform] || "↗";
  return <span className={cn("platform-icon", `platform-${platform}`, size === "small" && "platform-small")} aria-hidden="true">{letter}</span>;
}
export function PermissionNotice() {
  const { canManage, session, setLoginOpen, t, locale } = useWorkspace();
  const c = networkCopy(locale);
  if (canManage || session.isPending) return null;
  return <div className="permission-notice"><span>{session.isError ? t("sessionUnknown") : <><strong>{c.guest}</strong> · {c.guestHint}</>}</span><Button variant="ghost" onClick={() => session.isError ? session.refetch() : setLoginOpen(true)}>{session.isError ? t("retry") : c.login}</Button></div>;
}

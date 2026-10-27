"use client";
import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Activity, ArrowUpRight, BarChart3, Bot, ChevronRight, CircleHelp, FileText, Fingerprint, LayoutDashboard, Menu, MessageSquare, Network, KeyRound, Radio, RefreshCw, ScanLine, Settings2, ShieldCheck, UserRound } from "lucide-react";
import type { CopyKey } from "@/lib/i18n";
import { dateTime } from "@/lib/i18n";
import type { Mode } from "@/lib/schema";
import { useWorkspace } from "./providers";
import { Button, Modal, PermissionNotice } from "./ui";
import { OverviewScreen, DetectionsScreen } from "./dashboard";
import { AgentsScreen, MonitoringScreen } from "./agents";
import { ScannerScreen } from "./scanner";
import { AssistantScreen } from "./assistant";
import { ReportsScreen } from "./reports";
import { LanguageSelect, LoginDialog, SettingsScreen, useHealth } from "./settings";
import { ScanDialog } from "./scan-detail";
import { NetworksScreen } from "./networks";
import { networkCopy } from "@/lib/networks-i18n";

export const sections = ["overview", "monitoring", "agents", "detections", "scanner", "networks", "analytics", "assistant", "reports", "settings"] as const;
export type Section = (typeof sections)[number];
const navigation = [
  { title: "workspace", items: [{ id: "overview", icon: LayoutDashboard }, { id: "monitoring", icon: Radio }, { id: "agents", icon: Bot }, { id: "detections", icon: Fingerprint }, { id: "scanner", icon: ScanLine }] },
  { title: "intelligence", items: [{ id: "networks", icon: Network }, { id: "analytics", icon: BarChart3 }, { id: "assistant", icon: MessageSquare }, { id: "reports", icon: FileText }] },
  { title: "system", items: [{ id: "settings", icon: Settings2 }] },
] as const;
function Brand() { return <Link href="/overview" className="brand" aria-label="SafeNet AI"><span className="brand-shield"><ShieldCheck size={25} strokeWidth={1.8} /></span><span>SafeNet{' '}<span className="brand-ai">AI</span></span></Link>; }
function Navigation({ section, close }: { section: Section; close?: () => void }) {
  const { t, overview, locale } = useWorkspace();
  return <nav aria-label={t("workspace")}>{navigation.map((group) => <div className="nav-group" key={group.title}><span className="nav-group-label">{t(group.title)}</span>{group.items.map((item) => <Link href={`/${item.id}`} key={item.id} onClick={close} aria-current={section === item.id ? "page" : undefined} className={`nav-link ${section === item.id ? "nav-active" : ""}`}><item.icon size={18} strokeWidth={1.7} /><span>{item.id === "networks" ? networkCopy(locale).title : t(item.id)}</span>{item.id === "detections" && !!overview.data?.totals.suspicious && <span className="nav-count">{overview.data.totals.suspicious}</span>}{section === item.id && <span className="nav-active-mark" />}</Link>)}</div>)}</nav>;
}
function Sidebar({ section }: { section: Section }) {
  const { t, canManage, setLoginOpen, overview, session, locale } = useWorkspace();
  const health = useHealth();
  const online = health.data?.status === "ok" && !health.isError;
  return <aside className="sidebar"><Brand /><div className="workspace-label"><span className="country-mark">KZ</span><div><strong>{t("kazakhstan")}</strong><span>{t("operations")}</span></div><ChevronRight size={14} /></div><Navigation section={section} /><div className="sidebar-bottom"><Link href="/settings" className="system-indicator"><span className={`status-dot ${online ? "dot-mint" : "dot-muted"}`} /><span>{health.isPending ? t("connectConnecting") : online ? t("health") : t("offline")}</span><ArrowUpRight size={13} /></Link><div className="operator-row"><div className="user-avatar"><UserRound size={18} /></div><div><strong>{canManage ? networkCopy(locale)[session.data?.login_enabled ? "admin" : "localAdmin"] : t("visitor")}</strong><span>{overview.data?.mode.toUpperCase() || "LIVE"} WORKSPACE</span></div>{!canManage && <button className="icon-button" aria-label={t("login")} onClick={() => setLoginOpen(true)}><ArrowUpRight size={18} /></button>}</div></div></aside>;
}
export function Console({ section }: { section: Section }) {
  const { t, mode, setMode, overview, locale, canManage, session, setLoginOpen } = useWorkspace();
  const c = networkCopy(locale);
  const [mobileOpen, setMobileOpen] = useState(false);
  const connection = overview.isError && !overview.data ? "offline" : overview.connection === "live" ? "connectLive" : overview.connection === "polling" ? "connectPolling" : "connectConnecting";
  return <div className="app-shell"><a className="skip-link" href="#main-content">{t("skip")}</a><Sidebar section={section} /><div className="workspace-main"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label={t("menu")}><Menu size={21} /></button><span className="desktop-label">{t("workspace")}</span><ChevronRight size={14} className="desktop-label" /><strong>{section === "networks" ? c.title : t(section)}</strong></div><div className="topbar-tools">{!canManage && !session.isPending && <Button className="admin-signin" variant="secondary" onClick={() => setLoginOpen(true)}><KeyRound size={15} />{c.login}</Button>}<label className={`mode-select ${mode === "demo" ? "mode-demo" : ""}`}><span className="status-dot" /><span className="sr-only">{t("mode")}</span><select aria-label={t("mode")} value={mode} onChange={(event) => setMode(event.target.value as Mode)}><option value="live">LIVE</option><option value="demo">DEMO</option></select></label><LanguageSelect compact /><Link className="icon-button top-help" href="/settings" aria-label={t("settings")}><CircleHelp size={18} /></Link></div></header>
    <main id="main-content" tabIndex={-1} className="main-content"><div className="page-heading"><div><div className="eyebrow"><span />SAFENET / {t("operations")}</div><h1>{section === "networks" ? c.title : t(section)}</h1><p>{section === "networks" ? c.description : t(`${section}Desc` as CopyKey)}</p></div><div className="page-actions"><Button variant="secondary" onClick={() => overview.refetch()} aria-label={t("refresh")} busy={overview.isFetching}><RefreshCw size={16} /></Button>{section !== "scanner" && <Link className="button button-primary" href="/scanner"><ScanLine size={17} />{t("analyze")}</Link>}</div></div>
      <div className="connection-strip"><div><span className={`status-dot ${connection === "connectLive" ? "dot-mint" : connection === "offline" ? "dot-rose" : "dot-amber"}`} /><span>{t(connection)}</span></div>{overview.dataUpdatedAt > 0 && <span>{t("lastUpdated")} {dateTime(new Date(overview.dataUpdatedAt).toISOString(), locale, true)}</span>}</div>
      {mode === "demo" && <div className="demo-banner"><Activity size={17} /><span>{t("demoNotice")}</span></div>}
      {!["agents", "assistant", "scanner"].includes(section) && <PermissionNotice />}
      {canManage && !session.data?.login_enabled && <div className="local-access-notice"><ShieldCheck size={16} /><strong>{c.localAdmin}</strong><span>{c.localHint}</span></div>}
      <motion.div key={`${section}-${mode}`} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
        {section === "overview" && <OverviewScreen />}{section === "monitoring" && <MonitoringScreen />}{section === "agents" && <AgentsScreen />}{section === "detections" && <DetectionsScreen />}{section === "scanner" && <ScannerScreen />}{section === "networks" && <NetworksScreen />}{section === "analytics" && <OverviewScreen analytics />}{section === "assistant" && <AssistantScreen />}{section === "reports" && <ReportsScreen />}{section === "settings" && <SettingsScreen />}
      </motion.div><footer className="workspace-footer"><span><ShieldCheck size={13} />SafeNet AI</span><p>{t("scoreNotice")}</p><span className="footer-region">KAZAKHSTAN · KZ</span></footer>
    </main></div><Modal open={mobileOpen} onOpenChange={setMobileOpen} title="SafeNet AI"><Navigation section={section} close={() => setMobileOpen(false)} /></Modal><LoginDialog /><ScanDialog /></div>;
}

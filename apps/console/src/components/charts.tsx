"use client";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useId } from "react";
import { useWorkspace } from "./providers";
import { EmptyState, Panel } from "./ui";
import { levelText } from "@/lib/i18n";
import { levels, type Overview } from "@/lib/schema";
export const riskColors: Record<string, string> = { low: "var(--risk-low)", medium: "var(--risk-mid)", high: "var(--risk-high)", critical: "var(--risk-critical)" };
const tooltipStyle = {
  background: "var(--tooltip-bg)",
  border: "1px solid var(--tooltip-border)",
  borderRadius: 10,
  boxShadow: "var(--shadow-float)",
  color: "var(--tooltip-text)",
  fontSize: 13,
  lineHeight: 1.6,
  padding: "10px 14px",
};
const tooltipLabelStyle = { color: "var(--text-secondary)", fontWeight: 600 };
const tooltipItemStyle = { color: "var(--tooltip-text)" };

export function TrendChart({ data }: { data: Overview["timeline"] }) {
  const { t, locale } = useWorkspace();
  const id = useId().replace(/:/g, "");
  return <Panel title={t("trend")} aside={<div className="chart-legend"><span><i className="bg-mint" />{t("allScans")}</span><span><i className="bg-amber" />{t("suspicious")}</span></div>}>
    {data.length ? <div className="chart-wrap" role="img" aria-label={`${t("trend")}: ${data.map((p) => `${p.date}: ${p.count}, ${t("suspicious")}: ${p.suspicious}`).join("; ")}`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={data} margin={{ top: 15, right: 12, bottom: 0, left: -18 }} accessibilityLayer>
          <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={riskColors.low} stopOpacity={0.2} /><stop offset="100%" stopColor={riskColors.low} stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 5" vertical={false} />
          <XAxis dataKey="date" stroke="var(--chart-axis)" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-axis)" }} tickMargin={12} minTickGap={28} tickFormatter={(value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale, { day: "numeric", month: "short" }); }} />
          <YAxis stroke="var(--chart-axis)" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--chart-axis)" }} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabelStyle} itemStyle={tooltipItemStyle} cursor={{ stroke: "var(--line-strong)", strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="count" name={t("allScans")} stroke={riskColors.low} fill={`url(#${id})`} strokeWidth={2.5} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} dot={data.length === 1} />
          <Area type="monotone" dataKey="suspicious" name={t("suspicious")} stroke={riskColors.medium} fill="transparent" strokeWidth={2.5} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} dot={data.length === 1} />
        </AreaChart>
      </ResponsiveContainer>
    </div> : <div className="chart-empty"><div className="chart-grid" /><EmptyState title={t("noTrend")} compact /></div>}
  </Panel>;
}
export function RiskChart({ data }: { data: Overview["distribution"] }) {
  const { t } = useWorkspace();
  const normalized = levels.map((level) => ({ level, name: levelText(level, t), count: data.find((item) => item.level === level)?.count || 0 }));
  const total = normalized.reduce((sum, item) => sum + item.count, 0);
  return <Panel title={t("riskDistribution")} className="risk-panel">
    <div className="risk-chart-body"><div className="donut-wrap">
      {total > 0 ? <ResponsiveContainer width="100%" height="100%" minWidth={0}><PieChart accessibilityLayer><Pie data={normalized} dataKey="count" nameKey="name" innerRadius={62} outerRadius={78} strokeWidth={0} paddingAngle={3} isAnimationActive={false}>{normalized.map((item) => <Cell key={item.level} fill={riskColors[item.level]} />)}</Pie><Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabelStyle} itemStyle={tooltipItemStyle} /></PieChart></ResponsiveContainer> : <div className="empty-donut" />}
      <div className="donut-label"><strong>{total.toLocaleString()}</strong><span>{t("scanned")}</span></div>
    </div><ul className="risk-legend">{normalized.map((item) => <li key={item.level}><span><i style={{ background: riskColors[item.level] }} />{item.name}</span><strong>{item.count}</strong></li>)}</ul></div>
    {!total && <p className="risk-caption">{t("noRisk")}</p>}
  </Panel>;
}

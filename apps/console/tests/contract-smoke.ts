import assert from "node:assert/strict";
import { z } from "zod";
import { agentSchema, healthSchema, logsSchema, overviewSchema, reportSchema, scanSchema, sessionSchema, settingsSchema } from "../src/lib/schema";

const base = process.env.SAFENET_API_URL || "http://127.0.0.1:8100";
async function check<T>(path: string, schema: z.ZodType<T>) {
  const response = await fetch(`${base}/api/v1${path}`);
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  const data = schema.parse(await response.json());
  console.log(`PASS ${path}`);
  return data;
}
async function main() {
  await check("/health", healthSchema);
  await check("/session", sessionSchema);
  await check("/settings", settingsSchema);
  const agents = await check("/agents", z.object({ items: z.array(agentSchema) }));
  assert.deepEqual(agents.items.map((a) => a.id).sort(), ["instagram", "threads", "tiktok", "youtube"]);
  for (const agent of agents.items) await check(`/agents/${agent.id}/logs`, logsSchema);
  for (const mode of ["live", "demo"]) {
    const overview = await check(`/overview?mode=${mode}`, overviewSchema);
    assert.equal(overview.mode, mode);
    const scans = await check(`/scans?mode=${mode}&limit=100`, z.object({ items: z.array(scanSchema), total: z.number() }));
    assert.ok(scans.items.every((scan) => scan.mode === mode));
    if (scans.items[0]) await check(`/scans/${scans.items[0].id}`, scanSchema);
    console.log(`${mode}: ${overview.totals.scanned} completed, ${scans.total} total; validated ${scans.items.length} records`);
  }
  const reports = await check("/reports", z.object({ items: z.array(reportSchema) }));
  if (reports.items[0]) await check(`/reports/${reports.items[0].id}`, reportSchema);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

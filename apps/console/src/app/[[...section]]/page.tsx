import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Console, type Section } from "@/components/console";

const routes = ["overview", "monitoring", "agents", "detections", "scanner", "networks", "analytics", "assistant", "reports", "settings"];
export default async function Page({ params }: { params: Promise<{ section?: string[] }> }) {
  const { section } = await params;
  const selected = section?.[0] || "overview";
  if ((section?.length || 0) > 1 || !routes.includes(selected)) notFound();
  return <Suspense fallback={<div className="boot-state" role="status">SafeNet AI · Загрузка / Жүктелуде / Loading…</div>}><Console section={selected as Section} /></Suspense>;
}

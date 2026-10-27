"use client";
import { useWorkspace } from "@/components/providers";
import { Button } from "@/components/ui";
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) { const { t } = useWorkspace(); return <div className="boot-state"><h1>{t("error")}</h1><Button variant="primary" onClick={reset}>{t("retry")}</Button></div>; }

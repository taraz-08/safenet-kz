import type { Locale, Mode, Scan } from "./schema";

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const MEDIA_ACCEPT = ".mp4,.mov,.webm,.mp3,.wav,.m4a,.flac,.ogg,.jpg,.jpeg,.png,.webp";
const extensions = new Set(MEDIA_ACCEPT.split(",").map((value) => value.slice(1)));

export function mediaFileError(file: Pick<File, "name" | "size"> | null): "mediaFileRequired" | "mediaFileEmpty" | "mediaFileTooLarge" | "mediaFileType" | null {
  if (!file) return "mediaFileRequired";
  if (file.size === 0) return "mediaFileEmpty";
  if (file.size > MAX_MEDIA_BYTES) return "mediaFileTooLarge";
  if (!extensions.has(file.name.split(".").pop()?.toLowerCase() || "")) return "mediaFileType";
  return null;
}

export function mediaUpload(file: File, mode: Mode, locale: Locale, sourceUrl = ""): RequestInit {
  const body = new FormData();
  body.append("file", file);
  body.append("mode", mode);
  body.append("locale", locale);
  if (sourceUrl.trim()) body.append("source_url", sourceUrl.trim());
  return { method: "POST", body };
}

export function mediaTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const tail = `${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
  const fraction = Math.floor((seconds - whole) * 10 + 1e-6);
  return `${hours ? `${hours}:` : ""}${tail}${fraction ? `.${fraction}` : ""}`;
}

export function mediaRange(start: number | null | undefined, end?: number | null): string | null {
  if (start == null && end == null) return null;
  return start != null && end != null && start !== end ? `${mediaTime(start)}–${mediaTime(end)}` : mediaTime(start ?? end);
}

export function isUploadedMedia(scan: Pick<Scan, "platform" | "metadata">): boolean {
  return ["user_upload", "user_uploaded", "user_uploaded_media", "media_upload", "uploaded_media", "synthetic_media"].includes(String(scan.metadata.origin)) || scan.platform === "upload" || scan.platform === "media";
}

// Fetch previews only from our authenticated scan route, never arbitrary source URLs.
export function frameThumbnail(scanId: string, index: number): string {
  return `/api/v1/scans/${encodeURIComponent(scanId)}/frames/${index}`;
}

type CapabilitySource = { capabilities?: unknown; video_analysis?: boolean; audio_transcription?: boolean; media_processing?: Record<string, unknown> } | undefined;
export function mediaCapabilities(source: CapabilitySource) {
  const nested = source?.capabilities && typeof source.capabilities === "object" && !Array.isArray(source.capabilities) ? source.capabilities as Record<string, unknown> : {};
  return {
    video_analysis: typeof nested.video_analysis === "boolean" ? nested.video_analysis : source?.video_analysis,
    audio_transcription: typeof nested.audio_transcription === "boolean" ? nested.audio_transcription : source?.audio_transcription,
    media_processing: nested.media_processing ?? source?.media_processing,
  };
}

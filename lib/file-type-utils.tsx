import { File, FileArchive, FileText, Film, Image, Music } from "lucide-react";
import { getMimeCategory } from "@/lib/utils";

export type { LucideIcon } from "lucide-react";

const ICONS: Record<string, React.ElementType> = {
  image: Image, video: Film, audio: Music,
  pdf: FileText, document: FileText, spreadsheet: FileText,
  presentation: FileText, archive: FileArchive, text: FileText,
};

const ACCENT_COLORS: Record<string, string> = {
  image: "text-violet-500", video: "text-blue-500", audio: "text-emerald-500",
  pdf: "text-red-500", document: "text-sky-500", spreadsheet: "text-green-500",
  presentation: "text-orange-500", archive: "text-amber-500", text: "text-gray-500",
};

const GRADIENT_FALLBACKS: Record<string, string> = {
  image: "from-violet-500/20 to-fuchsia-500/10",
  video: "from-blue-500/20 to-cyan-500/10",
  audio: "from-emerald-500/20 to-teal-500/10",
  pdf: "from-red-500/20 to-orange-500/10",
  document: "from-sky-500/20 to-indigo-500/10",
  spreadsheet: "from-green-500/20 to-lime-500/10",
  presentation: "from-orange-500/20 to-amber-500/10",
  archive: "from-amber-500/20 to-yellow-500/10",
  text: "from-gray-500/15 to-zinc-500/10",
};

const TYPE_LABELS: Record<string, string> = {
  image: "Image", video: "Video", audio: "Audio", pdf: "PDF",
  document: "Document", spreadsheet: "Sheet", presentation: "Slides",
  archive: "Archive", text: "Text",
};

export function getFileTypeIcon(mimeType: string): React.ElementType {
  return ICONS[getMimeCategory(mimeType)] ?? File;
}

export function getAccentColor(mimeType: string): string {
  return ACCENT_COLORS[getMimeCategory(mimeType)] ?? "text-gray-400";
}

export function getGradientFallback(mimeType: string): string {
  return GRADIENT_FALLBACKS[getMimeCategory(mimeType)] ?? "from-gray-500/10 to-zinc-500/5";
}

export function getTypeLabel(mimeType: string): string {
  return TYPE_LABELS[getMimeCategory(mimeType)] ?? "File";
}

export function FileTypeIcon({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}) {
  const Icon = getFileTypeIcon(mimeType);
  return <Icon className={className} />;
}

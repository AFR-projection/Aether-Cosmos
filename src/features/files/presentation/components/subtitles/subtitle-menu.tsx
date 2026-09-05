"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  Globe,
  Loader2,
  Paperclip,
  Pencil,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { Button } from "@/ui/primitives/button";
import { cn } from "@/shared/lib/utils";
import { useLocale, useT, type TranslationKey } from "@/shared/lib/i18n";
import {
  SUBTITLE_LANGUAGES,
  subtitleLanguageLabel,
  UNDETERMINED_LANGUAGE,
} from "@files/domain/services/subtitles/languages";
import { suggestedSubtitleLanguages } from "@files/domain/services/subtitles/suggested-languages";
import {
  SUBTITLE_OFFSET_MAX,
  type SubtitleBackdrop,
  type SubtitlePrefs,
  type SubtitleTextSize,
} from "@files/domain/services/subtitles/view-prefs";
import type { SubtitleTrack } from "@files/presentation/hooks/use-subtitle-tracks";

/**
 * The CC menu: one list, one press.
 *
 * This is the second version. The first hid unmade languages behind an "Add a language…" submenu and
 * then behind a confirmation dialog, which meant four presses to get Indonesian subtitles on a
 * Japanese film. That is not how anybody expects a video player to behave, and being technically
 * more careful did not make up for it.
 *
 * So the list is flat. Tracks that exist and languages that do not sit in the same column, in the
 * same shape, and a press means the same thing in both cases: *show me this language*. Whether that
 * is instant or takes four minutes is the menu's problem to display, not the viewer's problem to
 * anticipate.
 *
 * What the earlier version was protecting is kept, just not as a gate. Making a track sends this
 * video's audio to a third party and costs money, and both facts stay permanently visible in the
 * footer — where they inform without standing in the way. A person who reads it once never needs to
 * dismiss it again.
 *
 * Two more things that follow from "be a video player":
 *  - **Seven languages, not 103.** The reader's own interface language first. The full table is one
 *    press away behind search, which is where a long list belongs.
 *  - **Nothing relies on colour.** A tick marks what is playing, a spinner marks what is being made,
 *    a warning glyph marks what failed, and `aria-checked` says the same to a screen reader.
 */

type Panel = "main" | "all" | "appearance";

export type SubtitleMenuProps = {
  tracks: SubtitleTrack[];
  activeTrackId: string | null;
  onSelect: (trackId: string | null) => void;
  /** Start a language that has no track yet. Absent on a share link: strangers may watch, not spend. */
  onGenerate?: (language: string) => Promise<void>;
  onAttach?: () => void;
  onDelete?: (trackId: string) => Promise<void>;
  onEdit?: (trackId: string) => void;
  canGenerate: boolean;
  canTranslate: boolean;
  refusalKey: TranslationKey | null;
  provider: string;
  /** `null` means the account is uncapped. */
  remainingSeconds: number | null;
  prefs: SubtitlePrefs;
  onPrefsChange: (next: Partial<SubtitlePrefs>) => void;
  onClose: () => void;
  vttUrl: (trackId: string) => string;
};

const SIZE_OPTIONS: { value: SubtitleTextSize; labelKey: TranslationKey }[] = [
  { value: "sm", labelKey: "files.subtitles.appearance.small" },
  { value: "md", labelKey: "files.subtitles.appearance.medium" },
  { value: "lg", labelKey: "files.subtitles.appearance.large" },
  { value: "xl", labelKey: "files.subtitles.appearance.huge" },
];

const BACKDROP_OPTIONS: { value: SubtitleBackdrop; labelKey: TranslationKey }[] = [
  { value: "none", labelKey: "files.subtitles.appearance.backgroundNone" },
  { value: "soft", labelKey: "files.subtitles.appearance.backgroundSoft" },
  { value: "solid", labelKey: "files.subtitles.appearance.backgroundSolid" },
];

const ORIGIN_KEYS: Record<SubtitleTrack["origin"], TranslationKey> = {
  asr: "files.subtitles.original",
  translated: "files.subtitles.translated",
  uploaded: "files.subtitles.uploaded",
};

/** Rows sit on a dark stage rather than a themed surface, so this palette is fixed rather than tokenised. */
const ROW =
  "group/row flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors";
const ROW_IDLE = "text-white/85 hover:bg-white/10 hover:text-white";
const ROW_ACTIVE = "bg-white/[0.16] text-white";
const CHIP =
  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white/55";

export function SubtitleMenu(props: SubtitleMenuProps) {
  const t = useT();
  const locale = useLocale();
  const uid = useId();
  const [panel, setPanel] = useState<Panel>("main");
  const [query, setQuery] = useState("");
  /** The language a press has been sent for but whose row has not appeared yet. */
  const [starting, setStarting] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const ready = props.tracks.filter((track) => track.status === "ready" && track.cueCount > 0);
  const working = props.tracks.filter(
    (track) => track.status === "queued" || track.status === "processing"
  );
  const failed = props.tracks.filter((track) => track.status === "failed");

  /** Languages the file already covers in some form, so nothing is offered twice. */
  const taken = useMemo(
    () => new Set(props.tracks.map((track) => track.language)),
    [props.tracks]
  );

  const suggested = useMemo(
    () => (props.canGenerate ? suggestedSubtitleLanguages(locale, taken) : []),
    [props.canGenerate, locale, taken]
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return SUBTITLE_LANGUAGES.filter((language) => {
      if (taken.has(language.tag)) return false;
      if (needle.length === 0) return true;
      return (
        language.english.toLowerCase().includes(needle) ||
        language.native.toLowerCase().includes(needle) ||
        language.tag.toLowerCase().startsWith(needle)
      );
    });
  }, [query, taken]);

  /**
   * Ask for a language, with no confirmation in the way.
   *
   * `starting` covers the gap between the press and the queued row arriving: without it the row the
   * user just pressed would sit there looking untouched for a round trip, which reads as a dead
   * button. It is cleared by the row appearing, not by a timer.
   */
  const start = useCallback(
    async (language: string) => {
      if (!props.onGenerate) return;
      setStarting(language);
      setPanel("main");
      setQuery("");
      try {
        await props.onGenerate(language);
      } finally {
        setStarting(null);
      }
    },
    [props]
  );

  const progressLine = (track: SubtitleTrack): string => {
    if (track.status === "queued") return t("files.subtitles.status.queued");
    const percent = Math.max(1, Math.min(99, track.progress));
    // Which phase it is in is not a detail to hide: they take different amounts of time, and
    // "translating" tells a viewer the listening part is already done.
    return track.origin === "translated"
      ? t("files.subtitles.status.translating", { percent })
      : t("files.subtitles.status.transcribing", { percent });
  };

  /** A track's name: the language in itself, or "detecting" while the audio has not been placed. */
  const trackName = (track: SubtitleTrack): string =>
    track.language === UNDETERMINED_LANGUAGE
      ? t("files.subtitles.detecting")
      : subtitleLanguageLabel(track.language);

  const headingKey: TranslationKey =
    panel === "appearance"
      ? "files.subtitles.appearance.title"
      : panel === "all"
        ? "files.subtitles.allLanguages"
        : "files.subtitles.menuTitle";

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${uid}-title`}
      className={cn(
        // Positioned and bounded by the wrapper the player puts around it, NOT by itself.
        //
        // The first version anchored with `bottom-full` inside the control bar and capped its own
        // height in `vh`. On a short player that made a menu taller than the stage, and the preview
        // modal's `overflow-hidden` sliced the top off it. Now the player hands it a box that spans
        // from just below the top edge to just above the controls, and `max-h-full` inside a flex
        // column means the list scrolls instead of the menu overflowing. It cannot be clipped at any
        // window size, in fullscreen or out of it.
        "pointer-events-auto flex max-h-full w-[19rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden",
        "rounded-2xl border border-white/10 bg-[#111214]/95 shadow-[0_16px_48px_rgba(0,0,0,0.6)] backdrop-blur-xl",
        // The one animation the files-page design rules allow here: a menu entrance, and only when
        // the reader has not asked for less motion.
        "motion-safe:animate-fade-in-scale origin-bottom-right"
      )}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.08] px-2 py-1.5">
        {panel !== "main" && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white/60 hover:bg-white/10 hover:text-white"
            aria-label={t("common.back")}
            onClick={() => {
              setPanel("main");
              setQuery("");
            }}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
        <p
          id={`${uid}-title`}
          className={cn(
            "flex-1 text-xs font-semibold uppercase tracking-wider text-white/60",
            panel === "main" && "pl-1.5"
          )}
        >
          {t(headingKey)}
        </p>
        {panel === "main" && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white/60 hover:bg-white/10 hover:text-white"
            aria-label={t("files.subtitles.appearance.title")}
            onClick={() => setPanel("appearance")}
          >
            <Settings2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {panel === "main" && (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={props.activeTrackId === null}
              className={cn(ROW, props.activeTrackId === null ? ROW_ACTIVE : ROW_IDLE)}
              onClick={() => props.onSelect(null)}
            >
              <Check
                className={cn(
                  "h-4 w-4 shrink-0",
                  props.activeTrackId === null ? "opacity-100" : "opacity-0"
                )}
                aria-hidden="true"
              />
              <span className="flex-1">{t("files.subtitles.off")}</span>
            </button>

            {/* Tracks that exist. A press shows them; there is nothing to wait for. */}
            {ready.map((track) => (
              <div key={track.id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={props.activeTrackId === track.id}
                  className={cn(
                    ROW,
                    "flex-1",
                    props.activeTrackId === track.id ? ROW_ACTIVE : ROW_IDLE
                  )}
                  onClick={() => props.onSelect(track.id)}
                >
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      props.activeTrackId === track.id ? "opacity-100" : "opacity-0"
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{trackName(track)}</span>
                  <span className={CHIP}>{t(ORIGIN_KEYS[track.origin])}</span>
                </button>
                {/*
                  Per-track actions, revealed on hover or focus rather than always drawn — the list
                  is the thing being read, and four glyphs per row competes with it. `focus-within`
                  is what keeps them reachable by keyboard, and on touch there is no hover so they
                  stay visible.
                */}
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  <a
                    href={`${props.vttUrl(track.id)}?download`}
                    download
                    aria-label={t("files.subtitles.actions.download")}
                    title={t("files.subtitles.actions.download")}
                    className="rounded-md p-1.5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                  {props.onEdit && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-white/45 hover:bg-white/10 hover:text-white"
                      aria-label={t("files.subtitles.actions.edit")}
                      onClick={() => props.onEdit?.(track.id)}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  )}
                  {props.onDelete && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-white/45 hover:bg-white/10 hover:text-white"
                      aria-label={t("files.subtitles.actions.delete")}
                      onClick={() => void props.onDelete?.(track.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {/* Being made. Same row shape as a finished one, so it does not jump when it lands. */}
            {working.map((track) => (
              <div key={track.id} className={cn(ROW, "text-white/60")} role="status">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{trackName(track)}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-white/45">
                  {progressLine(track)}
                </span>
              </div>
            ))}

            {failed.map((track) => (
              <div key={track.id} className="flex items-start gap-0.5">
                <button
                  type="button"
                  className={cn(ROW, "flex-1 items-start", ROW_IDLE)}
                  // Pressing a failed row tries again, which is the only thing anybody wants from it.
                  onClick={() => props.onGenerate && void start(track.language)}
                  disabled={!props.onGenerate}
                >
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{trackName(track)}</span>
                    <span className="block text-[11px] leading-snug text-white/45">
                      {track.failureMessage ?? t("files.subtitles.status.failed")}
                    </span>
                  </span>
                  {props.onGenerate && (
                    <span className={cn(CHIP, "bg-white/10")}>
                      {t("files.subtitles.actions.retry")}
                    </span>
                  )}
                </button>
                {props.onDelete && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mt-1 shrink-0 text-white/45 hover:bg-white/10 hover:text-white"
                    aria-label={t("files.subtitles.actions.delete")}
                    onClick={() => void props.onDelete?.(track.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
              </div>
            ))}

            {/*
              Languages this file does not have yet, offered as plainly as the ones it does. A press
              starts the work — no submenu, no dialog. This row and a ready row look the same on
              purpose: to the viewer they mean the same thing.
            */}
            {suggested.length > 0 && (
              <>
                {props.tracks.length > 0 && <div className="my-1.5 border-t border-white/[0.08]" />}
                {suggested.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={cn(ROW, ROW_IDLE)}
                    onClick={() => void start(tag)}
                    disabled={starting !== null}
                  >
                    {starting === tag ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                    ) : (
                      <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{subtitleLanguageLabel(tag)}</span>
                  </button>
                ))}
              </>
            )}

            {props.tracks.length === 0 && suggested.length === 0 && (
              <p className="px-2.5 py-3 text-xs leading-relaxed text-white/50">
                {/* An empty state names its own cause rather than just being empty. */}
                {props.refusalKey ? t(props.refusalKey) : t("files.subtitles.none")}
              </p>
            )}

            <div className="my-1.5 border-t border-white/[0.08]" />

            {props.canGenerate && props.onGenerate && (
              <button type="button" className={cn(ROW, ROW_IDLE)} onClick={() => setPanel("all")}>
                <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="flex-1">{t("files.subtitles.moreLanguages")}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-white/40">
                  {SUBTITLE_LANGUAGES.length}
                </span>
              </button>
            )}
            {props.onAttach && (
              <button type="button" className={cn(ROW, ROW_IDLE)} onClick={props.onAttach}>
                <Paperclip className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="flex-1">{t("files.subtitles.actions.attach")}</span>
              </button>
            )}
          </div>

          {/*
            The disclosure the earlier version made a dialog out of. Where the audio goes and what
            is left of the month are facts a viewer is entitled to — they are just not a gate. Read
            once, never dismissed, never in the way.
          */}
          {props.canGenerate && props.onGenerate && (
            <p className="shrink-0 border-t border-white/[0.08] px-3 py-2 text-[11px] leading-relaxed text-white/40">
              {t("files.subtitles.footer.sendsAudio", { provider: props.provider })}
              {props.remainingSeconds !== null && (
                <>
                  {" · "}
                  {t("files.subtitles.footer.remaining", {
                    minutes: Math.floor(props.remainingSeconds / 60),
                  })}
                </>
              )}
            </p>
          )}
          {!props.canGenerate && props.refusalKey && props.tracks.length > 0 && (
            <p className="shrink-0 border-t border-white/[0.08] px-3 py-2 text-[11px] leading-relaxed text-white/40">
              {t(props.refusalKey)}
            </p>
          )}
        </>
      )}

      {panel === "all" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="relative shrink-0 border-b border-white/[0.08] p-2">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // 16px on mobile: anything smaller makes iOS zoom the whole player on focus.
              className="w-full rounded-lg bg-white/[0.08] py-2 pl-7 pr-2 text-base text-white placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-white/25 sm:text-sm"
              placeholder={t("files.subtitles.searchLanguage")}
              aria-label={t("files.subtitles.searchLanguage")}
              autoFocus
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {matches.map((language) => (
              <button
                key={language.tag}
                type="button"
                className={cn(ROW, ROW_IDLE)}
                onClick={() => void start(language.tag)}
                disabled={starting !== null}
              >
                {starting === language.tag ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                ) : (
                  <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate">{language.native}</span>
                {/* The English name as a second handle: it is how somebody would have searched for
                    a script they do not read. */}
                <span className="shrink-0 text-[11px] text-white/35">{language.english}</span>
              </button>
            ))}
            {matches.length === 0 && (
              <p className="px-2.5 py-3 text-xs leading-relaxed text-white/50">
                {t("files.subtitles.noMatch", { query: query.trim() })}
              </p>
            )}
          </div>
        </div>
      )}

      {panel === "appearance" && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
          <fieldset>
            <legend className="mb-1.5 text-[11px] uppercase tracking-wider text-white/45">
              {t("files.subtitles.appearance.size")}
            </legend>
            <div className="flex gap-1">
              {SIZE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={props.prefs.size === option.value}
                  className={cn(
                    "flex-1 rounded-lg px-2 py-1.5 text-xs transition-colors",
                    props.prefs.size === option.value
                      ? "bg-white font-medium text-black"
                      : "bg-white/[0.08] text-white/70 hover:bg-white/[0.16] hover:text-white"
                  )}
                  onClick={() => props.onPrefsChange({ size: option.value })}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-[11px] uppercase tracking-wider text-white/45">
              {t("files.subtitles.appearance.background")}
            </legend>
            <div className="flex gap-1">
              {BACKDROP_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={props.prefs.backdrop === option.value}
                  className={cn(
                    "flex-1 rounded-lg px-2 py-1.5 text-xs transition-colors",
                    props.prefs.backdrop === option.value
                      ? "bg-white font-medium text-black"
                      : "bg-white/[0.08] text-white/70 hover:bg-white/[0.16] hover:text-white"
                  )}
                  onClick={() => props.onPrefsChange({ backdrop: option.value })}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <label
              htmlFor={`${uid}-offset`}
              className="mb-1.5 block text-[11px] uppercase tracking-wider text-white/45"
            >
              {t("files.subtitles.appearance.position")}
            </label>
            <input
              id={`${uid}-offset`}
              type="range"
              className="media-range w-full"
              min={0}
              max={SUBTITLE_OFFSET_MAX}
              step={1}
              value={props.prefs.offset}
              aria-valuetext={`${props.prefs.offset}%`}
              style={{ ["--pct" as string]: `${(props.prefs.offset / SUBTITLE_OFFSET_MAX) * 100}%` }}
              onChange={(event) => props.onPrefsChange({ offset: Number(event.target.value) })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

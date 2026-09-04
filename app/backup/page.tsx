"use client";

import { useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  Brain,
  Check,
  Copy,
  FileSearch,
  Fingerprint,
  FolderTree,
  KeyRound,
  Loader2,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { getCsrfToken } from "@/shared/api/client";
import { apiErrorMessage, useFormat, useT, type TranslationKey } from "@/shared/lib/i18n";
import { notify } from "@/shared/lib/system/notify-store";
import { Button } from "@/ui/primitives/button";
import { EmptyState } from "@/ui/primitives/empty-state";
import { Modal } from "@/ui/primitives/modal";
import { DomainCard } from "./_domain-card";
import { PhraseDialog } from "./_phrase-dialog";
import { AskPhraseDialog } from "./_ask-phrase-dialog";
import { PreviewDialog } from "./_preview-dialog";
import { ConfirmReplaceDialog } from "./_confirm-replace-dialog";
import { StepCodeDialog } from "./_step-code-dialog";
import { ResultDialog } from "./_result-dialog";
import {
  BackupApiError,
  fetchIdentity,
  inspectArchive,
  prepareTakeout,
  restoreArchive,
} from "./_client";
import type { InspectResponse, RestoreResponse } from "./_types";
import type { BackupDomain } from "@backup/domain/types";
import type { RestoreMode } from "@backup/account/application/import-types";

/** The design system's one entrance curve, as a tuple framer will accept by type. */
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** The file being restored, and the phrase that opens it, carried through every step. */
interface RestoreTarget {
  file: File;
  domain: BackupDomain;
  /** Set only when this server's own key could not open the archive. */
  phrase: string | null;
}

type RestoreState =
  | { phase: "idle" }
  | { phase: "reading"; target: RestoreTarget }
  | { phase: "ask-phrase"; target: RestoreTarget; error: string | null }
  | {
      phase: "preview";
      target: RestoreTarget;
      mode: RestoreMode;
      preview: InspectResponse;
      /** A mode switch is in flight: the dialog stays, its actions lock. */
      busy: boolean;
    }
  | { phase: "confirm-replace"; target: RestoreTarget; preview: InspectResponse }
  | {
      phase: "step-code";
      target: RestoreTarget;
      preview: InspectResponse;
      mode: RestoreMode;
      remaining: number | null;
      error: string | null;
    }
  | { phase: "uploading"; percent: number }
  | { phase: "working" }
  | { phase: "done"; result: RestoreResponse }
  | { phase: "error"; message: string };

/**
 * A preview, and whether a phrase was needed to produce it.
 *
 * The flag is the point. Re-picking the same file after a cancel arrives with no phrase, and
 * handing back a preview that only opened because one was supplied would show a plan the restore
 * cannot carry out — the server would refuse the upload as unreadable. The phrase itself is
 * never cached.
 */
interface CachedPreview {
  preview: InspectResponse;
  usedPhrase: boolean;
}

type PreviewCache = Record<string, Partial<Record<RestoreMode, CachedPreview>>>;

/** Enough to tell two picks apart without holding on to the bytes. */
function cacheKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/** The one code that means "this server's key did not open it; ask for the phrase". */
function needsPhrase(failure: unknown): failure is BackupApiError {
  return failure instanceof BackupApiError && failure.code === "AFRBAK_UNREADABLE";
}

/** A wrong 2-Step Code is worth another try. A locked or missing one is not. */
function retryableStepCode(failure: unknown): failure is BackupApiError {
  return (
    failure instanceof BackupApiError &&
    (failure.code === "STEP_CODE_INVALID" || failure.code === "AFRBAK_STEP_CODE_REQUIRED")
  );
}

/**
 * Start the download without leaving the page.
 *
 * The anchor has to be in the document before it is clicked — Firefox ignores a click on a
 * detached node — and `download` carries the server's filename so the browser does not name the
 * file after the ticket in the URL.
 */
function triggerDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** The two busy dialogs cannot be dismissed, and `Modal` still requires an `onClose`. */
function ignoreClose() {
  /* dismissible={false}: nothing to close */
}

export default function BackupPage() {
  const t = useT();
  const { formatBytes, formatNumber } = useFormat();
  const reduceMotion = useReducedMotion();

  const {
    data,
    isPending,
    isError,
    error: identityError,
    refetch,
  } = useQuery({
    queryKey: ["backup-identity"],
    queryFn: fetchIdentity,
    // A refusal here is a fact about the server, not a blip: `BACKUP_MASTER_KEY` will not appear
    // on its own, and three more round trips only delay the sentence that says so.
    retry: false,
  });

  const [preparing, setPreparing] = useState<BackupDomain | null>(null);
  const [phraseToShow, setPhraseToShow] = useState<string | null>(null);
  const [pendingDownload, setPendingDownload] = useState<{ url: string; filename: string } | null>(
    null
  );
  const [restoreState, setRestoreState] = useState<RestoreState>({ phase: "idle" });
  /** Two seconds of "Copied", the same acknowledgement the phrase dialog gives. */
  const [copiedId, setCopiedId] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingDomainRef = useRef<BackupDomain | null>(null);
  const readingFocusRef = useRef<HTMLDivElement>(null);
  const runFocusRef = useRef<HTMLDivElement>(null);
  /** Never rendered, so a ref: writing to the cache must not repaint an open dialog. */
  const cacheRef = useRef<PreviewCache>({});

  /**
   * A refusal, in the user's language.
   *
   * The code is read first on purpose: a coded 503 from a server that was never configured for
   * this is a refusal, not a dropped connection, and calling it "check your connection" would
   * send the user hunting for a fault that is not theirs.
   */
  const describeFailure = (failure: unknown, fallbackKey: TranslationKey): string => {
    if (!(failure instanceof BackupApiError)) return t(fallbackKey);
    if (failure.code !== null) {
      return apiErrorMessage({ error: failure.message, code: failure.code }, t, fallbackKey);
    }
    if (failure.status === 0) return t("errors.network");
    return failure.message.length > 0 ? failure.message : t(fallbackKey);
  };

  /**
   * Describe the archive, then show the plan.
   *
   * One path for all three entry points — the first pick, a phrase attempt, a mode already
   * cached — because each ends the same two ways: a plan to show, or a phrase to ask for.
   */
  const runInspect = async (target: RestoreTarget, mode: RestoreMode) => {
    if (!data) return;

    const key = cacheKey(target.file);
    const cached = cacheRef.current[key]?.[mode];
    if (cached && (!cached.usedPhrase || target.phrase !== null)) {
      setRestoreState({ phase: "preview", target, mode, preview: cached.preview, busy: false });
      return;
    }

    setRestoreState({ phase: "reading", target });

    try {
      const csrf = await getCsrfToken();
      const preview = await inspectArchive(
        target.file,
        target.domain,
        mode,
        data.previewBytes,
        target.phrase,
        csrf
      );
      cacheRef.current[key] = {
        ...cacheRef.current[key],
        [mode]: { preview, usedPhrase: target.phrase !== null },
      };
      // Only if this pick is still the one on screen: cancelling mid-read must not be undone by
      // a reply that arrives afterwards.
      setRestoreState((prev) =>
        prev.phase === "reading" && prev.target === target
          ? { phase: "preview", target, mode, preview, busy: false }
          : prev
      );
    } catch (failure) {
      if (needsPhrase(failure)) {
        // The generic sentence, and only after an attempt: the first ask has nothing to report.
        setRestoreState({
          phase: "ask-phrase",
          target: { file: target.file, domain: target.domain, phrase: null },
          error:
            target.phrase === null ? null : describeFailure(failure, "backup.inspect.failed"),
        });
        return;
      }
      setRestoreState({
        phase: "error",
        message: describeFailure(failure, "backup.inspect.failed"),
      });
    }
  };

  /**
   * Upload the archive, then report what the server did with it.
   *
   * `preview` and `mode` are carried through only so a wrong 2-Step Code can reopen its dialog on
   * the same archive: a mistyped code should cost an attempt, not the whole restore.
   */
  const startRestore = async (
    target: RestoreTarget,
    mode: RestoreMode,
    preview: InspectResponse,
    stepCode: string | null
  ) => {
    setRestoreState({ phase: "uploading", percent: 0 });

    try {
      const csrf = await getCsrfToken();
      const result = await restoreArchive(
        target.file,
        target.domain,
        mode,
        target.phrase,
        stepCode,
        csrf,
        (percent) => {
          // The last byte is not the end. Five server stages follow and report nothing at all,
          // so the bar hands over to a spinner instead of sitting at 100% for minutes.
          setRestoreState((prev) => {
            if (prev.phase !== "uploading") return prev;
            return percent >= 100 ? { phase: "working" } : { phase: "uploading", percent };
          });
        }
      );

      // Every cached plan was computed against contents this restore has just changed.
      cacheRef.current = {};
      setRestoreState({ phase: "done", result });
      void refetch();
    } catch (failure) {
      if (retryableStepCode(failure)) {
        setRestoreState({
          phase: "step-code",
          target,
          preview,
          mode,
          remaining: failure.remaining,
          error: describeFailure(failure, "backup.failed"),
        });
        return;
      }
      setRestoreState({ phase: "error", message: describeFailure(failure, "backup.failed") });
    }
  };

  const handleDownload = async (domain: BackupDomain) => {
    // One prepare per domain per ten minutes: a second click would spend the next one.
    if (preparing !== null) return;
    setPreparing(domain);

    try {
      const csrf = await getCsrfToken();
      const prepared = await prepareTakeout(domain, csrf);

      // §4.3: every download has its own nine words, and this response is the only place they
      // are readable — the file itself carries only the salt. So the navigation waits for the
      // dialog: a user who closes the tab first keeps an archive nothing can open on a rebuilt
      // server. `phrase` is not optional; a server that cannot mint one fails `prepare` outright.
      setPhraseToShow(prepared.phrase);
      setPendingDownload({ url: prepared.url, filename: prepared.filename });
      void refetch();
    } catch (failure) {
      notify({ title: describeFailure(failure, "backup.download.failed"), tone: "error" });
    } finally {
      setPreparing(null);
    }
  };

  const handleRestore = (domain: BackupDomain) => {
    pendingDomainRef.current = domain;
    fileInputRef.current?.click();
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const domain = pendingDomainRef.current;
    // Cleared straight away, so picking the same file twice still fires a change event.
    event.target.value = "";
    if (!file || domain === null) return;

    if (!file.name.toLowerCase().endsWith(".afrbak")) {
      setRestoreState({ phase: "error", message: t("backup.inspect.wrongExtension") });
      return;
    }
    void runInspect({ file, domain, phrase: null }, "merge");
  };

  const handlePhraseSubmit = (phrase: string) => {
    if (restoreState.phase !== "ask-phrase") return;
    const { target } = restoreState;
    void runInspect({ file: target.file, domain: target.domain, phrase }, "merge");
  };

  const handleModeChange = async (nextMode: RestoreMode) => {
    if (restoreState.phase !== "preview" || restoreState.mode === nextMode || !data) return;
    const current = restoreState;

    const key = cacheKey(current.target.file);
    const cached = cacheRef.current[key]?.[nextMode];
    if (cached && (!cached.usedPhrase || current.target.phrase !== null)) {
      setRestoreState({ ...current, mode: nextMode, preview: cached.preview });
      return;
    }

    // The dialog stays up with its actions locked. Swapping it for the reading overlay would
    // throw focus out of the panel and straight back in for a request that is usually quick.
    setRestoreState({ ...current, busy: true });

    try {
      const csrf = await getCsrfToken();
      const preview = await inspectArchive(
        current.target.file,
        current.target.domain,
        nextMode,
        data.previewBytes,
        current.target.phrase,
        csrf
      );
      cacheRef.current[key] = {
        ...cacheRef.current[key],
        [nextMode]: { preview, usedPhrase: current.target.phrase !== null },
      };
      setRestoreState((prev) =>
        prev.phase === "preview" && prev.target === current.target
          ? { ...prev, mode: nextMode, preview, busy: false }
          : prev
      );
    } catch (failure) {
      // The archive is open and the mode on screen still describes it truthfully, so a failed
      // switch is reported over the dialog rather than replacing it with an error page.
      notify({ title: describeFailure(failure, "backup.inspect.failed"), tone: "error" });
      setRestoreState((prev) =>
        prev.phase === "preview" && prev.target === current.target
          ? { ...prev, busy: false }
          : prev
      );
    }
  };

  const handlePreviewConfirm = () => {
    if (restoreState.phase !== "preview") return;
    const { target, mode, preview } = restoreState;
    if (mode === "replace") {
      setRestoreState({ phase: "confirm-replace", target, preview });
      return;
    }
    void startRestore(target, mode, preview, null);
  };

  const handleConfirmReplace = () => {
    if (restoreState.phase !== "confirm-replace") return;
    const { target, preview } = restoreState;
    // `remaining` starts null: the lockout counter only travels on a denial, and a guessed
    // number would be a promise the server has not made.
    setRestoreState({
      phase: "step-code",
      target,
      preview,
      mode: "replace",
      remaining: null,
      error: null,
    });
  };

  const handleStepCodeSubmit = (code: string) => {
    if (restoreState.phase !== "step-code") return;
    const { target, preview, mode } = restoreState;
    void startRestore(target, mode, preview, code);
  };

  const handleCloseDialog = () => setRestoreState({ phase: "idle" });

  /**
   * Put the Archive ID on the clipboard.
   *
   * Silent on failure, the way the phrase dialog is: a browser that refuses clipboard access has
   * given the user nothing to act on, and the ID is on screen and selectable either way.
   */
  const handleCopyId = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.accountBackupIdDisplay);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch {
      // Deliberately ignored — see above.
    }
  };

  if (isPending) {
    return (
      <div className="flex min-h-[60dvh] items-center justify-center" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );
  }

  // A server with no `BACKUP_MASTER_KEY` answers the identity route 503 with a code, and this is
  // where that has to be readable. Spinning forever on it was the whole reason this page could
  // not be opened at all.
  if (isError || !data) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title={t("common.somethingWentWrong")}
        description={describeFailure(identityError, "common.somethingWentWrong")}
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  }

  const { identity, overview } = data;
  const filesBlocked = overview.files.encryptedFiles > 0;
  const runOpen = restoreState.phase === "uploading" || restoreState.phase === "working";
  const percent = restoreState.phase === "uploading" ? restoreState.percent : null;
  const readingName = restoreState.phase === "reading" ? restoreState.target.file.name : "";

  /**
   * The three properties of an `.afrbak` worth stating up front.
   *
   * Each one is a fact the format tests hold in place rather than a promise: the payload is
   * AES-256-GCM from the SUMMARY to the last chunk, keyslot 0 opens with this server's key and
   * keyslot 1 with the phrase only the owner has, and the container is not a ZIP any other tool
   * can walk into. They lead the page because they are what a person is actually deciding about
   * before they click Download.
   */
  const assurances: Array<{ icon: LucideIcon; label: string; hint: string }> = [
    {
      icon: Lock,
      label: t("backup.assurance.encrypted"),
      hint: t("backup.assurance.encryptedHint"),
    },
    {
      icon: KeyRound,
      label: t("backup.assurance.twoHalves"),
      hint: t("backup.assurance.twoHalvesHint"),
    },
    {
      icon: ShieldCheck,
      label: t("backup.assurance.afrOnly"),
      hint: t("backup.assurance.afrOnlyHint"),
    },
  ];

  /** One curve and one duration for the whole page, so the entrance reads as a single move. */
  const enter = (delay: number) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12 },
    animate: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 },
    transition: {
      duration: reduceMotion ? 0 : 0.3,
      delay: reduceMotion ? 0 : delay,
      ease: EASE,
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <motion.header {...enter(0)} className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="hidden h-12 w-12 shrink-0 place-items-center rounded-2xl bg-accent/10 ring-1 ring-accent/20 sm:grid"
        >
          <Archive className="h-6 w-6 text-accent-ink" />
        </span>
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t("backup.title")}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{t("backup.subtitle")}</p>
        </div>
      </motion.header>

      {/* What the format guarantees, said once and above everything that acts on it. */}
      <motion.ul {...enter(0.04)} className="grid gap-3 sm:grid-cols-3">
        {assurances.map((item) => {
          const Icon = item.icon;
          return (
            <li
              key={item.label}
              className="flex items-start gap-3 rounded-2xl border border-border/60 bg-surface p-4 shadow-sm"
            >
              <span
                aria-hidden="true"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/10 ring-1 ring-accent/20"
              >
                <Icon className="h-4 w-4 text-accent-ink" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.hint}</p>
              </div>
            </li>
          );
        })}
      </motion.ul>

      <motion.section
        aria-labelledby="backupIdentityHeading"
        {...enter(0.08)}
        className="rounded-2xl border border-border/60 bg-surface p-5 shadow-sm"
      >
        <div className="mb-4 flex items-center gap-2">
          <Fingerprint className="h-4 w-4 shrink-0 text-accent-ink" aria-hidden="true" />
          <h2 id="backupIdentityHeading" className="text-sm font-semibold text-foreground">
            {t("backup.identity.heading")}
          </h2>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("backup.identity.idLabel")}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background-secondary/60 px-2.5 py-1.5 font-mono text-sm text-foreground"
                title={data.accountBackupIdDisplay}
              >
                {data.accountBackupIdDisplay}
              </code>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void handleCopyId()}
                aria-label={t("backup.identity.copyId")}
                title={t("backup.identity.copyId")}
              >
                {copiedId ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                {copiedId ? t("common.copied") : t("common.copy")}
              </Button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t("backup.identity.idHint")}
            </p>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 shrink-0 text-accent-ink" aria-hidden="true" />
              <p className="text-sm font-medium text-foreground">
                {t("backup.identity.perFilePhrase")}
              </p>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t("backup.identity.perFilePhraseHint")}
            </p>
          </div>
        </div>

        {identity.adopted.length > 0 && (
          <div className="mt-4 border-t border-border/60 pt-4">
            <p className="text-sm text-foreground">
              {t("backup.identity.adopted", { count: identity.adopted.length })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("backup.identity.adoptedHint")}
            </p>
          </div>
        )}
      </motion.section>

      {/* Two archives, never one file: a Files backup and a Brain backup are separate formats
          and separate restores. */}
      <div className="grid items-stretch gap-5 md:grid-cols-2">
        <DomainCard
          domain="files"
          icon={FolderTree}
          title={t("backup.card.filesTitle")}
          subtitle={t("backup.card.filesSubtitle")}
          stats={[
            { label: t("backup.card.folders"), value: formatNumber(overview.files.folders) },
            { label: t("backup.card.files"), value: formatNumber(overview.files.files) },
            { label: t("backup.card.size"), value: formatBytes(overview.files.bytes) },
          ]}
          note={t("backup.card.filesNote")}
          isEmpty={overview.files.files === 0}
          blocked={
            filesBlocked
              ? {
                  count: overview.files.encryptedFiles,
                  message: t("backup.card.encryptedBlocked", {
                    count: overview.files.encryptedFiles,
                  }),
                }
              : undefined
          }
          downloading={preparing === "files"}
          onDownload={() => void handleDownload("files")}
          onRestore={() => handleRestore("files")}
          downloadDisabled={filesBlocked}
          delay={reduceMotion ? 0 : 0.12}
        />
        <DomainCard
          domain="brain"
          icon={Brain}
          title={t("backup.card.brainTitle")}
          subtitle={t("backup.card.brainSubtitle")}
          stats={[
            { label: t("backup.card.brains"), value: formatNumber(overview.brain.brains) },
            {
              label: t("backup.card.memories"),
              value: formatNumber(overview.brain.memories),
              // The whole of bug #5's visible half: this card counts the rows the archive
              // carries, and `/brain` counts active and archived in two separate tiles. Without
              // the split spelled out, one number reads as a contradiction of the other.
              hint: t("backup.card.memoriesHint", {
                active: formatNumber(overview.brain.memories - overview.brain.archivedMemories),
                archived: formatNumber(overview.brain.archivedMemories),
              }),
            },
          ]}
          note={t("backup.card.brainNote")}
          isEmpty={overview.brain.memories === 0}
          downloading={preparing === "brain"}
          onDownload={() => void handleDownload("brain")}
          onRestore={() => handleRestore("brain")}
          delay={reduceMotion ? 0 : 0.16}
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".afrbak"
        className="hidden"
        onChange={handleFileSelected}
      />

      <PhraseDialog
        open={phraseToShow !== null}
        phrase={phraseToShow ?? ""}
        onClose={() => {
          setPhraseToShow(null);
          // If there's a pending download, trigger it now that user has seen the phrase
          if (pendingDownload !== null) {
            triggerDownload(pendingDownload.url, pendingDownload.filename);
            notify({
              title: t("backup.download.started"),
              description: t("backup.download.startedHint"),
              tone: "success",
            });
            setPendingDownload(null);
          }
        }}
      />

      <AskPhraseDialog
        open={restoreState.phase === "ask-phrase"}
        error={restoreState.phase === "ask-phrase" ? restoreState.error : null}
        onSubmit={handlePhraseSubmit}
        onClose={handleCloseDialog}
      />

      <PreviewDialog
        open={restoreState.phase === "preview"}
        preview={restoreState.phase === "preview" ? restoreState.preview : null}
        mode={restoreState.phase === "preview" ? restoreState.mode : "merge"}
        busy={restoreState.phase === "preview" ? restoreState.busy : false}
        onModeChange={(next) => void handleModeChange(next)}
        onConfirm={handlePreviewConfirm}
        onClose={handleCloseDialog}
      />

      <ConfirmReplaceDialog
        open={restoreState.phase === "confirm-replace"}
        domain={restoreState.phase === "confirm-replace" ? restoreState.target.domain : "files"}
        onConfirm={handleConfirmReplace}
        onClose={handleCloseDialog}
      />

      <StepCodeDialog
        open={restoreState.phase === "step-code"}
        remaining={restoreState.phase === "step-code" ? restoreState.remaining : null}
        error={restoreState.phase === "step-code" ? restoreState.error : null}
        onSubmit={handleStepCodeSubmit}
        onClose={handleCloseDialog}
      />

      {/* The preview upload is at most a couple of megabytes, but it is still a request the user
          must not be able to cancel halfway: a reply arriving after a cancel would reopen a
          dialog they had already dismissed. */}
      <Modal
        open={restoreState.phase === "reading"}
        onClose={ignoreClose}
        dismissible={false}
        icon={FileSearch}
        title={t("backup.inspect.reading")}
        initialFocusRef={readingFocusRef}
      >
        <div
          ref={readingFocusRef}
          tabIndex={-1}
          className="flex items-center gap-3 outline-none"
        >
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-accent-ink" aria-hidden="true" />
          <p className="truncate font-mono text-sm text-muted-foreground">{readingName}</p>
        </div>
      </Modal>

      {/* One dialog for both halves of a restore, under a title that does not change: the bytes
          going up, which the browser can measure, and the five server stages afterwards, which
          report nothing. A title that counted would be read out again on every tick. */}
      <Modal
        open={runOpen}
        onClose={ignoreClose}
        dismissible={false}
        icon={Upload}
        title={t("backup.run.title")}
        initialFocusRef={runFocusRef}
      >
        <div ref={runFocusRef} tabIndex={-1} className="space-y-4 outline-none">
          {percent === null ? (
            <div className="flex items-center gap-3">
              <Loader2
                className="h-5 w-5 shrink-0 animate-spin text-accent-ink"
                aria-hidden="true"
              />
              <p className="text-sm text-foreground">{t("backup.run.working")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                {t("backup.run.uploading", { percent })}
              </p>
              <div
                role="progressbar"
                aria-label={t("backup.run.title")}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("backup.run.warnClose")}
          </p>
        </div>
      </Modal>

      <ResultDialog
        open={restoreState.phase === "done"}
        result={restoreState.phase === "done" ? restoreState.result : null}
        onClose={handleCloseDialog}
      />

      <Modal
        open={restoreState.phase === "error"}
        onClose={handleCloseDialog}
        icon={AlertTriangle}
        tone="danger"
        title={t("common.somethingWentWrong")}
        footer={<Button onClick={handleCloseDialog}>{t("common.close")}</Button>}
      >
        <p className="text-sm leading-relaxed text-foreground">
          {restoreState.phase === "error" ? restoreState.message : ""}
        </p>
      </Modal>
    </div>
  );
}

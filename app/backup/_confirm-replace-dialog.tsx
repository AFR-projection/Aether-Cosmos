"use client";

import { AlertTriangle } from "lucide-react";
import { Modal } from "@/ui/primitives/modal";
import { Button } from "@/ui/primitives/button";
import { useT } from "@/shared/lib/i18n";
import type { BackupDomain } from "@backup/domain/types";

interface ConfirmReplaceDialogProps {
  open: boolean;
  domain: BackupDomain;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmReplaceDialog({
  open,
  domain,
  onConfirm,
  onClose,
}: ConfirmReplaceDialogProps) {
  const t = useT();

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={AlertTriangle}
      tone="danger"
      title={t("backup.confirm.title")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t("backup.confirm.proceed")}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-foreground">
        {domain === "files" ? t("backup.confirm.bodyFiles") : t("backup.confirm.bodyBrain")}
      </p>
    </Modal>
  );
}

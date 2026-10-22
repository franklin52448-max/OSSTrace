import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";
import { ErrorText } from "./QueryState.tsx";

/** Confirmation step for destructive actions. Shows the mutation error inline instead of closing. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  pending,
  error,
  confirmDisabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: unknown;
  /** Blocks the destructive action (e.g. the item is still in use); the body explains why. */
  confirmDisabled?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger-solid" loading={pending} disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-muted">
        {body}
        {error ? <ErrorText error={error} /> : null}
      </div>
    </Dialog>
  );
}

/**
 * The Discard and Stop buttons for a splat, each behind a confirmation dialog.
 *
 * DeleteSplatButton deletes the splat with its photos and results. StopJobButton stops the worker job that's running
 * for it. Neither can be undone, so both ask first.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useSnackbar } from "notistack";
import { useState } from "react";
import { useSWRConfig } from "swr";

import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";

interface ConfirmButtonProps {
  label: string;
  variant: "contained" | "outlined";
  title: string;
  description: string;
  confirmLabel: string;
  keepLabel: string;
  // Resolves once the action is done. A rejection is reported and leaves the dialog open.
  onConfirm: () => Promise<void>;
}

// A destructive action behind a confirmation, since neither deleting nor stopping a worker job can be undone.
function ConfirmButton({ label, variant, title, description, confirmLabel, keepLabel, onConfirm }: ConfirmButtonProps) {
  const { enqueueSnackbar } = useSnackbar();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      enqueueSnackbar(`${confirmLabel} failed`, {
        variant: "error",
        detail: err instanceof Error ? err.message : undefined,
        persist: true,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onOpenChange={next => !pending && setOpen(next)}>
        <DialogContent>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="outlined" onClick={() => setOpen(false)} disabled={pending}>
              {keepLabel}
            </Button>
            <Button variant="danger" onClick={confirm} loading={pending}>
              {confirmLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DeleteSplatButton({
  splatId,
  label,
  variant,
}: {
  splatId: string;
  label: string;
  variant: "contained" | "outlined";
}) {
  const { getToken } = useAuth();
  const { mutate } = useSWRConfig();
  const router = useRouter();

  return (
    <ConfirmButton
      label={label}
      variant={variant}
      title="Delete this splat?"
      description="Its photos and anything built from them are deleted too. This can't be undone."
      confirmLabel="Delete"
      keepLabel="Keep it"
      onConfirm={async () => {
        await apiFetch<unknown>(`/api/v1/splats/${splatId}`, "DELETE", await requireToken(getToken));
        await mutate("splats");
        router.push("/splats");
      }}
    />
  );
}

export function StopJobButton({ splatId, onJobChanged }: { splatId: string; onJobChanged: () => void }) {
  const { getToken } = useAuth();
  const { mutate } = useSWRConfig();

  return (
    <ConfirmButton
      label="Stop"
      variant="contained"
      title="Stop processing?"
      description="The cloud GPU stops straight away. Starting again later begins from placing the cameras."
      confirmLabel="Stop"
      keepLabel="Keep going"
      onConfirm={async () => {
        await apiFetch<unknown>(`/api/v1/splats/${splatId}/cancel`, "POST", await requireToken(getToken));
        onJobChanged();
        await mutate("splats");
      }}
    />
  );
}

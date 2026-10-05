/**
 * The confirmation dialog behind the account menu's Delete account item.
 *
 * Confirming calls DELETE /api/v1/account, which removes every splat, photo and result along with the Clerk account,
 * then signs the browser out and returns to the home page. The site header owns whether the dialog is open, because
 * the item that opens it lives inside Clerk's account menu.
 */

"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import { useSnackbar } from "notistack";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";

export function DeleteAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  const { enqueueSnackbar } = useSnackbar();

  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await apiFetch<unknown>("/api/v1/account", "DELETE", await requireToken(getToken));
    } catch (err) {
      enqueueSnackbar("Delete account failed", {
        variant: "error",
        detail: err instanceof Error ? err.message : undefined,
        persist: true,
      });
      setPending(false);
      return;
    }

    // The session ended with the Clerk account, so signOut only clears it from the browser. pending stays true until
    // the redirect replaces the page.
    await signOut({ redirectUrl: "/" });
  }

  return (
    <Dialog open={open} onOpenChange={next => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogTitle>Delete your account?</DialogTitle>
        <DialogDescription>
          Every splat, photo and result in your account is deleted with it. This can&apos;t be undone.
        </DialogDescription>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button variant="outlined" onClick={() => onOpenChange(false)} disabled={pending}>
            Keep it
          </Button>
          <Button variant="danger" onClick={confirm} loading={pending}>
            Delete account
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

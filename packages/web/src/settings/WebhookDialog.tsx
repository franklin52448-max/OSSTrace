import { useState, type FormEvent } from "react";
import { describeError } from "../kit/errors.ts";
import { useCreateNotificationMethod } from "./api.ts";
import { validateWebhookUrl } from "../kit/validation.ts";
import { Button } from "../kit/Button.tsx";
import { Dialog } from "../kit/Dialog.tsx";
import { Field, Input } from "../kit/Field.tsx";
import { ErrorText } from "../kit/QueryState.tsx";
import { useToast } from "../kit/Toast.tsx";
import { PasswordInput } from "../kit/PasswordInput.tsx";

/** 32 random bytes as hex, generated in the browser; shown once, then only the server keeps it. */
export function generateSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function WebhookDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState({ name: "", url: "", secret: "" });
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({});
  const create = useCreateNotificationMethod();
  const toast = useToast();

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setForm({ name: "", url: "", secret: "" });
      setErrors({});
      create.reset();
    }
  };

  // The server's SSRF guard rejects private/loopback targets with a 400; show that under the URL field.
  const serverError = create.error ? describeError(create.error) : null;
  const urlServerError = serverError && serverError.code === "bad_request" ? serverError.message : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!form.name.trim()) errs.name = "Give it a name you will recognise in alert rules.";
    else if (form.name.trim().length > 60) errs.name = "At most 60 characters.";
    const u = validateWebhookUrl(form.url);
    if (u) errs.url = u;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    create.mutate(
      { kind: "webhook", name: form.name.trim(), url: form.url.trim(), secret: form.secret || undefined },
      {
        onSuccess: () => {
          toast.success("Webhook added. Send a test to check it.");
          close(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Add webhook"
      description="OSSTrace POSTs each alert event as JSON to this URL (5 second timeout, redirects not followed)."
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="kit-webhook-form" variant="primary" loading={create.isPending}>
            Add webhook
          </Button>
        </>
      }
    >
      <form id="kit-webhook-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Name" error={errors.name}>
          {(p) => <Input {...p} autoFocus maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
        <Field
          label="URL"
          error={errors.url ?? urlServerError}
          help="Public http(s) endpoint. Addresses on private, loopback or link-local networks are refused."
        >
          {(p) => (
            <Input {...p} type="url" inputMode="url" spellCheck={false} className="kit-mono" placeholder="https://" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          )}
        </Field>
        <Field label="Signing secret" optional help="When set, each request carries an HMAC-SHA256 signature of the body. Copy it now: it is not shown again.">
          {(p) => (
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <PasswordInput {...p} autoComplete="off" spellCheck={false} className="kit-mono" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
              </div>
              <Button variant="secondary" onClick={() => setForm({ ...form, secret: generateSecret() })}>
                Generate
              </Button>
            </div>
          )}
        </Field>
        {serverError && !urlServerError ? <ErrorText error={create.error} /> : null}
      </form>
    </Dialog>
  );
}

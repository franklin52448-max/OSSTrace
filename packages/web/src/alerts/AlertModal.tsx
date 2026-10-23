import { supportedChainNames } from "../chainList.ts";
import type { AlertRule, Chain } from "@osstrace/contract";
import { Plus, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAlertLimits, useCreateAlert, useUpdateAlert } from "./api.ts";
import { describeError } from "../kit/errors.ts";
import { useEntities } from "../labels/api.ts";
import { useNotificationMethods } from "../settings/api.ts";
import { ALERT_NAME_MAX, describeRule, emptyAlertForm, formToPayload, noBackfillNote, ruleToForm, suggestAlertName, validateAlertForm, type AlertFormErrors, type AlertFormState } from "./alertForm.ts";
import { usePrefs } from "../settings/prefs.ts";
import { Button, IconButton } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { Dialog } from "../kit/Dialog.tsx";
import { Checkbox, Input } from "../kit/Field.tsx";
import { ErrorText } from "../kit/QueryState.tsx";
import { TargetsEditor } from "./TargetsEditor.tsx";

const DIRECTIONS: { value: AlertRule["direction"]; label: string; tone?: string }[] = [
  { value: "both", label: "Sends or receives" },
  { value: "in", label: "Receives", tone: "text-in" },
  { value: "out", label: "Sends", tone: "text-out" },
];

/** One-click minimums; "" is no floor. */
const USD_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Any" },
  { value: "1000", label: "$1K" },
  { value: "10000", label: "$10K" },
  { value: "100000", label: "$100K" },
];

/**
 * Create/edit an alert on one page, top to bottom: what to watch, when it fires, then its name and
 * where it's delivered. A plain-language summary of the rule sits just above the save button, so
 * there's no separate review step and nothing hidden behind collapsed sections.
 */
export function AlertModal({
  open,
  onOpenChange,
  existing,
  prefill,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  existing?: AlertRule;
  prefill?: { chain?: Chain | null; address?: string | null; entityId?: string | null };
  onSaved: (rule: AlertRule) => void;
}) {
  const prefs = usePrefs();
  const limits = useAlertLimits();
  const entities = useEntities();
  const methods = useNotificationMethods();
  const create = useCreateAlert();
  const update = useUpdateAlert();
  const mutation = existing ? update : create;
  const initial = () => (existing ? ruleToForm(existing) : emptyAlertForm({ ...prefill, minUsd: prefs.defaultUsdGte }));
  const [form, setForm] = useState<AlertFormState>(initial);
  const [errors, setErrors] = useState<AlertFormErrors>({});
  const [tokenDraft, setTokenDraft] = useState("");

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setForm(initial());
    setErrors({});
    setTokenDraft("");
    create.reset();
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  const set = <K extends keyof AlertFormState>(k: K, v: AlertFormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k === "anyToken" ? "tokens" : k]: undefined }));
  };
  const webhooks = (methods.data ?? []).filter((m) => m.kind === "webhook");
  const suggestedName = suggestAlertName(form, entities.data);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // A blank name takes the suggestion, so naming is never a blocker.
    const final = { ...form, name: form.name.trim() || suggestedName };
    const errs = validateAlertForm(final, limits.data);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const payload = formToPayload(final);
    if (existing) update.mutate({ id: existing.id, ...payload }, { onSuccess: onSaved });
    else create.mutate(payload, { onSuccess: onSaved });
  };

  const addToken = () => {
    const v = tokenDraft.trim();
    if (!v) return;
    if (!form.tokens.includes(v)) set("tokens", [...form.tokens, v]);
    setTokenDraft("");
  };

  const ready = form.targets.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title={existing ? "Edit alert" : "New alert"}
      description="Get notified when an address you care about moves funds."
      footer={
        <div className="flex w-full flex-col gap-3">
          <section aria-label="Summary" aria-live="polite" className={cn("rounded-[12px] px-3.5 py-3 text-[13px]", ready ? "bg-accent-soft" : "bg-surface-3")}>
            <p className={ready ? "text-text" : "text-muted"}>{ready ? describeRule(form, entities.data, methods.data) : "Add something to watch and the rule will be summarised here."}</p>
            <p className="mt-1 text-xs text-muted">{noBackfillNote(limits.data?.pollIntervalSec)}</p>
          </section>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="alert-modal-form" variant="primary" loading={mutation.isPending}>
              {existing ? "Save changes" : "Create alert"}
            </Button>
          </div>
        </div>
      }
    >
      <form id="alert-modal-form" onSubmit={submit} noValidate className="flex flex-col gap-7 pb-1">
        {mutation.isError ? (
          <div role="alert" className="rounded-[12px] border border-danger/35 bg-danger-soft px-3 py-2.5 text-[13px]">
            <p className="font-medium text-danger">{existing ? "Couldn't save the alert" : "Couldn't create the alert"}</p>
            <p className="mt-0.5 text-muted">{describeError(mutation.error).message}</p>
          </div>
        ) : null}

        <Step n={1} title="Watch" hint={`${supportedChainNames("and")} addresses. The chain is picked up from what you paste; a 0x address starts on Ethereum, so pick its chain for one on any other EVM chain.`}>
          {entities.isError ? <ErrorText error={entities.error} /> : null}
          <TargetsEditor
            targets={form.targets}
            onChange={(t) => set("targets", t)}
            entities={entities.data ?? []}
            max={limits.data?.maxTargetsPerRule}
            defaultChain={prefill?.chain ?? prefs.defaultChain}
            error={errors.targets}
            autoFocus={!existing && form.targets.length === 0}
          />
        </Step>

        <Step n={2} title="Trigger when it…" hint="Every condition has to match for the alert to fire.">
          <div className="flex flex-col gap-5">
            <Field label="Direction">
              <Segmented
                label="Direction"
                value={form.direction}
                onChange={(v) => set("direction", v)}
                options={DIRECTIONS.map((d) => ({ value: d.value, label: <span className={form.direction === d.value ? d.tone : undefined}>{d.label}</span> }))}
              />
            </Field>

            <Field label="Worth at least" error={errors.minUsd} help="Transfers without a known USD price don't pass a minimum.">
              <div className="flex flex-wrap items-center gap-2">
                <span className="relative w-40">
                  <span aria-hidden className="kit-mono pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                    $
                  </span>
                  <Input
                    aria-label="Minimum USD value"
                    inputMode="decimal"
                    aria-invalid={errors.minUsd ? true : undefined}
                    className="kit-num h-9 pl-6"
                    placeholder="Any amount"
                    value={form.minUsd}
                    onChange={(e) => set("minUsd", e.target.value)}
                  />
                </span>
                {USD_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={form.minUsd.trim().replace(/,/g, "") === p.value}
                    onClick={() => set("minUsd", p.value)}
                    className="kit-fade h-8 rounded-full bg-[var(--helium-elevated-7)] px-3 text-xs font-medium text-muted hover:bg-[var(--helium-elevated-10)] hover:text-text aria-pressed:bg-accent-soft aria-pressed:text-accent"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Token" error={errors.tokens}>
              <Segmented
                label="Token"
                value={form.anyToken ? "any" : "some"}
                onChange={(v) => set("anyToken", v === "any")}
                options={[
                  { value: "any", label: "Any token" },
                  { value: "some", label: "Only specific tokens" },
                ]}
              />
              {!form.anyToken ? (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Input
                      aria-label="Token id"
                      className="kit-mono h-9"
                      placeholder="native, an ERC-20 contract or an SPL mint"
                      spellCheck={false}
                      value={tokenDraft}
                      onChange={(e) => setTokenDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addToken();
                        }
                      }}
                    />
                    <Button className="h-9" onClick={addToken} disabled={!tokenDraft.trim()} icon={<Plus aria-hidden className="size-3.5" />}>
                      Add
                    </Button>
                  </div>
                  {form.tokens.length ? (
                    <ul aria-label="Selected tokens" className="flex flex-wrap gap-1.5">
                      {form.tokens.map((t) => (
                        <li key={t} className="kit-mono inline-flex h-7 items-center gap-1 rounded-full bg-[var(--helium-elevated-7)] pl-3 pr-1 text-xs">
                          <span className="max-w-64 truncate">{t === "native" ? "native (ETH / SOL)" : t}</span>
                          <IconButton size="sm" className="size-5" label={`Remove ${t}`} onClick={() => set("tokens", form.tokens.filter((x) => x !== t))}>
                            <X aria-hidden className="size-3" />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted">Use “native” for ETH or SOL itself. Ids are matched exactly as entered.</p>
                  )}
                </div>
              ) : null}
            </Field>
          </div>
        </Step>

        <Step n={3} title="Name & notify">
          <div className="flex flex-col gap-5">
            <Field label="Name" error={errors.name} help={form.name.trim() ? "Shown on notifications and webhook payloads." : suggestedName ? "Leave it blank to use the suggestion." : undefined}>
              <Input
                aria-label="Alert name"
                aria-invalid={errors.name ? true : undefined}
                maxLength={ALERT_NAME_MAX + 20}
                placeholder={suggestedName || "e.g. Treasury outflows"}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                className="h-9"
              />
            </Field>
            <fieldset>
              <legend className="mb-2 text-[12.5px] font-medium text-text">Deliver to</legend>
              <div className="flex flex-col divide-y divide-border rounded-[12px] border border-border">
                <div className="px-3 py-2.5">
                  <Checkbox label="Inbox on OSSTrace (always on)" checked disabled readOnly />
                </div>
                {methods.isError ? <ErrorText error={methods.error} className="px-3 py-2.5" /> : null}
                {webhooks.map((m) => (
                  <div key={m.id} className="px-3 py-2.5">
                    <Checkbox
                      label={
                        <>
                          {m.name} <span className="kit-mono text-xs text-faint">{m.url}</span>
                          {!m.enabled ? <span className="ml-1.5 text-xs text-warn">disabled, won't deliver</span> : null}
                        </>
                      }
                      checked={form.methodIds.includes(m.id)}
                      onChange={(e) => set("methodIds", e.target.checked ? [...form.methodIds, m.id] : form.methodIds.filter((x) => x !== m.id))}
                    />
                  </div>
                ))}
                <a href="#alerts/manage" onClick={() => onOpenChange(false)} className="kit-fade flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-accent hover:bg-surface-2">
                  <Plus aria-hidden className="size-3.5" />
                  {webhooks.length ? "Add another webhook" : "Add a webhook"}
                </a>
              </div>
            </fieldset>
          </div>
        </Step>
      </form>
    </Dialog>
  );
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`alert-step-${n}`}>
      <div className="mb-3 flex items-start gap-3">
        <span className="kit-num mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--helium-elevated-10)] text-xs font-semibold text-text">{n}</span>
        <div className="min-w-0">
          <h3 id={`alert-step-${n}`} className="text-[15px] font-semibold text-text">
            {title}
          </h3>
          {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
        </div>
      </div>
      <div className="pl-9">{children}</div>
    </section>
  );
}

function Field({ label, help, error, children }: { label: string; help?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[12.5px] font-medium text-text">{label}</div>
      {children}
      {error ? <p className="mt-1.5 text-xs text-danger">{error}</p> : help ? <p className="mt-1.5 text-xs text-muted">{help}</p> : null}
    </div>
  );
}

/** A pill segmented control behaving as a radio group. */
function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-full bg-[var(--helium-elevated-7)] p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "kit-fade h-8 rounded-full px-3.5 text-[13px] font-medium",
            value === o.value ? "bg-[var(--helium-elevated-15)] text-text shadow-sm" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

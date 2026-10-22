import type { AlertRule, Chain } from "@osstrace/contract";
import { ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useAlertLimits, useCreateAlert, useUpdateAlert } from "./api.ts";
import { describeError } from "../kit/errors.ts";
import { useEntities } from "../labels/api.ts";
import { useNotificationMethods } from "../settings/api.ts";
import {
  ALERT_NAME_MAX,
  describeRule,
  emptyAlertForm,
  formToPayload,
  noBackfillNote,
  ruleToForm,
  targetKey,
  validateAlertForm,
  type AlertFormErrors,
  type AlertFormState,
} from "./alertForm.ts";
import { usePrefs } from "../settings/prefs.ts";
import { Button, IconButton } from "../kit/Button.tsx";
import { Chip } from "../kit/Chip.tsx";
import { cn } from "../kit/cn.ts";
import { Dialog } from "../kit/Dialog.tsx";
import { Checkbox, Input } from "../kit/Field.tsx";
import { ErrorText } from "../kit/QueryState.tsx";
import { ruleChipSpecs } from "./parts.tsx";
import { TargetsEditor } from "./TargetsEditor.tsx";

const DIRECTIONS: { value: AlertRule["direction"]; label: string; help: string }[] = [
  { value: "both", label: "Both", help: "Either direction" },
  { value: "in", label: "Inflow", help: "Target receives funds" },
  { value: "out", label: "Outflow", help: "Target sends funds" },
];

type Section = "targets" | "direction" | "tokens" | "amount" | "network";
const STEP1_KEYS = ["targets", "minUsd", "tokens"] as const;

/**
 * Two-step create/edit dialog. Step 1: filters as collapsible sections with a live chip summary (Reset / Next).
 * Step 2: name and delivery methods (Back / Create or Save).
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
  const [step, setStep] = useState<1 | 2>(1);
  const [openSections, setOpenSections] = useState<Set<Section>>(() => new Set<Section>(["targets"]));
  const [tokenDraft, setTokenDraft] = useState("");

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setForm(initial());
    setErrors({});
    setStep(1);
    setOpenSections(new Set<Section>(["targets"]));
    create.reset();
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  const set = <K extends keyof AlertFormState>(k: K, v: AlertFormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (s: Section) =>
    setOpenSections((cur) => {
      const n = new Set(cur);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });
  const chips = useMemo(() => ruleChipSpecs(form, entities.data), [form, entities.data]);
  const webhooks = (methods.data ?? []).filter((m) => m.kind === "webhook");
  const networks = Array.from(new Set(form.targets.filter((t) => t.type === "address").map((t) => (t.type === "address" ? t.chain : null)))) as Chain[];
  const hasEntity = form.targets.some((t) => t.type === "entity");

  const next = () => {
    const all = validateAlertForm({ ...form, name: form.name || "x" }, limits.data);
    const errs: AlertFormErrors = {};
    for (const k of STEP1_KEYS) if (all[k]) errs[k] = all[k];
    setErrors(errs);
    if (Object.keys(errs).length) {
      setOpenSections((cur) => new Set([...cur, ...(errs.targets ? (["targets"] as Section[]) : []), ...(errs.tokens ? (["tokens"] as Section[]) : []), ...(errs.minUsd ? (["amount"] as Section[]) : [])]));
      return;
    }
    setStep(2);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 1) return next();
    const errs = validateAlertForm(form, limits.data);
    setErrors(errs);
    if (Object.keys(errs).length) {
      if (STEP1_KEYS.some((k) => errs[k])) setStep(1);
      return;
    }
    const payload = formToPayload(form);
    if (existing) update.mutate({ id: existing.id, ...payload }, { onSuccess: onSaved });
    else create.mutate(payload, { onSuccess: onSaved });
  };

  const addToken = () => {
    const v = tokenDraft.trim();
    if (!v) return;
    if (!form.tokens.includes(v)) set("tokens", [...form.tokens, v]);
    setTokenDraft("");
  };

  const removeChip = (c: (typeof chips)[number]) => {
    if (c.kind === "target" && c.target) set("targets", form.targets.filter((t) => targetKey(t) !== targetKey(c.target!)));
    else if (c.kind === "direction") set("direction", "both");
    else if (c.kind === "usd") set("minUsd", "");
    else if (c.kind === "tokens") setForm((f) => ({ ...f, anyToken: true, tokens: [] }));
  };

  const title = existing ? "Edit alert" : "Create alert";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title={
        <span className="flex items-center gap-3">
          {title}
          <span className="kit-mono text-[11px] font-normal uppercase tracking-[0.08em] text-muted">Step {step} of 2</span>
        </span>
      }
      description={step === 1 ? "Choose what to watch and which transfers count." : "Name the alert and choose where it is delivered."}
      footer={
        <div className="flex w-full flex-col gap-3">
          <div aria-label="Alert filters" role="group" className="flex min-h-6 flex-wrap items-center gap-1.5">
            {chips.length === 0 ? <span className="text-xs text-faint">No filters yet. Add a target to watch.</span> : null}
            {chips.map((c) => (
              <Chip key={c.id} k={c.k} tone={c.tone} onRemove={step === 1 ? () => removeChip(c) : undefined} removeLabel={`Remove ${c.k}${c.value ? ` ${c.value}` : ""}`}>
                {c.value}
              </Chip>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            {step === 1 ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setForm((f) => ({ ...emptyAlertForm({ minUsd: null }), name: f.name, methodIds: f.methodIds }));
                  setErrors({});
                }}
              >
                Reset
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setStep(1)}>
                Back
              </Button>
            )}
            <Button type="submit" form="alert-modal-form" variant="primary" loading={mutation.isPending}>
              {step === 1 ? "Next" : existing ? "Save" : "Create alert"}
            </Button>
          </div>
        </div>
      }
    >
      <form id="alert-modal-form" onSubmit={submit} noValidate className="flex flex-col gap-2.5">
        {mutation.isError ? (
          <div role="alert" className="rounded-md border border-danger/35 bg-danger-soft px-3 py-2.5 text-[13px]">
            <p className="font-medium text-danger">{existing ? "Could not save the alert" : "Could not create the alert"}</p>
            <p className="mt-0.5 text-muted">{describeError(mutation.error).message}</p>
          </div>
        ) : null}

        {step === 1 ? (
          <>
            <FilterSection id="targets" title="Targets" summary={form.targets.length ? `${form.targets.length}${limits.data ? ` of ${limits.data.maxTargetsPerRule}` : ""}` : undefined} open={openSections.has("targets")} onToggle={toggle} error={errors.targets}>
              {entities.isError ? <ErrorText error={entities.error} /> : null}
              <TargetsEditor
                targets={form.targets}
                onChange={(t) => set("targets", t)}
                entities={entities.data ?? []}
                max={limits.data?.maxTargetsPerRule}
                defaultChain={prefill?.chain ?? prefs.defaultChain}
                error={errors.targets}
              />
            </FilterSection>
            <FilterSection id="direction" title="Direction" summary={DIRECTIONS.find((d) => d.value === form.direction)?.label} open={openSections.has("direction")} onToggle={toggle}>
              <div role="radiogroup" aria-label="Direction" className="flex flex-wrap gap-2">
                {DIRECTIONS.map((d) => (
                  <label
                    key={d.value}
                    className="kit-fade flex cursor-pointer items-center gap-2 rounded-sm border border-border bg-surface px-3 py-1.5 text-[13px] hover:border-border-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
                  >
                    <input type="radio" name="direction" value={d.value} checked={form.direction === d.value} onChange={() => set("direction", d.value)} className="sr-only" />
                    <span className={d.value === "in" ? "text-in" : d.value === "out" ? "text-out" : ""}>{d.label}</span>
                    <span className="text-xs text-muted">{d.help}</span>
                  </label>
                ))}
              </div>
            </FilterSection>
            <FilterSection id="tokens" title="Tokens" summary={form.anyToken ? "Any token" : `${form.tokens.length} selected`} open={openSections.has("tokens")} onToggle={toggle} error={errors.tokens}>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="radio" name="tokens" checked={form.anyToken} onChange={() => set("anyToken", true)} className="accent-[var(--trace-accent)]" />
                  Any token
                </label>
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="radio" name="tokens" checked={!form.anyToken} onChange={() => set("anyToken", false)} className="accent-[var(--trace-accent)]" />
                  Only these tokens
                </label>
              </div>
              {!form.anyToken ? (
                <div className="mt-3 flex flex-col gap-2">
                  {form.tokens.length ? (
                    <ul aria-label="Selected tokens" className="flex flex-wrap gap-1.5">
                      {form.tokens.map((t) => (
                        <li key={t} className="kit-mono inline-flex h-6 items-center gap-1 rounded-sm border border-border pl-2 text-xs">
                          <span className="max-w-64 truncate">{t}</span>
                          <IconButton size="sm" className="size-5" label={`Remove ${t}`} onClick={() => set("tokens", form.tokens.filter((x) => x !== t))}>
                            <X aria-hidden className="size-3" />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex gap-2">
                    <Input
                      aria-label="Token id"
                      className="kit-mono"
                      placeholder="native, ERC-20 contract address or SPL mint"
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
                    <Button onClick={addToken} disabled={!tokenDraft.trim()} icon={<Plus aria-hidden className="size-3.5" />}>
                      Add
                    </Button>
                  </div>
                  <p className="text-xs text-muted">Use "native" for ETH or SOL itself. Token ids are matched exactly as entered.</p>
                </div>
              ) : null}
            </FilterSection>
            <FilterSection id="amount" title="Amount" summary={form.minUsd.trim() ? `USD >= ${form.minUsd.trim()}` : "Any amount"} open={openSections.has("amount")} onToggle={toggle} error={errors.minUsd}>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium">Minimum USD value</span>
                <span className="relative w-56">
                  <span aria-hidden className="kit-mono pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                    $
                  </span>
                  <Input inputMode="decimal" aria-invalid={errors.minUsd ? true : undefined} className="kit-num pl-6" placeholder="Any amount" value={form.minUsd} onChange={(e) => set("minUsd", e.target.value)} />
                </span>
                <span className="text-xs text-muted">Starts at your default USD floor. Transfers without a price source have no USD value and do not pass a minimum.</span>
              </label>
            </FilterSection>
            <FilterSection
              id="network"
              title="Network"
              summary={networks.length ? networks.map((c) => (c === "ethereum" ? "Ethereum" : "Solana")).join(", ") : hasEntity ? "From entity" : "From targets"}
              open={openSections.has("network")}
              onToggle={toggle}
            >
              <p className="text-[13px] text-muted">
                The network comes from each target: an address is watched on the chain it belongs to, and an entity target is watched on every chain its addresses
                are on. OSSTrace watches Ethereum and Solana.
              </p>
            </FilterSection>
          </>
        ) : (
          <div className="flex flex-col gap-6 pt-1">
            <label className="flex flex-col gap-2">
              <span className="flex items-baseline justify-between">
                <span className="kit-panel-title">Alert name</span>
                <span className="kit-mono text-[11px] uppercase tracking-[0.08em] text-muted">Required</span>
              </span>
              <Input
                autoFocus
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? "alert-name-err" : undefined}
                maxLength={ALERT_NAME_MAX + 20}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                className="h-9"
              />
              {errors.name ? (
                <span id="alert-name-err" className="text-xs text-danger">
                  {errors.name}
                </span>
              ) : (
                <span className="text-xs text-muted">Shown on notifications and webhook payloads.</span>
              )}
            </label>
            <fieldset className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <legend className="kit-panel-title">Delivery method</legend>
                <a href="#alerts/manage" className="text-xs font-medium text-accent hover:underline" onClick={() => onOpenChange(false)}>
                  + Webhook
                </a>
              </div>
              <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                <div className="px-3 py-2.5">
                  <Checkbox label="In-app inbox and bell (always on)" checked disabled readOnly />
                </div>
                {methods.isError ? <ErrorText error={methods.error} className="px-3 py-2.5" /> : null}
                {webhooks.map((m) => (
                  <div key={m.id} className="px-3 py-2.5">
                    <Checkbox
                      label={
                        <>
                          {m.name} <span className="kit-mono text-xs text-faint">{m.url}</span>
                          {!m.enabled ? <span className="ml-1.5 text-xs text-warn">disabled, will not deliver</span> : null}
                        </>
                      }
                      checked={form.methodIds.includes(m.id)}
                      onChange={(e) => set("methodIds", e.target.checked ? [...form.methodIds, m.id] : form.methodIds.filter((x) => x !== m.id))}
                    />
                  </div>
                ))}
                {methods.isSuccess && webhooks.length === 0 ? <p className="px-3 py-2.5 text-xs text-muted">No webhooks yet. Email, Telegram and Slack are not available in this version.</p> : null}
              </div>
            </fieldset>
            <section aria-label="Summary" className="rounded-md border border-border bg-surface-2 px-3.5 py-3 text-[13px]">
              <p>{describeRule(form, entities.data, methods.data)}</p>
              <p className="mt-1 text-xs text-muted">{noBackfillNote(limits.data?.pollIntervalSec)}</p>
            </section>
          </div>
        )}
      </form>
    </Dialog>
  );
}

function FilterSection({ id, title, summary, open, onToggle, error, children }: { id: Section; title: string; summary?: string; open: boolean; onToggle: (s: Section) => void; error?: string; children: ReactNode }) {
  const bodyId = `alert-sec-${id}`;
  return (
    <section className={cn("rounded-md border bg-surface", error ? "border-danger/60" : "border-border")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle(id)}
        className="kit-fade flex h-12 w-full items-center gap-3 rounded-md px-4 text-left hover:bg-surface-2"
      >
        <span className="kit-panel-title">{title}</span>
        {error ? <span className="text-xs text-danger">{error}</span> : summary ? <span className="kit-mono ml-auto truncate text-xs text-muted">{summary}</span> : null}
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted transition-transform duration-150", !error && !summary && "ml-auto", error && "ml-auto", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={bodyId} className="border-t border-border px-4 py-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}

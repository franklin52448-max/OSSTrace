import type { Chain, Label } from "@osstrace/contract";
import { detectChain } from "@osstrace/contract";
import { useEffect, useState, type FormEvent } from "react";
import { useCreateLabel, useEntities, useTags, useUpdateLabel } from "./api.ts";
import { isApiError } from "../kit/api.ts";
import { CHAIN_NAMES, validateAddress } from "../kit/validation.ts";
import { Button } from "../kit/Button.tsx";
import { Dialog } from "../kit/Dialog.tsx";
import { Field, Input, Select, Textarea } from "../kit/Field.tsx";
import { ErrorText } from "../kit/QueryState.tsx";
import { useToast } from "../kit/Toast.tsx";
import { TagPicker } from "./parts.tsx";

export const LABEL_NAME_MAX = 200;

export type LabelDialogInitial = { chain?: Chain; address?: string; entityId?: string | null; name?: string };

type Form = { chain: Chain; address: string; name: string; note: string; entityId: string; tagIds: string[] };
type Errors = Partial<Record<"address" | "name" | "note", string>>;

export function validateLabelForm(f: Form): Errors {
  const e: Errors = {};
  const a = validateAddress(f.chain, f.address);
  if (a) e.address = a;
  const name = f.name.trim();
  if (!name) e.name = "Enter a name.";
  else if (name.length > LABEL_NAME_MAX) e.name = `Name must be at most ${LABEL_NAME_MAX} characters.`;
  if (f.note.length > 2000) e.note = "Note must be at most 2000 characters.";
  return e;
}

/**
 * Create or edit a label. `label` switches to edit mode (chain/address fixed); `initial` prefills a new label
 * (used by the explorer quick-label action and the entity "Add address" action).
 */
export function LabelDialog({
  open,
  onOpenChange,
  label,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  label?: Label | null;
  initial?: LabelDialogInitial;
  onSaved?: (l: Label) => void;
}) {
  const entities = useEntities();
  const tags = useTags();
  const create = useCreateLabel();
  const update = useUpdateLabel();
  const toast = useToast();
  const editing = !!label;
  const [form, setForm] = useState<Form>(() => blank(label, initial));
  const [errors, setErrors] = useState<Errors>({});
  const [chainTouched, setChainTouched] = useState(false);
  const mutation = editing ? update : create;

  useEffect(() => {
    if (open) {
      setForm(blank(label, initial));
      setErrors({});
      setChainTouched(!!initial?.chain || editing);
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, label?.id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const onAddress = (v: string) => {
    const detected = detectChain(v);
    setForm((f) => ({ ...f, address: v, chain: !chainTouched && detected ? detected : f.chain }));
  };

  const conflict = isApiError(mutation.error, "conflict");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateLabelForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = {
      name: form.name.trim(),
      note: form.note.trim() || undefined,
      entityId: form.entityId || null,
      tagIds: form.tagIds,
    };
    const done = (l: Label) => {
      toast.success(editing ? "Label saved" : "Label created");
      onSaved?.(l);
      onOpenChange(false);
    };
    if (editing) update.mutate({ id: label!.id, ...body, note: form.note.trim() }, { onSuccess: done });
    else create.mutate({ chain: form.chain, address: form.address.trim(), ...body }, { onSuccess: done });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit label" : "Add new address"}
      description="Labels are private to your account and replace the hash wherever this address appears."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="label-form" variant="primary" loading={mutation.isPending}>
            {editing ? "Save" : "Create label"}
          </Button>
        </>
      }
    >
      <form id="label-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <Field label="Chain">
            {(p) => (
              <Select
                {...p}
                value={form.chain}
                disabled={editing}
                onChange={(e) => {
                  setChainTouched(true);
                  set("chain", e.target.value as Chain);
                }}
              >
                {(Object.keys(CHAIN_NAMES) as Chain[]).map((c) => (
                  <option key={c} value={c}>
                    {CHAIN_NAMES[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Address" error={errors.address ?? (conflict ? "You already have a label for this address. Edit that one instead." : null)}>
            {(p) => (
              <Input
                {...p}
                className="kit-mono"
                value={form.address}
                readOnly={editing}
                spellCheck={false}
                autoComplete="off"
                autoFocus={!editing && !initial?.address}
                onChange={(e) => onAddress(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Name" error={errors.name} help={`Up to ${LABEL_NAME_MAX} characters.`}>
          {(p) => <Input {...p} value={form.name} maxLength={LABEL_NAME_MAX + 20} autoFocus={editing || !!initial?.address} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <Field label="Entity" optional help="Group this address under one of your entities.">
          {(p) => (
            <Select {...p} value={form.entityId} onChange={(e) => set("entityId", e.target.value)}>
              <option value="">No entity</option>
              {(entities.data ?? []).map((en) => (
                <option key={en.id} value={en.id}>
                  {en.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium">
            Tags <span className="ml-1 font-normal text-faint">(optional)</span>
          </span>
          <TagPicker tags={tags.data} value={form.tagIds} onChange={(ids) => set("tagIds", ids)} />
        </div>
        <Field label="Note" optional error={errors.note}>
          {(p) => <Textarea {...p} value={form.note} onChange={(e) => set("note", e.target.value)} />}
        </Field>
        {mutation.isError && !conflict ? <ErrorText error={mutation.error} /> : null}
      </form>
    </Dialog>
  );
}

function blank(label: Label | null | undefined, initial?: LabelDialogInitial): Form {
  if (label) {
    return { chain: label.chain, address: label.address, name: label.name, note: label.note ?? "", entityId: label.entityId ?? "", tagIds: label.tagIds };
  }
  const address = initial?.address ?? "";
  return {
    chain: initial?.chain ?? detectChain(address) ?? "ethereum",
    address,
    name: initial?.name ?? "",
    note: "",
    entityId: initial?.entityId ?? "",
    tagIds: [],
  };
}

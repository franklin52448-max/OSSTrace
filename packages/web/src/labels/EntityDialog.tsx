import type { Entity } from "@osstrace/contract";
import { useEffect, useState, type FormEvent } from "react";
import { useCreateEntity, useTags, useUpdateEntity } from "./api.ts";
import { isApiError } from "../kit/api.ts";
import { Button } from "../kit/Button.tsx";
import { Dialog } from "../kit/Dialog.tsx";
import { Field, Input, Textarea } from "../kit/Field.tsx";
import { ErrorText } from "../kit/QueryState.tsx";
import { useToast } from "../kit/Toast.tsx";
import { isHttpUrl, TagPicker } from "./parts.tsx";

export const ENTITY_TYPES = ["exchange", "fund", "individual", "protocol", "bridge", "mixer", "dao", "market maker", "miner or validator", "scam"];

type Form = { name: string; type: string; website: string; twitter: string; note: string; tagIds: string[] };
type Errors = Partial<Record<keyof Form, string>>;

export function validateEntityForm(f: Form): Errors {
  const e: Errors = {};
  const n = f.name.trim();
  if (!n) e.name = "Enter a name.";
  else if (n.length > 120) e.name = "Name must be at most 120 characters.";
  if (f.type.trim().length > 40) e.type = "Type must be at most 40 characters.";
  if (f.website.trim() && !isHttpUrl(f.website.trim())) e.website = "Use a full http:// or https:// URL.";
  if (f.twitter.trim() && !/^@?[A-Za-z0-9_]{1,15}$/.test(f.twitter.trim())) e.twitter = "Use an X/Twitter handle: letters, digits and underscore, up to 15.";
  return e;
}

export function EntityDialog({ open, onOpenChange, entity, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; entity?: Entity | null; onSaved?: (e: Entity) => void }) {
  const tags = useTags();
  const create = useCreateEntity();
  const update = useUpdateEntity();
  const toast = useToast();
  const m = entity ? update : create;
  const [form, setForm] = useState<Form>(() => blank(entity));
  const [errors, setErrors] = useState<Errors>({});
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (open) {
      setForm(blank(entity));
      setErrors({});
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entity?.id]);

  const conflict = isApiError(m.error, "conflict");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateEntityForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = {
      name: form.name.trim(),
      type: form.type.trim(),
      website: form.website.trim(),
      twitter: form.twitter.trim().replace(/^@/, ""),
      note: form.note.trim(),
      tagIds: form.tagIds,
    };
    const done = (en: Entity) => {
      toast.success(entity ? "Entity saved" : "Entity created");
      onSaved?.(en);
      onOpenChange(false);
    };
    if (entity) update.mutate({ id: entity.id, ...body }, { onSuccess: done });
    else
      create.mutate(
        { name: body.name, type: body.type || undefined, website: body.website || undefined, twitter: body.twitter || undefined, note: body.note || undefined, tagIds: body.tagIds },
        { onSuccess: done },
      );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={entity ? "Edit entity" : "New entity"}
      description="An entity groups addresses that belong to one owner. Its name wins over label names in every view."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="entity-form" variant="primary" loading={m.isPending}>
            {entity ? "Save" : "Create entity"}
          </Button>
        </>
      }
    >
      <form id="entity-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Name" error={errors.name ?? (conflict ? "An entity with this name already exists." : null)}>
          {(p) => <Input {...p} autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <Field label="Type" optional error={errors.type} help="Free text. Pick a suggestion or write your own.">
          {(p) => (
            <>
              <Input {...p} list="entity-type-options" value={form.type} onChange={(e) => set("type", e.target.value)} />
              <datalist id="entity-type-options">
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Website" optional error={errors.website}>
            {(p) => <Input {...p} type="url" inputMode="url" placeholder="https://" value={form.website} onChange={(e) => set("website", e.target.value)} />}
          </Field>
          <Field label="X / Twitter" optional error={errors.twitter}>
            {(p) => <Input {...p} placeholder="@handle" value={form.twitter} onChange={(e) => set("twitter", e.target.value)} />}
          </Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">
            Tags <span className="font-normal text-faint">optional</span>
          </span>
          <TagPicker tags={tags.data} value={form.tagIds} onChange={(ids) => set("tagIds", ids)} />
        </div>
        <Field label="Note" optional>
          {(p) => <Textarea {...p} value={form.note} onChange={(e) => set("note", e.target.value)} />}
        </Field>
        {m.isError && !conflict ? <ErrorText error={m.error} /> : null}
      </form>
    </Dialog>
  );
}

function blank(e: Entity | null | undefined): Form {
  return {
    name: e?.name ?? "",
    type: e?.type ?? "",
    website: e?.website ?? "",
    twitter: e?.twitter ?? "",
    note: e?.note ?? "",
    tagIds: e?.tagIds ?? [],
  };
}

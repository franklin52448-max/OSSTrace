import type { Tag } from "@osstrace/contract";
import { TagChip } from "../kit/TagChip.tsx";

/** Multi-select tags as a checkbox list. Shows a link to the tags tab when none exist. */
export function TagPicker({ tags, value, onChange }: { tags: Tag[] | undefined; value: string[]; onChange: (ids: string[]) => void }) {
  if (!tags) return <p className="text-xs text-muted">Loading tags</p>;
  if (tags.length === 0) {
    return (
      <p className="text-xs text-muted">
        No tags yet.{" "}
        <a href="#labels/tags" className="text-accent underline">
          Create tags
        </a>{" "}
        to group labels.
      </p>
    );
  }
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <fieldset className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
      <legend className="sr-only">Tags</legend>
      {tags.map((t) => {
        const on = value.includes(t.id);
        return (
          <label
            key={t.id}
            className={`kit-fade inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-sm border px-1.5 text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[var(--trace-accent)] ${on ? "border-accent bg-accent-soft text-text" : "border-border text-muted hover:border-border-strong"}`}
          >
            <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(t.id)} />
            <span aria-hidden className="size-2 rounded-[2px]" style={{ background: t.color }} />
            {t.name}
          </label>
        );
      })}
    </fieldset>
  );
}

/** Renders tag chips for ids, skipping ids whose tag was deleted. */
export function TagList({ ids, tags, max = 3 }: { ids: string[]; tags: Map<string, Tag>; max?: number }) {
  const list = ids.map((id) => tags.get(id)).filter((t): t is Tag => !!t);
  if (list.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {list.slice(0, max).map((t) => (
        <TagChip key={t.id} tag={t} />
      ))}
      {list.length > max ? <span className="kit-num text-xs text-muted">+{list.length - max}</span> : null}
    </span>
  );
}

export const byId = <T extends { id: string }>(xs: T[] | undefined) => new Map((xs ?? []).map((x) => [x.id, x]));

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

import type { ImportResult } from "@osstrace/contract";
import { Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useImportLabels } from "./api.ts";
import { IMPORT_COLUMNS, parseLabelsImport, type ImportFormat } from "./labelsImport.ts";
import { Button } from "../kit/Button.tsx";
import { cn } from "../kit/cn.ts";
import { Dialog } from "../kit/Dialog.tsx";
import { Textarea } from "../kit/Field.tsx";
import { formatCount, shortAddress } from "../kit/format.ts";
import { ErrorText } from "../kit/QueryState.tsx";
import { useToast } from "../kit/Toast.tsx";

const PREVIEW_ROWS = 50;
const MAX_BYTES = 5 * 1024 * 1024;

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [formatOverride, setFormatOverride] = useState<ImportFormat | "auto">("auto");
  const [onConflict, setOnConflict] = useState<"update" | "skip">("skip");
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imp = useImportLabels();
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setText("");
      setFileName(null);
      setFormatOverride("auto");
      setFileError(null);
      setResult(null);
      imp.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const preview = useMemo(() => (text.trim() ? parseLabelsImport(text, formatOverride === "auto" ? undefined : formatOverride) : null), [text, formatOverride]);
  const invalid = preview?.rows.filter((r) => r.errors.length > 0).length ?? 0;
  const valid = (preview?.rows.length ?? 0) - invalid;

  const readFile = (f: File) => {
    setFileError(null);
    if (f.size > MAX_BYTES) {
      setFileError("File is larger than 5 MB. Split it and import in parts.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      setFileName(f.name);
      if (/\.json$/i.test(f.name)) setFormatOverride("json");
      else if (/\.csv$/i.test(f.name)) setFormatOverride("csv");
    };
    reader.onerror = () => setFileError("Could not read that file.");
    reader.readAsText(f);
  };

  const submit = () => {
    if (!preview || preview.fatal) return;
    imp.mutate(
      { format: preview.format, data: text, onConflict },
      {
        onSuccess: (r) => {
          setResult(r);
          toast.success(`Imported: ${r.created} created, ${r.updated} updated, ${r.skipped.length} skipped`);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title="Bulk upload labels"
      description={`CSV with a header row (${IMPORT_COLUMNS.join(",")}; tags separated by semicolons) or a JSON array of objects with the same keys. Missing entities and tags are created.`}
      footer={
        result ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={imp.isPending} disabled={!preview || !!preview.fatal || valid === 0} onClick={submit}>
              {valid > 0 ? `Import ${formatCount(valid)} row${valid === 1 ? "" : "s"}` : "Import"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ImportReport result={result} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              className="sr-only"
              aria-label="Choose a CSV or JSON file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
                e.target.value = "";
              }}
            />
            <Button icon={<Upload aria-hidden className="size-3.5" />} onClick={() => fileRef.current?.click()}>
              Choose file
            </Button>
            <span className="kit-mono truncate text-xs text-muted">{fileName ?? "or paste below"}</span>
            <label className="ml-auto inline-flex items-center gap-2 text-[13px]">
              Format
              <select
                value={formatOverride}
                onChange={(e) => setFormatOverride(e.target.value as ImportFormat | "auto")}
                className="kit-select kit-fade h-7 cursor-pointer rounded-sm border border-border bg-surface pl-2 pr-7 text-[13px] hover:border-border-strong"
              >
                <option value="auto">Detect{preview && formatOverride === "auto" ? ` (${preview.format.toUpperCase()})` : ""}</option>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </label>
          </div>
          {fileError ? <p className="text-xs text-danger">{fileError}</p> : null}
          <Textarea
            aria-label="Label data"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFileName(null);
            }}
            spellCheck={false}
            placeholder={`${IMPORT_COLUMNS.join(",")}\nethereum,0x…,Name,Optional note,Entity name,tag one;tag two`}
            className="kit-mono min-h-28 text-xs"
          />
          <fieldset className="flex flex-wrap items-center gap-4 text-[13px]">
            <legend className="sr-only">When an address already has a label</legend>
            <span className="text-muted">When an address already has a label:</span>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="onConflict" className="accent-[var(--trace-accent)]" checked={onConflict === "skip"} onChange={() => setOnConflict("skip")} />
              Keep mine (skip row)
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="onConflict" className="accent-[var(--trace-accent)]" checked={onConflict === "update"} onChange={() => setOnConflict("update")} />
              Overwrite with the file
            </label>
          </fieldset>
          {preview ? <Preview preview={preview} valid={valid} invalid={invalid} /> : null}
          {imp.isError ? <ErrorText error={imp.error} /> : null}
        </div>
      )}
    </Dialog>
  );
}

function Preview({ preview, valid, invalid }: { preview: ReturnType<typeof parseLabelsImport>; valid: number; invalid: number }) {
  if (preview.fatal) return <p className="rounded-md border border-danger/35 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">{preview.fatal}</p>;
  const shown = preview.rows.slice(0, PREVIEW_ROWS);
  return (
    <div className="flex flex-col gap-2">
      <p className="kit-num text-xs text-muted">
        {formatCount(preview.rows.length)} rows · <span className="text-in">{formatCount(valid)} valid</span>
        {invalid ? (
          <>
            {" "}
            · <span className="text-danger">{formatCount(invalid)} with errors (the server will skip them)</span>
          </>
        ) : null}
        {preview.rows.length > PREVIEW_ROWS ? ` · previewing the first ${PREVIEW_ROWS}` : ""}
      </p>
      <div className="max-h-64 overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-xs" aria-label="Import preview">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              {["Row", "Chain", "Address", "Name", "Entity", "Tags", "Check"].map((h) => (
                <th key={h} scope="col" className="kit-colhead h-7 whitespace-nowrap border-b border-border px-2 text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.row} className={cn("border-b border-border align-top", r.errors.length && "bg-danger-soft")}>
                <td className="kit-num px-2 py-1.5 text-muted">{r.row}</td>
                <td className="px-2 py-1.5">{r.chain || "—"}</td>
                <td className="kit-mono whitespace-nowrap px-2 py-1.5" title={r.address}>
                  {r.address ? shortAddress(r.address, 6, 4) : "—"}
                </td>
                <td className="max-w-40 truncate px-2 py-1.5">{r.name || "—"}</td>
                <td className="max-w-32 truncate px-2 py-1.5 text-muted">{r.entity || "—"}</td>
                <td className="max-w-32 truncate px-2 py-1.5 text-muted">{r.tags.join(", ") || "—"}</td>
                <td className="px-2 py-1.5">{r.errors.length ? <span className="text-danger">{r.errors.join(" ")}</span> : <span className="text-in">OK</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImportReport({ result }: { result: ImportResult }) {
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border">
        {[
          ["Created", result.created],
          ["Updated", result.updated],
          ["Skipped", result.skipped.length],
        ].map(([k, v]) => (
          <div key={k} className="bg-surface px-3 py-2">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="kit-num text-base">{formatCount(v as number)}</dd>
          </div>
        ))}
      </dl>
      {result.skipped.length ? (
        <div>
          <p className="mb-1.5 font-medium">Skipped rows</p>
          <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {result.skipped.map((s) => (
              <li key={`${s.row}-${s.reason}`} className="flex gap-3 px-3 py-1.5 text-xs">
                <span className="kit-num w-14 shrink-0 text-muted">row {s.row}</span>
                <span>{s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-muted">Every row was applied.</p>
      )}
    </div>
  );
}

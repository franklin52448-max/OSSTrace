import { useDocumentTitle } from "./hooks.ts";
import { buttonClass } from "./Button.tsx";

export function NotFound({ href = "#", label = "Go home" }: { href?: string; label?: string }) {
  useDocumentTitle("Not found");
  return (
    <div className="px-4 py-10 xl:px-6">
      <div className="kit-panel mx-auto flex max-w-xl flex-col items-center gap-2 px-6 py-12 text-center">
        <h1 className="text-[17px] font-semibold">Nothing at this address</h1>
        <p className="max-w-[48ch] text-[13px] text-muted">The page does not exist, or the item was deleted or belongs to another account.</p>
        <a href={href} className={buttonClass("secondary", "md", "mt-3")}>
          {label}
        </a>
      </div>
    </div>
  );
}

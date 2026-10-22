// React port of Helium Prism's Svelte components (https://github.com/imputnet/helium-prism,
// GPL-3.0-only). Same props and class names as the originals; the scoped Svelte styles live in
// ./prism.css. The GradientShimmer hero effect and the Helium logos are intentionally not ported.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from "react";
import { IconCheck, IconChevronDown, IconCopy, IconExternalLink, IconLink, IconLoader, IconSearch } from "./icons.tsx";

/** Svelte's `class={[...]}` equivalent: joins truthy class names. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  transparent?: boolean;
  card?: boolean;
  selected?: boolean;
  circle?: boolean;
};

export function Button({ className, type = "button", primary, transparent, card, selected, circle, ...rest }: ButtonProps) {
  return (
    <button
      className={cx("button", primary && "primary", card && "card", selected && "selected", circle && "circle", transparent && "transparent", className)}
      type={type}
      {...rest}
    />
  );
}

export function CardLink({ title, desc, href, disabled, className }: { title: string; desc: string; href: string; disabled?: boolean; className?: string }) {
  return (
    <a
      className={cx("button card card-link", disabled && "disabled", className)}
      href={disabled ? undefined : href}
      target="_blank"
      rel="noopener noreferrer"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
    >
      <div className="link-text">
        <h4>{title}</h4>
        <p>{desc}</p>
      </div>
      <IconExternalLink />
    </a>
  );
}

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "checked" | "onChange"> & {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  children?: ReactNode;
};

export function Checkbox({ checked = false, onCheckedChange, children, className, disabled, ...rest }: CheckboxProps) {
  // Mirrors Prism: suppress the background transition for the frame the state flips in.
  const [toggling, setToggling] = useState(false);
  const previous = useRef(checked);
  useEffect(() => {
    if (checked === previous.current) return;
    previous.current = checked;
    setToggling(true);
    const frame = requestAnimationFrame(() => setToggling(false));
    return () => cancelAnimationFrame(frame);
  }, [checked]);

  return (
    <label className={cx("checkbox", disabled && "disabled", toggling && "toggling", className)}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onCheckedChange?.(e.target.checked)} {...rest} />
      <span className="checkbox-control" aria-hidden="true">
        <IconCheck />
      </span>
      {children && <span className="checkbox-content">{children}</span>}
    </label>
  );
}

export function CopyIcon({ check, link = false, className }: { check: boolean; link?: boolean; className?: string }) {
  return (
    <div className={cx("copy-animation", check && "check", className)}>
      <div className="icon-copy">{link ? <IconLink /> : <IconCopy />}</div>
      <div className="icon-check">
        <IconCheck />
      </div>
    </div>
  );
}

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

type DropdownProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "value" | "onChange"> & {
  "aria-label": string;
  value?: string;
  onValueChange?: (value: string) => void;
  options?: readonly DropdownOption[];
  placeholder?: string;
  width?: string;
  selectRef?: Ref<HTMLSelectElement>;
  children?: ReactNode;
};

export function Dropdown({ value = "", onValueChange, options = [], placeholder, width, selectRef, children, className, disabled, ...rest }: DropdownProps) {
  return (
    <label className={cx("dropdown", disabled && "disabled", className)} style={{ width }}>
      <select
        ref={selectRef}
        value={value}
        onChange={(e) => onValueChange?.(e.target.value)}
        className={!value && placeholder ? "placeholder" : undefined}
        disabled={disabled}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled hidden>
            {placeholder}
          </option>
        )}
        {options.length
          ? options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))
          : children}
      </select>
      <span className="dropdown-icon" aria-hidden="true">
        <IconChevronDown />
      </span>
    </label>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "width"> & {
  "aria-label": string;
  small?: boolean;
  width?: string;
  inputRef?: Ref<HTMLInputElement>;
  leading?: ReactNode;
  trailing?: ReactNode;
};

export function Input({ small, width, inputRef, leading, trailing, className, disabled, ...rest }: InputProps) {
  return (
    <label className={cx("input-field", small && "small", disabled && "disabled", className)} style={{ width }}>
      {leading && (
        <span className="input-accessory" aria-hidden="true">
          {leading}
        </span>
      )}
      <input ref={inputRef} disabled={disabled} {...rest} />
      {trailing && (
        <span className="input-accessory" aria-hidden="true">
          {trailing}
        </span>
      )}
    </label>
  );
}

function isExternalHref(href: string): boolean {
  try {
    return new URL(href, location.href).origin !== location.origin;
  } catch {
    return true;
  }
}

export function Link({ href, className, target, rel, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const external = isExternalHref(href);
  return (
    <a
      className={cx("p-link", className)}
      href={href}
      target={external ? (target ?? "_blank") : undefined}
      rel={external ? (rel ?? "noopener noreferrer") : undefined}
      {...rest}
    />
  );
}

export function SearchBar({ width, ...rest }: Omit<InputProps, "type" | "leading">) {
  return (
    <div className="search-bar" style={{ width }} role="search">
      <Input width="100%" type="search" leading={<IconSearch />} {...rest} />
    </div>
  );
}

export function Skeleton({ className, width, height }: { className?: string; width?: string; height?: string }) {
  return <div className={cx("skeleton", className)} style={{ width, height }} />;
}

export function Spinner({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <div className={cx("spinner", className)} style={{ "--size": `${size}px` } as React.CSSProperties}>
      <IconLoader />
    </div>
  );
}

type Variant = "display" | "title" | "heading" | "subheading" | "body" | "caption";
type Tone = "primary" | "secondary" | "tertiary" | "white";
type Tag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span" | "div";

const DEFAULT_TAG: Record<Variant, Tag> = { display: "h1", title: "h2", heading: "h3", subheading: "h4", body: "p", caption: "p" };

export function Text({
  children,
  variant = "body",
  tag,
  tone,
  center,
  className,
}: {
  children: ReactNode;
  variant?: Variant;
  tag?: Tag;
  tone?: Tone;
  center?: boolean;
  className?: string;
}) {
  const Element = tag ?? DEFAULT_TAG[variant];
  return <Element className={cx("text", tone && `tone-${tone}`, center && "center", className)}>{children}</Element>;
}

type ToggleProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "name"> & {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  name?: string;
  desc?: string;
};

export function Toggle({ checked = false, onCheckedChange, name, desc, children, className, type = "button", disabled, onClick, ...rest }: ToggleProps) {
  return (
    <button
      className={cx("button toggle-button card", className)}
      disabled={disabled}
      type={type}
      role="switch"
      aria-checked={checked}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled) return;
        onCheckedChange?.(!checked);
      }}
      {...rest}
    >
      <div className="toggle-text">
        {children ?? (
          <>
            {name && <h4>{name}</h4>}
            {desc && <p>{desc}</p>}
          </>
        )}
      </div>
      <div className={cx("toggle", checked && "enabled")} aria-hidden="true">
        <div className="runner" />
      </div>
    </button>
  );
}

const TOOLTIP_OFFSET_X = 16;
const TOOLTIP_OFFSET_Y = 12;

export function Tooltip({ anchor, content, id }: { anchor: ReactNode; content: ReactNode; id?: string }) {
  const generatedId = useId();
  const tooltipId = id ?? generatedId;
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover?.showPopover) return;
    if (visible) popover.showPopover();
    else if (popover.matches(":popover-open")) popover.hidePopover();
  }, [visible]);

  return (
    <>
      <div
        ref={anchorRef}
        className="tooltip-anchor"
        onPointerMove={(e) => setPosition({ x: e.clientX - TOOLTIP_OFFSET_X, y: e.clientY - TOOLTIP_OFFSET_Y })}
        onPointerEnter={() => setVisible(true)}
        onPointerLeave={() => setVisible(false)}
        onFocus={() => {
          const rect = anchorRef.current?.getBoundingClientRect();
          if (!visible && rect) setPosition({ x: rect.left, y: rect.bottom - TOOLTIP_OFFSET_Y });
          setVisible(true);
        }}
        onBlur={() => setVisible(false)}
        role="group"
        aria-describedby={tooltipId}
      >
        {anchor}
      </div>
      <div ref={popoverRef} popover="manual" className="tooltip-container" role="tooltip" id={tooltipId} style={{ left: position.x, top: position.y }}>
        <div className="tooltip-content">{content}</div>
      </div>
    </>
  );
}

/** Copy-to-clipboard button built from Prism's Button + CopyIcon. */
export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      circle
      transparent
      className={className}
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
    >
      <CopyIcon check={copied} />
    </Button>
  );
}

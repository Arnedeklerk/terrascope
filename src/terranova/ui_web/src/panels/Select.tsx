import { useEffect, useRef, useState } from "react";

/**
 * Lightweight dropdown that renders entirely as React DOM.
 *
 * Why this exists: native ``<select>`` popups are rendered by the host
 * browser's native widget code, and in QtWebEngine on lower-spec
 * Windows machines that pipeline is *slow* — the open animation
 * appears as a white box that visibly expands over hundreds of
 * milliseconds.  A pure-DOM dropdown avoids the native popup
 * pipeline entirely and renders at React-component speed.
 *
 * Behaviour is intentionally minimal: click to open, click an option
 * or click outside / press Esc to close.  Keyboard arrows / type-
 * ahead are not implemented — when needed, swap to Radix Select.
 */

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange(value: string): void;
  options: SelectOption[];
  /** Placeholder shown when ``value`` doesn't match any option. */
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes added to the trigger button — usually width/positioning. */
  className?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "— pick —",
  disabled,
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside-click + Esc.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const display = selected?.label ?? placeholder;

  return (
    <div ref={rootRef} className={"relative " + className}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={
          "w-full bg-bg-1 border border-bg-2 rounded px-2 py-1 text-left " +
          "flex items-center justify-between gap-2 " +
          "disabled:opacity-50 disabled:cursor-not-allowed"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selected ? "" : "text-fg-muted"}>{display}</span>
        <span className="text-fg-muted text-xs shrink-0">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <ul
          role="listbox"
          className={
            "absolute z-30 mt-1 w-full max-h-60 overflow-auto " +
            "bg-bg-1 border border-bg-2 rounded shadow-lg py-1 text-sm"
          }
        >
          {options.length === 0 && (
            <li className="px-2 py-1 text-fg-muted/70 text-xs">
              (no options)
            </li>
          )}
          {options.map((o) => {
            const active = o.value === value;
            return (
              <li
                key={o.value || "_empty_"}
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={
                  "px-2 py-1 cursor-pointer truncate " +
                  (active
                    ? "bg-accent/20 text-fg"
                    : "hover:bg-bg-2 text-fg")
                }
                title={o.label}
              >
                {o.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

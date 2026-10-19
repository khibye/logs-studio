import { useEffect, useRef, useState, type ReactNode } from "react";

/** Small accessible dropdown: a button that toggles a panel; closes on outside click / Escape. */
export function Menu(props: {
  label: ReactNode;
  ariaLabel?: string;
  className?: string;
  align?: "start" | "end";
  onOpen?: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className={props.className ?? "btn"}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={props.ariaLabel}
        onClick={() => {
          if (!open) props.onOpen?.();
          setOpen((v) => !v);
        }}
      >
        {props.label}
      </button>
      {open && <div className={`menu-pop ${props.align === "start" ? "start" : "end"}`}>{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

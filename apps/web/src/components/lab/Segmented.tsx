import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SegOption<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: ReactNode;
  title?: string;
}

/**
 * A segmented single-choice control (radio group semantics: one tab stop, arrow keys move and select).
 * Shared by the Lab and the Outbox; its styles are `.lab-seg*` in lab.css.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  options: ReadonlyArray<SegOption<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    else return;
    e.preventDefault();
    const o = options[next];
    if (!o) return;
    onChange(o.id);
    refs.current[next]?.focus();
  };

  return (
    <div className={`lab-seg ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          className="lab-seg__btn"
          title={o.title}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => move(e, i)}
        >
          {o.icon}
          <span>{o.label}</span>
          {o.count !== undefined ? <span className="lab-seg__n tnum">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

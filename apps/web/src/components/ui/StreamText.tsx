import { useEffect, useRef } from "react";

/**
 * Text that "types itself in": when the new text only EXTENDS what was on screen, just the new characters
 * materialise (blur + fade); when it is a different text altogether (the model's title replaces the local
 * draft) the whole string transitions. Nothing animates on first mount, so a page of existing cards stays calm.
 */
export function StreamText({ text, streaming = false, className }: { text: string; streaming?: boolean; className?: string }) {
  const committed = useRef<string | null>(null);
  const prev = committed.current;
  let stable = text;
  if (prev !== null && prev !== text) stable = prev.length > 0 && text.startsWith(prev) ? prev : "";
  const tail = text.slice(stable.length);

  useEffect(() => {
    committed.current = text;
  });

  return (
    <span className={`${className ?? ""}${streaming && text ? " caret" : ""}`}>
      {stable}
      {tail ? (
        <span key={`${stable.length}:${tail.length}`} className="tok-in">
          {tail}
        </span>
      ) : null}
    </span>
  );
}

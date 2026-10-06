import { Fragment, memo, useMemo } from "react";
import { CheckSquare, Square } from "lucide-react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import { CodeBlock } from "./CodeBlock";

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <Fragment key={i}>{n.v}</Fragment>;
          case "br":
            return <br key={i} />;
          case "code":
            return (
              <code key={i} className="md__code mono">
                {n.v}
              </code>
            );
          case "b":
            return (
              <strong key={i}>
                <Inlines nodes={n.c} />
              </strong>
            );
          case "i":
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            );
          case "a":
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="md__link">
                <Inlines nodes={n.c} />
              </a>
            );
        }
      })}
    </>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "h":
      return (
        <div className={`md__h md__h${b.level}`} role="heading" aria-level={b.level + 2}>
          <Inlines nodes={b.c} />
        </div>
      );
    case "p":
      return (
        <p className="md__p">
          <Inlines nodes={b.c} />
        </p>
      );
    case "ul":
      return (
        <ul className="md__ul">
          {b.items.map((it, i) => (
            <li key={i} className={it.checked === undefined ? undefined : "md__task"}>
              {it.checked === undefined ? null : it.checked ? <CheckSquare size={14} aria-label="done" /> : <Square size={14} aria-label="to do" />}
              <span>
                <Inlines nodes={it.c} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="md__ol">
          {b.items.map((it, i) => (
            <li key={i}>
              <Inlines nodes={it.c} />
            </li>
          ))}
        </ol>
      );
    case "code":
      return <CodeBlock code={b.v} language={b.lang} maxHeight="14rem" />;
    case "quote":
      return (
        <blockquote className="md__quote">
          <Inlines nodes={b.c} />
        </blockquote>
      );
    case "hr":
      return <hr className="md__hr" />;
  }
}

/** Renders issue-style markdown as React nodes (never as HTML). Safe on partial, still-streaming input. */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="md">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
});

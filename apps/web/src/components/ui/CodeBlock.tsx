import { memo, useMemo } from "react";
import { tokenize } from "@/lib/highlight";
import { CopyButton } from "./CopyButton";

/** Monospace block with a language label, a copy button and light syntax highlighting. */
export const CodeBlock = memo(function CodeBlock({ code, language, streaming = false, maxHeight = "20rem" }: { code: string; language?: string; streaming?: boolean; maxHeight?: string }) {
  const tokens = useMemo(() => tokenize(code, language), [code, language]);
  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span className="codeblock__lang mono">{language || "code"}</span>
        <CopyButton text={code} disabled={!code} />
      </div>
      <pre className="codeblock__pre mono" style={{ maxHeight }} tabIndex={0} aria-label={`${language || "code"} snippet`}>
        <code className={streaming ? "caret" : undefined}>
          {tokens.map((t, i) => (
            <span key={i} className={`tk-${t.kind}`}>
              {t.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
});

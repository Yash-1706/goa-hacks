import { useId, useState } from "react";
import { motion } from "motion/react";
import { Check, X } from "lucide-react";
import type { ArtifactView } from "@synapse/shared";
import { EDIT_FIELDS, buildPatch, fieldToText, type EditField } from "@/lib/artifacts";

/** Inline editor for the artifact's fields. Saves a PATCH that the server merges into the payload. */
export function EditPanel({ artifact, onSave, onCancel }: { artifact: ArtifactView; onSave: (patch: Record<string, unknown>) => void; onCancel: () => void }) {
  const fields = EDIT_FIELDS[artifact.kind] ?? [];
  const payload = artifact.payload as unknown as Record<string, unknown>;
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, fieldToText(f, payload)])));
  const uid = useId();
  const patch = buildPatch(artifact.kind, form, payload);
  const dirty = Object.keys(patch).length > 0;

  const set = (k: string, v: string): void => setForm((s) => ({ ...s, [k]: v }));

  const control = (f: EditField) => {
    const id = `${uid}-${f.key}`;
    const v = form[f.key] ?? "";
    switch (f.kind) {
      case "textarea":
      case "list":
      case "code":
        return <textarea id={id} className={`input${f.kind === "code" ? " mono" : ""}`} rows={f.kind === "list" ? 3 : 5} value={v} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} spellCheck={f.kind !== "code"} />;
      case "select":
        return (
          <select id={id} className="input" value={v} onChange={(e) => set(f.key, e.target.value)}>
            {f.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      case "datetime":
        return <input id={id} type="datetime-local" className="input" value={v} onChange={(e) => set(f.key, e.target.value)} />;
      default:
        return <input id={id} type="text" className="input" value={v} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />;
    }
  };

  return (
    <motion.form
      className="edit"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 40 }}
      style={{ overflow: "hidden" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) onSave(patch);
        else onCancel();
      }}
    >
      <div className="edit__inner">
        {fields.map((f) => (
          <label key={f.key} className="edit__field" htmlFor={`${uid}-${f.key}`}>
            <span className="edit__label">{f.label}</span>
            {control(f)}
          </label>
        ))}
        <div className="edit__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            <X size={13} /> Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty}>
            <Check size={13} /> Save changes
          </button>
        </div>
      </div>
    </motion.form>
  );
}

// node:sqlite is "experimental" on Node 25 and prints a warning on first load.
// It is the zero-install-risk SQLite binding (no native build), so we silence only that warning.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const name = typeof args[0] === "string" ? args[0] : (args[0] as { type?: string } | undefined)?.type;
  const msg = typeof warning === "string" ? warning : warning?.message;
  if (name === "ExperimentalWarning" && typeof msg === "string" && /sqlite/i.test(msg)) return;
  return (original as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

export {};

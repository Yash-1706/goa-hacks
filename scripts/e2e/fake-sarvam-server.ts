// The test suite's faithful fake of Sarvam's POST /speech-to-text, as a standalone server for end-to-end runs without a key.
// What it "hears" is FAKE_SARVAM_TEXT ("|"-separated: one per request, the last one repeats), whatever the audio says.
// usage: FAKE_SARVAM_TEXT="..." pnpm --filter @synapse/server exec tsx ../../scripts/e2e/fake-sarvam-server.ts
import { startFakeSarvam } from "../../apps/server/test/fake-sarvam";

const key = process.env.FAKE_SARVAM_KEY ?? "sk_fake_sarvam_e2e";
const texts = (process.env.FAKE_SARVAM_TEXT ?? "hello from the fake sarvam").split("|");
const fake = await startFakeSarvam({ key, initial: texts.map((transcript) => ({ kind: "ok" as const, transcript, language_code: "en-IN" })) });
console.log(`FAKE_SARVAM_URL=${fake.url}`);
setInterval(() => {
  const n = fake.requests.length;
  if (n) console.log(`requests=${n} last=${JSON.stringify(fake.requests.at(-1)?.wav)}`);
}, 10_000).unref?.();
process.on("SIGTERM", () => void fake.close().then(() => process.exit(0)));
await new Promise(() => undefined);

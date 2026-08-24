// Reference capability adapter (Node). Implements the protocol decision rules from the
// published contract alone. Must agree with the Python and Go adapters; any disagreement
// means the contract is not language-neutral and ARC-006 is unmet.
import { readFileSync } from "node:fs";

interface Contract {
  readonly supportedMajors: readonly number[];
  readonly requiredManifestKeys: readonly string[];
  readonly audience: string;
}
interface Case {
  readonly name: string;
  readonly kind: string;
  readonly now: number;
  readonly payload?: Record<string, unknown>;
}
interface Verdict { case: string; accepted: boolean; code: string | null }

const contractPath = process.argv[2] as string;
const corpusPath = process.argv[3] as string;
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Contract;
const corpus = (JSON.parse(readFileSync(corpusPath, "utf8")) as { cases: Case[] }).cases;

function decide(item: Case): string | null {
  const payload = item.payload ?? {};
  const version = payload.contractVersion as { major?: unknown } | undefined;
  if (!version || typeof version.major !== "number") return "MALFORMED_MANIFEST";
  if (!contract.supportedMajors.includes(version.major)) return "UNSUPPORTED_CONTRACT_VERSION";
  if (item.kind === "manifest") {
    for (const key of contract.requiredManifestKeys) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return "MALFORMED_MANIFEST";
    }
    const signature = payload.signature;
    if (typeof signature !== "string" || signature.length === 0) return "UNSIGNED_MANIFEST";
  }
  if (item.kind === "principal") {
    if (payload.aud !== contract.audience) return "UNAUTHORIZED_CAPABILITY";
    const exp = payload.exp;
    if (typeof exp !== "number" || exp <= item.now) return "UNAUTHORIZED_CAPABILITY";
  }
  return null;
}

const out: Verdict[] = corpus.map((item) => {
  const code = decide(item);
  return { case: item.name, accepted: code === null, code };
});
process.stdout.write(JSON.stringify(out));

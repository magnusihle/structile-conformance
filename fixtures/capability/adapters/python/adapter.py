"""Reference capability adapter (Python). Mirrors the Node and Go adapters."""
import json
import sys

contract_path, corpus_path = sys.argv[1], sys.argv[2]
with open(contract_path, encoding="utf-8") as handle:
    contract = json.load(handle)
with open(corpus_path, encoding="utf-8") as handle:
    corpus = json.load(handle)["cases"]


def decide(item):
    payload = item.get("payload") or {}
    version = payload.get("contractVersion")
    if not isinstance(version, dict) or not isinstance(version.get("major"), int) or isinstance(version.get("major"), bool):
        return "MALFORMED_MANIFEST"
    if version["major"] not in contract["supportedMajors"]:
        return "UNSUPPORTED_CONTRACT_VERSION"
    if item.get("kind") == "manifest":
        for key in contract["requiredManifestKeys"]:
            if key not in payload:
                return "MALFORMED_MANIFEST"
        signature = payload.get("signature")
        if not isinstance(signature, str) or signature == "":
            return "UNSIGNED_MANIFEST"
    if item.get("kind") == "principal":
        if payload.get("aud") != contract["audience"]:
            return "UNAUTHORIZED_CAPABILITY"
        exp = payload.get("exp")
        if not isinstance(exp, int) or isinstance(exp, bool) or exp <= item["now"]:
            return "UNAUTHORIZED_CAPABILITY"
    return None


out = []
for entry in corpus:
    code = decide(entry)
    out.append({"case": entry["name"], "accepted": code is None, "code": code})
sys.stdout.write(json.dumps(out, separators=(",", ":")))

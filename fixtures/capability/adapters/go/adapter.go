// Reference capability adapter (Go). Mirrors the Node and Python adapters.
package main

import (
	"encoding/json"
	"os"
)

type contractDoc struct {
	SupportedMajors      []int    `json:"supportedMajors"`
	RequiredManifestKeys []string `json:"requiredManifestKeys"`
	Audience             string   `json:"audience"`
}

type caseDoc struct {
	Name    string                 `json:"name"`
	Kind    string                 `json:"kind"`
	Now     int64                  `json:"now"`
	Payload map[string]interface{} `json:"payload"`
}

type verdict struct {
	Case     string  `json:"case"`
	Accepted bool    `json:"accepted"`
	Code     *string `json:"code"`
}

func code(value string) *string { return &value }

func decide(contract contractDoc, item caseDoc) *string {
	payload := item.Payload
	if payload == nil {
		return code("MALFORMED_MANIFEST")
	}
	rawVersion, ok := payload["contractVersion"].(map[string]interface{})
	if !ok {
		return code("MALFORMED_MANIFEST")
	}
	majorFloat, ok := rawVersion["major"].(float64)
	if !ok {
		return code("MALFORMED_MANIFEST")
	}
	supported := false
	for _, candidate := range contract.SupportedMajors {
		if candidate == int(majorFloat) {
			supported = true
		}
	}
	if !supported {
		return code("UNSUPPORTED_CONTRACT_VERSION")
	}
	if item.Kind == "manifest" {
		for _, key := range contract.RequiredManifestKeys {
			if _, present := payload[key]; !present {
				return code("MALFORMED_MANIFEST")
			}
		}
		signature, ok := payload["signature"].(string)
		if !ok || signature == "" {
			return code("UNSIGNED_MANIFEST")
		}
	}
	if item.Kind == "principal" {
		audience, _ := payload["aud"].(string)
		if audience != contract.Audience {
			return code("UNAUTHORIZED_CAPABILITY")
		}
		exp, ok := payload["exp"].(float64)
		if !ok || int64(exp) <= item.Now {
			return code("UNAUTHORIZED_CAPABILITY")
		}
	}
	return nil
}

func main() {
	contractBytes, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	corpusBytes, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	var contract contractDoc
	if err := json.Unmarshal(contractBytes, &contract); err != nil {
		panic(err)
	}
	var corpus struct {
		Cases []caseDoc `json:"cases"`
	}
	if err := json.Unmarshal(corpusBytes, &corpus); err != nil {
		panic(err)
	}
	out := make([]verdict, 0, len(corpus.Cases))
	for _, item := range corpus.Cases {
		result := decide(contract, item)
		out = append(out, verdict{Case: item.Name, Accepted: result == nil, Code: result})
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		panic(err)
	}
	os.Stdout.Write(encoded)
}

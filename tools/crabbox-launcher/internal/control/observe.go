package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type StateObservation struct {
	SchemaVersion int            `json:"schemaVersion"`
	AccountID     string         `json:"accountId"`
	WorkerName    string         `json:"workerName"`
	ObservedAt    time.Time      `json:"observedAt"`
	Surfaces      map[string]any `json:"surfaces"`
	IdentitySet   []string       `json:"identitySet"`
}

func (observation StateObservation) Digests() (string, string, error) {
	copy := observation
	copy.ObservedAt = time.Time{}
	data, err := json.Marshal(copy)
	if err != nil {
		return "", "", err
	}
	identities, err := json.Marshal(observation.IdentitySet)
	if err != nil {
		return "", "", err
	}
	return SHA256(data), SHA256(identities), nil
}

type StateObserver interface {
	Observe(context.Context, []byte, time.Time) (StateObservation, error)
}

type CloudflareObserver struct {
	AccountID string
	Client    *http.Client
}

type cloudflareEnvelope struct {
	Success    bool            `json:"success"`
	Result     json.RawMessage `json:"result"`
	Errors     json.RawMessage `json:"errors,omitempty"`
	Messages   json.RawMessage `json:"messages,omitempty"`
	ResultInfo json.RawMessage `json:"result_info,omitempty"`
}

func (observer CloudflareObserver) Observe(ctx context.Context, credential []byte, now time.Time) (StateObservation, error) {
	if !identifierPattern.MatchString(observer.AccountID) || len(credential) == 0 {
		return StateObservation{}, errors.New("E_OBSERVER_IDENTITY")
	}
	base := "/client/v4/accounts/" + observer.AccountID
	script := base + "/workers/scripts/" + WorkerName
	paths := map[string]string{
		"accountWorkers":    base + "/workers/scripts?page=1&per_page=1000",
		"accountWorkersDev": base + "/workers/subdomain",
		"durableObjects":    base + "/workers/durable_objects/namespaces?page=1&per_page=1000",
		"scriptDomains":     base + "/workers/domains?page=1&per_page=1000",
		"scriptDeployments": script + "/deployments?page=1&per_page=1000",
		"scriptSchedules":   script + "/schedules",
		"scriptSecrets":     script + "/secrets?page=1&per_page=1000",
		"scriptSettings":    script + "/script-settings",
		"scriptTails":       script + "/tails",
		"scriptWorkersDev":  script + "/subdomain",
		"scriptVersions":    base + "/workers/workers/" + WorkerName + "/versions?page=1&per_page=1000",
	}
	client := observer.Client
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	surfaces := make(map[string]any, len(paths))
	for name, path := range paths {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.cloudflare.com"+path, nil)
		if err != nil {
			return StateObservation{}, errors.New("E_OBSERVER_REQUEST")
		}
		request.Header.Set("Authorization", "Bearer "+string(credential))
		request.Header.Set("Accept", "application/json")
		response, err := client.Do(request)
		if err != nil {
			return StateObservation{}, errors.New("E_OBSERVER_UNAVAILABLE")
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
		response.Body.Close()
		if readErr != nil || len(body) > 1<<20 {
			return StateObservation{}, errors.New("E_OBSERVER_OUTPUT")
		}
		if response.StatusCode == http.StatusNotFound {
			surfaces[name] = map[string]any{"absent": true}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return StateObservation{}, errors.New("E_OBSERVER_FAILURE")
		}
		var envelope cloudflareEnvelope
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&envelope); err != nil || decoder.Decode(&struct{}{}) != io.EOF || !envelope.Success || len(envelope.Result) == 0 {
			return StateObservation{}, errors.New("E_OBSERVER_ENVELOPE")
		}
		if len(envelope.ResultInfo) > 0 && string(envelope.ResultInfo) != "null" {
			var page struct {
				TotalPages int `json:"total_pages"`
			}
			if err := json.Unmarshal(envelope.ResultInfo, &page); err != nil || page.TotalPages > 1 {
				return StateObservation{}, errors.New("E_OBSERVER_PAGINATION")
			}
		}
		var value any
		decoder = json.NewDecoder(bytes.NewReader(envelope.Result))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
			return StateObservation{}, errors.New("E_OBSERVER_SCHEMA")
		}
		surfaces[name] = canonicalizeJSON(value)
	}
	identities := []string{}
	collectIdentities(surfaces, "", &identities)
	sort.Strings(identities)
	return StateObservation{SchemaVersion: SchemaVersion, AccountID: observer.AccountID, WorkerName: WorkerName, ObservedAt: now, Surfaces: surfaces, IdentitySet: identities}, nil
}

func canonicalizeJSON(value any) any {
	switch item := value.(type) {
	case []any:
		for index := range item {
			item[index] = canonicalizeJSON(item[index])
		}
		sort.Slice(item, func(left, right int) bool {
			leftData, _ := json.Marshal(item[left])
			rightData, _ := json.Marshal(item[right])
			return string(leftData) < string(rightData)
		})
		return item
	case map[string]any:
		for key, child := range item {
			item[key] = canonicalizeJSON(child)
		}
		return item
	default:
		return value
	}
}

func collectIdentities(value any, path string, output *[]string) {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			next := strings.TrimPrefix(path+"/"+key, "/")
			lower := strings.ToLower(key)
			if lower == "id" || strings.HasSuffix(lower, "_id") || strings.HasSuffix(lower, "id") || lower == "tag" || strings.HasSuffix(lower, "version") {
				switch scalar := child.(type) {
				case string:
					*output = append(*output, fmt.Sprintf("%s=%s", next, scalar))
				case json.Number:
					*output = append(*output, fmt.Sprintf("%s=%s", next, scalar.String()))
				}
			}
			collectIdentities(child, next, output)
		}
	case []any:
		for index, child := range item {
			collectIdentities(child, fmt.Sprintf("%s/%d", path, index), output)
		}
	}
}

func ValidateTerminalObservation(plan Plan, state StateObservation) error {
	if state.AccountID != plan.AccountID || state.WorkerName != plan.WorkerName {
		return errors.New("E_TERMINAL_STATE_IDENTITY")
	}
	if plan.Kind == "retire" {
		for _, surface := range []string{"scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "scriptTails", "scriptWorkersDev", "scriptVersions"} {
			if !surfaceAbsent(state.Surfaces[surface]) {
				return errors.New("E_RETIREMENT_CLOUDFLARE_NOT_ABSENT")
			}
		}
		return nil
	}
	for _, surface := range []string{"scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "scriptWorkersDev", "scriptVersions"} {
		if surfaceAbsent(state.Surfaces[surface]) {
			return errors.New("E_DEPLOYMENT_STATE_ABSENT")
		}
	}
	for _, required := range []string{"HETZNER_TOKEN", "CRABBOX_SHARED_TOKEN", "CRABBOX_ADMIN_TOKEN"} {
		if !containsScalar(state.Surfaces["scriptSecrets"], required) {
			return errors.New("E_DEPLOYMENT_SECRET_STATE")
		}
	}
	if !containsScalar(state.Surfaces["scriptSchedules"], "*/15 * * * *") || !containsScalar(state.Surfaces, "FLEET") || !containsScalar(state.Surfaces, "FleetDurableObject") || (plan.DurableObjectNamespaceID != "absent" && !containsScalar(state.Surfaces, plan.DurableObjectNamespaceID)) || !containsScalar(state.Surfaces["scriptWorkersDev"], true) {
		return errors.New("E_DEPLOYMENT_PROFILE_STATE")
	}
	if !collectionEmpty(state.Surfaces["scriptTails"]) || unsafeDiagnosticSettings(state.Surfaces["scriptSettings"]) {
		return errors.New("E_DEPLOYMENT_DIAGNOSTIC_MUTATION")
	}
	for key, expected := range map[string]string{
		"AGENTSCOPE_CRABBOX_ENVIRONMENT_ID":   plan.EnvironmentID,
		"CRABBOX_DEFAULT_ORG":                 "agentscope-development",
		"CRABBOX_MAX_ACTIVE_LEASES":           "4",
		"CRABBOX_MAX_ACTIVE_LEASES_PER_ORG":   "4",
		"CRABBOX_MAX_ACTIVE_LEASES_PER_OWNER": "4",
		"CRABBOX_MAX_MONTHLY_USD":             "25",
		"CRABBOX_MAX_MONTHLY_USD_PER_ORG":     "25",
		"CRABBOX_MAX_MONTHLY_USD_PER_OWNER":   "25",
		"CRABBOX_RUN_RETENTION_DAYS":          "30",
		"CRABBOX_SHARED_OWNER":                "agentscope-fleet-control",
	} {
		if !containsKeyValue(state.Surfaces, key, expected) {
			return errors.New("E_DEPLOYMENT_VARIABLE_STATE")
		}
	}
	if containsScalar(state.Surfaces["scriptDomains"], WorkerName) {
		return errors.New("E_DEPLOYMENT_DOMAIN_STATE")
	}
	return nil
}

func surfaceAbsent(value any) bool {
	item, ok := value.(map[string]any)
	if !ok {
		return value == nil
	}
	absent, _ := item["absent"].(bool)
	return absent
}

func containsScalar(value any, expected any) bool {
	if value == nil {
		return false
	}
	switch item := value.(type) {
	case map[string]any:
		for _, child := range item {
			if containsScalar(child, expected) {
				return true
			}
		}
	case []any:
		for _, child := range item {
			if containsScalar(child, expected) {
				return true
			}
		}
	default:
		return fmt.Sprint(item) == fmt.Sprint(expected)
	}
	return false
}

func collectionEmpty(value any) bool {
	switch item := value.(type) {
	case []any:
		return len(item) == 0
	case map[string]any:
		if surfaceAbsent(item) {
			return true
		}
		return len(item) == 0
	default:
		return value == nil
	}
}

func unsafeDiagnosticSettings(value any) bool {
	settings, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if logpush, ok := settings["logpush"].(bool); ok && logpush {
		return true
	}
	if consumers, exists := settings["tail_consumers"]; exists && !collectionEmpty(consumers) {
		return true
	}
	if observability, ok := settings["observability"].(map[string]any); ok {
		if enabled, ok := observability["enabled"].(bool); ok && enabled {
			return true
		}
	}
	return false
}

func containsKeyValue(value any, key, expected string) bool {
	switch item := value.(type) {
	case map[string]any:
		if child, exists := item[key]; exists && fmt.Sprint(child) == expected {
			return true
		}
		for _, child := range item {
			if containsKeyValue(child, key, expected) {
				return true
			}
		}
	case []any:
		for _, child := range item {
			if containsKeyValue(child, key, expected) {
				return true
			}
		}
	}
	return false
}

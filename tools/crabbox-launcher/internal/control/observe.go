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
	type surfaceRequest struct {
		path      string
		paginated bool
	}
	paths := map[string]surfaceRequest{
		"accountWorkers":    {base + "/workers/scripts", false},
		"accountWorkersDev": {base + "/workers/subdomain", false},
		"durableObjects":    {base + "/workers/durable_objects/namespaces?page=1&per_page=1000", true},
		"scriptDomains":     {base + "/workers/domains", false},
		"scriptDeployments": {script + "/deployments", false},
		"scriptSchedules":   {script + "/schedules", false},
		"scriptSecrets":     {script + "/secrets", false},
		"scriptSettings":    {script + "/script-settings", false},
		"workerSettings":    {script + "/settings", false},
		"scriptTails":       {script + "/tails", false},
		"scriptWorkersDev":  {script + "/subdomain", false},
		"scriptVersions":    {base + "/workers/workers/" + WorkerName + "/versions?page=1&per_page=1000", true},
	}
	client := observer.Client
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	safeClient := *client
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("E_OBSERVER_REDIRECT") }
	surfaces := make(map[string]any, len(paths))
	for name, surface := range paths {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.cloudflare.com"+surface.path, nil)
		if err != nil {
			return StateObservation{}, errors.New("E_OBSERVER_REQUEST")
		}
		request.Header.Set("Authorization", "Bearer "+string(credential))
		request.Header.Set("Accept", "application/json")
		response, err := safeClient.Do(request)
		if err != nil {
			return StateObservation{}, errors.New("E_OBSERVER_UNAVAILABLE")
		}
		if response.Request != nil && (response.Request.URL.Scheme != "https" || response.Request.URL.Host != "api.cloudflare.com") {
			response.Body.Close()
			return StateObservation{}, errors.New("E_OBSERVER_ORIGIN")
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
		if surface.paginated && (len(envelope.ResultInfo) == 0 || string(envelope.ResultInfo) == "null") {
			return StateObservation{}, errors.New("E_OBSERVER_PAGINATION")
		}
		if len(envelope.ResultInfo) > 0 && string(envelope.ResultInfo) != "null" {
			var page struct {
				Page       int `json:"page"`
				TotalPages int `json:"total_pages"`
			}
			if err := json.Unmarshal(envelope.ResultInfo, &page); err != nil || (surface.paginated && (page.Page != 1 || page.TotalPages != 1)) || page.TotalPages > 1 {
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
	if plan.Kind == "account-workers-dev-enable" {
		if len(plan.Operations) != 1 || plan.Operations[0].Subdomain == nil || mapString(state.Surfaces["accountWorkersDev"], "subdomain") != *plan.Operations[0].Subdomain {
			return errors.New("E_ACCOUNT_WORKERS_DEV_NOT_OBSERVED")
		}
		return nil
	}
	if plan.Kind == "retire" {
		if workerPresent(state.Surfaces["accountWorkers"]) || ownedDurableObjectPresent(state.Surfaces["durableObjects"], plan) || ownedDomainPresent(state.Surfaces["scriptDomains"]) {
			return errors.New("E_RETIREMENT_ACCOUNT_RESOURCE_PRESENT")
		}
		for _, surface := range []string{"scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "scriptTails", "scriptWorkersDev", "scriptVersions"} {
			if !surfaceAbsent(state.Surfaces[surface]) && !collectionEmpty(state.Surfaces[surface]) {
				return errors.New("E_RETIREMENT_CLOUDFLARE_NOT_ABSENT")
			}
		}
		return nil
	}
	if !workerPresent(state.Surfaces["accountWorkers"]) || !ownedDurableObjectPresent(state.Surfaces["durableObjects"], plan) || ownedDomainPresent(state.Surfaces["scriptDomains"]) {
		return errors.New("E_DEPLOYMENT_ACCOUNT_RESOURCE_STATE")
	}
	for _, surface := range []string{"scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "scriptWorkersDev", "scriptVersions"} {
		if surfaceAbsent(state.Surfaces[surface]) {
			return errors.New("E_DEPLOYMENT_STATE_ABSENT")
		}
	}
	for _, required := range []string{"HETZNER_TOKEN", "CRABBOX_SHARED_TOKEN", "CRABBOX_ADMIN_TOKEN"} {
		if !namedObjectPresent(state.Surfaces["scriptSecrets"], "name", required) {
			return errors.New("E_DEPLOYMENT_SECRET_STATE")
		}
	}
	if !objectHasKeyValue(state.Surfaces["scriptSchedules"], "cron", "*/15 * * * *") || !bindingPresent(state.Surfaces["workerSettings"], "FLEET", "FleetDurableObject", plan.DurableObjectNamespaceID) || !mapBool(state.Surfaces["scriptWorkersDev"], "enabled") {
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
		if !plainTextBindingPresent(state.Surfaces["workerSettings"], key, expected) {
			return errors.New("E_DEPLOYMENT_VARIABLE_STATE")
		}
	}
	return nil
}

func ValidateActionTransition(plan Plan, operation Operation, before, after StateObservation) error {
	beforeUnrelated, err := unrelatedProjectionDigest(before, plan, operation.Action)
	if err != nil {
		return err
	}
	afterUnrelated, err := unrelatedProjectionDigest(after, plan, operation.Action)
	if err != nil || beforeUnrelated != afterUnrelated {
		return errors.New("E_UNRELATED_RESOURCE_DRIFT")
	}
	switch operation.Action {
	case "worker.secret.put":
		if operation.SecretName == nil || !namedObjectPresent(after.Surfaces["scriptSecrets"], "name", *operation.SecretName) {
			return errors.New("E_SECRET_WRITE_NOT_OBSERVED")
		}
		if namedObjectPresent(before.Surfaces["scriptSecrets"], "name", *operation.SecretName) {
			return errors.New("E_WRITE_ONLY_ROTATION_UNCERTAIN")
		}
	case "worker.secret.delete":
		if operation.SecretName == nil || namedObjectPresent(after.Surfaces["scriptSecrets"], "name", *operation.SecretName) {
			return errors.New("E_SECRET_DELETE_NOT_OBSERVED")
		}
	case "worker.deploy":
		if !workerPresent(after.Surfaces["accountWorkers"]) || surfaceAbsent(after.Surfaces["scriptDeployments"]) {
			return errors.New("E_DEPLOY_NOT_OBSERVED")
		}
	case "worker.rollback":
		if operation.VersionID == nil || !containsIdentityOnSurface(after.Surfaces["scriptDeployments"], *operation.VersionID) {
			return errors.New("E_ROLLBACK_NOT_OBSERVED")
		}
	case "worker.schedule.delete":
		if !collectionEmpty(after.Surfaces["scriptSchedules"]) {
			return errors.New("E_SCHEDULE_DELETE_NOT_OBSERVED")
		}
	case "worker.scriptWorkersDev.disable":
		if !surfaceAbsent(after.Surfaces["scriptWorkersDev"]) && mapBool(after.Surfaces["scriptWorkersDev"], "enabled") {
			return errors.New("E_WORKERS_DEV_DISABLE_NOT_OBSERVED")
		}
	case "worker.terminalArtifact.deploy":
		if !workerPresent(after.Surfaces["accountWorkers"]) || bindingPresent(after.Surfaces["workerSettings"], "FLEET", "FleetDurableObject", plan.DurableObjectNamespaceID) {
			return errors.New("E_TERMINAL_DEPLOY_NOT_OBSERVED")
		}
	case "worker.version.delete":
		if operation.VersionID == nil || containsIdentityOnSurface(after.Surfaces["scriptVersions"], *operation.VersionID) {
			return errors.New("E_VERSION_DELETE_NOT_OBSERVED")
		}
	case "worker.delete":
		if workerPresent(after.Surfaces["accountWorkers"]) {
			return errors.New("E_WORKER_DELETE_NOT_OBSERVED")
		}
	case "account.workersDev.enable":
		if operation.Subdomain == nil || mapString(after.Surfaces["accountWorkersDev"], "subdomain") != *operation.Subdomain {
			return errors.New("E_ACCOUNT_WORKERS_DEV_NOT_OBSERVED")
		}
	default:
		return errors.New("E_ACTION_TRANSITION_UNKNOWN")
	}
	return nil
}

func unrelatedProjectionDigest(state StateObservation, plan Plan, action string) (string, error) {
	projection := map[string]any{
		"accountWorkers": filterObjects(state.Surfaces["accountWorkers"], func(item map[string]any) bool { return objectMatchesWorker(item) }),
		"durableObjects": filterObjects(state.Surfaces["durableObjects"], func(item map[string]any) bool { return objectMatchesDurableObject(item, plan) }),
		"scriptDomains":  filterObjects(state.Surfaces["scriptDomains"], objectMatchesWorkerDomain),
	}
	if action != "account.workersDev.enable" {
		projection["accountWorkersDev"] = state.Surfaces["accountWorkersDev"]
	}
	data, err := json.Marshal(canonicalizeJSON(projection))
	if err != nil {
		return "", err
	}
	return SHA256(data), nil
}

func objectSlice(value any) []map[string]any {
	if wrapper, ok := value.(map[string]any); ok {
		for _, key := range []string{"deployments", "schedules", "items"} {
			if nested, exists := wrapper[key]; exists {
				return objectSlice(nested)
			}
		}
	}
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	for _, value := range items {
		if item, ok := value.(map[string]any); ok {
			result = append(result, item)
		}
	}
	return result
}

func filterObjects(value any, owned func(map[string]any) bool) []any {
	result := []any{}
	for _, item := range objectSlice(value) {
		if !owned(item) {
			result = append(result, item)
		}
	}
	return result
}

func objectMatchesWorker(item map[string]any) bool {
	return fmt.Sprint(item["id"]) == WorkerName || fmt.Sprint(item["name"]) == WorkerName
}

func workerPresent(value any) bool {
	for _, item := range objectSlice(value) {
		if objectMatchesWorker(item) {
			return true
		}
	}
	return false
}

func objectMatchesDurableObject(item map[string]any, plan Plan) bool {
	return (plan.DurableObjectNamespaceID != "absent" && fmt.Sprint(item["id"]) == plan.DurableObjectNamespaceID) || (fmt.Sprint(item["script"]) == WorkerName && fmt.Sprint(item["class"]) == "FleetDurableObject")
}

func ownedDurableObjectPresent(value any, plan Plan) bool {
	for _, item := range objectSlice(value) {
		if objectMatchesDurableObject(item, plan) {
			return true
		}
	}
	return false
}

func objectMatchesWorkerDomain(item map[string]any) bool {
	return fmt.Sprint(item["service"]) == WorkerName
}
func ownedDomainPresent(value any) bool {
	for _, item := range objectSlice(value) {
		if objectMatchesWorkerDomain(item) {
			return true
		}
	}
	return false
}

func namedObjectPresent(value any, key, expected string) bool {
	for _, item := range objectSlice(value) {
		if fmt.Sprint(item[key]) == expected {
			return true
		}
	}
	return false
}

func objectHasKeyValue(value any, key, expected string) bool {
	return namedObjectPresent(value, key, expected)
}

func mapBool(value any, key string) bool {
	item, ok := value.(map[string]any)
	result, _ := item[key].(bool)
	return ok && result
}

func mapString(value any, key string) string {
	item, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	result, _ := item[key].(string)
	return result
}

func bindingPresent(value any, name, className, namespaceID string) bool {
	settings, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for _, binding := range objectSlice(settings["bindings"]) {
		if fmt.Sprint(binding["name"]) == name && fmt.Sprint(binding["class_name"]) == className {
			if namespaceID == "absent" || namespaceID == "none" || fmt.Sprint(binding["namespace_id"]) == namespaceID {
				return true
			}
		}
	}
	return false
}

func plainTextBindingPresent(value any, name, expected string) bool {
	settings, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for _, binding := range objectSlice(settings["bindings"]) {
		if fmt.Sprint(binding["name"]) == name && fmt.Sprint(binding["text"]) == expected {
			return true
		}
	}
	return false
}

func containsIdentityOnSurface(value any, expected string) bool {
	identities := []string{}
	collectIdentities(value, "", &identities)
	for _, identity := range identities {
		if strings.HasSuffix(identity, "="+expected) {
			return true
		}
	}
	return false
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
		for _, key := range []string{"deployments", "schedules", "items"} {
			if nested, ok := item[key]; ok {
				return collectionEmpty(nested)
			}
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

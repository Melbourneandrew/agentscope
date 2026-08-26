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
	copy.Surfaces, _ = canonicalizeForComparison(observation.Surfaces).(map[string]any)
	copy.IdentitySet = append([]string{}, observation.IdentitySet...)
	sort.Strings(copy.IdentitySet)
	data, err := json.Marshal(copy)
	if err != nil {
		return "", "", err
	}
	identities, err := json.Marshal(copy.IdentitySet)
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

type cloudflareSurfaceRequest struct {
	path      string
	paginated bool
}

func fetchCloudflareSurface(ctx context.Context, client *http.Client, credential []byte, surface cloudflareSurfaceRequest) (any, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.cloudflare.com"+surface.path, nil)
	if err != nil {
		return nil, errors.New("E_OBSERVER_REQUEST")
	}
	request.Header.Set("Authorization", "Bearer "+string(credential))
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("E_OBSERVER_UNAVAILABLE")
	}
	if response.Request != nil && (response.Request.URL.Scheme != "https" || response.Request.URL.Host != "api.cloudflare.com") {
		response.Body.Close()
		return nil, errors.New("E_OBSERVER_ORIGIN")
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	response.Body.Close()
	if readErr != nil || len(body) > 1<<20 {
		return nil, errors.New("E_OBSERVER_OUTPUT")
	}
	if response.StatusCode == http.StatusNotFound {
		return map[string]any{"absent": true}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errors.New("E_OBSERVER_FAILURE")
	}
	var envelope cloudflareEnvelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil || decoder.Decode(&struct{}{}) != io.EOF || !envelope.Success || len(envelope.Result) == 0 {
		return nil, errors.New("E_OBSERVER_ENVELOPE")
	}
	if surface.paginated && (len(envelope.ResultInfo) == 0 || string(envelope.ResultInfo) == "null") {
		return nil, errors.New("E_OBSERVER_PAGINATION")
	}
	if len(envelope.ResultInfo) > 0 && string(envelope.ResultInfo) != "null" {
		var page struct {
			Page       int `json:"page"`
			TotalPages int `json:"total_pages"`
		}
		if err := json.Unmarshal(envelope.ResultInfo, &page); err != nil || (surface.paginated && (page.Page != 1 || page.TotalPages != 1)) || page.TotalPages > 1 {
			return nil, errors.New("E_OBSERVER_PAGINATION")
		}
	}
	var value any
	decoder = json.NewDecoder(bytes.NewReader(envelope.Result))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return nil, errors.New("E_OBSERVER_SCHEMA")
	}
	return canonicalizeJSON(value), nil
}

func (observer CloudflareObserver) Observe(ctx context.Context, credential []byte, now time.Time) (StateObservation, error) {
	if !identifierPattern.MatchString(observer.AccountID) || len(credential) == 0 {
		return StateObservation{}, errors.New("E_OBSERVER_IDENTITY")
	}
	base := "/client/v4/accounts/" + observer.AccountID
	script := base + "/workers/scripts/" + WorkerName
	paths := map[string]cloudflareSurfaceRequest{
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
		value, err := fetchCloudflareSurface(ctx, &safeClient, credential, surface)
		if err != nil {
			return StateObservation{}, err
		}
		surfaces[name] = value
	}
	unrelated := map[string]any{}
	for _, worker := range objectSlice(surfaces["accountWorkers"]) {
		name := fmt.Sprint(worker["id"])
		if name == "<nil>" || name == "" {
			name = fmt.Sprint(worker["name"])
		}
		if name == WorkerName {
			continue
		}
		if !identifierPattern.MatchString(name) {
			return StateObservation{}, errors.New("E_OBSERVER_WORKER_IDENTITY")
		}
		workerBase := base + "/workers/scripts/" + name
		workerSurfaces := map[string]any{}
		for surfaceName, surface := range map[string]cloudflareSurfaceRequest{
			"deployments": {workerBase + "/deployments", false},
			"schedules":   {workerBase + "/schedules", false},
			"secrets":     {workerBase + "/secrets", false},
			"script":      {workerBase + "/script-settings", false},
			"settings":    {workerBase + "/settings", false},
			"tails":       {workerBase + "/tails", false},
			"workersDev":  {workerBase + "/subdomain", false},
			"versions":    {base + "/workers/workers/" + name + "/versions?page=1&per_page=1000", true},
		} {
			value, err := fetchCloudflareSurface(ctx, &safeClient, credential, surface)
			if err != nil {
				return StateObservation{}, err
			}
			workerSurfaces[surfaceName] = value
		}
		unrelated[name] = workerSurfaces
	}
	surfaces["unrelatedWorkers"] = unrelated
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
	return validateDeploymentProfile(plan, state, true)
}

func validateDeploymentProfile(plan Plan, state StateObservation, requireSecrets bool) error {
	if !workerPresent(state.Surfaces["accountWorkers"]) || !ownedDurableObjectPresent(state.Surfaces["durableObjects"], plan) || ownedDomainPresent(state.Surfaces["scriptDomains"]) {
		return errors.New("E_DEPLOYMENT_ACCOUNT_RESOURCE_STATE")
	}
	for _, surface := range []string{"scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "scriptWorkersDev", "scriptVersions"} {
		if surfaceAbsent(state.Surfaces[surface]) {
			return errors.New("E_DEPLOYMENT_STATE_ABSENT")
		}
	}
	secretNames := namedObjectValues(state.Surfaces["scriptSecrets"], "name")
	if requireSecrets && !sameStringSet(secretNames, canonicalSecrets) {
		return errors.New("E_DEPLOYMENT_SECRET_STATE")
	}
	if !requireSecrets && len(secretNames) != 0 {
		for _, required := range canonicalSecrets {
			if !namedObjectPresent(state.Surfaces["scriptSecrets"], "name", required) {
				return errors.New("E_DEPLOYMENT_SECRET_STATE")
			}
		}
	}
	schedules := objectSlice(state.Surfaces["scriptSchedules"])
	if len(schedules) != 1 || fmt.Sprint(schedules[0]["cron"]) != "*/15 * * * *" || !bindingPresent(state.Surfaces["workerSettings"], "FLEET", "FleetDurableObject", plan.DurableObjectNamespaceID) || !mapBool(state.Surfaces["scriptWorkersDev"], "enabled") || mapBool(state.Surfaces["scriptWorkersDev"], "previews_enabled") {
		return errors.New("E_DEPLOYMENT_PROFILE_STATE")
	}
	if !collectionEmpty(state.Surfaces["scriptTails"]) || unsafeDiagnosticSettings(state.Surfaces["scriptSettings"]) {
		return errors.New("E_DEPLOYMENT_DIAGNOSTIC_MUTATION")
	}
	expectedVariables := map[string]string{
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
	}
	for key, expected := range expectedVariables {
		if !plainTextBindingPresent(state.Surfaces["workerSettings"], key, expected) {
			return errors.New("E_DEPLOYMENT_VARIABLE_STATE")
		}
	}
	allowedBindings := map[string]struct{}{"FLEET": {}, "CF_VERSION_METADATA": {}}
	for key := range expectedVariables {
		allowedBindings[key] = struct{}{}
	}
	for _, secret := range canonicalSecrets {
		allowedBindings[secret] = struct{}{}
	}
	settings, ok := state.Surfaces["workerSettings"].(map[string]any)
	if !ok {
		return errors.New("E_DEPLOYMENT_SETTINGS_SCHEMA")
	}
	if fmt.Sprint(settings["compatibility_date"]) != "2026-04-30" || !sameStringSet(stringSlice(settings["compatibility_flags"]), []string{"nodejs_compat"}) || cacheEnabled(settings["cache_options"]) {
		return errors.New("E_DEPLOYMENT_RUNTIME_SETTINGS")
	}
	if tag := fmt.Sprint(settings["migration_tag"]); tag != "v1" && tag != "<nil>" {
		return errors.New("E_DEPLOYMENT_MIGRATION_STATE")
	}
	for _, binding := range objectSlice(settings["bindings"]) {
		name := fmt.Sprint(binding["name"])
		if _, allowed := allowedBindings[name]; !allowed {
			return errors.New("E_DEPLOYMENT_EXTRA_BINDING")
		}
	}
	scriptSettings, ok := state.Surfaces["scriptSettings"].(map[string]any)
	if !ok {
		return errors.New("E_DEPLOYMENT_SCRIPT_SETTINGS")
	}
	for key := range scriptSettings {
		if key != "logpush" && key != "observability" && key != "tags" && key != "tail_consumers" {
			return errors.New("E_DEPLOYMENT_EXTRA_SCRIPT_SETTING")
		}
	}
	return nil
}

func ValidateActionTransition(plan Plan, operation Operation, before, after StateObservation) error {
	_, err := actionTransitionIdentities(plan, operation, before, after)
	return err
}

func actionTransitionIdentities(plan Plan, operation Operation, before, after StateObservation) ([]string, error) {
	allowed := map[string]struct{}{}
	allow := func(names ...string) {
		for _, name := range names {
			allowed[name] = struct{}{}
		}
	}
	switch operation.Action {
	case "worker.secret.put":
		allow("scriptSecrets", "scriptDeployments", "scriptVersions")
	case "worker.secret.delete":
		allow("scriptSecrets", "scriptDeployments", "scriptVersions")
	case "worker.deploy":
		allow("accountWorkers", "durableObjects", "scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "workerSettings", "scriptTails", "scriptWorkersDev", "scriptVersions")
	case "worker.rollback":
		allow("scriptDeployments")
	case "worker.schedule.delete":
		allow("scriptSchedules")
	case "worker.scriptWorkersDev.disable":
		allow("scriptWorkersDev")
	case "worker.terminalArtifact.deploy":
		allow("accountWorkers", "durableObjects", "scriptDeployments", "scriptSchedules", "scriptSettings", "workerSettings", "scriptWorkersDev", "scriptVersions")
	case "worker.version.delete":
		allow("scriptVersions")
	case "worker.delete":
		allow("accountWorkers", "durableObjects", "scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "workerSettings", "scriptTails", "scriptWorkersDev", "scriptVersions")
	case "account.workersDev.enable":
		allow("accountWorkersDev")
	default:
		return nil, errors.New("E_ACTION_TRANSITION_UNKNOWN")
	}
	if err := requireUnchangedSurfaces(before, after, allowed); err != nil {
		return nil, err
	}

	switch operation.Action {
	case "worker.secret.put":
		if operation.SecretName == nil || !namedObjectPresent(after.Surfaces["scriptSecrets"], "name", *operation.SecretName) {
			return nil, errors.New("E_SECRET_WRITE_NOT_OBSERVED")
		}
		beforeDeployment, afterDeployment := currentDeploymentID(before.Surfaces["scriptDeployments"]), currentDeploymentID(after.Surfaces["scriptDeployments"])
		if afterDeployment == "" || afterDeployment == beforeDeployment {
			return nil, errors.New("E_SECRET_DEPLOYMENT_IDENTITY")
		}
		return []string{"deployment=" + afterDeployment, "secret=" + *operation.SecretName}, nil
	case "worker.secret.delete":
		if operation.SecretName == nil || namedObjectPresent(after.Surfaces["scriptSecrets"], "name", *operation.SecretName) {
			return nil, errors.New("E_SECRET_DELETE_NOT_OBSERVED")
		}
		return []string{"secret-absent=" + *operation.SecretName}, nil
	case "worker.deploy":
		beforeDeployment, afterDeployment := currentDeploymentID(before.Surfaces["scriptDeployments"]), currentDeploymentID(after.Surfaces["scriptDeployments"])
		if !workerPresent(after.Surfaces["accountWorkers"]) || afterDeployment == "" || afterDeployment == beforeDeployment || operation.ExpectedPreviousVersionID == nil || (*operation.ExpectedPreviousVersionID != "absent" && *operation.ExpectedPreviousVersionID != beforeDeployment) {
			return nil, errors.New("E_DEPLOY_NOT_OBSERVED")
		}
		if err := validateDeploymentProfile(plan, after, false); err != nil {
			return nil, err
		}
		return []string{"deployment=" + afterDeployment}, nil
	case "worker.rollback":
		if operation.VersionID == nil || !containsIdentityOnSurface(after.Surfaces["scriptDeployments"], *operation.VersionID) || currentDeploymentID(after.Surfaces["scriptDeployments"]) == currentDeploymentID(before.Surfaces["scriptDeployments"]) {
			return nil, errors.New("E_ROLLBACK_NOT_OBSERVED")
		}
		return []string{"rollback-version=" + *operation.VersionID}, nil
	case "worker.schedule.delete":
		if !collectionEmpty(after.Surfaces["scriptSchedules"]) {
			return nil, errors.New("E_SCHEDULE_DELETE_NOT_OBSERVED")
		}
		return []string{"schedule=absent"}, nil
	case "worker.scriptWorkersDev.disable":
		if !surfaceAbsent(after.Surfaces["scriptWorkersDev"]) && mapBool(after.Surfaces["scriptWorkersDev"], "enabled") {
			return nil, errors.New("E_WORKERS_DEV_DISABLE_NOT_OBSERVED")
		}
		return []string{"script-workers-dev=disabled"}, nil
	case "worker.terminalArtifact.deploy":
		beforeDeployment, afterDeployment := currentDeploymentID(before.Surfaces["scriptDeployments"]), currentDeploymentID(after.Surfaces["scriptDeployments"])
		if !workerPresent(after.Surfaces["accountWorkers"]) || afterDeployment == "" || afterDeployment == beforeDeployment || bindingPresent(after.Surfaces["workerSettings"], "FLEET", "FleetDurableObject", plan.DurableObjectNamespaceID) {
			return nil, errors.New("E_TERMINAL_DEPLOY_NOT_OBSERVED")
		}
		return []string{"terminal-deployment=" + afterDeployment}, nil
	case "worker.version.delete":
		if operation.VersionID == nil || containsIdentityOnSurface(after.Surfaces["scriptVersions"], *operation.VersionID) {
			return nil, errors.New("E_VERSION_DELETE_NOT_OBSERVED")
		}
		return []string{"version-absent=" + *operation.VersionID}, nil
	case "worker.delete":
		if workerPresent(after.Surfaces["accountWorkers"]) {
			return nil, errors.New("E_WORKER_DELETE_NOT_OBSERVED")
		}
		return []string{"worker-absent=" + WorkerName}, nil
	case "account.workersDev.enable":
		if operation.Subdomain == nil || mapString(after.Surfaces["accountWorkersDev"], "subdomain") != *operation.Subdomain {
			return nil, errors.New("E_ACCOUNT_WORKERS_DEV_NOT_OBSERVED")
		}
		return []string{"account-subdomain=" + *operation.Subdomain}, nil
	}
	return nil, errors.New("E_ACTION_TRANSITION_UNKNOWN")
}

func requireUnchangedSurfaces(before, after StateObservation, allowed map[string]struct{}) error {
	keys := map[string]struct{}{}
	for key := range before.Surfaces {
		keys[key] = struct{}{}
	}
	for key := range after.Surfaces {
		keys[key] = struct{}{}
	}
	for key := range keys {
		if _, mutable := allowed[key]; mutable {
			continue
		}
		beforeData, beforeErr := json.Marshal(canonicalizeForComparison(before.Surfaces[key]))
		afterData, afterErr := json.Marshal(canonicalizeForComparison(after.Surfaces[key]))
		if beforeErr != nil || afterErr != nil || !bytes.Equal(beforeData, afterData) {
			return errors.New("E_UNRELATED_RESOURCE_DRIFT")
		}
	}
	return nil
}

func canonicalizeForComparison(value any) any {
	switch item := value.(type) {
	case []any:
		values := make([]any, len(item))
		for index := range item {
			values[index] = canonicalizeForComparison(item[index])
		}
		sort.Slice(values, func(left, right int) bool {
			leftData, _ := json.Marshal(values[left])
			rightData, _ := json.Marshal(values[right])
			return bytes.Compare(leftData, rightData) < 0
		})
		return values
	case map[string]any:
		copy := make(map[string]any, len(item))
		for key, child := range item {
			copy[key] = canonicalizeForComparison(child)
		}
		return copy
	default:
		return value
	}
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

func namedObjectValues(value any, key string) []string {
	values := []string{}
	for _, item := range objectSlice(value) {
		if name, ok := item[key].(string); ok {
			values = append(values, name)
		}
	}
	return values
}

func sameStringSet(actual, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	counts := map[string]int{}
	for _, value := range actual {
		counts[value]++
	}
	for _, value := range expected {
		counts[value]--
	}
	for _, count := range counts {
		if count != 0 {
			return false
		}
	}
	return true
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

func stringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil
		}
		result = append(result, text)
	}
	return result
}

func cacheEnabled(value any) bool {
	item, ok := value.(map[string]any)
	if !ok {
		return false
	}
	enabled, _ := item["enabled"].(bool)
	return enabled
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

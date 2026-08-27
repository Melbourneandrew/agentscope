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
	coreSurfaces := map[string]any{}
	for name, value := range observation.Surfaces {
		if name != "rollbackVersionDetail" {
			coreSurfaces[name] = value
		}
	}
	copy.Surfaces, _ = canonicalizeForComparison(coreSurfaces).(map[string]any)
	copy.IdentitySet = []string{}
	collectIdentities(copy.Surfaces, "", &copy.IdentitySet)
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
	AccountID         string
	RollbackVersionID string
	Client            *http.Client
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
	if observer.RollbackVersionID != "" {
		if !identifierPattern.MatchString(observer.RollbackVersionID) || observer.RollbackVersionID == "latest" {
			return StateObservation{}, errors.New("E_OBSERVER_VERSION_IDENTITY")
		}
		value, err := fetchCloudflareSurface(ctx, &safeClient, credential, cloudflareSurfaceRequest{base + "/workers/workers/" + WorkerName + "/versions/" + observer.RollbackVersionID, false})
		if err != nil {
			return StateObservation{}, err
		}
		surfaces["rollbackVersionDetail"] = value
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
	namespaceID, namespaceCount := ownedDurableObjectIdentity(state.Surfaces["durableObjects"], plan)
	if !workerPresent(state.Surfaces["accountWorkers"]) || namespaceCount != 1 || namespaceID == "" || (plan.DurableObjectNamespaceID != "absent" && namespaceID != plan.DurableObjectNamespaceID) || ownedDomainPresent(state.Surfaces["scriptDomains"]) {
		return errors.New("E_DEPLOYMENT_ACCOUNT_RESOURCE_STATE")
	}
	for _, surface := range []string{"scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "scriptWorkersDev", "scriptVersions"} {
		if surfaceAbsent(state.Surfaces[surface]) {
			return errors.New("E_DEPLOYMENT_STATE_ABSENT")
		}
	}
	secretNames := namedObjectValues(state.Surfaces["scriptSecrets"], "name")
	secretsPresent := sameStringSet(secretNames, canonicalSecrets)
	if requireSecrets && !secretsPresent {
		return errors.New("E_DEPLOYMENT_SECRET_STATE")
	}
	if !requireSecrets && len(secretNames) != 0 && !secretsPresent {
		return errors.New("E_DEPLOYMENT_SECRET_STATE")
	}
	schedules := objectSlice(state.Surfaces["scriptSchedules"])
	workersDev, workersDevOK := state.Surfaces["scriptWorkersDev"].(map[string]any)
	if len(schedules) != 1 || fmt.Sprint(schedules[0]["cron"]) != "*/15 * * * *" || !bindingPresent(state.Surfaces["workerSettings"], "FLEET", "FleetDurableObject", namespaceID) || !workersDevOK || !allowedObjectKeys(workersDev, "enabled", "previews_enabled") || !exactBoolean(workersDev, "enabled", true) || !optionalBoolean(workersDev, "previews_enabled", false) {
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
	settings, ok := state.Surfaces["workerSettings"].(map[string]any)
	if !ok {
		return errors.New("E_DEPLOYMENT_SETTINGS_SCHEMA")
	}
	allowedSettingKeys := map[string]bool{"bindings": true, "compatibility_date": true, "compatibility_flags": true, "cache_options": true, "limits": true, "logpush": true, "migrations": true, "observability": true, "placement": true, "tags": true, "tail_consumers": true, "usage_model": true}
	for key := range settings {
		if !allowedSettingKeys[key] {
			return errors.New("E_DEPLOYMENT_EXTRA_WORKER_SETTING")
		}
	}
	cache, cacheOK := settings["cache_options"].(map[string]any)
	if fmt.Sprint(settings["compatibility_date"]) != "2026-04-30" || !sameStringSet(stringSlice(settings["compatibility_flags"]), []string{"nodejs_compat"}) || !cacheOK || !exactObjectKeys(cache, "enabled") || !exactBoolean(cache, "enabled", false) {
		return errors.New("E_DEPLOYMENT_RUNTIME_SETTINGS")
	}
	if !collectionEmpty(settings["limits"]) || !optionalBoolean(settings, "logpush", false) || !optionalDisabledObservability(settings) || !collectionEmpty(settings["placement"]) || !collectionEmpty(settings["tags"]) || !collectionEmpty(settings["tail_consumers"]) || (settings["usage_model"] != nil && fmt.Sprint(settings["usage_model"]) != "standard") {
		return errors.New("E_DEPLOYMENT_RUNTIME_SETTINGS")
	}
	migration, hasMigration := settings["migrations"].(map[string]any)
	if !hasMigration || !validInitialMigrationProjection(migration) {
		return errors.New("E_DEPLOYMENT_MIGRATION_STATE")
	}
	bindings := objectSlice(settings["bindings"])
	expectedBindingCount := 2 + len(expectedVariables)
	if requireSecrets || secretsPresent {
		expectedBindingCount += len(canonicalSecrets)
	}
	if len(bindings) != expectedBindingCount {
		return errors.New("E_DEPLOYMENT_EXTRA_BINDING")
	}
	seenBindings := map[string]bool{}
	for _, binding := range bindings {
		name, kind := fmt.Sprint(binding["name"]), fmt.Sprint(binding["type"])
		if seenBindings[name] {
			return errors.New("E_DEPLOYMENT_EXTRA_BINDING")
		}
		seenBindings[name] = true
		switch {
		case name == "FLEET":
			if kind != "durable_object_namespace" || fmt.Sprint(binding["class_name"]) != "FleetDurableObject" || fmt.Sprint(binding["namespace_id"]) != namespaceID || !exactObjectKeys(binding, "name", "type", "class_name", "namespace_id") {
				return errors.New("E_DEPLOYMENT_EXTRA_BINDING")
			}
		case name == "CF_VERSION_METADATA":
			if kind != "version_metadata" || !exactObjectKeys(binding, "name", "type") {
				return errors.New("E_DEPLOYMENT_EXTRA_BINDING")
			}
		case expectedVariables[name] != "":
			if kind != "plain_text" || fmt.Sprint(binding["text"]) != expectedVariables[name] || !exactObjectKeys(binding, "name", "type", "text") {
				return errors.New("E_DEPLOYMENT_EXTRA_BINDING")
			}
		case (requireSecrets || secretsPresent) && stringInSlice(name, canonicalSecrets):
			if kind != "secret_text" || !exactObjectKeys(binding, "name", "type") {
				return errors.New("E_DEPLOYMENT_EXTRA_BINDING")
			}
		default:
			return errors.New("E_DEPLOYMENT_EXTRA_BINDING")
		}
	}
	scriptSettings, ok := state.Surfaces["scriptSettings"].(map[string]any)
	if !ok {
		return errors.New("E_DEPLOYMENT_SCRIPT_SETTINGS")
	}
	observability, observationOK := scriptSettings["observability"].(map[string]any)
	if !exactObjectKeys(scriptSettings, "logpush", "observability", "tags", "tail_consumers") || !observationOK || !exactObjectKeys(observability, "enabled") || !exactBoolean(scriptSettings, "logpush", false) || !exactBoolean(observability, "enabled", false) || !collectionEmpty(scriptSettings["tail_consumers"]) || !collectionEmpty(scriptSettings["tags"]) {
		return errors.New("E_DEPLOYMENT_SCRIPT_SETTINGS")
	}
	return nil
}

func validInitialMigrationProjection(migration map[string]any) bool {
	if fmt.Sprint(migration["new_tag"]) != "v1" {
		return false
	}
	if oldTag, exists := migration["old_tag"]; exists && fmt.Sprint(oldTag) != "" {
		return false
	}
	if classes, exists := migration["new_sqlite_classes"]; exists {
		return allowedObjectKeys(migration, "new_tag", "old_tag", "new_sqlite_classes") && sameStringSet(stringSlice(classes), []string{"FleetDurableObject"})
	}
	if rawSteps, exists := migration["steps"]; exists {
		steps := objectSlice(rawSteps)
		return allowedObjectKeys(migration, "new_tag", "old_tag", "steps") && len(steps) == 1 && exactObjectKeys(steps[0], "new_sqlite_classes") && sameStringSet(stringSlice(steps[0]["new_sqlite_classes"]), []string{"FleetDurableObject"})
	}
	return false
}

func exactObjectKeys(value map[string]any, expected ...string) bool {
	if len(value) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, exists := value[key]; !exists {
			return false
		}
	}
	return true
}

func allowedObjectKeys(value map[string]any, allowed ...string) bool {
	set := map[string]bool{}
	for _, key := range allowed {
		set[key] = true
	}
	for key := range value {
		if !set[key] {
			return false
		}
	}
	return true
}

func exactBoolean(value map[string]any, key string, expected bool) bool {
	actual, ok := value[key].(bool)
	return ok && actual == expected
}

func optionalBoolean(value map[string]any, key string, expected bool) bool {
	if _, exists := value[key]; !exists {
		return true
	}
	return exactBoolean(value, key, expected)
}

func optionalDisabledObservability(value map[string]any) bool {
	raw, exists := value["observability"]
	if !exists {
		return true
	}
	observation, ok := raw.(map[string]any)
	return ok && exactObjectKeys(observation, "enabled") && exactBoolean(observation, "enabled", false)
}

func stringInSlice(value string, values []string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
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
		allow("scriptSecrets", "scriptDeployments", "scriptVersions", "workerSettings")
	case "worker.secret.delete":
		allow("scriptSecrets", "scriptDeployments", "scriptVersions", "workerSettings")
	case "worker.deploy":
		allow("accountWorkers", "durableObjects", "scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "workerSettings", "scriptTails", "scriptWorkersDev", "scriptVersions")
	case "worker.rollback":
		allow("scriptDeployments")
	case "worker.schedule.delete":
		allow("scriptSchedules")
	case "worker.scriptWorkersDev.disable":
		allow("scriptWorkersDev")
	case "worker.terminalArtifact.deploy":
		allow("accountWorkers", "durableObjects", "scriptDeployments", "workerSettings", "scriptVersions")
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
	if operation.Action == "worker.deploy" || operation.Action == "worker.terminalArtifact.deploy" || operation.Action == "worker.delete" {
		if !filteredObjectsEqual(before.Surfaces["accountWorkers"], after.Surfaces["accountWorkers"], objectMatchesWorker) || !filteredObjectsEqual(before.Surfaces["durableObjects"], after.Surfaces["durableObjects"], func(item map[string]any) bool { return objectMatchesDurableObject(item, plan) }) {
			return nil, errors.New("E_UNRELATED_RESOURCE_DRIFT")
		}
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
		newVersion := singleAddedIdentity(before.Surfaces["scriptVersions"], after.Surfaces["scriptVersions"])
		if !namedObjectsEqualExcept(before.Surfaces["scriptSecrets"], after.Surfaces["scriptSecrets"], "name", *operation.SecretName) || !bindingObjectsEqualExcept(before.Surfaces["workerSettings"], after.Surfaces["workerSettings"], *operation.SecretName) || newVersion == "" || currentWorkerVersionID(after.Surfaces["scriptDeployments"]) != newVersion || !deploymentTransitionExact(before.Surfaces["scriptDeployments"], after.Surfaces["scriptDeployments"], newVersion) {
			return nil, errors.New("E_SECRET_UNEXPECTED_DELTA")
		}
		return []string{"deployment=" + afterDeployment, "secret=" + *operation.SecretName}, nil
	case "worker.secret.delete":
		if operation.SecretName == nil || !namedObjectPresent(before.Surfaces["scriptSecrets"], "name", *operation.SecretName) || namedObjectPresent(after.Surfaces["scriptSecrets"], "name", *operation.SecretName) {
			return nil, errors.New("E_SECRET_DELETE_NOT_OBSERVED")
		}
		if !namedObjectsEqualExcept(before.Surfaces["scriptSecrets"], after.Surfaces["scriptSecrets"], "name", *operation.SecretName) || !bindingObjectsEqualExcept(before.Surfaces["workerSettings"], after.Surfaces["workerSettings"], *operation.SecretName) || !sameCanonicalValue(before.Surfaces["scriptDeployments"], after.Surfaces["scriptDeployments"]) || !sameCanonicalValue(before.Surfaces["scriptVersions"], after.Surfaces["scriptVersions"]) {
			return nil, errors.New("E_SECRET_UNEXPECTED_DELTA")
		}
		return []string{"secret-absent=" + *operation.SecretName}, nil
	case "worker.deploy":
		beforeDeployment, afterDeployment := currentDeploymentID(before.Surfaces["scriptDeployments"]), currentDeploymentID(after.Surfaces["scriptDeployments"])
		if !workerPresent(after.Surfaces["accountWorkers"]) || afterDeployment == "" || afterDeployment == beforeDeployment || operation.ExpectedPreviousVersionID == nil || (*operation.ExpectedPreviousVersionID != "absent" && *operation.ExpectedPreviousVersionID != currentWorkerVersionID(before.Surfaces["scriptDeployments"])) {
			return nil, errors.New("E_DEPLOY_NOT_OBSERVED")
		}
		if err := validateDeploymentProfile(plan, after, false); err != nil {
			return nil, err
		}
		newVersion := singleAddedIdentity(before.Surfaces["scriptVersions"], after.Surfaces["scriptVersions"])
		if !sameStringSet(namedObjectValues(before.Surfaces["scriptSecrets"], "name"), namedObjectValues(after.Surfaces["scriptSecrets"], "name")) || newVersion == "" || currentWorkerVersionID(after.Surfaces["scriptDeployments"]) != newVersion {
			return nil, errors.New("E_DEPLOY_UNEXPECTED_DELTA")
		}
		namespaceID, _ := ownedDurableObjectIdentity(after.Surfaces["durableObjects"], plan)
		return []string{"deployment=" + afterDeployment, "worker-version=" + newVersion, "durable-object-namespace=" + namespaceID, "migration=v1"}, nil
	case "worker.rollback":
		if operation.VersionID == nil || currentWorkerVersionID(after.Surfaces["scriptDeployments"]) != *operation.VersionID || currentDeploymentID(after.Surfaces["scriptDeployments"]) == currentDeploymentID(before.Surfaces["scriptDeployments"]) || !sameCanonicalValue(before.Surfaces["scriptVersions"], after.Surfaces["scriptVersions"]) {
			return nil, errors.New("E_ROLLBACK_NOT_OBSERVED")
		}
		return []string{"rollback-version=" + *operation.VersionID}, nil
	case "worker.schedule.delete":
		if collectionEmpty(before.Surfaces["scriptSchedules"]) || !collectionEmpty(after.Surfaces["scriptSchedules"]) {
			return nil, errors.New("E_SCHEDULE_DELETE_NOT_OBSERVED")
		}
		return []string{"schedule=absent"}, nil
	case "worker.scriptWorkersDev.disable":
		beforeWorkersDev, beforeOK := before.Surfaces["scriptWorkersDev"].(map[string]any)
		if !beforeOK || !exactBoolean(beforeWorkersDev, "enabled", true) {
			return nil, errors.New("E_WORKERS_DEV_DISABLE_NOT_OBSERVED")
		}
		if !surfaceAbsent(after.Surfaces["scriptWorkersDev"]) {
			workersDev, ok := after.Surfaces["scriptWorkersDev"].(map[string]any)
			if !ok || !exactObjectKeys(workersDev, "enabled") || !exactBoolean(workersDev, "enabled", false) {
				return nil, errors.New("E_WORKERS_DEV_DISABLE_NOT_OBSERVED")
			}
		}
		return []string{"script-workers-dev=disabled"}, nil
	case "worker.terminalArtifact.deploy":
		beforeDeployment, afterDeployment := currentDeploymentID(before.Surfaces["scriptDeployments"]), currentDeploymentID(after.Surfaces["scriptDeployments"])
		newVersion := singleAddedIdentity(before.Surfaces["scriptVersions"], after.Surfaces["scriptVersions"])
		settings, settingsOK := after.Surfaces["workerSettings"].(map[string]any)
		migration, migrationOK := settings["migrations"].(map[string]any)
		if !workerPresent(after.Surfaces["accountWorkers"]) || afterDeployment == "" || afterDeployment == beforeDeployment || newVersion == "" || currentWorkerVersionID(after.Surfaces["scriptDeployments"]) != newVersion || !settingsOK || !allowedObjectKeys(settings, "bindings", "compatibility_date", "compatibility_flags", "cache_options", "migrations", "limits", "logpush", "observability", "placement", "tags", "tail_consumers", "usage_model") || !collectionEmpty(settings["bindings"]) || !migrationOK || !validTerminalMigrationProjection(migration) || !collectionEmpty(after.Surfaces["durableObjects"]) {
			return nil, errors.New("E_TERMINAL_DEPLOY_NOT_OBSERVED")
		}
		return []string{"terminal-deployment=" + afterDeployment, "terminal-version=" + newVersion}, nil
	case "worker.version.delete":
		if operation.VersionID == nil || !namedObjectPresent(before.Surfaces["scriptVersions"], "id", *operation.VersionID) || containsIdentityOnSurface(after.Surfaces["scriptVersions"], *operation.VersionID) || !namedObjectsEqualExcept(before.Surfaces["scriptVersions"], after.Surfaces["scriptVersions"], "id", *operation.VersionID) {
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

func validTerminalMigrationProjection(migration map[string]any) bool {
	if fmt.Sprint(migration["new_tag"]) != "v2-retire-fleet-durable-object" || fmt.Sprint(migration["old_tag"]) != "v1" {
		return false
	}
	if classes, exists := migration["deleted_classes"]; exists {
		return allowedObjectKeys(migration, "new_tag", "old_tag", "deleted_classes") && sameStringSet(stringSlice(classes), []string{"FleetDurableObject"})
	}
	if rawSteps, exists := migration["steps"]; exists {
		steps := objectSlice(rawSteps)
		return allowedObjectKeys(migration, "new_tag", "old_tag", "steps") && len(steps) == 1 && exactObjectKeys(steps[0], "deleted_classes") && sameStringSet(stringSlice(steps[0]["deleted_classes"]), []string{"FleetDurableObject"})
	}
	return false
}

func deploymentTransitionExact(before, after any, expectedVersion string) bool {
	beforeObject, beforeOK := before.(map[string]any)
	afterObject, afterOK := after.(map[string]any)
	if !beforeOK || !afterOK || currentDeploymentID(before) == "" || currentDeploymentID(after) == "" || currentDeploymentID(before) == currentDeploymentID(after) || currentWorkerVersionID(after) != expectedVersion {
		return false
	}
	beforeCopy, afterCopy := map[string]any{}, map[string]any{}
	for key, value := range beforeObject {
		if key != "id" && key != "versions" {
			beforeCopy[key] = value
		}
	}
	for key, value := range afterObject {
		if key != "id" && key != "versions" {
			afterCopy[key] = value
		}
	}
	return sameCanonicalValue(beforeCopy, afterCopy)
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

func filteredObjectsEqual(before, after any, owned func(map[string]any) bool) bool {
	left, right := filterObjects(before, owned), filterObjects(after, owned)
	leftData, leftErr := json.Marshal(canonicalizeForComparison(left))
	rightData, rightErr := json.Marshal(canonicalizeForComparison(right))
	return leftErr == nil && rightErr == nil && bytes.Equal(leftData, rightData)
}

func sameCanonicalValue(before, after any) bool {
	left, leftErr := json.Marshal(canonicalizeForComparison(before))
	right, rightErr := json.Marshal(canonicalizeForComparison(after))
	return leftErr == nil && rightErr == nil && bytes.Equal(left, right)
}

func namedObjectsEqualExcept(before, after any, key, except string) bool {
	filter := func(value any) []any {
		result := []any{}
		for _, item := range objectSlice(value) {
			if fmt.Sprint(item[key]) != except {
				result = append(result, item)
			}
		}
		return result
	}
	left, _ := json.Marshal(canonicalizeForComparison(filter(before)))
	right, _ := json.Marshal(canonicalizeForComparison(filter(after)))
	return bytes.Equal(left, right)
}

func bindingObjectsEqualExcept(before, after any, except string) bool {
	beforeSettings, beforeOK := before.(map[string]any)
	afterSettings, afterOK := after.(map[string]any)
	if !beforeOK || !afterOK {
		return false
	}
	beforeCopy, afterCopy := map[string]any{}, map[string]any{}
	for key, value := range beforeSettings {
		beforeCopy[key] = value
	}
	for key, value := range afterSettings {
		afterCopy[key] = value
	}
	filter := func(value any) []any {
		result := []any{}
		for _, binding := range objectSlice(value) {
			if fmt.Sprint(binding["name"]) != except {
				result = append(result, binding)
			}
		}
		return result
	}
	beforeCopy["bindings"] = filter(beforeSettings["bindings"])
	afterCopy["bindings"] = filter(afterSettings["bindings"])
	left, _ := json.Marshal(canonicalizeForComparison(beforeCopy))
	right, _ := json.Marshal(canonicalizeForComparison(afterCopy))
	return bytes.Equal(left, right)
}

func singleAddedIdentity(before, after any) string {
	beforeIDs, afterIDs := map[string]map[string]any{}, map[string]map[string]any{}
	for _, item := range objectSlice(before) {
		if id := fmt.Sprint(item["id"]); id != "" && id != "<nil>" {
			beforeIDs[id] = item
		}
	}
	for _, item := range objectSlice(after) {
		if id := fmt.Sprint(item["id"]); id != "" && id != "<nil>" {
			afterIDs[id] = item
		}
	}
	added := ""
	for id, beforeItem := range beforeIDs {
		afterItem, exists := afterIDs[id]
		if !exists || !sameCanonicalValue(beforeItem, afterItem) {
			return ""
		}
	}
	for id := range afterIDs {
		if _, exists := beforeIDs[id]; !exists {
			if added != "" {
				return ""
			}
			added = id
		}
	}
	return added
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

func ownedDurableObjectIdentity(value any, plan Plan) (string, int) {
	identity, count := "", 0
	for _, item := range objectSlice(value) {
		if !objectMatchesDurableObject(item, plan) {
			continue
		}
		count++
		candidate := fmt.Sprint(item["id"])
		if candidate == "<nil>" || candidate == "" {
			return "", count
		}
		identity = candidate
	}
	return identity, count
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
		return true
	}
	if raw, exists := settings["logpush"]; exists {
		logpush, valid := raw.(bool)
		if !valid || logpush {
			return true
		}
	}
	if consumers, exists := settings["tail_consumers"]; exists && !collectionEmpty(consumers) {
		return true
	}
	if raw, exists := settings["observability"]; exists {
		observability, valid := raw.(map[string]any)
		if !valid {
			return true
		}
		if enabled, valid := observability["enabled"].(bool); !valid || enabled {
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

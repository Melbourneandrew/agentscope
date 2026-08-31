package control

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixture struct {
	t             *testing.T
	store         Store
	installation  Installation
	toolchain     ToolchainIdentity
	now           time.Time
	profileDigest string
}

var syntheticOperatorPassphrase = []byte("synthetic-operator-passphrase-32")

func newFixture(t *testing.T) fixture {
	t.Helper()
	parent := t.TempDir()
	lock := []byte("locked\n")
	toolchain := ToolchainIdentity{NodeVersion: "24.19.0", NodeArchiveSHA256: strings.Repeat("1", 64), WranglerVersion: "4.114.0", WorkerLockSHA256: SHA256(lock), GoVersion: "1.26.5", GoArchiveSHA256: strings.Repeat("2", 64), CrabboxClientSHA256: strings.Repeat("3", 64)}
	launcher, admission, manifest := []byte("launcher"), []byte(`{"coordinator":{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}`), []byte("manifest")
	live, terminal, terminalEntry := []byte("live-profile"), []byte("terminal-profile"), []byte("terminal-entry")
	runtimeClosure := runtimeArchive(t, map[string][]byte{
		"node/bin/node": []byte("fake-node"),
		"node/lib/node_modules/npm/bin/npm-cli.js":                 []byte("fake-npm"),
		"coordinator/worker/node_modules/wrangler/bin/wrangler.js": []byte("fake-wrangler"),
		"coordinator/worker/package-lock.json":                     lock,
		"coordinator/worker/src/index.ts":                          []byte("export default {}"),
	})
	root := filepath.Join(parent, "installed")
	installation, err := Install(InstallInput{skipCanonicalPolicyValidationForTest: true, Root: root, InstallationID: "install-1", EnvironmentID: "asgcf_0123456789abcdef0123456789abcdef", AccountID: "account-1", HetznerProjectID: "project-1", CoordinatorCommit: strings.Repeat("a", 40), AdmissionSHA256: SHA256(admission), PermissionManifestSHA256: SHA256(manifest), LiveProfileSHA256: SHA256(live), TerminalProfileSHA256: SHA256(terminal), Launcher: launcher, LauncherSourceCommit: strings.Repeat("8", 40), LauncherSourceTree: strings.Repeat("9", 40), Admission: admission, PermissionManifest: manifest, LiveProfile: live, TerminalProfile: terminal, TerminalEntryPoint: terminalEntry, RuntimeClosure: runtimeClosure, RuntimeClosureSHA256: SHA256(runtimeClosure), ToolchainIdentity: toolchain, OperatorPassphrase: syntheticOperatorPassphrase})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if info.IsDir() {
				return os.Chmod(path, 0o700)
			}
			return os.Chmod(path, 0o600)
		})
	})
	store := NewStore(root)
	now := time.Date(2026, 8, 26, 19, 0, 0, 0, time.UTC)
	roles := []string{"cloudflare-deployment", "cloudflare-plan-read", "hetzner-worker", "crabbox-shared", "crabbox-admin", "hetzner-inventory-read", "hetzner-recovery"}
	for index, role := range roles {
		value := []byte(strings.Repeat(string(rune('a'+index)), 32))
		if _, err := store.EnrollCredential(installation.EnvironmentID, role, "slot-"+role, "version-1", value, now); err != nil {
			t.Fatalf("enroll %s: %v", role, err)
		}
	}
	return fixture{t: t, store: store, installation: installation, toolchain: toolchain, now: now, profileDigest: SHA256(live)}
}

func runtimeArchive(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	tarry := tar.NewWriter(gzipWriter)
	var names []string
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value := files[name]
		if err := tarry.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(value)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarry.Write(value); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarry.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func pointer(value string) *string { return &value }

func syntheticState(account string, step int, kind string, now time.Time) StateObservation {
	bindings := []any{map[string]any{"name": "FLEET", "type": "durable_object_namespace", "class_name": "FleetDurableObject", "namespace_id": "namespace-1"}, map[string]any{"name": "CF_VERSION_METADATA", "type": "version_metadata"}}
	for _, variable := range [][2]string{{"AGENTSCOPE_CRABBOX_ENVIRONMENT_ID", "asgcf_0123456789abcdef0123456789abcdef"}, {"CRABBOX_DEFAULT_ORG", "agentscope-development"}, {"CRABBOX_MAX_ACTIVE_LEASES", "4"}, {"CRABBOX_MAX_ACTIVE_LEASES_PER_ORG", "4"}, {"CRABBOX_MAX_ACTIVE_LEASES_PER_OWNER", "4"}, {"CRABBOX_MAX_MONTHLY_USD", "25"}, {"CRABBOX_MAX_MONTHLY_USD_PER_ORG", "25"}, {"CRABBOX_MAX_MONTHLY_USD_PER_OWNER", "25"}, {"CRABBOX_RUN_RETENTION_DAYS", "30"}, {"CRABBOX_SHARED_OWNER", "agentscope-fleet-control"}} {
		bindings = append(bindings, map[string]any{"name": variable[0], "type": "plain_text", "text": variable[1]})
	}
	surfaces := map[string]any{
		"accountWorkers": []any{map[string]any{"id": WorkerName, "modified_on": "stable"}}, "accountWorkersDev": map[string]any{"enabled": true, "subdomain": "agentscope-dev"},
		"durableObjects": []any{map[string]any{"id": "namespace-1", "script": WorkerName, "class": "FleetDurableObject"}}, "scriptDomains": []any{},
		"scriptSettings": map[string]any{"logpush": false, "observability": map[string]any{"enabled": false}, "tags": []any{}, "tail_consumers": []any{}}, "workerSettings": map[string]any{"bindings": bindings, "compatibility_date": "2026-04-30", "compatibility_flags": []any{"nodejs_compat"}, "migrations": map[string]any{"new_tag": "v1", "new_sqlite_classes": []any{"FleetDurableObject"}}, "cache_options": map[string]any{"enabled": false}},
		"scriptDeployments": map[string]any{"deployments": []any{map[string]any{"id": "deployment-0", "versions": []any{map[string]any{"version_id": "version-current", "percentage": 100}}}}}, "scriptVersions": []any{map[string]any{"id": "version-current", "migration_tag": "v1"}, map[string]any{"id": "version-old", "migration_tag": "v1"}},
		"scriptSchedules": []any{map[string]any{"cron": "*/15 * * * *"}}, "scriptSecrets": []any{}, "scriptWorkersDev": map[string]any{"enabled": true}, "scriptTails": []any{},
	}
	if kind == "deploy" || kind == "rotate" {
		deployments := []any{}
		for index := step; index >= 0; index-- {
			version := "version-current"
			if index > 0 {
				version = fmt.Sprintf("version-%d", index)
			}
			deployments = append(deployments, map[string]any{"id": fmt.Sprintf("deployment-%d", index), "versions": []any{map[string]any{"version_id": version, "percentage": 100}}})
		}
		surfaces["scriptDeployments"] = map[string]any{"deployments": deployments}
		for index, secret := range canonicalSecrets {
			if kind == "rotate" || step > index {
				surfaces["scriptSecrets"] = append(surfaces["scriptSecrets"].([]any), map[string]any{"name": secret})
				settings := surfaces["workerSettings"].(map[string]any)
				settings["bindings"] = append(settings["bindings"].([]any), map[string]any{"name": secret, "type": "secret_text"})
			}
		}
		for index := 1; index <= step; index++ {
			surfaces["scriptVersions"] = append(surfaces["scriptVersions"].([]any), map[string]any{"id": fmt.Sprintf("version-%d", index)})
		}
	} else if kind == "account" {
		surfaces["scriptDeployments"] = map[string]any{"deployments": []any{map[string]any{"id": "deployment-current", "versions": []any{map[string]any{"version_id": "version-current", "percentage": 100}}}}}
		if step == 0 {
			surfaces["accountWorkersDev"] = map[string]any{"absent": true}
		} else {
			surfaces["accountWorkersDev"] = map[string]any{"subdomain": "agentscope-dev"}
		}
		surfaces["scriptSecrets"] = []any{map[string]any{"name": "CRABBOX_ADMIN_TOKEN"}, map[string]any{"name": "CRABBOX_SHARED_TOKEN"}, map[string]any{"name": "HETZNER_TOKEN"}}
	} else {
		retirementDeployments := []any{}
		for index := min(step, 5); index >= 3; index-- {
			retirementDeployments = append(retirementDeployments, map[string]any{"id": fmt.Sprintf("retirement-deployment-%d", index), "versions": []any{map[string]any{"version_id": fmt.Sprintf("retirement-version-%d", index), "percentage": 100}}})
		}
		retirementDeployments = append(retirementDeployments, map[string]any{"id": "deployment-current", "versions": []any{map[string]any{"version_id": "version-current", "percentage": 100}}})
		surfaces["scriptDeployments"] = map[string]any{"deployments": retirementDeployments}
		for index := 3; index <= min(step, 5); index++ {
			surfaces["scriptVersions"] = append(surfaces["scriptVersions"].([]any), map[string]any{"id": fmt.Sprintf("retirement-version-%d", index), "migration_tag": "v1"})
		}
		secrets := append([]string{}, canonicalSecrets...)
		if step >= 3 {
			secrets = secrets[1:]
		}
		if step >= 4 {
			secrets = secrets[1:]
		}
		if step >= 5 {
			secrets = secrets[1:]
		}
		items := []any{}
		for _, secret := range secrets {
			items = append(items, map[string]any{"name": secret})
		}
		surfaces["scriptSecrets"] = items
		if step >= 1 {
			surfaces["scriptSchedules"] = []any{}
		}
		if step >= 2 {
			surfaces["scriptWorkersDev"] = map[string]any{"enabled": false}
		}
		if step >= 6 {
			surfaces["durableObjects"] = []any{}
			surfaces["workerSettings"] = map[string]any{"bindings": []any{}, "compatibility_date": "2026-04-30", "compatibility_flags": []any{"nodejs_compat"}, "cache_options": map[string]any{"enabled": false}, "migrations": map[string]any{"new_tag": "v2-retire-fleet-durable-object", "old_tag": "v1", "deleted_classes": []any{"FleetDurableObject"}}}
			terminalDeployments := append([]any{map[string]any{"id": "terminal-deployment", "versions": []any{map[string]any{"version_id": "terminal-version", "percentage": 100}}}}, retirementDeployments...)
			surfaces["scriptDeployments"] = map[string]any{"deployments": terminalDeployments}
			surfaces["scriptVersions"] = append(surfaces["scriptVersions"].([]any), map[string]any{"id": "terminal-version", "migration_tag": "v2-retire-fleet-durable-object"})
		}
		if step >= 7 {
			versions := []any{}
			for _, version := range objectSlice(surfaces["scriptVersions"]) {
				if fmt.Sprint(version["id"]) != "version-old" {
					versions = append(versions, version)
				}
			}
			surfaces["scriptVersions"] = versions
		}
		if step >= 8 {
			surfaces["accountWorkers"], surfaces["durableObjects"] = []any{}, []any{}
			for _, name := range []string{"scriptSettings", "workerSettings", "scriptDeployments", "scriptVersions", "scriptSchedules", "scriptSecrets", "scriptTails", "scriptWorkersDev"} {
				surfaces[name] = map[string]any{"absent": true}
			}
		}
	}
	identities := []string{"workerVersion=version-current", "namespaceId=namespace-1", "migrationTag=v1"}
	if kind == "retire" && step >= 8 {
		identities = []string{"migrationTag=v2-retire-fleet-durable-object"}
	}
	return StateObservation{SchemaVersion: SchemaVersion, AccountID: account, WorkerName: WorkerName, ObservedAt: now, Surfaces: surfaces, IdentitySet: identities}
}

func freshWorkerState(account string, now time.Time) StateObservation {
	state := syntheticState(account, 0, "deploy", now)
	state.Surfaces["accountWorkers"] = []any{}
	state.Surfaces["durableObjects"] = []any{}
	for _, name := range []string{"scriptDeployments", "scriptSchedules", "scriptSecrets", "scriptSettings", "workerSettings", "scriptTails", "scriptWorkersDev", "scriptVersions"} {
		state.Surfaces[name] = map[string]any{"absent": true}
	}
	state.IdentitySet = []string{}
	return state
}

func freshDeployedState(account string, step int, now time.Time) StateObservation {
	state := syntheticState(account, step, "deploy", now)
	versions := []any{}
	for index := 0; index <= step; index++ {
		versions = append(versions, map[string]any{"id": fmt.Sprintf("version-%d", index), "migration_tag": "v1"})
	}
	state.Surfaces["scriptVersions"] = versions
	deployments := []any{}
	for index := step; index >= 0; index-- {
		deployments = append(deployments, map[string]any{"id": fmt.Sprintf("deployment-%d", index), "versions": []any{map[string]any{"version_id": fmt.Sprintf("version-%d", index), "percentage": 100}}})
	}
	state.Surfaces["scriptDeployments"] = map[string]any{"deployments": deployments}
	return state
}

type sequenceStateObserver struct {
	mu     sync.Mutex
	states []StateObservation
	next   int
}

func (observer *sequenceStateObserver) Observe(_ context.Context, _ []byte, now time.Time) (StateObservation, error) {
	observer.mu.Lock()
	defer observer.mu.Unlock()
	if observer.next >= len(observer.states) {
		return StateObservation{}, errors.New("synthetic observer exhausted")
	}
	state := observer.states[observer.next]
	state.ObservedAt = now
	observer.next++
	return state, nil
}

func (item fixture) plan() (Plan, []byte) {
	pre, _, _ := syntheticState(item.installation.AccountID, 0, "rotate", item.now).Digests()
	plan := Plan{SchemaVersion: SchemaVersion, Kind: "rotate-secrets", AccountID: item.installation.AccountID, EnvironmentID: item.installation.EnvironmentID, WorkerName: WorkerName, SourceCommit: strings.Repeat("a", 40), ToolchainIdentity: item.toolchain, AdmissionSHA256: item.installation.AdmissionSHA256, PermissionManifestSHA256: item.installation.PermissionManifestSHA256, ProfileSHA256: item.profileDigest, ObservablePrestateSHA256: pre, ObservationID: "observation-1", CurrentWorkerVersionID: "version-current", DurableObjectNamespaceID: "namespace-1", CurrentMigrationTag: "v1", CompatibleVersionDetailSHA256: "none", HetznerProjectID: item.installation.HetznerProjectID, Operations: []Operation{
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-admin", SecretName: pointer("CRABBOX_ADMIN_TOKEN"), SlotID: pointer("slot-crabbox-admin"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-shared", SecretName: pointer("CRABBOX_SHARED_TOKEN"), SlotID: pointer("slot-crabbox-shared"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-provider", SecretName: pointer("HETZNER_TOKEN"), SlotID: pointer("slot-hetzner-worker"), SlotVersion: pointer("version-1")},
	}, IssuedAt: item.now.Add(-time.Minute), ExpiresAt: item.now.Add(10 * time.Minute), Nonce: "nonce-1"}
	plan.IntendedTerminalStateSHA256 = terminalContractSHA256(plan)
	data, err := json.Marshal(plan)
	if err != nil {
		item.t.Fatal(err)
	}
	return plan, data
}

func (item fixture) authority(plan Plan, planData []byte) ([]byte, []byte, []byte) {
	authorization, err := item.store.SignAuthorization(planData, plan, item.now, syntheticOperatorPassphrase)
	if err != nil {
		item.t.Fatal(err)
	}
	authorizationData, _ := json.Marshal(authorization)
	quotas := map[string]Quota{}
	for _, name := range requiredQuotaNames() {
		quotas[name] = Quota{Limit: 100, Used: 10, SourceIdentity: "source-" + name}
	}
	observation := Observation{SchemaVersion: SchemaVersion, AccountID: item.installation.AccountID, CredentialRole: "billing-product-read-only", WorkersPlan: "free-no-overage", AllAccountConsumersIncluded: true, Quotas: quotas, ObservedAt: item.now.Add(-time.Minute), ExpiresAt: item.now.Add(10 * time.Minute), ObservationID: plan.ObservationID}
	observationData, _ := json.Marshal(observation)
	attestation, err := item.store.SignObservation(observationData, observation, item.now, syntheticOperatorPassphrase)
	if err != nil {
		item.t.Fatal(err)
	}
	attestationData, _ := json.Marshal(attestation)
	return authorizationData, observationData, attestationData
}

func (item fixture) retirementPlan() (Plan, []byte) {
	providerZero, tombstone := strings.Repeat("6", 64), strings.Repeat("7", 64)
	pre, _, _ := syntheticState(item.installation.AccountID, 0, "retire", item.now).Digests()
	plan := Plan{SchemaVersion: SchemaVersion, Kind: "retire", AccountID: item.installation.AccountID, EnvironmentID: item.installation.EnvironmentID, WorkerName: WorkerName, SourceCommit: strings.Repeat("a", 40), ToolchainIdentity: item.toolchain, AdmissionSHA256: item.installation.AdmissionSHA256, PermissionManifestSHA256: item.installation.PermissionManifestSHA256, ProfileSHA256: item.installation.TerminalProfileSHA256, ObservablePrestateSHA256: pre, ObservationID: "observation-retire", CurrentWorkerVersionID: "version-current", DurableObjectNamespaceID: "namespace-1", CurrentMigrationTag: "v1", CompatibleVersionDetailSHA256: "none", HetznerProjectID: item.installation.HetznerProjectID, ProviderZeroSHA256: &providerZero, RetirementTombstoneSHA256: &tombstone, AcquisitionFreezeID: pointer("freeze-1"), LauncherCredentialRevocationID: pointer("revocation-1"), Operations: []Operation{
		{Action: "worker.schedule.delete", Target: WorkerName, RequestID: "delete-schedule"},
		{Action: "worker.scriptWorkersDev.disable", Target: WorkerName, RequestID: "disable-workers-dev"},
		{Action: "worker.secret.delete", Target: WorkerName, RequestID: "delete-admin", SecretName: pointer("CRABBOX_ADMIN_TOKEN"), SlotID: pointer("slot-crabbox-admin"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.delete", Target: WorkerName, RequestID: "delete-shared", SecretName: pointer("CRABBOX_SHARED_TOKEN"), SlotID: pointer("slot-crabbox-shared"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.delete", Target: WorkerName, RequestID: "delete-provider", SecretName: pointer("HETZNER_TOKEN"), SlotID: pointer("slot-hetzner-worker"), SlotVersion: pointer("version-1")},
		{Action: "worker.terminalArtifact.deploy", Target: WorkerName, RequestID: "terminal-deploy", ProfileSHA256: pointer(item.installation.TerminalProfileSHA256), EntryPointSHA256: pointer(item.installation.TerminalEntryPointSHA256), ProviderZeroSHA256: &providerZero, RetirementTombstoneSHA256: &tombstone},
		{Action: "worker.version.delete", Target: WorkerName, RequestID: "delete-version", VersionID: pointer("version-old")},
		{Action: "worker.delete", Target: WorkerName, RequestID: "delete-worker"},
	}, RollbackActions: []Operation{}, IssuedAt: item.now.Add(-time.Minute), ExpiresAt: item.now.Add(10 * time.Minute), Nonce: "retirement-nonce"}
	plan.IntendedTerminalStateSHA256 = terminalContractSHA256(plan)
	data, err := json.Marshal(plan)
	if err != nil {
		item.t.Fatal(err)
	}
	return plan, data
}

func (item fixture) signedRetirementEvidence(plan Plan) []byte {
	evidence := RetirementEvidence{SchemaVersion: SchemaVersion, Domain: RetirementEvidenceDomain, InstallationID: item.installation.InstallationID, EnvironmentID: item.installation.EnvironmentID, AccountID: item.installation.AccountID, HetznerProjectID: item.installation.HetznerProjectID, WorkerName: WorkerName, WorkerVersionID: plan.CurrentWorkerVersionID, DurableObjectNamespaceID: plan.DurableObjectNamespaceID, MigrationTag: plan.CurrentMigrationTag, AcquisitionFreezeID: *plan.AcquisitionFreezeID, LauncherCredentialRevocationID: *plan.LauncherCredentialRevocationID, ProviderObservationSHA256: *plan.ProviderZeroSHA256, CoordinatorObservationSHA256: strings.Repeat("9", 64), RetirementTombstoneSHA256: *plan.RetirementTombstoneSHA256, ObservedAt: item.now.Add(-time.Minute), ExpiresAt: item.now.Add(10 * time.Minute)}
	signed, err := item.store.SignRetirementEvidence(evidence, item.now, syntheticOperatorPassphrase)
	if err != nil {
		item.t.Fatal(err)
	}
	data, _ := json.Marshal(signed)
	return data
}

type recordingExecutor struct {
	mu        sync.Mutex
	calls     []Invocation
	failureAt int
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func (executor *recordingExecutor) Invoke(_ context.Context, invocation Invocation) (MutationReceipt, error) {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	executor.calls = append(executor.calls, invocation)
	if executor.failureAt > 0 && len(executor.calls) == executor.failureAt {
		return MutationReceipt{}, errors.New("synthetic")
	}
	return MutationReceipt{RequestID: invocation.RequestID, Action: invocation.Action, ResponseSHA256: SHA256([]byte(invocation.RequestID))}, nil
}
func (executor *recordingExecutor) ValidateCoordinatorCredentials(_ context.Context, _ string, secrets map[string][]byte) (MutationReceipt, error) {
	if len(secrets) != len(canonicalSecrets) {
		return MutationReceipt{}, errors.New("synthetic credential set")
	}
	return MutationReceipt{RequestID: "credential-forward-check", Action: "coordinator.credentials.validate", ResponseSHA256: strings.Repeat("c", 64)}, nil
}
func (executor *recordingExecutor) count() int {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return len(executor.calls)
}

type advancingObserver struct {
	mu      sync.Mutex
	account string
	now     time.Time
	calls   int
	kind    string
}

func (observer *advancingObserver) Observe(_ context.Context, _ []byte, now time.Time) (StateObservation, error) {
	observer.mu.Lock()
	defer observer.mu.Unlock()
	step := observer.calls / 2
	if observer.calls == 0 {
		step = 0
	}
	observer.calls++
	if (observer.kind == "deploy" || observer.kind == "rotate") && step > 3 {
		step = 3
	}
	return syntheticState(observer.account, step, observer.kind, now), nil
}

func (item fixture) observer() StateObserver {
	return &advancingObserver{account: item.installation.AccountID, now: item.now, kind: "rotate"}
}

func TestSyntheticStateDigestIsDeterministic(t *testing.T) {
	now := time.Date(2026, 8, 26, 19, 0, 0, 0, time.UTC)
	left, _, _ := syntheticState("account-1", 0, "deploy", now).Digests()
	right, _, _ := syntheticState("account-1", 0, "deploy", now).Digests()
	if left != right {
		t.Fatalf("synthetic state drift: %s != %s", left, right)
	}
}

func TestCanonicalInstallInputsRejectEverySubstitutedAuthority(t *testing.T) {
	policyRoot := filepath.Join("..", "..", "..", "..", "ops", "crabbox-coordinator")
	admission, err := os.ReadFile(filepath.Join(policyRoot, "admission.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(policyRoot, "permission-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	entry, err := os.ReadFile(filepath.Join(policyRoot, "terminal-worker.agentscope.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	environment := "asgcf_0123456789abcdef0123456789abcdef"
	live, _ := json.Marshal(expectedLiveProfile(environment))
	terminal, _ := json.Marshal(expectedTerminalProfile())
	identity := ToolchainIdentity{NodeVersion: CanonicalNodeVersion, NodeArchiveSHA256: CanonicalNodeArchiveSHA256, WranglerVersion: CanonicalWranglerVersion, WorkerLockSHA256: CanonicalWorkerLockSHA256, GoVersion: CanonicalGoVersion, GoArchiveSHA256: CanonicalGoArchiveSHA256, CrabboxClientSHA256: CanonicalCrabboxClientSHA256}
	if err := ValidateCanonicalInstallInputs(admission, manifest, live, terminal, entry, environment, identity); err != nil {
		t.Fatalf("canonical inputs rejected: %v", err)
	}
	mutated := identity
	mutated.NodeArchiveSHA256 = strings.Repeat("b", 64)
	if ValidateCanonicalInstallInputs(admission, manifest, live, terminal, entry, environment, mutated) == nil {
		t.Fatal("substituted Node authority accepted")
	}
	changed := append([]byte{}, entry...)
	changed = append(changed, '\n')
	if ValidateCanonicalInstallInputs(admission, manifest, live, terminal, changed, environment, identity) == nil {
		t.Fatal("substituted terminal artifact accepted")
	}
	var profile map[string]any
	_ = json.Unmarshal(live, &profile)
	profile["workers_dev"] = false
	changedLive, _ := json.Marshal(profile)
	if ValidateCanonicalInstallInputs(admission, manifest, changedLive, terminal, entry, environment, identity) == nil {
		t.Fatal("substituted deployment profile accepted")
	}
}

func TestPlanBuilderOwnsClosedDeployAndAccountSequences(t *testing.T) {
	item := newFixture(t)
	state := syntheticState(item.installation.AccountID, 0, "deploy", item.now)
	state.Surfaces["rollbackVersionDetail"] = map[string]any{"id": "version-current", "migration_tag": "v1", "bindings": state.Surfaces["workerSettings"].(map[string]any)["bindings"], "annotations": map[string]any{"workers/message": "agentscope-source:" + item.installation.CoordinatorCommit}}
	slots := map[string]SlotReference{}
	for _, secret := range canonicalSecrets {
		slots[secret] = SlotReference{SlotID: "slot-" + strings.ToLower(secret), SlotVersion: "version-1"}
	}
	plan, err := BuildPlan(item.installation, PlanBuildInput{Kind: "deploy", State: state, ObservationID: "observation-builder", Now: item.now})
	if err != nil || len(plan.Operations) != 1 || plan.Operations[0].Action != "worker.deploy" {
		t.Fatalf("deploy plan: %v %#v", err, plan.Operations)
	}
	rotation, err := BuildPlan(item.installation, PlanBuildInput{Kind: "rotate-secrets", State: state, ObservationID: "observation-builder", Slots: slots, Now: item.now})
	if err != nil || len(rotation.Operations) != 3 {
		t.Fatalf("rotation plan: %v %#v", err, rotation.Operations)
	}
	accountState := syntheticState(item.installation.AccountID, 0, "deploy", item.now)
	accountState.Surfaces["accountWorkersDev"] = map[string]any{"absent": true}
	accountPlan, err := BuildPlan(item.installation, PlanBuildInput{Kind: "account-workers-dev-enable", State: accountState, ObservationID: "observation-builder", AccountSubdomain: "agentscope-dev", Now: item.now})
	if err != nil || len(accountPlan.Operations) != 1 || accountPlan.Operations[0].Subdomain == nil || *accountPlan.Operations[0].Subdomain != "agentscope-dev" {
		t.Fatalf("account plan: %v %#v", err, accountPlan.Operations)
	}
}

func TestFreshDeployAdmitsWorkerBeforeSecretMutations(t *testing.T) {
	item := newFixture(t)
	fresh := freshWorkerState(item.installation.AccountID, item.now)
	slots := map[string]SlotReference{}
	for _, secret := range canonicalSecrets {
		role := map[string]string{"CRABBOX_ADMIN_TOKEN": "crabbox-admin", "CRABBOX_SHARED_TOKEN": "crabbox-shared", "HETZNER_TOKEN": "hetzner-worker"}[secret]
		slots[secret] = SlotReference{SlotID: "slot-" + role, SlotVersion: "version-1"}
	}
	plan, err := BuildPlan(item.installation, PlanBuildInput{Kind: "deploy", State: fresh, ObservationID: "observation-fresh", Slots: slots, Now: item.now})
	if err != nil || len(plan.Operations) != 4 || plan.Operations[0].Action != "worker.deploy" {
		t.Fatalf("fresh plan: %v %#v", err, plan.Operations)
	}
	orphanNamespace := freshWorkerState(item.installation.AccountID, item.now)
	orphanNamespace.Surfaces["durableObjects"] = []any{map[string]any{"id": "namespace-orphan", "script": WorkerName, "class": "FleetDurableObject"}}
	if _, err := BuildPlan(item.installation, PlanBuildInput{Kind: "deploy", State: orphanNamespace, ObservationID: "observation-orphan", Slots: slots, Now: item.now}); err == nil || !strings.Contains(err.Error(), "E_PLAN_BUILD_RESOURCE_IDENTITY") {
		t.Fatalf("orphan namespace admitted by builder: %v", err)
	}
	orphanMigration := freshWorkerState(item.installation.AccountID, item.now)
	orphanMigration.Surfaces["workerSettings"] = map[string]any{"migrations": map[string]any{"new_tag": "v1"}}
	if _, err := BuildPlan(item.installation, PlanBuildInput{Kind: "deploy", State: orphanMigration, ObservationID: "observation-orphan", Slots: slots, Now: item.now}); err == nil || !strings.Contains(err.Error(), "E_PLAN_BUILD_RESOURCE_IDENTITY") {
		t.Fatalf("orphan migration admitted by builder: %v", err)
	}
	contradictory := plan
	contradictory.DurableObjectNamespaceID = "namespace-orphan"
	contradictory.IntendedTerminalStateSHA256 = terminalContractSHA256(contradictory)
	if err := ValidatePlanCandidate(contradictory, item.installation, item.now); err == nil || !strings.Contains(err.Error(), "E_PLAN_RESOURCE_IDENTITY") {
		t.Fatalf("orphan namespace admitted by candidate validator: %v", err)
	}
	targetEquivalent := plan
	targetEquivalent.CurrentMigrationTag = "v1"
	if terminalContractSHA256(plan) != terminalContractSHA256(targetEquivalent) {
		t.Fatal("fresh terminal contract was derived from absent prestate migration")
	}
	data, _ := json.Marshal(plan)
	authorization, observation, attestation := item.authority(plan, data)
	deployed0 := freshDeployedState(item.installation.AccountID, 0, item.now)
	deployed1 := freshDeployedState(item.installation.AccountID, 1, item.now)
	deployed2 := freshDeployedState(item.installation.AccountID, 2, item.now)
	deployed3 := freshDeployedState(item.installation.AccountID, 3, item.now)
	identities, err := actionTransitionIdentities(plan, plan.Operations[0], fresh, deployed0)
	if err != nil || !stringInSlice("durable-object-namespace=namespace-1", identities) || !stringInSlice("migration=v1", identities) {
		t.Fatalf("fresh Durable Object identity was not bound: %v %v", err, identities)
	}
	observer := &sequenceStateObserver{states: []StateObservation{fresh, fresh, deployed0, deployed0, deployed1, deployed1, deployed2, deployed2, deployed3, deployed3, deployed3}}
	executor := &recordingExecutor{}
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, observer); err != nil {
		t.Fatal(err)
	}
	if executor.count() != 4 || executor.calls[0].Action != "worker.deploy" {
		t.Fatalf("fresh mutation order %#v", executor.calls)
	}
}

func TestAccountWorkersDevPlanAppliesThroughClosedAction(t *testing.T) {
	item := newFixture(t)
	state := syntheticState(item.installation.AccountID, 0, "account", item.now)
	plan, err := BuildPlan(item.installation, PlanBuildInput{Kind: "account-workers-dev-enable", State: state, ObservationID: "observation-account", AccountSubdomain: "agentscope-dev", Now: item.now})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(plan)
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{}
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.accountObserver()); err != nil {
		t.Fatal(err)
	}
	if executor.count() != 1 || executor.calls[0].Action != "account.workersDev.enable" || executor.calls[0].Subdomain != "agentscope-dev" {
		t.Fatalf("unexpected account action %#v", executor.calls)
	}
}

func TestActionTransitionRejectsUnrelatedDriftAndWriteOnlyRotation(t *testing.T) {
	item := newFixture(t)
	plan, _ := item.plan()
	before := syntheticState(item.installation.AccountID, 0, "deploy", item.now)
	after := syntheticState(item.installation.AccountID, 1, "deploy", item.now)
	if err := ValidateActionTransition(plan, plan.Operations[0], before, after); err != nil {
		t.Fatalf("initial secret transition: %v", err)
	}
	drifted := syntheticState(item.installation.AccountID, 1, "deploy", item.now)
	drifted.Surfaces["accountWorkersDev"] = map[string]any{"enabled": false}
	if err := ValidateActionTransition(plan, plan.Operations[0], before, drifted); err == nil {
		t.Fatal("unrelated account drift accepted")
	}
	if err := ValidateActionTransition(plan, plan.Operations[0], after, after); err == nil || !strings.Contains(err.Error(), "E_SECRET_DEPLOYMENT_IDENTITY") {
		t.Fatalf("no-op rotation accepted: %v", err)
	}
	fresh := freshWorkerState(item.installation.AccountID, item.now)
	slots := map[string]SlotReference{}
	for _, secret := range canonicalSecrets {
		role := map[string]string{"CRABBOX_ADMIN_TOKEN": "crabbox-admin", "CRABBOX_SHARED_TOKEN": "crabbox-shared", "HETZNER_TOKEN": "hetzner-worker"}[secret]
		slots[secret] = SlotReference{SlotID: "slot-" + role, SlotVersion: "version-1"}
	}
	deploy, err := BuildPlan(item.installation, PlanBuildInput{Kind: "deploy", State: fresh, ObservationID: "observation-unrelated", Slots: slots, Now: item.now})
	if err != nil {
		t.Fatal(err)
	}
	deployed := freshDeployedState(item.installation.AccountID, 0, item.now)
	deployed.Surfaces["durableObjects"] = append(deployed.Surfaces["durableObjects"].([]any), map[string]any{"id": "unrelated-namespace", "script": "other-worker", "class": "OtherClass"})
	if err := ValidateActionTransition(deploy, deploy.Operations[0], fresh, deployed); err == nil || !strings.Contains(err.Error(), "E_UNRELATED_RESOURCE_DRIFT") {
		t.Fatalf("unrelated Durable Object creation accepted: %v", err)
	}
	retirement, _ := item.retirementPlan()
	deleteBefore := syntheticState(item.installation.AccountID, 2, "retire", item.now)
	deleteAfter := syntheticState(item.installation.AccountID, 3, "retire", item.now)
	deleteAfter.Surfaces["scriptSecrets"] = []any{}
	if err := ValidateActionTransition(retirement, retirement.Operations[2], deleteBefore, deleteAfter); err == nil || !strings.Contains(err.Error(), "E_SECRET_UNEXPECTED_DELTA") {
		t.Fatalf("collateral secret deletion accepted: %v", err)
	}
	rollbackState := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	rollbackState.Surfaces["rollbackVersionDetail"] = map[string]any{"id": "version-old", "migration_tag": "v1", "bindings": rollbackState.Surfaces["workerSettings"].(map[string]any)["bindings"], "annotations": map[string]any{"workers/message": "agentscope-source:" + item.installation.CoordinatorCommit}}
	rollbackPlan, err := BuildPlan(item.installation, PlanBuildInput{Kind: "rollback", State: rollbackState, ObservationID: "observation-rollback", RollbackVersionID: "version-old", Now: item.now})
	if err != nil {
		t.Fatal(err)
	}
	if !digestPattern.MatchString(rollbackPlan.CompatibleVersionDetailSHA256) {
		t.Fatal("rollback plan did not bind the canonical compatible-version detail")
	}
	rollbackBefore := rollbackState
	rollbackAfter := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	rollbackAfter.Surfaces["rollbackVersionDetail"] = rollbackState.Surfaces["rollbackVersionDetail"]
	rollbackAfter.Surfaces["scriptDeployments"] = map[string]any{"id": "wrong-current-deployment", "versions": []any{map[string]any{"version_id": "wrong-current-version", "percentage": 100}}, "history": []any{map[string]any{"id": "version-old"}}}
	if err := ValidateActionTransition(rollbackPlan, rollbackPlan.Operations[0], rollbackBefore, rollbackAfter); err == nil || !strings.Contains(err.Error(), "E_ROLLBACK_NOT_OBSERVED") {
		t.Fatalf("historical rollback identity accepted as current: %v", err)
	}
	tamperedAfter := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	tamperedAfter.Surfaces["scriptDeployments"] = map[string]any{"deployments": []any{
		map[string]any{"id": "rollback-deployment", "versions": []any{map[string]any{"version_id": "version-old", "percentage": 100}}},
		map[string]any{"id": "deployment-0", "versions": []any{map[string]any{"version_id": "version-current", "percentage": 100}}},
	}}
	tamperedAfter.Surfaces["rollbackVersionDetail"] = map[string]any{"id": "version-old", "migration_tag": "v0", "bindings": []any{}, "annotations": map[string]any{"workers/message": "agentscope-source:" + strings.Repeat("b", 40)}}
	badDetailState := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	badDetailState.Surfaces["rollbackVersionDetail"] = tamperedAfter.Surfaces["rollbackVersionDetail"]
	goodDigest, _, _ := rollbackBefore.Digests()
	badDigest, _, _ := badDetailState.Digests()
	if goodDigest != badDigest || validateCompatibleVersionEvidence(rollbackPlan, badDetailState) == nil || ValidateActionTransition(rollbackPlan, rollbackPlan.Operations[0], rollbackBefore, tamperedAfter) == nil {
		t.Fatal("fresh rollback detail substitution was not rejected independently of the core-state digest")
	}
	incompatible := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	incompatible.Surfaces["rollbackVersionDetail"] = map[string]any{"id": "version-old", "migration_tag": "v0", "bindings": incompatible.Surfaces["workerSettings"].(map[string]any)["bindings"]}
	if _, err := BuildPlan(item.installation, PlanBuildInput{Kind: "rollback", State: incompatible, ObservationID: "observation-incompatible", RollbackVersionID: "version-old", Now: item.now}); err == nil || !strings.Contains(err.Error(), "E_PLAN_BUILD_VERSION_COMPATIBILITY") {
		t.Fatalf("unobserved rollback compatibility accepted: %v", err)
	}
	wrongSource := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	wrongSource.Surfaces["rollbackVersionDetail"] = map[string]any{"id": "version-old", "migration_tag": "v1", "bindings": wrongSource.Surfaces["workerSettings"].(map[string]any)["bindings"], "annotations": map[string]any{"workers/message": "agentscope-source:" + strings.Repeat("b", 40)}}
	if _, err := BuildPlan(item.installation, PlanBuildInput{Kind: "rollback", State: wrongSource, ObservationID: "observation-wrong-source", RollbackVersionID: "version-old", Now: item.now}); err == nil || !strings.Contains(err.Error(), "E_PLAN_BUILD_VERSION_COMPATIBILITY") {
		t.Fatalf("rollback to unadmitted coordinator source accepted: %v", err)
	}
}

func TestMigrationNamespaceAndActionOraclesAreExact(t *testing.T) {
	item := newFixture(t)
	plan, _ := item.plan()
	bareMigration := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	bareMigration.Surfaces["workerSettings"].(map[string]any)["migrations"] = map[string]any{"new_tag": "v1"}
	if err := validateDeploymentProfile(plan, bareMigration, true); err == nil || !strings.Contains(err.Error(), "E_DEPLOYMENT_MIGRATION_STATE") {
		t.Fatalf("migration without SQLite class admission accepted: %v", err)
	}

	unrelatedNamespace := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	unrelatedNamespace.Surfaces["durableObjects"] = []any{map[string]any{"id": "namespace-other", "script": "other-worker", "class": "FleetDurableObject"}}
	if _, err := BuildPlan(item.installation, PlanBuildInput{Kind: "deploy", State: unrelatedNamespace, ObservationID: "observation-unrelated-namespace", Now: item.now}); err == nil {
		t.Fatal("same-class namespace owned by another Worker was adopted")
	}

	rotation, err := BuildPlan(item.installation, PlanBuildInput{Kind: "rotate-secrets", State: syntheticState(item.installation.AccountID, 0, "rotate", item.now), ObservationID: "observation-rotation", Slots: map[string]SlotReference{
		"CRABBOX_ADMIN_TOKEN":  {SlotID: "slot-crabbox-admin", SlotVersion: "version-1"},
		"CRABBOX_SHARED_TOKEN": {SlotID: "slot-crabbox-shared", SlotVersion: "version-1"},
		"HETZNER_TOKEN":        {SlotID: "slot-hetzner-worker", SlotVersion: "version-1"},
	}, Now: item.now})
	if err != nil {
		t.Fatal(err)
	}
	before := syntheticState(item.installation.AccountID, 0, "rotate", item.now)
	after := syntheticState(item.installation.AccountID, 1, "rotate", item.now)
	after.Surfaces["scriptDeployments"].(map[string]any)["collateral"] = "unexpected"
	if err := ValidateActionTransition(rotation, rotation.Operations[0], before, after); err == nil || (!strings.Contains(err.Error(), "E_SECRET_UNEXPECTED_DELTA") && !strings.Contains(err.Error(), "E_SECRET_DEPLOYMENT_IDENTITY")) {
		t.Fatalf("secret write with collateral deployment drift accepted: %v", err)
	}

	retirement, _ := item.retirementPlan()
	terminalBefore := syntheticState(item.installation.AccountID, 5, "retire", item.now)
	terminalAfter := syntheticState(item.installation.AccountID, 6, "retire", item.now)
	delete(terminalAfter.Surfaces["workerSettings"].(map[string]any), "migrations")
	if err := ValidateActionTransition(retirement, retirement.Operations[5], terminalBefore, terminalAfter); err == nil || !strings.Contains(err.Error(), "E_TERMINAL_DEPLOY_NOT_OBSERVED") {
		t.Fatalf("terminal deployment without class-deletion migration accepted: %v", err)
	}
	malformedTerminal := syntheticState(item.installation.AccountID, 6, "retire", item.now)
	malformedTerminal.Surfaces["workerSettings"].(map[string]any)["compatibility_date"] = "1999-01-01"
	malformedTerminal.Surfaces["workerSettings"].(map[string]any)["compatibility_flags"] = []any{"unsafe"}
	malformedTerminal.Surfaces["workerSettings"].(map[string]any)["logpush"] = true
	if err := ValidateActionTransition(retirement, retirement.Operations[5], terminalBefore, malformedTerminal); err == nil || !strings.Contains(err.Error(), "E_TERMINAL_DEPLOY_NOT_OBSERVED") {
		t.Fatalf("terminal deployment with noncanonical runtime settings accepted: %v", err)
	}
	secretDeleteBefore := syntheticState(item.installation.AccountID, 2, "retire", item.now)
	secretDeleteAfter := syntheticState(item.installation.AccountID, 3, "retire", item.now)
	if err := ValidateActionTransition(retirement, retirement.Operations[2], secretDeleteBefore, secretDeleteAfter); err != nil {
		t.Fatalf("Cloudflare-faithful secret deletion was rejected: %v", err)
	}
	workerDeleteAfter := syntheticState(item.installation.AccountID, 8, "retire", item.now)
	workerDeleteAfter.Surfaces["workerSettings"] = map[string]any{"residue": true}
	if err := ValidateActionTransition(retirement, retirement.Operations[7], syntheticState(item.installation.AccountID, 7, "retire", item.now), workerDeleteAfter); err == nil || !strings.Contains(err.Error(), "E_WORKER_DELETE_NOT_OBSERVED") {
		t.Fatalf("Worker deletion with residual settings accepted: %v", err)
	}
}

func TestTerminalObservationCannotBorrowUnrelatedResourceFields(t *testing.T) {
	item := newFixture(t)
	plan, _ := item.plan()
	state := syntheticState(item.installation.AccountID, 4, "deploy", item.now)
	if err := ValidateTerminalObservation(plan, state); err != nil {
		t.Fatalf("valid terminal state: %v", err)
	}
	settings := state.Surfaces["workerSettings"].(map[string]any)
	bindings := settings["bindings"].([]any)
	settings["bindings"] = bindings[1:]
	state.Surfaces["unrelatedWorker"] = map[string]any{"name": "FLEET", "class_name": "FleetDurableObject", "namespace_id": "namespace-1"}
	if ValidateTerminalObservation(plan, state) == nil {
		t.Fatal("unrelated binding satisfied target terminal oracle")
	}
	retirement, _ := item.retirementPlan()
	retired := syntheticState(item.installation.AccountID, 8, "retire", item.now)
	if err := ValidateTerminalObservation(retirement, retired); err != nil {
		t.Fatalf("valid retirement terminal state: %v", err)
	}
	retired.Surfaces["accountWorkers"] = []any{map[string]any{"id": WorkerName}}
	if ValidateTerminalObservation(retirement, retired) == nil {
		t.Fatal("retirement accepted target in account inventory")
	}
}

func TestTerminalObservationRejectsExtraProfileAuthority(t *testing.T) {
	item := newFixture(t)
	plan, _ := item.plan()
	state := syntheticState(item.installation.AccountID, 4, "deploy", item.now)
	settings := state.Surfaces["workerSettings"].(map[string]any)
	settings["bindings"] = append(settings["bindings"].([]any), map[string]any{"name": "UNPLANNED", "type": "plain_text", "text": "authority"})
	if err := ValidateTerminalObservation(plan, state); err == nil || !strings.Contains(err.Error(), "E_DEPLOYMENT_EXTRA_BINDING") {
		t.Fatalf("extra binding accepted: %v", err)
	}
	state = syntheticState(item.installation.AccountID, 4, "deploy", item.now)
	state.Surfaces["scriptSettings"].(map[string]any)["tail_consumers"] = []any{"unplanned-tail"}
	if err := ValidateTerminalObservation(plan, state); err == nil || !strings.Contains(err.Error(), "E_DEPLOYMENT_DIAGNOSTIC_MUTATION") {
		t.Fatalf("tail consumer accepted: %v", err)
	}
	state = syntheticState(item.installation.AccountID, 4, "deploy", item.now)
	state.Surfaces["workerSettings"].(map[string]any)["migrations"].(map[string]any)["new_tag"] = "replacement"
	if err := ValidateTerminalObservation(plan, state); err == nil || !strings.Contains(err.Error(), "E_DEPLOYMENT_MIGRATION_STATE") {
		t.Fatalf("migration drift accepted: %v", err)
	}
	state = syntheticState(item.installation.AccountID, 4, "deploy", item.now)
	state.Surfaces["workerSettings"].(map[string]any)["unplanned_setting"] = true
	if err := ValidateTerminalObservation(plan, state); err == nil || !strings.Contains(err.Error(), "E_DEPLOYMENT_EXTRA_WORKER_SETTING") {
		t.Fatalf("extra worker setting accepted: %v", err)
	}
	state = syntheticState(item.installation.AccountID, 4, "deploy", item.now)
	settings = state.Surfaces["workerSettings"].(map[string]any)
	settings["bindings"] = append(settings["bindings"].([]any), settings["bindings"].([]any)[0])
	if err := ValidateTerminalObservation(plan, state); err == nil || !strings.Contains(err.Error(), "E_DEPLOYMENT_EXTRA_BINDING") {
		t.Fatalf("duplicate allowed binding accepted: %v", err)
	}
	for name, mutate := range map[string]func(StateObservation){
		"cache enabled": func(state StateObservation) {
			state.Surfaces["workerSettings"].(map[string]any)["cache_options"].(map[string]any)["enabled"] = "false"
		},
		"worker logpush": func(state StateObservation) { state.Surfaces["workerSettings"].(map[string]any)["logpush"] = "false" },
		"worker observability": func(state StateObservation) {
			state.Surfaces["workerSettings"].(map[string]any)["observability"] = "disabled"
		},
		"script logpush": func(state StateObservation) { state.Surfaces["scriptSettings"].(map[string]any)["logpush"] = "false" },
		"observability": func(state StateObservation) {
			state.Surfaces["scriptSettings"].(map[string]any)["observability"].(map[string]any)["enabled"] = "false"
		},
	} {
		state = syntheticState(item.installation.AccountID, 4, "deploy", item.now)
		mutate(state)
		if err := ValidateTerminalObservation(plan, state); err == nil {
			t.Fatalf("malformed %s accepted", name)
		}
	}
}

func TestObservationDigestIgnoresInventoryOrdering(t *testing.T) {
	item := newFixture(t)
	first := syntheticState(item.installation.AccountID, 4, "deploy", item.now)
	first.Surfaces["accountWorkers"] = []any{map[string]any{"id": WorkerName}, map[string]any{"id": "unrelated-worker"}}
	second := syntheticState(item.installation.AccountID, 4, "deploy", item.now)
	second.Surfaces["accountWorkers"] = []any{map[string]any{"id": "unrelated-worker"}, map[string]any{"id": WorkerName}}
	firstDigest, _, err := first.Digests()
	if err != nil {
		t.Fatal(err)
	}
	secondDigest, _, err := second.Digests()
	if err != nil {
		t.Fatal(err)
	}
	if firstDigest != secondDigest {
		t.Fatal("equivalent inventory reorder produced drift")
	}
}

func (item fixture) retirementObserver() StateObserver {
	return &advancingObserver{account: item.installation.AccountID, now: item.now, kind: "retire"}
}

func (item fixture) accountObserver() StateObserver {
	return &advancingObserver{account: item.installation.AccountID, now: item.now, kind: "account"}
}

func TestInstalledRootsAndPrivateState(t *testing.T) {
	item := newFixture(t)
	seen := map[string]bool{}
	for role, root := range item.installation.Roots {
		if seen[root.PublicKey] {
			t.Fatalf("aliased root for %s", role)
		}
		seen[root.PublicKey] = true
		info, err := os.Stat(item.store.path("keys", role+".key"))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("key mode %o", info.Mode().Perm())
		}
	}
	for _, role := range []string{OwnerRole, RecoveryRole, BillingRole} {
		data, err := os.ReadFile(item.store.path("keys", role+".key"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "PBKDF2-HMAC-SHA256+A256GCM") {
			t.Fatalf("%s private key is not sealed", role)
		}
	}
	info, err := os.Stat(item.store.path("bin", "agentscope-crabbox-control"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o500 {
		t.Fatalf("launcher mode %o", info.Mode().Perm())
	}
}

func TestStrictJSONRejectsDuplicateAndUnknownKeys(t *testing.T) {
	var target map[string]any
	if err := strictJSON([]byte(`{"a":1,"a":2}`), &target); err == nil || !strings.Contains(err.Error(), "E_JSON_DUPLICATE_KEY") {
		t.Fatalf("duplicate accepted: %v", err)
	}
	var observation Observation
	if err := strictJSON([]byte(`{"unknown":true}`), &observation); err == nil || !strings.Contains(err.Error(), "E_JSON_SCHEMA") {
		t.Fatalf("unknown accepted: %v", err)
	}
}

func TestCandidateOrWrongRoleCannotAuthorize(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	if _, err := item.store.SignAuthorization(data, plan, item.now, []byte("wrong-passphrase-that-is-long-enough")); err == nil || !strings.Contains(err.Error(), "E_OPERATOR_AUTHENTICATION") {
		t.Fatalf("wrong operator passphrase accepted: %v", err)
	}
	authorizationData, _, _ := item.authority(plan, data)
	var authorization Authorization
	if err := strictJSON(authorizationData, &authorization); err != nil {
		t.Fatal(err)
	}
	authorization.KeyID = item.installation.Roots[BillingRole].KeyID
	forged, _ := json.Marshal(authorization)
	digest, _ := item.store.CredentialSetSHA256()
	if _, err := ValidatePlan(data, forged, item.installation, digest, item.now); err == nil {
		t.Fatal("wrong-role candidate authority accepted")
	}
}

func TestCredentialSetSubstitutionInvalidatesAuthorization(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorizationData, _, _ := item.authority(plan, data)
	metadata, err := item.store.credentialMetadata()
	if err != nil {
		t.Fatal(err)
	}
	entry := metadata["cloudflare-plan-read"]
	rotated, err := item.store.EnrollCredential(item.installation.EnvironmentID, "cloudflare-plan-read", "slot-plan-new", "version-2", []byte(strings.Repeat("z", 32)), item.now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if rotated.SupersedesSlotID != entry.SlotID || rotated.SupersedesVersion != entry.SlotVersion {
		t.Fatal("credential rotation did not authenticate its predecessor")
	}
	digest, err := item.store.CredentialSetSHA256()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidatePlan(data, authorizationData, item.installation, digest, item.now); err == nil || !strings.Contains(err.Error(), "E_AUTHORIZATION_BINDING") {
		t.Fatalf("credential substitution accepted: %v", err)
	}
}

func TestCredentialMetadataRejectsIncompleteImmutableVersion(t *testing.T) {
	item := newFixture(t)
	directory := item.store.path("slots", "slot-incomplete")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeExclusive(filepath.Join(directory, "version-2.secret"), []byte("sealed-but-uncommitted"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeExclusive(filepath.Join(directory, "version-2.json.staging-deadbeef"), []byte("{partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.CredentialSetSHA256(); err == nil || (!strings.Contains(err.Error(), "E_SLOT_VERSION_INCOMPLETE") && !strings.Contains(err.Error(), "E_SLOT_VERSION_FILE")) {
		t.Fatalf("incomplete slot version accepted: %v", err)
	}
	if _, err := item.store.EnrollCredential(item.installation.EnvironmentID, "cloudflare-plan-read", "slot-incomplete", "version-2", []byte(strings.Repeat("q", 32)), item.now.Add(time.Second)); err != nil {
		t.Fatalf("incomplete immutable version was not recoverable: %v", err)
	}
}

func TestConcurrentCredentialEnrollmentProducesOneAuthenticatedHead(t *testing.T) {
	item := newFixture(t)
	var wait sync.WaitGroup
	errorsSeen := make(chan error, 2)
	for index := 2; index <= 3; index++ {
		index := index
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := item.store.EnrollCredential(item.installation.EnvironmentID, "cloudflare-plan-read", fmt.Sprintf("slot-plan-%d", index), fmt.Sprintf("version-%d", index), []byte(strings.Repeat(string(rune('p'+index)), 32)), item.now.Add(time.Duration(index)*time.Second))
			errorsSeen <- err
		}()
	}
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		if err != nil {
			t.Fatalf("serialized enrollment failed: %v", err)
		}
	}
	metadata, err := item.store.credentialMetadata()
	if err != nil {
		t.Fatalf("concurrent enrollment created a branch: %v", err)
	}
	if head := metadata["cloudflare-plan-read"]; head.SupersedesVersion == "version-1" || head.SlotVersion == "version-1" {
		t.Fatalf("concurrent enrollment did not produce one successor chain: %#v", head)
	}
}

func TestApplyRejectsSupersededWorkerSecretVersion(t *testing.T) {
	item := newFixture(t)
	if _, err := item.store.EnrollCredential(item.installation.EnvironmentID, "crabbox-admin", "slot-admin-new", "version-2", []byte(strings.Repeat("z", 32)), item.now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{}
	err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.observer())
	if err == nil || !strings.Contains(err.Error(), "E_SLOT_SUPERSEDED") || executor.count() != 0 {
		t.Fatalf("superseded slot admitted: %v calls=%d", err, executor.count())
	}
}

func TestObservationRejectsPaidStaleAndWrongRoot(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	_, observationData, attestationData := item.authority(plan, data)
	if _, err := ValidateObservation(observationData, attestationData, item.installation, item.now); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateObservation(observationData, attestationData, item.installation, item.now.Add(20*time.Minute)); err == nil {
		t.Fatal("stale observation accepted")
	}
	var observation Observation
	_ = strictJSON(observationData, &observation)
	observation.PaidOrOverageEnabled = true
	paidData, _ := json.Marshal(observation)
	paidAttestation, _ := item.store.SignObservation(paidData, observation, item.now, syntheticOperatorPassphrase)
	paidAttestationData, _ := json.Marshal(paidAttestation)
	if _, err := ValidateObservation(paidData, paidAttestationData, item.installation, item.now); err == nil {
		t.Fatal("paid observation accepted")
	}
	observation.PaidOrOverageEnabled = false
	for _, name := range requiredQuotaNames() {
		observation.Quotas[name] = Quota{Limit: 100, Used: 10, SourceIdentity: "source-" + name}
	}
	boundary := requiredQuotaNames()[0]
	observation.Quotas[boundary] = Quota{Limit: 100, Used: 80, SourceIdentity: "source-" + boundary}
	if err := ValidateObservationCandidate(observation, item.installation, item.now); err == nil || !strings.Contains(err.Error(), "E_OBSERVATION_QUOTA") {
		t.Fatalf("80 percent quota boundary admitted: %v", err)
	}
}

func TestApplyConsumesBeforeResolutionAndNeverReplays(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	metadata, _ := item.store.credentialMetadata()
	provider := metadata["hetzner-worker"]
	if err := os.Remove(item.store.path("slots", provider.SlotID, provider.SlotVersion+".secret")); err != nil {
		t.Fatal(err)
	}
	executor := &recordingExecutor{}
	input := ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}
	if err := item.store.Apply(context.Background(), input, executor, item.observer()); err == nil {
		t.Fatal("missing credential accepted")
	}
	if executor.count() != 0 {
		t.Fatal("executor invoked before credential resolution")
	}
	if _, err := os.Stat(item.store.path("journal", SHA256(data), "000000-consumed.json")); err != nil {
		t.Fatalf("consumption not durable: %v", err)
	}
	if err := item.store.Apply(context.Background(), input, executor, item.observer()); err == nil {
		t.Fatal("replay accepted")
	}
}

func TestConcurrentApplyReachesExecutorOnce(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{}
	input := ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}
	start := make(chan struct{})
	results := make(chan error, 8)
	for range 8 {
		go func() { <-start; results <- item.store.Apply(context.Background(), input, executor, item.observer()) }()
	}
	close(start)
	successes := 0
	for range 8 {
		if err := <-results; err == nil {
			successes++
		}
	}
	if successes != 1 || executor.count() != 3 {
		t.Fatalf("successes=%d calls=%d", successes, executor.count())
	}
}

func TestApplyRechecksFreezeAndCredentialAuthorityInsideAdmissionGuard(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	guard, err := item.store.acquireAdmissionGuard()
	if err != nil {
		t.Fatal(err)
	}
	executor := &recordingExecutor{}
	result := make(chan error, 1)
	go func() {
		result <- item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.observer())
	}()
	freeze, err := item.store.signControlRecord(SignedControlRecord{Domain: FreezeDomain, PlanSHA256: strings.Repeat("6", 64), RequestID: "concurrent-incident", Disposition: "frozen", RecordedAt: item.now}, RecoveryRole, syntheticOperatorPassphrase)
	if err != nil {
		releaseAdmissionGuard(guard)
		t.Fatal(err)
	}
	freezeData, _ := json.MarshalIndent(freeze, "", "  ")
	if err := writeAtomicExclusive(item.store.path("journal", "acquisition.freeze"), append(freezeData, '\n'), 0o600); err != nil {
		releaseAdmissionGuard(guard)
		t.Fatal(err)
	}
	releaseAdmissionGuard(guard)
	if err := <-result; err == nil || !strings.Contains(err.Error(), "E_ACQUISITION_FROZEN") || executor.count() != 0 {
		t.Fatalf("apply crossed a concurrently published freeze: %v calls=%d", err, executor.count())
	}
}

func TestApplyResumesAfterObservedCommittedCrashPrefix(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	digest := SHA256(data)
	previous, err := item.store.consumePlan(digest, data, item.now)
	if err != nil {
		t.Fatal(err)
	}
	state1 := syntheticState(item.installation.AccountID, 1, "rotate", item.now)
	stateDigest, identityDigest, _ := state1.Digests()
	if _, err := item.store.appendEvent(Event{SchemaVersion: SchemaVersion, Sequence: 1, PlanSHA256: digest, RequestID: plan.Operations[0].RequestID, State: "observed-committed", PreviousSHA256: previous, RecordedAt: item.now, DetailCode: "OK", StateSHA256: stateDigest, IdentitySHA256: identityDigest, ReceiptSHA256: strings.Repeat("a", 64)}); err != nil {
		t.Fatal(err)
	}
	fence, err := item.store.acquireFence(digest)
	if err != nil {
		t.Fatal(err)
	}
	if err := fence.Close(); err != nil {
		t.Fatal(err)
	}
	state2 := syntheticState(item.installation.AccountID, 2, "rotate", item.now)
	state3 := syntheticState(item.installation.AccountID, 3, "rotate", item.now)
	observer := &sequenceStateObserver{states: []StateObservation{state1, state1, state2, state2, state3, state3, state3}}
	executor := &recordingExecutor{}
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, observer); err != nil {
		t.Fatal(err)
	}
	if executor.count() != 2 || executor.calls[0].RequestID != plan.Operations[1].RequestID {
		t.Fatalf("resume replayed committed prefix: %#v", executor.calls)
	}
}

func TestApplyResumesTerminalPrefixWithoutMutation(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, &recordingExecutor{}, item.observer()); err != nil {
		t.Fatal(err)
	}
	fence, err := item.store.acquireFence(SHA256(data))
	if err != nil {
		t.Fatal(err)
	}
	if err := fence.Close(); err != nil {
		t.Fatal(err)
	}
	executor := &recordingExecutor{}
	terminal := syntheticState(item.installation.AccountID, 3, "rotate", item.now)
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, fixedObserver{state: terminal}); err != nil {
		t.Fatal(err)
	}
	if executor.count() != 0 {
		t.Fatalf("terminal crash prefix replayed mutation: %#v", executor.calls)
	}
}

func TestApplyResumesCredentialValidationPrefixWithoutMutation(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, &recordingExecutor{}, item.observer()); err != nil {
		t.Fatal(err)
	}
	directory := item.store.path("journal", SHA256(data))
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), "-reconciled-terminal.json") {
			if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
				t.Fatal(err)
			}
		}
	}
	fence, err := item.store.acquireFence(SHA256(data))
	if err != nil {
		t.Fatal(err)
	}
	if err := fence.Close(); err != nil {
		t.Fatal(err)
	}
	executor := &recordingExecutor{}
	terminal := syntheticState(item.installation.AccountID, 3, "rotate", item.now)
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, fixedObserver{state: terminal}); err != nil {
		t.Fatal(err)
	}
	if executor.count() != 0 {
		t.Fatalf("credential-validation crash prefix replayed mutation: %#v", executor.calls)
	}
}

func TestOutcomeUncertainKeepsFenceAndRedactsSecrets(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{failureAt: 1}
	input := ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}
	err := item.store.Apply(context.Background(), input, executor, item.observer())
	if err == nil || !strings.Contains(err.Error(), "E_OUTCOME_UNCERTAIN") {
		t.Fatalf("unexpected result: %v", err)
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); err != nil {
		t.Fatal("uncertain outcome released fence")
	}
	var durable strings.Builder
	_ = filepath.Walk(item.store.Root, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.Mode().IsRegular() && !strings.Contains(path, string(filepath.Separator)+"keys"+string(filepath.Separator)) {
			value, _ := os.ReadFile(path)
			durable.Write(value)
		}
		return nil
	})
	for _, canary := range []string{strings.Repeat("c", 32), strings.Repeat("d", 32), strings.Repeat("e", 32)} {
		if strings.Contains(durable.String(), canary) {
			t.Fatal("secret leaked to durable evidence")
		}
	}
}

type fixedObserver struct{ state StateObservation }

func (observer fixedObserver) Observe(context.Context, []byte, time.Time) (StateObservation, error) {
	return observer.state, nil
}

func TestApplyRefusesRemotePrestateMismatchBeforeMutation(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{}
	wrong := syntheticState(item.installation.AccountID, 99, "deploy", item.now)
	err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, fixedObserver{state: wrong})
	if err == nil || !strings.Contains(err.Error(), "E_OBSERVABLE_PRESTATE") || executor.count() != 0 {
		t.Fatalf("remote prestate mismatch was not fail-closed: %v calls=%d", err, executor.count())
	}
}

func TestAuthorityDeadlineStopsTheNextMutation(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{}
	calls := 0
	clock := func() time.Time {
		calls++
		if calls > 4 {
			return item.now.Add(20 * time.Minute)
		}
		return item.now
	}
	err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: clock}, executor, item.observer())
	if err == nil || !strings.Contains(err.Error(), "E_AUTHORITY_EXPIRED_DURING_APPLY") || executor.count() != 1 {
		t.Fatalf("authority expiry did not stop exact next mutation: %v calls=%d clock=%d", err, executor.count(), calls)
	}
}

func TestPairwiseEqualWorkerSecretsFailBeforeMutation(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	metadata, _ := item.store.credentialMetadata()
	shared := metadata["crabbox-shared"]
	adminValue, err := item.store.ResolveCredential("crabbox-admin")
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(adminValue)
	key, err := item.store.credentialKey()
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(key)
	sealed, err := sealCredential(adminValue, key, shared.EnvironmentID+":"+shared.Role+":"+shared.SlotID+":"+shared.SlotVersion)
	if err != nil {
		t.Fatal(err)
	}
	shared.CiphertextSHA256, shared.Signature = SHA256(sealed), ""
	payload, _ := signaturePayload(shared)
	signingKey, err := item.store.privateKey(SlotEvidenceRole, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer zeroBytes(signingKey)
	shared.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(signingKey, payload))
	metadataData, _ := json.MarshalIndent(shared, "", "  ")
	if err := os.WriteFile(item.store.path("slots", shared.SlotID, shared.SlotVersion+".secret"), sealed, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(item.store.path("slots", shared.SlotID, shared.SlotVersion+".json"), append(metadataData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{}
	err = item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.observer())
	if err == nil || !strings.Contains(err.Error(), "E_SLOT_EQUAL") || executor.count() != 0 {
		t.Fatalf("equal secrets not rejected: %v calls=%d", err, executor.count())
	}
}

func TestPlanRejectsExtraFieldsAndDeletionFirstRetirement(t *testing.T) {
	item := newFixture(t)
	plan, _ := item.plan()
	plan.IntendedTerminalStateSHA256 = strings.Repeat("f", 64)
	alteredContract, _ := json.Marshal(plan)
	if _, err := item.store.SignAuthorization(alteredContract, plan, item.now, syntheticOperatorPassphrase); err == nil {
		t.Fatal("digest-shaped noncanonical terminal contract accepted")
	}
	plan, _ = item.plan()
	plan.Operations[2].VersionID = pointer("smuggled")
	altered, _ := json.Marshal(plan)
	if _, err := item.store.SignAuthorization(altered, plan, item.now, syntheticOperatorPassphrase); err == nil {
		t.Fatal("action-specific extra field accepted")
	}
	retirement, _ := item.retirementPlan()
	retirement.Operations = []Operation{{Action: "worker.delete", Target: WorkerName, RequestID: "delete"}}
	retireData, _ := json.Marshal(retirement)
	if _, err := item.store.SignAuthorization(retireData, retirement, item.now, syntheticOperatorPassphrase); err == nil {
		t.Fatal("deletion-first retirement accepted")
	}
}

func TestFreezeBlocksDeployButAdmitsExactRetirement(t *testing.T) {
	item := newFixture(t)
	if _, err := item.store.Freeze("freeze-1", item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	deploy, deployData := item.plan()
	deployAuth, observation, attestation := item.authority(deploy, deployData)
	executor := &recordingExecutor{}
	err := item.store.Apply(context.Background(), ApplyInput{PlanData: deployData, AuthorizationData: deployAuth, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.observer())
	if err == nil || !strings.Contains(err.Error(), "E_ACQUISITION_FROZEN") || executor.count() != 0 {
		t.Fatalf("frozen deploy result=%v calls=%d", err, executor.count())
	}
	retirement, retirementData := item.retirementPlan()
	retirementAuth, retirementObservation, retirementAttestation := item.authority(retirement, retirementData)
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: retirementData, AuthorizationData: retirementAuth, ObservationData: retirementObservation, AttestationData: retirementAttestation, RetirementEvidenceData: item.signedRetirementEvidence(retirement), Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.retirementObserver()); err != nil {
		t.Fatal(err)
	}
	if executor.count() != 8 {
		t.Fatalf("retirement calls=%d", executor.count())
	}
	if _, err := os.Stat(item.store.path("evidence", "retirement-cloud-absence.json")); err != nil {
		t.Fatal("retirement Cloudflare/provider absence evidence missing")
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); err != nil {
		t.Fatal("retirement released mutation fence before credential revocation")
	}
	planDigest := SHA256(retirementData)
	recoveryEvidence := strings.Repeat("7", 64)
	if _, err := item.store.RecoverQuarantine(planDigest, "plan", recoveryEvidence, item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatalf("terminal retirement quarantine: %v", err)
	}
	if _, err := item.store.ResolveQuarantine(planDigest, "plan", recoveryEvidence, item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatalf("terminal retirement resolution: %v", err)
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); err != nil {
		t.Fatal("generic recovery bypassed retirement finalization")
	}
	freezePath := item.store.path("journal", "acquisition.freeze")
	freezeData, err := readPrivate(freezePath)
	if err != nil {
		t.Fatal(err)
	}
	assertFinalizationBlocked := func(label string) {
		t.Helper()
		if _, finalizeErr := item.store.FinalizeRetirement(planDigest, "cloudflare-deployment-revoked", "cloudflare-plan-read-revoked", "hetzner-worker-rotated", "hetzner-inventory-rotated", "hetzner-recovery-rotated", item.now.Add(time.Second), syntheticOperatorPassphrase); finalizeErr == nil || !strings.Contains(finalizeErr.Error(), "E_RETIREMENT_STATE") {
			t.Fatalf("%s freeze admitted finalization: %v", label, finalizeErr)
		}
		if _, statErr := os.Stat(item.store.path("journal", "mutation.lock")); statErr != nil {
			t.Fatalf("%s freeze released fence: %v", label, statErr)
		}
		if _, statErr := os.Stat(item.store.path("evidence", "retirement-finalized.json")); !os.IsNotExist(statErr) {
			t.Fatalf("%s freeze published finalization: %v", label, statErr)
		}
	}
	if err := os.Remove(freezePath); err != nil {
		t.Fatal(err)
	}
	assertFinalizationBlocked("missing")
	if err := os.WriteFile(freezePath, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertFinalizationBlocked("malformed")
	var wrongSignedFreeze SignedControlRecord
	if err := json.Unmarshal(freezeData, &wrongSignedFreeze); err != nil {
		t.Fatal(err)
	}
	wrongSignedFreeze.Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	wrongSignedData, _ := json.MarshalIndent(wrongSignedFreeze, "", "  ")
	if err := os.WriteFile(freezePath, append(wrongSignedData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	assertFinalizationBlocked("wrong-signed")
	if err := os.Remove(freezePath); err != nil {
		t.Fatal(err)
	}
	symlinkTarget := item.store.path("journal", "freeze-symlink-target")
	if err := os.WriteFile(symlinkTarget, freezeData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(symlinkTarget, freezePath); err != nil {
		t.Fatal(err)
	}
	assertFinalizationBlocked("symlinked")
	if err := os.Remove(freezePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(symlinkTarget); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomicExclusive(freezePath, freezeData, 0o600); err != nil {
		t.Fatal(err)
	}
	finalizationIdentities := []string{"cloudflare-deployment-revoked", "cloudflare-plan-read-revoked", "hetzner-worker-rotated", "hetzner-inventory-rotated", "hetzner-recovery-rotated"}
	finalizationEvidence, _ := json.Marshal(finalizationIdentities)
	finalizationDigest := SHA256(finalizationEvidence)
	prematureCompletion, err := item.store.signControlRecord(SignedControlRecord{Domain: RetirementCompletionDomain, PlanSHA256: planDigest, RequestID: "mutation-fence-release", Disposition: "durably-released", EvidenceSHA256: finalizationDigest, RecordedAt: item.now}, RecoveryRole, syntheticOperatorPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	prematureData, _ := json.MarshalIndent(prematureCompletion, "", "  ")
	completionPath := item.store.path("evidence", "retirement-complete.json")
	if err := writeAtomicExclusive(completionPath, append(prematureData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.FinalizeRetirement(planDigest, finalizationIdentities[0], finalizationIdentities[1], finalizationIdentities[2], finalizationIdentities[3], finalizationIdentities[4], item.now, syntheticOperatorPassphrase); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_STATE") {
		t.Fatalf("completion without finalization was self-healed: %v", err)
	}
	finalizationRecord, err := item.store.signControlRecord(SignedControlRecord{Domain: RetirementFinalizationDomain, PlanSHA256: planDigest, RequestID: "credential-revocations", Disposition: "finalized", EvidenceSHA256: finalizationDigest, RecordedAt: item.now}, RecoveryRole, syntheticOperatorPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	finalizationData, _ := json.MarshalIndent(finalizationRecord, "", "  ")
	finalizationPath := item.store.path("evidence", "retirement-finalized.json")
	if err := writeAtomicExclusive(finalizationPath, append(finalizationData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.FinalizeRetirement(planDigest, finalizationIdentities[0], finalizationIdentities[1], finalizationIdentities[2], finalizationIdentities[3], finalizationIdentities[4], item.now, syntheticOperatorPassphrase); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_STATE") {
		t.Fatalf("completion coexisting with fence was self-healed: %v", err)
	}
	if err := os.Remove(completionPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(finalizationPath); err != nil {
		t.Fatal(err)
	}
	record, err := item.store.FinalizeRetirement(planDigest, "cloudflare-deployment-revoked", "cloudflare-plan-read-revoked", "hetzner-worker-rotated", "hetzner-inventory-rotated", "hetzner-recovery-rotated", item.now.Add(-time.Second), syntheticOperatorPassphrase)
	if err != nil || record.Disposition != "finalized" {
		t.Fatalf("retirement finalization: %v %#v", err, record)
	}
	retirementStatus, err := item.store.RetirementStatus()
	if err != nil || !retirementStatus.CloudAbsenceRecorded || !retirementStatus.Finalized || retirementStatus.PlanSHA256 != planDigest {
		t.Fatalf("authenticated retirement status: %v %#v", err, retirementStatus)
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); !os.IsNotExist(err) {
		t.Fatal("finalized retirement retained mutation fence")
	}
	if _, err := item.store.ResolveCredential("cloudflare-deployment"); err == nil {
		t.Fatal("finalized retirement retained local credential authority")
	}
	if _, err := item.store.Thaw(strings.Repeat("6", 64), item.now.Add(2*time.Second), syntheticOperatorPassphrase); err == nil || !strings.Contains(err.Error(), "E_ENVIRONMENT_RETIRED") {
		t.Fatalf("generic thaw reopened retired environment: %v", err)
	}
	if _, err := item.store.EnrollCredential(item.installation.EnvironmentID, "cloudflare-deployment", "new-slot", "new-version", []byte(strings.Repeat("n", 32)), item.now.Add(2*time.Second)); err == nil || !strings.Contains(err.Error(), "E_ENVIRONMENT_RETIRED") {
		t.Fatalf("credential enrollment reopened retired environment: %v", err)
	}
	deployPlan, deployData := item.plan()
	if _, err := item.store.SignAuthorization(deployData, deployPlan, item.now.Add(2*time.Second), syntheticOperatorPassphrase); err == nil || !strings.Contains(err.Error(), "E_ENVIRONMENT_RETIRED") {
		t.Fatalf("authorization reopened retired environment: %v", err)
	}
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: deployData, Now: item.now.Add(2 * time.Second)}, &recordingExecutor{}, item.observer()); err == nil || !strings.Contains(err.Error(), "E_ENVIRONMENT_RETIRED") {
		t.Fatalf("apply reopened retired environment: %v", err)
	}
	if _, err := item.store.FinalizeRetirement(planDigest, "different-deployment-revocation", "cloudflare-plan-read-revoked", "hetzner-worker-rotated", "hetzner-inventory-rotated", "hetzner-recovery-rotated", item.now.Add(2*time.Second), syntheticOperatorPassphrase); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_FINALIZATION_BINDING") {
		t.Fatalf("finalized retirement accepted changed evidence: %v", err)
	}
	if err := os.WriteFile(item.store.path("evidence", "retirement-finalized.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.RetirementStatus(); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_STATE") {
		t.Fatalf("malformed finalization claimed terminal status: %v", err)
	}
	if _, err := item.store.EnrollCredential(item.installation.EnvironmentID, "cloudflare-deployment", "malformed-slot", "v1", []byte(strings.Repeat("x", 32)), item.now.Add(3*time.Second)); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_STATE") {
		t.Fatalf("malformed retirement evidence did not fail closed: %v", err)
	}
}

func TestAdmissionWaiterRechecksRetirementInsideGuard(t *testing.T) {
	item := newFixture(t)
	if _, err := item.store.Freeze("freeze-1", item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	plan, data := item.retirementPlan()
	authorization, observation, attestation := item.authority(plan, data)
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, RetirementEvidenceData: item.signedRetirementEvidence(plan), Now: item.now, Clock: func() time.Time { return item.now }}, &recordingExecutor{}, item.retirementObserver()); err != nil {
		t.Fatal(err)
	}
	guard, err := item.store.acquireAdmissionGuard()
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	statusResult := make(chan struct {
		status RetirementStatus
		err    error
	}, 1)
	go func() {
		_, enrollErr := item.store.EnrollCredential(item.installation.EnvironmentID, "cloudflare-deployment", "late-slot", "v1", []byte(strings.Repeat("x", 32)), item.now.Add(2*time.Second))
		result <- enrollErr
	}()
	go func() {
		status, statusErr := item.store.RetirementStatus()
		statusResult <- struct {
			status RetirementStatus
			err    error
		}{status, statusErr}
	}()
	time.Sleep(25 * time.Millisecond)
	identities := []string{"cloudflare-deployment-revoked", "cloudflare-plan-read-revoked", "hetzner-worker-rotated", "hetzner-inventory-rotated", "hetzner-recovery-rotated"}
	evidenceData, _ := json.Marshal(identities)
	planDigest := SHA256(data)
	prematureCompletion, err := item.store.signControlRecord(SignedControlRecord{Domain: RetirementCompletionDomain, PlanSHA256: planDigest, RequestID: "mutation-fence-release", Disposition: "durably-released", EvidenceSHA256: SHA256(evidenceData), RecordedAt: item.now}, RecoveryRole, syntheticOperatorPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	prematureData, _ := json.MarshalIndent(prematureCompletion, "", "  ")
	completionPath := item.store.path("evidence", "retirement-complete.json")
	if err := writeAtomicExclusive(completionPath, append(prematureData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.retirementStatusLocked(); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_STATE") {
		t.Fatalf("completion without finalization was accepted: %v", err)
	}
	if err := os.Remove(completionPath); err != nil {
		t.Fatal(err)
	}
	record, err := item.store.signControlRecord(SignedControlRecord{Domain: RetirementFinalizationDomain, PlanSHA256: planDigest, RequestID: "credential-revocations", Disposition: "finalized", EvidenceSHA256: SHA256(evidenceData), RecordedAt: item.now.Add(time.Second)}, RecoveryRole, syntheticOperatorPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	if err := item.store.retireLocalCredentials(); err != nil {
		t.Fatal(err)
	}
	recordData, _ := json.MarshalIndent(record, "", "  ")
	if err := writeAtomicExclusive(item.store.path("evidence", "retirement-finalized.json"), append(recordData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomicExclusive(completionPath, append(prematureData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.retirementStatusLocked(); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_STATE") {
		t.Fatalf("completion coexisting with fence was accepted: %v", err)
	}
	if err := os.Remove(completionPath); err != nil {
		t.Fatal(err)
	}
	prefixStatus, err := item.store.retirementStatusLocked()
	if err != nil || !prefixStatus.FinalizationRecorded || !prefixStatus.FenceReleasePending || prefixStatus.Finalized || !prefixStatus.MutationFenceHeld || prefixStatus.EnrolledSlotCount != 0 || prefixStatus.CredentialSetComplete {
		t.Fatalf("signed finalization crash prefix misclassified: %v %#v", err, prefixStatus)
	}
	releaseAdmissionGuard(guard)
	if err := <-result; err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_FINALIZATION_REQUIRED") {
		t.Fatalf("waiting enrollment crossed terminal retirement: %v", err)
	}
	queuedStatus := <-statusResult
	if queuedStatus.err != nil || !queuedStatus.status.FenceReleasePending || queuedStatus.status.Finalized || !queuedStatus.status.MutationFenceHeld || queuedStatus.status.EnrolledSlotCount != 0 || queuedStatus.status.CredentialSetComplete {
		t.Fatalf("queued status crossed retirement with a mixed snapshot: %v %#v", queuedStatus.err, queuedStatus.status)
	}
	item.store.syncDirectoryForTest = func(string) error { return errors.New("synthetic journal sync failure") }
	if _, err := item.store.FinalizeRetirement(planDigest, identities[0], identities[1], identities[2], identities[3], identities[4], item.now.Add(2*time.Second), syntheticOperatorPassphrase); err == nil || !strings.Contains(err.Error(), "synthetic journal sync failure") {
		t.Fatalf("unlink-to-sync failure was not surfaced: %v", err)
	}
	unsyncedStatus, err := item.store.RetirementStatus()
	if err != nil || !unsyncedStatus.FenceReleasePending || unsyncedStatus.Finalized || unsyncedStatus.MutationFenceHeld {
		t.Fatalf("lock-absent completion-missing prefix misclassified: %v %#v", err, unsyncedStatus)
	}
	item.store.syncDirectoryForTest = nil
	if _, err := item.store.FinalizeRetirement(planDigest, identities[0], identities[1], identities[2], identities[3], identities[4], item.now.Add(-time.Second), syntheticOperatorPassphrase); err != nil {
		t.Fatalf("same-evidence finalization retry failed: %v", err)
	}
	finalStatus, err := item.store.RetirementStatus()
	if err != nil || !finalStatus.Finalized || finalStatus.FenceReleasePending || finalStatus.MutationFenceHeld {
		t.Fatalf("finalization retry did not close terminal state: %v %#v", err, finalStatus)
	}
	entries, err := os.ReadDir(item.store.path("slots"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("waiting enrollment published post-retirement slot: %v %#v", err, entries)
	}
}

func TestCompletionOnlyRetirementStateFailsClosed(t *testing.T) {
	item := newFixture(t)
	completion, err := item.store.signControlRecord(SignedControlRecord{Domain: RetirementCompletionDomain, PlanSHA256: strings.Repeat("a", 64), RequestID: "mutation-fence-release", Disposition: "durably-released", EvidenceSHA256: strings.Repeat("b", 64), RecordedAt: item.now}, RecoveryRole, syntheticOperatorPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	path := item.store.path("evidence", "retirement-complete.json")
	data, _ := json.MarshalIndent(completion, "", "  ")
	if err := writeAtomicExclusive(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	assertBlocked := func(label string) {
		t.Helper()
		if _, err := item.store.RetirementStatus(); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_STATE") {
			t.Fatalf("%s completion-only state was accepted: %v", label, err)
		}
		if _, err := item.store.EnrollCredential(item.installation.EnvironmentID, "cloudflare-deployment", "late-slot", "v1", []byte(strings.Repeat("x", 32)), item.now); err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_STATE") {
			t.Fatalf("%s completion-only state admitted enrollment: %v", label, err)
		}
	}
	assertBlocked("signed")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertBlocked("malformed")
}

func TestRetirementRejectsDigestShapedButUnsignedZeroState(t *testing.T) {
	item := newFixture(t)
	if _, err := item.store.Freeze("freeze-1", item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	plan, data := item.retirementPlan()
	authorization, observation, attestation := item.authority(plan, data)
	unsigned := item.signedRetirementEvidence(plan)
	var evidence RetirementEvidence
	if err := json.Unmarshal(unsigned, &evidence); err != nil {
		t.Fatal(err)
	}
	evidence.Signature = ""
	unsigned, _ = json.Marshal(evidence)
	executor := &recordingExecutor{}
	err := item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, RetirementEvidenceData: unsigned, Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.observer())
	if err == nil || !strings.Contains(err.Error(), "E_RETIREMENT_EVIDENCE_SIGNATURE") || executor.count() != 0 {
		t.Fatalf("unsigned zero-state admitted: %v calls=%d", err, executor.count())
	}
}

func TestRecoveryQuarantineRequiresIntactJournalAndKeepsFence(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{failureAt: 1}
	_ = item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.observer())
	digest := SHA256(data)
	if err := item.store.VerifyJournal(digest); err != nil {
		t.Fatal(err)
	}
	record, err := item.store.RecoverQuarantine(digest, "put-admin", strings.Repeat("9", 64), item.now, syntheticOperatorPassphrase)
	if err != nil || record.Disposition != "quarantine" {
		t.Fatalf("quarantine: %v", err)
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); err != nil {
		t.Fatal("quarantine released fence")
	}
	resolved, err := item.store.ResolveQuarantine(digest, "put-admin", strings.Repeat("8", 64), item.now, syntheticOperatorPassphrase)
	if err != nil || resolved.Disposition != "reconciled-abandoned" {
		t.Fatalf("resolve quarantine: %v", err)
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); !os.IsNotExist(err) {
		t.Fatal("resolved quarantine retained local fence")
	}
	if !item.store.IsFrozen() {
		t.Fatal("resolved quarantine cleared acquisition freeze")
	}
	if err := item.store.ensureNoActiveMutation(); err != nil {
		t.Fatalf("resolved exact uncertain prefix still blocks mutation: %v", err)
	}
	resolvedEvidence := strings.Repeat("8", 64)
	if _, err := item.store.Thaw(resolvedEvidence, item.now.Add(time.Second), syntheticOperatorPassphrase); err != nil {
		t.Fatalf("reviewed restoration could not re-enable acquisition: %v", err)
	}
	if _, err := item.store.Thaw(resolvedEvidence, item.now.Add(2*time.Second), syntheticOperatorPassphrase); err != nil {
		t.Fatalf("completed thaw was not idempotent: %v", err)
	}
	if item.store.IsFrozen() {
		t.Fatal("reviewed restoration retained acquisition freeze")
	}
	if _, err := item.store.Freeze("unrelated-later-freeze", item.now.Add(3*time.Second), syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.Thaw(resolvedEvidence, item.now.Add(4*time.Second), syntheticOperatorPassphrase); err == nil || !strings.Contains(err.Error(), "E_THAW_PREREQUISITE") {
		t.Fatalf("historical recovery thawed an unrelated freeze: %v", err)
	}
	first := item.store.path("journal", digest, "000000-consumed.json")
	if err := os.WriteFile(first, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := item.store.VerifyJournal(digest); err == nil {
		t.Fatal("corrupt journal accepted")
	}
}

func TestGenericIncidentFreezeHasAttendedRestorationAndExclusivePublication(t *testing.T) {
	item := newFixture(t)
	if _, err := item.store.Freeze("billing-observation-stale", item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	evidence := strings.Repeat("7", 64)
	if _, err := item.store.Thaw(evidence, item.now.Add(time.Second), syntheticOperatorPassphrase); err != nil {
		t.Fatalf("generic incident could not be restored through attended evidence: %v", err)
	}
	if item.store.IsFrozen() {
		t.Fatal("restored generic incident remained frozen")
	}

	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "one-use.json")
	values := [][]byte{[]byte("first"), []byte("second"), []byte("third"), []byte("fourth")}
	var successes atomic.Int32
	var wait sync.WaitGroup
	for _, value := range values {
		value := append([]byte(nil), value...)
		wait.Add(1)
		go func() {
			defer wait.Done()
			if writeAtomicExclusive(path, value, 0o600) == nil {
				successes.Add(1)
			}
		}()
	}
	wait.Wait()
	data, err := os.ReadFile(path)
	if err != nil || successes.Load() != 1 {
		t.Fatalf("exclusive publication successes=%d read=%v", successes.Load(), err)
	}
	found := false
	for _, value := range values {
		found = found || bytes.Equal(data, value)
	}
	if !found {
		t.Fatalf("exclusive publication produced torn bytes: %q", data)
	}
	crashPath := filepath.Join(directory, "crash.json")
	stagingPath := crashPath + ".staging-deadbeef"
	if err := os.WriteFile(stagingPath, []byte("durable"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(stagingPath, crashPath); err != nil {
		t.Fatal(err)
	}
	if recovered, err := readPrivate(crashPath); err != nil || string(recovered) != "durable" {
		t.Fatalf("post-publication crash was not recoverable: %q %v", recovered, err)
	}
	if _, err := os.Stat(stagingPath); !os.IsNotExist(err) {
		t.Fatal("recovered publication retained staging alias")
	}
}

func TestRecoveryClassifiesCrashAfterConsumeBeforeFenceAsDefiniteNoncommit(t *testing.T) {
	item := newFixture(t)
	_, data := item.plan()
	digest := SHA256(data)
	if _, err := item.store.consumePlan(digest, data, item.now); err != nil {
		t.Fatal(err)
	}
	if err := writeExclusive(item.store.path("journal", "mutation.lock"), []byte(digest+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	evidence := strings.Repeat("a", 64)
	if _, err := item.store.RecoverQuarantine(digest, "plan", evidence, item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.ResolveQuarantine(digest, "plan", evidence, item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	last, err := item.store.lastEvent(digest)
	if err != nil || last.State != "abandoned-definite-noncommit" {
		t.Fatalf("unclassified early crash: %v %#v", err, last)
	}
	if err := item.store.ensureNoActiveMutation(); err != nil {
		t.Fatalf("definite noncommit still blocks admission: %v", err)
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); !os.IsNotExist(err) {
		t.Fatal("definite noncommit retained matching fence")
	}
}

func TestRecoveryRemovesMalformedPreInvocationFence(t *testing.T) {
	item := newFixture(t)
	_, data := item.plan()
	digest := SHA256(data)
	if _, err := item.store.consumePlan(digest, data, item.now); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(item.store.path("journal", "mutation.lock"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	evidence := strings.Repeat("d", 64)
	if _, err := item.store.RecoverQuarantine(digest, "plan", evidence, item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.ResolveQuarantine(digest, "plan", evidence, item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatalf("malformed pre-invocation fence was not recoverable: %v", err)
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); !os.IsNotExist(err) {
		t.Fatal("malformed recovered fence survived")
	}
}

func TestRecoveryResolutionResumesEveryDurablePrefix(t *testing.T) {
	item := newFixture(t)
	_, data := item.plan()
	digest, evidence := SHA256(data), strings.Repeat("b", 64)
	if _, err := item.store.consumePlan(digest, data, item.now); err != nil {
		t.Fatal(err)
	}
	if err := writeExclusive(item.store.path("journal", "mutation.lock"), []byte(digest+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.RecoverQuarantine(digest, "plan", evidence, item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	record, err := item.store.signControlRecord(SignedControlRecord{Domain: RecoveryDomain, PlanSHA256: digest, RequestID: "plan", Disposition: "reconciled-abandoned", EvidenceSHA256: evidence, RecordedAt: item.now}, RecoveryRole, syntheticOperatorPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	recordData, _ := json.MarshalIndent(record, "", "  ")
	if err := writeExclusive(item.store.path("journal", digest, "recovery-resolved.json"), append(recordData, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.ResolveQuarantine(digest, "plan", evidence, item.now.Add(time.Second), syntheticOperatorPassphrase); err != nil {
		t.Fatalf("resume after resolution write: %v", err)
	}
	if _, err := item.store.ResolveQuarantine(digest, "plan", evidence, item.now.Add(2*time.Second), syntheticOperatorPassphrase); err != nil {
		t.Fatalf("idempotent terminal retry: %v", err)
	}
}

func TestPrivateReaderRejectsSymlinkAndHardlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readPrivate(link); err == nil {
		t.Fatal("symlink accepted")
	}
	hard := filepath.Join(root, "hard")
	if err := os.Link(target, hard); err != nil {
		t.Fatal(err)
	}
	if _, err := readPrivate(target); err == nil {
		t.Fatal("hardlinked file accepted")
	}
}

func TestInstalledPolicyAndExecutionInputsAreRehashed(t *testing.T) {
	item := newFixture(t)
	if err := os.WriteFile(item.store.path("policy", "permission-manifest.json"), []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.LoadInstallation(); err == nil || !strings.Contains(err.Error(), "E_POLICY_CHANGED") {
		t.Fatalf("changed installed policy accepted: %v", err)
	}

	root := t.TempDir()
	worker := filepath.Join(root, "worker")
	if err := os.MkdirAll(worker, 0o700); err != nil {
		t.Fatal(err)
	}
	lock, profile, terminal := []byte("lock"), []byte("profile"), []byte("terminal")
	for path, value := range map[string][]byte{filepath.Join(worker, "package-lock.json"): lock, filepath.Join(root, "live"): profile, filepath.Join(root, "terminal"): terminal, filepath.Join(root, "entry"): []byte("entry")} {
		if err := os.WriteFile(path, value, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	npm := filepath.Join(root, "npm")
	script := []byte("#!/bin/sh\nexit 0\n")
	if err := os.WriteFile(npm, script, 0o700); err != nil {
		t.Fatal(err)
	}
	executor := CommandExecutor{ProtectedRoot: root, ProfilePath: filepath.Join(root, "live"), ProfileSHA256: SHA256(profile), TerminalProfilePath: filepath.Join(root, "terminal"), TerminalProfileSHA256: SHA256(terminal), TerminalEntryPointPath: filepath.Join(root, "entry"), TerminalEntryPointSHA256: SHA256([]byte("entry")), RuntimeHome: filepath.Join(root, "home"), Timeout: time.Second, skipRuntimeVerificationForTest: true}
	if err := os.WriteFile(filepath.Join(root, "live"), []byte("substituted"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := executor.Invoke(context.Background(), Invocation{Action: "worker.deploy", DeploymentCredential: []byte("synthetic")}); err == nil || !strings.Contains(err.Error(), "E_TOOLCHAIN_CHANGED") {
		t.Fatalf("substituted execution input accepted: %v", err)
	}
}

func TestCommandExecutorUsesClosedArgvEnvAndStdin(t *testing.T) {
	root := t.TempDir()
	paths := runtimePaths(root)
	worker := paths.workerRoot
	if err := os.MkdirAll(worker, 0o700); err != nil {
		t.Fatal(err)
	}
	lock := []byte("lock")
	profile := []byte("profile")
	terminal := []byte("terminal")
	for path, data := range map[string][]byte{filepath.Join(worker, "package-lock.json"): lock, filepath.Join(root, "live.jsonc"): profile, filepath.Join(root, "terminal.jsonc"): terminal} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	npm := paths.node
	if err := os.MkdirAll(filepath.Dir(paths.node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(paths.wranglerCLI), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.wranglerCLI, []byte("placeholder"), 0o500); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
set -eu
[ "${UNSAFE_AMBIENT-unset}" = unset ]
[ "$CI" = 1 ]
[ "$CLOUDFLARE_ACCOUNT_ID" = account-canary ]
[ "$CLOUDFLARE_API_TOKEN" = deployment-canary ]
[ "$(command -v node)" = "` + paths.node + `" ]
[ "$1" != "" ]
[ "$2" = secret ] && [ "$3" = put ] && [ "$4" = CRABBOX_ADMIN_TOKEN ]
IFS= read -r secret
[ "$secret" = worker-canary ]
`
	if err := os.WriteFile(npm, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UNSAFE_AMBIENT", "must-not-be-inherited")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "ambient-substitute")
	executor := CommandExecutor{AccountID: "account-canary", Installation: Installation{AccountID: "account-canary"}, ProtectedRoot: root, ProfilePath: filepath.Join(root, "live.jsonc"), ProfileSHA256: SHA256(profile), TerminalProfilePath: filepath.Join(root, "terminal.jsonc"), TerminalProfileSHA256: SHA256(terminal), RuntimeHome: filepath.Join(root, "home"), Timeout: 3 * time.Second, skipRuntimeVerificationForTest: true}
	_, err := executor.Invoke(context.Background(), Invocation{Action: "worker.secret.put", RequestID: "put", SecretName: "CRABBOX_ADMIN_TOKEN", Secret: []byte("worker-canary\n"), DeploymentCredential: []byte("deployment-canary")})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := executor.command(Invocation{Action: "forbidden"}); err == nil {
		t.Fatal("arbitrary action accepted")
	}
	deployArgs, _, err := executor.command(Invocation{Action: "worker.deploy", SourceCommit: strings.Repeat("a", 40)})
	if err != nil || !strings.Contains(strings.Join(deployArgs, " "), "--message agentscope-source:"+strings.Repeat("a", 40)) {
		t.Fatalf("deploy did not bind coordinator source identity: %v %v", deployArgs, err)
	}
}

func TestCommandExecutorRejectsMissingOrMismatchedWranglerAccountBinding(t *testing.T) {
	root := t.TempDir()
	paths := runtimePaths(root)
	if err := os.MkdirAll(paths.workerRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	profile := []byte("profile")
	for path, data := range map[string][]byte{filepath.Join(root, "live.jsonc"): profile, filepath.Join(root, "terminal.jsonc"): []byte("terminal")} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(paths.node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(paths.wranglerCLI), 0o700); err != nil {
		t.Fatal(err)
	}
	started := filepath.Join(root, "started")
	if err := os.WriteFile(paths.node, []byte("#!/bin/sh\ntouch '"+started+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.wranglerCLI, []byte("placeholder"), 0o500); err != nil {
		t.Fatal(err)
	}

	base := CommandExecutor{ProtectedRoot: root, ProfilePath: filepath.Join(root, "live.jsonc"), ProfileSHA256: SHA256(profile), TerminalProfilePath: filepath.Join(root, "terminal.jsonc"), TerminalProfileSHA256: SHA256([]byte("terminal")), RuntimeHome: filepath.Join(root, "home"), Timeout: time.Second, skipRuntimeVerificationForTest: true}
	for _, testCase := range []struct {
		name                  string
		executorAccountID     string
		installationAccountID string
	}{
		{name: "missing-installed", executorAccountID: "account-canary"},
		{name: "missing-executor", installationAccountID: "account-canary"},
		{name: "mismatch", executorAccountID: "account-canary", installationAccountID: "other-account"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			executor := base
			executor.AccountID = testCase.executorAccountID
			executor.Installation.AccountID = testCase.installationAccountID
			if _, err := executor.Invoke(context.Background(), Invocation{Action: "worker.deploy", SourceCommit: strings.Repeat("a", 40), DeploymentCredential: []byte("synthetic")}); err == nil || err.Error() != "E_ACCOUNT_ID" {
				t.Fatalf("invalid account binding accepted: %v", err)
			}
			if _, err := os.Stat(started); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("child started before account binding rejection: %v", err)
			}
		})
	}
}

func TestCloudflareDeleteUsesFixedResourceAndNoForce(t *testing.T) {
	var observed *http.Request
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		observed = request.Clone(request.Context())
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true}`)), Header: http.Header{}}, nil
	})}
	executor := CommandExecutor{AccountID: "account-1", Installation: Installation{AccountID: "account-1"}, HTTPClient: client, Timeout: time.Second}
	if _, err := executor.invokeCloudflare(context.Background(), Invocation{Action: "worker.version.delete", VersionID: "version-123", DeploymentCredential: []byte("credential-canary")}); err != nil {
		t.Fatal(err)
	}
	if observed.Method != http.MethodDelete || observed.URL.Host != "api.cloudflare.com" || observed.URL.Path != "/client/v4/accounts/account-1/workers/workers/"+WorkerName+"/versions/version-123" || observed.URL.RawQuery != "" {
		t.Fatalf("unexpected request: %s %s", observed.Method, observed.URL.String())
	}
	if observed.Header.Get("Authorization") != "Bearer credential-canary" {
		t.Fatal("credential missing from protected request channel")
	}
	if _, err := executor.invokeCloudflare(context.Background(), Invocation{Action: "worker.version.delete", VersionID: "latest", DeploymentCredential: []byte("x")}); err == nil {
		t.Fatal("moving latest version accepted")
	}
	if _, err := executor.invokeCloudflare(context.Background(), Invocation{Action: "worker.schedule.delete", RequestID: "schedule", DeploymentCredential: []byte("credential-canary")}); err != nil {
		t.Fatal(err)
	}
	if observed.Method != http.MethodPut || observed.URL.Path != "/client/v4/accounts/account-1/workers/scripts/"+WorkerName+"/schedules" {
		t.Fatalf("unexpected schedule request: %s %s", observed.Method, observed.URL.Path)
	}
	body, _ := io.ReadAll(observed.Body)
	if string(body) != "[]" {
		t.Fatalf("unexpected schedule body %q", body)
	}
	if _, err := executor.invokeCloudflare(context.Background(), Invocation{Action: "account.workersDev.enable", Subdomain: "agentscope-dev", DeploymentCredential: []byte("credential-canary")}); err != nil {
		t.Fatal(err)
	}
	if observed.Method != http.MethodPut || observed.URL.Path != "/client/v4/accounts/account-1/workers/subdomain" {
		t.Fatalf("unexpected account subdomain request: %s %s", observed.Method, observed.URL.Path)
	}
	executor.HTTPClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://example.invalid/stolen"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})}
	if _, err := executor.invokeCloudflare(context.Background(), Invocation{Action: "worker.version.delete", VersionID: "version-123", DeploymentCredential: []byte("credential-canary")}); err == nil {
		t.Fatal("credentialed mutation followed redirect")
	}
}

func TestCloudflareMutationRejectsInvalidAccountBindingBeforeRequest(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"success":true}`)), Header: http.Header{}, Request: request}, nil
	})}
	for _, testCase := range []struct {
		name                  string
		executorAccountID     string
		installationAccountID string
	}{
		{name: "missing-installed", executorAccountID: "account-canary"},
		{name: "missing-executor", installationAccountID: "account-canary"},
		{name: "mismatch", executorAccountID: "account-canary", installationAccountID: "other-account"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			executor := CommandExecutor{AccountID: testCase.executorAccountID, Installation: Installation{AccountID: testCase.installationAccountID}, HTTPClient: client, Timeout: time.Second}
			if _, err := executor.invokeCloudflare(context.Background(), Invocation{Action: "worker.schedule.delete", DeploymentCredential: []byte("synthetic")}); err == nil || err.Error() != "E_ACCOUNT_ID" {
				t.Fatalf("invalid direct account binding accepted: %v", err)
			}
		})
	}
	if requests != 0 {
		t.Fatalf("invalid account binding reached Cloudflare transport: requests=%d", requests)
	}
}

func TestCoordinatorCredentialForwardCheckProvesDistinctRoles(t *testing.T) {
	sharedOwner, sharedOrg := "agentscope-fleet-control", "agentscope-development"
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if request.URL.Host == "api.hetzner.cloud" && request.URL.Path == "/v1/servers" {
			if request.URL.RawQuery != "page=1&per_page=1" {
				t.Fatalf("unbounded provider query %s", request.URL.String())
			}
			if token != "hetzner-canary-value" {
				t.Fatal("coordinator credential crossed the provider origin")
			}
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"servers":[],"meta":{"pagination":{"page":1,"per_page":1}}}`)), Header: http.Header{}, Request: request}, nil
		}
		if request.URL.Host != WorkerName+".agentscope-dev.workers.dev" {
			t.Fatalf("unexpected coordinator target %s", request.URL.String())
		}
		if request.URL.Path == "/v1/admin/leases" {
			if token == "shared-canary-value" {
				return &http.Response{StatusCode: http.StatusForbidden, Body: io.NopCloser(strings.NewReader(`{"error":"forbidden"}`)), Header: http.Header{}, Request: request}, nil
			}
			if token == "admin-canary-value" {
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"leases":[]}`)), Header: http.Header{}, Request: request}, nil
			}
			t.Fatal("provider credential reached coordinator admin route")
		}
		if request.URL.Path != "/v1/whoami" {
			t.Fatalf("unexpected coordinator target %s", request.URL.String())
		}
		switch token {
		case "shared-canary-value":
			body, _ := json.Marshal(map[string]any{"owner": sharedOwner, "org": sharedOrg, "auth": "shared", "admin": false})
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}, Request: request}, nil
		case "admin-canary-value":
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"owner":"agentscope-admin","org":"agentscope-development","auth":"admin","admin":true}`)), Header: http.Header{}, Request: request}, nil
		case "hetzner-canary-value":
			return &http.Response{StatusCode: http.StatusUnauthorized, Body: io.NopCloser(strings.NewReader(`{"error":"unauthorized"}`)), Header: http.Header{}, Request: request}, nil
		default:
			t.Fatalf("unexpected credential channel")
			return nil, errors.New("unexpected")
		}
	})}
	executor := CommandExecutor{HTTPClient: client}
	receipt, err := executor.ValidateCoordinatorCredentials(context.Background(), "agentscope-dev", map[string][]byte{"CRABBOX_SHARED_TOKEN": []byte("shared-canary-value"), "CRABBOX_ADMIN_TOKEN": []byte("admin-canary-value"), "HETZNER_TOKEN": []byte("hetzner-canary-value")})
	if err != nil || receipt.Action != "coordinator.credentials.validate" || len(receipt.ObservedResourceIdentities) != 5 {
		t.Fatalf("forward check: %v %#v", err, receipt)
	}
	sharedOwner = "attacker-owner"
	if _, err := executor.ValidateCoordinatorCredentials(context.Background(), "agentscope-dev", map[string][]byte{"CRABBOX_SHARED_TOKEN": []byte("shared-canary-value"), "CRABBOX_ADMIN_TOKEN": []byte("admin-canary-value"), "HETZNER_TOKEN": []byte("hetzner-canary-value")}); err == nil || !strings.Contains(err.Error(), "E_CREDENTIAL_FORWARD_ROLE") {
		t.Fatalf("wrong coordinator owner was admitted: %v", err)
	}
	sharedOwner = "agentscope-fleet-control"
	sharedOrg = "attacker-org"
	if _, err := executor.ValidateCoordinatorCredentials(context.Background(), "agentscope-dev", map[string][]byte{"CRABBOX_SHARED_TOKEN": []byte("shared-canary-value"), "CRABBOX_ADMIN_TOKEN": []byte("admin-canary-value"), "HETZNER_TOKEN": []byte("hetzner-canary-value")}); err == nil || !strings.Contains(err.Error(), "E_CREDENTIAL_FORWARD_ROLE") {
		t.Fatalf("wrong coordinator org was admitted: %v", err)
	}
	sharedOrg = "agentscope-development"
	redirecting := CommandExecutor{HTTPClient: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://example.invalid/stolen"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})}}
	if _, err := redirecting.ValidateCoordinatorCredentials(context.Background(), "agentscope-dev", map[string][]byte{"CRABBOX_SHARED_TOKEN": []byte("shared-canary-value"), "CRABBOX_ADMIN_TOKEN": []byte("admin-canary-value"), "HETZNER_TOKEN": []byte("hetzner-canary-value")}); err == nil {
		t.Fatal("credential forward validation followed redirect")
	}
}

func TestCloudflareObserverUsesClosedReadOnlySurfaceAndRejectsFalseSuccess(t *testing.T) {
	var requests []*http.Request
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Clone(request.Context()))
		if strings.HasSuffix(request.URL.Path, "/versions/version-old") {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true,"result":{"id":"version-old","migration_tag":"v1","bindings":[]},"errors":[],"messages":[]}`)), Header: http.Header{}, Request: request}, nil
		}
		result := `{"id":"surface-current"}`
		resultInfo := ""
		if request.URL.RawQuery != "" {
			result = `[{"id":"version-current","namespace_id":"namespace-1","tag":"v1"}]`
			resultInfo = fmt.Sprintf(`,"result_info":{"page":1,"per_page":%s,"total_pages":1}`, request.URL.Query().Get("per_page"))
		}
		body := `{"success":true,"result":` + result + `,"errors":[],"messages":[]` + resultInfo + `}`
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
	})}
	observer := CloudflareObserver{AccountID: "account-1", Client: client}
	state, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC())
	if err != nil || len(requests) != 12 || !stateContainsIdentity(state, "version-current") || !stateContainsIdentity(state, "namespace-1") || !stateContainsIdentity(state, "v1") {
		t.Fatalf("observation failed: %v requests=%d identities=%v", err, len(requests), state.IdentitySet)
	}
	for _, request := range requests {
		if request.Method != http.MethodGet || request.URL.Host != "api.cloudflare.com" || (request.URL.RawQuery != "" && request.URL.RawQuery != "page=1&per_page=1000" && request.URL.RawQuery != "page=1&per_page=100") || request.Header.Get("Authorization") != "Bearer read-only-canary" {
			t.Fatalf("unclosed observation request: %s %s", request.Method, request.URL.String())
		}
	}
	requests = nil
	observer.RollbackVersionID = "version-old"
	state, err = observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC())
	detail, detailOK := state.Surfaces["rollbackVersionDetail"].(map[string]any)
	if err != nil || len(requests) != 13 || !detailOK || fmt.Sprint(detail["id"]) != "version-old" {
		t.Fatalf("rollback detail observation failed: %v requests=%d detail=%#v", err, len(requests), detail)
	}
	observer.RollbackVersionID = ""
	observer.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":false,"result":null,"errors":[{"code":1}]}`)), Header: http.Header{}}, nil
	})}
	if _, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC()); err == nil {
		t.Fatal("Cloudflare success:false accepted")
	}
	observer.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true,"result":[],"result_info":{"page":1,"per_page":1000,"total_pages":2}}`)), Header: http.Header{}}, nil
	})}
	if _, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC()); err == nil || !strings.Contains(err.Error(), "E_OBSERVER_PAGINATION") {
		t.Fatal("incomplete paginated inventory accepted")
	}
	observer.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://example.invalid/stolen"}}, Body: io.NopCloser(strings.NewReader("")), Request: request}, nil
	})}
	if _, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC()); err == nil {
		t.Fatal("credentialed observer followed redirect")
	}
	observer.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true,"result":[],"errors":[],"messages":[]}`)), Header: http.Header{}, Request: request}, nil
	})}
	if _, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC()); err == nil || !strings.Contains(err.Error(), "E_OBSERVER_PAGINATION") {
		t.Fatal("missing completeness metadata accepted on paginated inventory")
	}
	notFoundClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(`{"success":false,"result":null}`)), Header: http.Header{}, Request: request}, nil
	})}
	if _, err := fetchCloudflareSurface(context.Background(), notFoundClient, []byte("read-only-canary"), cloudflareSurfaceRequest{path: "/client/v4/accounts/account-1/workers/scripts"}); err == nil || !strings.Contains(err.Error(), "E_OBSERVER_NOT_FOUND") {
		t.Fatalf("account inventory 404 fabricated absence: %v", err)
	}
	value, err := fetchCloudflareSurface(context.Background(), notFoundClient, []byte("read-only-canary"), cloudflareSurfaceRequest{path: "/client/v4/accounts/account-1/workers/scripts/agentscope-crabbox-development/deployments", allowNotFound: true})
	if err != nil || !surfaceAbsent(value) {
		t.Fatalf("target-scoped 404 was not represented for inventory cross-check: %v %#v", err, value)
	}
	observer.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/deployments") {
			return &http.Response{StatusCode: http.StatusNotFound, Body: io.NopCloser(strings.NewReader(`{"success":false,"result":null}`)), Header: http.Header{}, Request: request}, nil
		}
		result := `[]`
		if request.URL.Path == "/client/v4/accounts/account-1/workers/scripts" {
			result = `[{"id":"agentscope-crabbox-development"}]`
		}
		resultInfo := ""
		if request.URL.RawQuery != "" {
			resultInfo = fmt.Sprintf(`,"result_info":{"page":1,"per_page":%s,"total_pages":1}`, request.URL.Query().Get("per_page"))
		}
		body := `{"success":true,"result":` + result + `,"errors":[],"messages":[]` + resultInfo + `}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
	})}
	if _, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC()); err == nil || !strings.Contains(err.Error(), "E_OBSERVER_FALSE_ABSENCE") {
		t.Fatalf("target 404 contradicted complete account inventory without failing: %v", err)
	}
}

func TestCloudflareObserverAcceptsOnlyProvenCompleteSinglePageResults(t *testing.T) {
	testCases := []struct {
		name       string
		result     string
		resultInfo string
		paginated  bool
		wantError  bool
	}{
		{name: "empty-count-total", result: `[]`, resultInfo: `{"page":1,"count":0,"total_count":0}`, paginated: true},
		{name: "empty-live-shape", result: `[]`, resultInfo: `{"page":1,"per_page":1000,"count":0,"total_count":0}`, paginated: true},
		{name: "nonempty-count-total", result: `[{"id":"namespace-1"}]`, resultInfo: `{"page":1,"per_page":1000,"count":1,"total_count":1}`, paginated: true},
		{name: "optional-surface-count-total", result: `[]`, resultInfo: `{"page":1,"per_page":1000,"count":0,"total_count":0}`},
		{name: "classic-total-pages", result: `[]`, resultInfo: `{"page":1,"per_page":1000,"total_pages":1}`, paginated: true},
		{name: "classic-scalar-result", result: `{"id":"namespace-1"}`, resultInfo: `{"page":1,"per_page":1000,"total_pages":1}`, paginated: true, wantError: true},
		{name: "classic-overfull-page", result: `[{"id":"one"},{"id":"two"}]`, resultInfo: `{"page":1,"per_page":1,"total_pages":1}`, paginated: true, wantError: true},
		{name: "later-page", result: `[]`, resultInfo: `{"page":2,"count":0,"total_count":0}`, paginated: true, wantError: true},
		{name: "multiple-pages", result: `[]`, resultInfo: `{"page":1,"per_page":1000,"total_pages":2}`, paginated: true, wantError: true},
		{name: "truncated-total", result: `[{"id":"namespace-1"}]`, resultInfo: `{"page":1,"per_page":1000,"count":1,"total_count":2}`, paginated: true, wantError: true},
		{name: "optional-surface-truncated-total", result: `[{"id":"domain-1"}]`, resultInfo: `{"page":1,"per_page":1000,"count":1,"total_count":2}`, wantError: true},
		{name: "count-does-not-match-result", result: `[]`, resultInfo: `{"page":1,"per_page":1000,"count":1,"total_count":1}`, paginated: true, wantError: true},
		{name: "partial-count-shape", result: `[]`, resultInfo: `{"page":1,"count":0}`, paginated: true, wantError: true},
		{name: "missing-terminal-proof", result: `[]`, resultInfo: `{"page":1,"per_page":1000}`, paginated: true, wantError: true},
		{name: "invalid-per-page", result: `[]`, resultInfo: `{"page":1,"per_page":0,"count":0,"total_count":0}`, paginated: true, wantError: true},
		{name: "count-exceeds-page", result: `[{"id":"one"},{"id":"two"}]`, resultInfo: `{"page":1,"per_page":1,"count":2,"total_count":2}`, paginated: true, wantError: true},
		{name: "count-shape-requires-array", result: `{"id":"namespace-1"}`, resultInfo: `{"page":1,"count":1,"total_count":1}`, paginated: true, wantError: true},
		{name: "unknown-pagination-field", result: `[]`, resultInfo: `{"page":1,"count":0,"total_count":0,"cursor":"opaque"}`, paginated: true, wantError: true},
		{name: "duplicate-pagination-field", result: `[]`, resultInfo: `{"page":1,"count":0,"count":1,"total_count":0}`, paginated: true, wantError: true},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			body := `{"success":true,"result":` + testCase.result + `,"errors":[],"messages":[],"result_info":` + testCase.resultInfo + `}`
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
			})}
			pageSize := 0
			if testCase.paginated {
				pageSize = 1000
			}
			value, err := fetchCloudflareSurface(context.Background(), client, []byte("read-only-canary"), cloudflareSurfaceRequest{name: "testSurface", path: "/client/v4/accounts/account-1/workers/durable_objects/namespaces", pageSize: pageSize})
			if testCase.wantError {
				if err == nil || err.Error() != "E_OBSERVER_PAGINATION_TEST_SURFACE" {
					t.Fatalf("incomplete pagination accepted: value=%#v err=%v", value, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("complete pagination rejected: %v", err)
			}
		})
	}
}

func TestCloudflareObserverTraversesWorkerVersionPaginationWithinBounds(t *testing.T) {
	versionPage := func(start, count int) string {
		items := make([]string, count)
		for index := range items {
			items[index] = fmt.Sprintf(`{"id":"version-%03d"}`, start+index)
		}
		return "[" + strings.Join(items, ",") + "]"
	}
	requests := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Path != "/client/v4/accounts/account-1/workers/workers/worker-1/versions" || request.URL.Query().Get("per_page") != "100" {
			t.Fatalf("unexpected version request: %s", request.URL.String())
		}
		page := request.URL.Query().Get("page")
		result := versionPage(1, 100)
		count := 100
		if page == "2" {
			result = versionPage(101, 1)
			count = 1
		} else if page != "1" {
			t.Fatalf("unexpected page: %s", page)
		}
		body := fmt.Sprintf(`{"success":true,"result":%s,"result_info":{"page":%s,"per_page":100,"count":%d,"total_count":101,"total_pages":2}}`, result, page, count)
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
	})}
	value, err := fetchCloudflareSurface(context.Background(), client, []byte("read-only-canary"), cloudflareSurfaceRequest{
		name:     "scriptVersions",
		path:     "/client/v4/accounts/account-1/workers/workers/worker-1/versions",
		pageSize: 100,
	})
	items, ok := value.([]any)
	if err != nil || !ok || len(items) != 101 || requests != 2 {
		t.Fatalf("complete version pagination failed: value=%T len=%d requests=%d err=%v", value, len(items), requests, err)
	}

	client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body := `{"success":true,"result":[],"result_info":{"page":1,"per_page":100,"count":0,"total_count":10000,"total_pages":101}}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
	})
	if _, err := fetchCloudflareSurface(context.Background(), client, []byte("read-only-canary"), cloudflareSurfaceRequest{name: "scriptVersions", path: "/client/v4/accounts/account-1/workers/workers/worker-1/versions", pageSize: 100}); err == nil || err.Error() != "E_OBSERVER_PAGINATION_SCRIPT_VERSIONS" {
		t.Fatalf("oversized pagination was not rejected with surface identity: %v", err)
	}
}

func TestCloudflareObserverRejectsCrossPageDriftAndStopsOnCancellation(t *testing.T) {
	hundredItems := "[" + strings.TrimSuffix(strings.Repeat(`{},`, 100), ",") + "]"
	testCases := []struct {
		name        string
		secondBody  string
		secondCode  int
		cancelAfter bool
		wantError   string
	}{
		{name: "total-count-drift", secondBody: `{"success":true,"result":[{}],"result_info":{"page":2,"per_page":100,"count":1,"total_count":102,"total_pages":2}}`, wantError: "E_OBSERVER_PAGINATION_CONTRACT_TEST"},
		{name: "per-page-drift", secondBody: `{"success":true,"result":[{}],"result_info":{"page":2,"per_page":51,"count":1,"total_count":101,"total_pages":2}}`, wantError: "E_OBSERVER_PAGINATION_CONTRACT_TEST"},
		{name: "final-aggregate-mismatch", secondBody: `{"success":true,"result":[],"result_info":{"page":2,"per_page":100,"count":0,"total_count":101,"total_pages":2}}`, wantError: "E_OBSERVER_PAGINATION_CONTRACT_TEST"},
		{name: "later-page-not-found", secondCode: http.StatusNotFound, secondBody: `{"success":false,"result":null}`, wantError: "E_OBSERVER_NOT_FOUND"},
		{name: "cancel-between-pages", cancelAfter: true, wantError: "E_OBSERVER_UNAVAILABLE"},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			requests := 0
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				requests++
				if err := request.Context().Err(); err != nil {
					return nil, err
				}
				if requests == 1 {
					if testCase.cancelAfter {
						cancel()
					}
					body := fmt.Sprintf(`{"success":true,"result":%s,"result_info":{"page":1,"per_page":100,"count":100,"total_count":101,"total_pages":2}}`, hundredItems)
					return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
				}
				code := testCase.secondCode
				if code == 0 {
					code = http.StatusOK
				}
				return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(testCase.secondBody)), Header: http.Header{}, Request: request}, nil
			})}
			_, err := fetchCloudflareSurface(ctx, client, []byte("read-only-canary"), cloudflareSurfaceRequest{name: "paginationContractTest", path: "/client/v4/accounts/account-1/workers/workers/worker-1/versions", pageSize: 100})
			if err == nil || err.Error() != testCase.wantError {
				t.Fatalf("cross-page failure mismatch: requests=%d err=%v want=%s", requests, err, testCase.wantError)
			}
		})
	}
}

func TestCloudflareObserverInventoriesEveryUnrelatedWorkerSurface(t *testing.T) {
	var paths []string
	accountWorkers := `[{"id":"agentscope-crabbox-development"},{"id":"unrelated-z"},{"id":"unrelated-a"}]`
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		paths = append(paths, request.URL.Path)
		result := `[]`
		if request.URL.Path == "/client/v4/accounts/account-1/workers/scripts" {
			result = accountWorkers
		}
		resultInfo := ""
		if request.URL.RawQuery != "" {
			resultInfo = fmt.Sprintf(`,"result_info":{"page":1,"per_page":%s,"total_pages":1}`, request.URL.Query().Get("per_page"))
		}
		body := `{"success":true,"result":` + result + `,"errors":[],"messages":[]` + resultInfo + `}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
	})}
	observer := CloudflareObserver{AccountID: "account-1", Client: client}
	state, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	unrelated, ok := state.Surfaces["unrelatedWorkers"].(map[string]any)
	if !ok || len(unrelated) != 2 || unrelated["unrelated-a"] == nil || unrelated["unrelated-z"] == nil {
		t.Fatalf("unrelated worker projection missing: %#v", state.Surfaces["unrelatedWorkers"])
	}
	firstUnrelated := ""
	for _, path := range paths {
		if strings.Contains(path, "unrelated-") {
			firstUnrelated = path
			break
		}
	}
	if !strings.Contains(firstUnrelated, "unrelated-a") {
		t.Fatalf("unrelated Workers were not inventoried in stable identity order: %v", paths)
	}
	for _, suffix := range []string{"/deployments", "/schedules", "/secrets", "/script-settings", "/settings", "/tails", "/subdomain", "/versions"} {
		for _, workerName := range []string{"unrelated-a", "unrelated-z"} {
			found := false
			for _, path := range paths {
				if strings.Contains(path, workerName) && strings.HasSuffix(path, suffix) {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("unrelated Worker %s surface %s was not inventoried: %v", workerName, suffix, paths)
			}
		}
	}
	accountWorkers = `[{"id":"agentscope-crabbox-development"},{"id":"duplicate-worker"},{"id":"duplicate-worker"}]`
	if _, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC()); err == nil || err.Error() != "E_OBSERVER_WORKER_IDENTITY" {
		t.Fatalf("duplicate Worker identity was not rejected: %v", err)
	}
	accountWorkers = `[{"id":"agentscope-crabbox-development"},{"id":"agentscope-crabbox-development"}]`
	if _, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC()); err == nil || err.Error() != "E_OBSERVER_WORKER_IDENTITY" {
		t.Fatalf("duplicate owned Worker identity was not rejected: %v", err)
	}
}

func TestInstalledRuntimeIsRootLocalAndTamperEvident(t *testing.T) {
	item := newFixture(t)
	data, err := os.ReadFile(item.store.path("policy", "installation.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{t.TempDir(), `"npmPath"`, `"crabboxSource"`, `"liveProfilePath"`} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("external runtime authority persisted: %s", forbidden)
		}
	}
	paths := runtimePaths(item.store.path("toolchain"))
	if err := os.Chmod(paths.wranglerCLI, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.wranglerCLI, []byte("substituted"), 0o500); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyRuntimeClosure(item.store.path("toolchain"), item.installation); err == nil {
		t.Fatal("protected runtime substitution accepted")
	}
}

func TestInstalledRuntimeAdmitsPinnedNodeBinarySize(t *testing.T) {
	item := newFixture(t)
	paths := runtimePaths(item.store.path("toolchain"))
	const pinnedNodeSize = int64(121306800)
	if pinnedNodeSize <= 64<<20 || pinnedNodeSize > maxRuntimeEntryBytes {
		t.Fatalf("pinned Node size is outside the intended runtime-only bound: %d", pinnedNodeSize)
	}
	if err := os.Chmod(paths.node, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(paths.node, pinnedNodeSize); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(paths.node, 0o555); err != nil {
		t.Fatal(err)
	}
	node, err := os.ReadFile(paths.node)
	if err != nil {
		t.Fatal(err)
	}
	item.installation.NodeSHA256 = SHA256(node)
	item.installation.RuntimeTreeSHA256, err = runtimeTreeDigest(item.store.path("toolchain"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifyRuntimeClosure(item.store.path("toolchain"), item.installation); err != nil {
		t.Fatalf("pinned Node-sized protected runtime rejected: %v", err)
	}
	if err := verifiedFileDigest(paths.node, item.installation.NodeSHA256); err == nil || !strings.Contains(err.Error(), "E_TOOLCHAIN_FILE") {
		t.Fatalf("unrelated 64 MiB verifier bound widened: %v", err)
	}
	item.installation.NodeSHA256 = strings.Repeat("0", 64)
	if _, err := verifyRuntimeClosure(item.store.path("toolchain"), item.installation); err == nil || !strings.Contains(err.Error(), "E_TOOLCHAIN_CHANGED") {
		t.Fatalf("wrong pinned Node digest accepted: %v", err)
	}
}

func TestRuntimeVerifierRejectsEntryAboveArchiveBound(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "oversized-runtime-entry")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxRuntimeEntryBytes + 1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o400); err != nil {
		t.Fatal(err)
	}
	if err := verifiedFileDigestBounded(path, strings.Repeat("0", 64), maxRuntimeEntryBytes); err == nil || !strings.Contains(err.Error(), "E_TOOLCHAIN_FILE") {
		t.Fatalf("runtime entry above archive bound accepted: %v", err)
	}
	valid := filepath.Join(root, "valid-runtime-entry")
	if err := os.WriteFile(valid, []byte("runtime"), 0o400); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "runtime-entry-link")
	if err := os.Symlink(valid, link); err != nil {
		t.Fatal(err)
	}
	if err := verifiedFileDigestBounded(link, SHA256([]byte("runtime")), maxRuntimeEntryBytes); err == nil || !strings.Contains(err.Error(), "E_TOOLCHAIN_FILE") {
		t.Fatalf("runtime entry symlink accepted: %v", err)
	}
	if err := os.Chmod(valid, 0o622); err != nil {
		t.Fatal(err)
	}
	if err := verifiedFileDigestBounded(valid, SHA256([]byte("runtime")), maxRuntimeEntryBytes); err == nil || !strings.Contains(err.Error(), "E_TOOLCHAIN_FILE") {
		t.Fatalf("group/world-writable runtime entry accepted: %v", err)
	}
}

func TestRuntimeClosureRejectsSymlinkAndTraversal(t *testing.T) {
	makeArchive := func(header tar.Header) []byte {
		var buffer bytes.Buffer
		gzipWriter := gzip.NewWriter(&buffer)
		tarry := tar.NewWriter(gzipWriter)
		if err := tarry.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		if err := tarry.Close(); err != nil {
			t.Fatal(err)
		}
		if err := gzipWriter.Close(); err != nil {
			t.Fatal(err)
		}
		return buffer.Bytes()
	}
	for name, header := range map[string]tar.Header{
		"symlink":   {Name: "node/bin/node", Typeflag: tar.TypeSymlink, Linkname: "/bin/sh", Mode: 0o700},
		"traversal": {Name: "../escape", Typeflag: tar.TypeReg, Mode: 0o600},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := extractRuntimeClosure(makeArchive(header), filepath.Join(t.TempDir(), "runtime"), strings.Repeat("a", 64)); err == nil {
				t.Fatal("hostile runtime archive accepted")
			}
		})
	}
}

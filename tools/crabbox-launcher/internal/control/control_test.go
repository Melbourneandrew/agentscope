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
	installation, err := Install(InstallInput{Root: root, InstallationID: "install-1", EnvironmentID: "asgcf_0123456789abcdef0123456789abcdef", AccountID: "account-1", HetznerProjectID: "project-1", CoordinatorCommit: strings.Repeat("a", 40), AdmissionSHA256: SHA256(admission), PermissionManifestSHA256: SHA256(manifest), LiveProfileSHA256: SHA256(live), TerminalProfileSHA256: SHA256(terminal), Launcher: launcher, Admission: admission, PermissionManifest: manifest, LiveProfile: live, TerminalProfile: terminal, TerminalEntryPoint: terminalEntry, RuntimeClosure: runtimeClosure, RuntimeClosureSHA256: SHA256(runtimeClosure), ToolchainIdentity: toolchain, OperatorPassphrase: syntheticOperatorPassphrase})
	if err != nil {
		t.Fatal(err)
	}
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

func syntheticState(account string, step int, now time.Time) StateObservation {
	vars := map[string]any{"AGENTSCOPE_CRABBOX_ENVIRONMENT_ID": "asgcf_0123456789abcdef0123456789abcdef", "CRABBOX_DEFAULT_ORG": "agentscope-development", "CRABBOX_MAX_ACTIVE_LEASES": "4", "CRABBOX_MAX_ACTIVE_LEASES_PER_ORG": "4", "CRABBOX_MAX_ACTIVE_LEASES_PER_OWNER": "4", "CRABBOX_MAX_MONTHLY_USD": "25", "CRABBOX_MAX_MONTHLY_USD_PER_ORG": "25", "CRABBOX_MAX_MONTHLY_USD_PER_OWNER": "25", "CRABBOX_RUN_RETENTION_DAYS": "30", "CRABBOX_SHARED_OWNER": "agentscope-fleet-control"}
	surfaces := map[string]any{"step": step, "scriptSettings": map[string]any{"binding": "FLEET", "class": "FleetDurableObject", "namespace": "namespace-1", "vars": vars}, "scriptDeployments": map[string]any{"id": fmt.Sprintf("version-%d", step)}, "scriptVersions": []any{map[string]any{"id": fmt.Sprintf("version-%d", step)}}, "scriptSchedules": []any{map[string]any{"cron": "*/15 * * * *"}}, "scriptSecrets": []any{map[string]any{"name": "HETZNER_TOKEN"}, map[string]any{"name": "CRABBOX_SHARED_TOKEN"}, map[string]any{"name": "CRABBOX_ADMIN_TOKEN"}}, "scriptWorkersDev": map[string]any{"enabled": true}, "scriptDomains": []any{}, "scriptTails": []any{}}
	if step >= 6 {
		for _, name := range []string{"scriptSettings", "scriptDeployments", "scriptVersions", "scriptSchedules", "scriptSecrets", "scriptTails", "scriptWorkersDev"} {
			surfaces[name] = map[string]any{"absent": true}
		}
	}
	return StateObservation{SchemaVersion: SchemaVersion, AccountID: account, WorkerName: WorkerName, ObservedAt: now, Surfaces: surfaces, IdentitySet: []string{fmt.Sprintf("step=%d", step), "workerVersion=version-current", "namespaceId=namespace-1", "migrationTag=v1"}}
}

func (item fixture) plan() (Plan, []byte) {
	pre, _, _ := syntheticState(item.installation.AccountID, 0, item.now).Digests()
	plan := Plan{SchemaVersion: SchemaVersion, Kind: "deploy", AccountID: item.installation.AccountID, EnvironmentID: item.installation.EnvironmentID, WorkerName: WorkerName, SourceCommit: strings.Repeat("a", 40), ToolchainIdentity: item.toolchain, AdmissionSHA256: item.installation.AdmissionSHA256, PermissionManifestSHA256: item.installation.PermissionManifestSHA256, ProfileSHA256: item.profileDigest, ObservablePrestateSHA256: pre, ObservationID: "observation-1", CurrentWorkerVersionID: "version-current", DurableObjectNamespaceID: "namespace-1", CurrentMigrationTag: "v1", HetznerProjectID: item.installation.HetznerProjectID, Operations: []Operation{
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-admin", SecretName: pointer("CRABBOX_ADMIN_TOKEN"), SlotID: pointer("slot-crabbox-admin"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-shared", SecretName: pointer("CRABBOX_SHARED_TOKEN"), SlotID: pointer("slot-crabbox-shared"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-provider", SecretName: pointer("HETZNER_TOKEN"), SlotID: pointer("slot-hetzner-worker"), SlotVersion: pointer("version-1")},
		{Action: "worker.deploy", Target: WorkerName, RequestID: "deploy", ProfileSHA256: pointer(item.profileDigest), ExpectedPreviousVersionID: pointer("version-current")},
	}, RollbackActions: []Operation{{Action: "worker.rollback", Target: WorkerName, RequestID: "rollback", VersionID: pointer("version-current"), CompatibleMigrationTag: pointer("v1")}}, IssuedAt: item.now.Add(-time.Minute), ExpiresAt: item.now.Add(10 * time.Minute), Nonce: "nonce-1"}
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
	pre, _, _ := syntheticState(item.installation.AccountID, 0, item.now).Digests()
	plan := Plan{SchemaVersion: SchemaVersion, Kind: "retire", AccountID: item.installation.AccountID, EnvironmentID: item.installation.EnvironmentID, WorkerName: WorkerName, SourceCommit: strings.Repeat("a", 40), ToolchainIdentity: item.toolchain, AdmissionSHA256: item.installation.AdmissionSHA256, PermissionManifestSHA256: item.installation.PermissionManifestSHA256, ProfileSHA256: item.installation.TerminalProfileSHA256, ObservablePrestateSHA256: pre, ObservationID: "observation-retire", CurrentWorkerVersionID: "version-current", DurableObjectNamespaceID: "namespace-1", CurrentMigrationTag: "v1", HetznerProjectID: item.installation.HetznerProjectID, ProviderZeroSHA256: &providerZero, RetirementTombstoneSHA256: &tombstone, AcquisitionFreezeID: pointer("freeze-1"), LauncherCredentialRevocationID: pointer("revocation-1"), Operations: []Operation{
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
}

func (observer *advancingObserver) Observe(_ context.Context, _ []byte, now time.Time) (StateObservation, error) {
	observer.mu.Lock()
	defer observer.mu.Unlock()
	step := observer.calls / 2
	if observer.calls == 0 {
		step = 0
	}
	observer.calls++
	return syntheticState(observer.account, step, now), nil
}

func (item fixture) observer() StateObserver {
	return &advancingObserver{account: item.installation.AccountID, now: item.now}
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
	if err := os.Remove(item.store.path("slots", entry.SlotID, entry.SlotVersion+".json")); err != nil {
		t.Fatal(err)
	}
	if _, err := item.store.EnrollCredential(item.installation.EnvironmentID, "cloudflare-plan-read", "slot-plan-new", "version-2", []byte(strings.Repeat("z", 32)), item.now); err != nil {
		t.Fatal(err)
	}
	digest, err := item.store.CredentialSetSHA256()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidatePlan(data, authorizationData, item.installation, digest, item.now); err == nil || !strings.Contains(err.Error(), "E_AUTHORIZATION_BINDING") {
		t.Fatalf("credential substitution accepted: %v", err)
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
	if successes != 1 || executor.count() != 4 {
		t.Fatalf("successes=%d calls=%d", successes, executor.count())
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
	wrong := syntheticState(item.installation.AccountID, 99, item.now)
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
	plan.Operations[3].VersionID = pointer("smuggled")
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
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: retirementData, AuthorizationData: retirementAuth, ObservationData: retirementObservation, AttestationData: retirementAttestation, RetirementEvidenceData: item.signedRetirementEvidence(retirement), Now: item.now, Clock: func() time.Time { return item.now }}, executor, item.observer()); err != nil {
		t.Fatal(err)
	}
	if executor.count() != 8 {
		t.Fatalf("retirement calls=%d", executor.count())
	}
	if _, err := os.Stat(item.store.path("evidence", "retirement-complete.json")); err != nil {
		t.Fatal("terminal retirement evidence absent")
	}
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
	first := item.store.path("journal", digest, "000000-consumed.json")
	if err := os.WriteFile(first, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := item.store.VerifyJournal(digest); err == nil {
		t.Fatal("corrupt journal accepted")
	}
}

func TestRecoveryClassifiesCrashAfterConsumeBeforeFenceAsDefiniteNoncommit(t *testing.T) {
	item := newFixture(t)
	_, data := item.plan()
	digest := SHA256(data)
	if _, err := item.store.consumePlan(digest, item.now); err != nil {
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
[ "$CLOUDFLARE_API_TOKEN" = deployment-canary ]
[ "$1" != "" ]
[ "$2" = secret ] && [ "$3" = put ] && [ "$4" = CRABBOX_ADMIN_TOKEN ]
IFS= read -r secret
[ "$secret" = worker-canary ]
`
	if err := os.WriteFile(npm, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UNSAFE_AMBIENT", "must-not-be-inherited")
	executor := CommandExecutor{ProtectedRoot: root, ProfilePath: filepath.Join(root, "live.jsonc"), ProfileSHA256: SHA256(profile), TerminalProfilePath: filepath.Join(root, "terminal.jsonc"), TerminalProfileSHA256: SHA256(terminal), RuntimeHome: filepath.Join(root, "home"), Timeout: 3 * time.Second, skipRuntimeVerificationForTest: true}
	_, err := executor.Invoke(context.Background(), Invocation{Action: "worker.secret.put", RequestID: "put", SecretName: "CRABBOX_ADMIN_TOKEN", Secret: []byte("worker-canary\n"), DeploymentCredential: []byte("deployment-canary")})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := executor.command(Invocation{Action: "forbidden"}); err == nil {
		t.Fatal("arbitrary action accepted")
	}
}

func TestCloudflareDeleteUsesFixedResourceAndNoForce(t *testing.T) {
	var observed *http.Request
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		observed = request.Clone(request.Context())
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true}`)), Header: http.Header{}}, nil
	})}
	executor := CommandExecutor{AccountID: "account-1", HTTPClient: client, Timeout: time.Second}
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
}

func TestCloudflareObserverUsesClosedReadOnlySurfaceAndRejectsFalseSuccess(t *testing.T) {
	var requests []*http.Request
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Clone(request.Context()))
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"success":true,"result":{"id":"version-current","namespace_id":"namespace-1","tag":"v1"},"errors":[],"messages":[]}`)), Header: http.Header{}}, nil
	})}
	observer := CloudflareObserver{AccountID: "account-1", Client: client}
	state, err := observer.Observe(context.Background(), []byte("read-only-canary"), time.Now().UTC())
	if err != nil || len(requests) != 11 || !stateContainsIdentity(state, "version-current") || !stateContainsIdentity(state, "namespace-1") || !stateContainsIdentity(state, "v1") {
		t.Fatalf("observation failed: %v requests=%d identities=%v", err, len(requests), state.IdentitySet)
	}
	for _, request := range requests {
		if request.Method != http.MethodGet || request.URL.Host != "api.cloudflare.com" || (request.URL.RawQuery != "" && request.URL.RawQuery != "page=1&per_page=1000") || request.Header.Get("Authorization") != "Bearer read-only-canary" {
			t.Fatalf("unclosed observation request: %s %s", request.Method, request.URL.String())
		}
	}
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

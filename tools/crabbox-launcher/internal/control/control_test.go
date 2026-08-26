package control

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
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
	npm := filepath.Join(parent, "npm")
	if err := os.WriteFile(npm, []byte("fake npm\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(parent, "crabbox")
	if err := os.MkdirAll(filepath.Join(source, "worker"), 0o700); err != nil {
		t.Fatal(err)
	}
	lock := []byte("locked\n")
	if err := os.WriteFile(filepath.Join(source, "worker", "package-lock.json"), lock, 0o600); err != nil {
		t.Fatal(err)
	}
	toolchain := ToolchainIdentity{NodeVersion: "24.19.0", NodeArchiveSHA256: strings.Repeat("1", 64), WranglerVersion: "4.114.0", WorkerLockSHA256: SHA256(lock), GoVersion: "1.26.5", GoArchiveSHA256: strings.Repeat("2", 64), CrabboxClientSHA256: strings.Repeat("3", 64)}
	launcher, admission, manifest := []byte("launcher"), []byte(`{"coordinator":{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}`), []byte("manifest")
	live, terminal, terminalEntry := []byte("live-profile"), []byte("terminal-profile"), []byte("terminal-entry")
	livePath, terminalPath, terminalEntryPath := filepath.Join(source, "worker", "live.jsonc"), filepath.Join(source, "worker", "terminal.jsonc"), filepath.Join(source, "worker", "terminal.mjs")
	for path, data := range map[string][]byte{livePath: live, terminalPath: terminal, terminalEntryPath: terminalEntry} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	root := filepath.Join(parent, "installed")
	installation, err := Install(InstallInput{Root: root, InstallationID: "install-1", EnvironmentID: "asgcf_0123456789abcdef0123456789abcdef", AccountID: "account-1", HetznerProjectID: "project-1", CoordinatorCommit: strings.Repeat("a", 40), AdmissionSHA256: SHA256(admission), PermissionManifestSHA256: SHA256(manifest), LiveProfileSHA256: SHA256(live), TerminalProfileSHA256: SHA256(terminal), Launcher: launcher, Admission: admission, PermissionManifest: manifest, LiveProfile: live, TerminalProfile: terminal, TerminalEntryPoint: terminalEntry, LiveProfilePath: livePath, TerminalProfilePath: terminalPath, TerminalEntryPointPath: terminalEntryPath, NPMPath: npm, NPMPathSHA256: SHA256([]byte("fake npm\n")), CrabboxSource: source, ToolchainIdentity: toolchain, OperatorPassphrase: syntheticOperatorPassphrase})
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

func pointer(value string) *string { return &value }

func (item fixture) plan() (Plan, []byte) {
	plan := Plan{SchemaVersion: SchemaVersion, Kind: "deploy", AccountID: item.installation.AccountID, EnvironmentID: item.installation.EnvironmentID, WorkerName: WorkerName, SourceCommit: strings.Repeat("a", 40), ToolchainIdentity: item.toolchain, AdmissionSHA256: item.installation.AdmissionSHA256, PermissionManifestSHA256: item.installation.PermissionManifestSHA256, ProfileSHA256: item.profileDigest, ObservablePrestateSHA256: strings.Repeat("4", 64), ObservationID: "observation-1", CurrentWorkerVersionID: "version-current", DurableObjectNamespaceID: "namespace-1", CurrentMigrationTag: "v1", HetznerProjectID: item.installation.HetznerProjectID, Operations: []Operation{
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-provider", SecretName: pointer("HETZNER_TOKEN"), SlotID: pointer("slot-hetzner-worker"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-shared", SecretName: pointer("CRABBOX_SHARED_TOKEN"), SlotID: pointer("slot-crabbox-shared"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.put", Target: WorkerName, RequestID: "put-admin", SecretName: pointer("CRABBOX_ADMIN_TOKEN"), SlotID: pointer("slot-crabbox-admin"), SlotVersion: pointer("version-1")},
		{Action: "worker.deploy", Target: WorkerName, RequestID: "deploy", ProfileSHA256: pointer(item.profileDigest), ExpectedPreviousVersionID: pointer("version-current")},
	}, RollbackActions: []Operation{{Action: "worker.rollback", Target: WorkerName, RequestID: "rollback", VersionID: pointer("version-current"), CompatibleMigrationTag: pointer("v1")}}, IssuedAt: item.now.Add(-time.Minute), ExpiresAt: item.now.Add(10 * time.Minute), Nonce: "nonce-1", IntendedTerminalStateSHA256: strings.Repeat("5", 64)}
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
	plan := Plan{SchemaVersion: SchemaVersion, Kind: "retire", AccountID: item.installation.AccountID, EnvironmentID: item.installation.EnvironmentID, WorkerName: WorkerName, SourceCommit: strings.Repeat("a", 40), ToolchainIdentity: item.toolchain, AdmissionSHA256: item.installation.AdmissionSHA256, PermissionManifestSHA256: item.installation.PermissionManifestSHA256, ProfileSHA256: item.installation.TerminalProfileSHA256, ObservablePrestateSHA256: strings.Repeat("4", 64), ObservationID: "observation-retire", CurrentWorkerVersionID: "version-current", DurableObjectNamespaceID: "namespace-1", CurrentMigrationTag: "v1", HetznerProjectID: item.installation.HetznerProjectID, ProviderZeroSHA256: &providerZero, RetirementTombstoneSHA256: &tombstone, AcquisitionFreezeID: pointer("freeze-1"), LauncherCredentialRevocationID: pointer("revocation-1"), Operations: []Operation{
		{Action: "worker.secret.delete", Target: WorkerName, RequestID: "delete-provider", SecretName: pointer("HETZNER_TOKEN"), SlotID: pointer("slot-hetzner-worker"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.delete", Target: WorkerName, RequestID: "delete-shared", SecretName: pointer("CRABBOX_SHARED_TOKEN"), SlotID: pointer("slot-crabbox-shared"), SlotVersion: pointer("version-1")},
		{Action: "worker.secret.delete", Target: WorkerName, RequestID: "delete-admin", SecretName: pointer("CRABBOX_ADMIN_TOKEN"), SlotID: pointer("slot-crabbox-admin"), SlotVersion: pointer("version-1")},
		{Action: "worker.terminalArtifact.deploy", Target: WorkerName, RequestID: "terminal-deploy", ProfileSHA256: pointer(item.installation.TerminalProfileSHA256), EntryPointSHA256: pointer(item.installation.TerminalEntryPointSHA256), ProviderZeroSHA256: &providerZero, RetirementTombstoneSHA256: &tombstone},
		{Action: "worker.version.delete", Target: WorkerName, RequestID: "delete-version", VersionID: pointer("version-old")},
		{Action: "worker.delete", Target: WorkerName, RequestID: "delete-worker"},
	}, RollbackActions: []Operation{}, IssuedAt: item.now.Add(-time.Minute), ExpiresAt: item.now.Add(10 * time.Minute), Nonce: "retirement-nonce", IntendedTerminalStateSHA256: strings.Repeat("8", 64)}
	data, err := json.Marshal(plan)
	if err != nil {
		item.t.Fatal(err)
	}
	return plan, data
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

func (executor *recordingExecutor) Invoke(_ context.Context, invocation Invocation) error {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	executor.calls = append(executor.calls, invocation)
	if executor.failureAt > 0 && len(executor.calls) == executor.failureAt {
		return errors.New("synthetic")
	}
	return nil
}
func (executor *recordingExecutor) count() int {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return len(executor.calls)
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
	if err := item.store.Apply(context.Background(), input, executor); err == nil {
		t.Fatal("missing credential accepted")
	}
	if executor.count() != 0 {
		t.Fatal("executor invoked before credential resolution")
	}
	if _, err := os.Stat(item.store.path("journal", SHA256(data), "000000-consumed.json")); err != nil {
		t.Fatalf("consumption not durable: %v", err)
	}
	if err := item.store.Apply(context.Background(), input, executor); err == nil {
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
		go func() { <-start; results <- item.store.Apply(context.Background(), input, executor) }()
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
	err := item.store.Apply(context.Background(), input, executor)
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
	err = item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor)
	if err == nil || !strings.Contains(err.Error(), "E_SLOT_EQUAL") || executor.count() != 0 {
		t.Fatalf("equal secrets not rejected: %v calls=%d", err, executor.count())
	}
}

func TestPlanRejectsExtraFieldsAndDeletionFirstRetirement(t *testing.T) {
	item := newFixture(t)
	plan, _ := item.plan()
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
	if _, err := item.store.Freeze("operator-freeze", item.now, syntheticOperatorPassphrase); err != nil {
		t.Fatal(err)
	}
	deploy, deployData := item.plan()
	deployAuth, observation, attestation := item.authority(deploy, deployData)
	executor := &recordingExecutor{}
	err := item.store.Apply(context.Background(), ApplyInput{PlanData: deployData, AuthorizationData: deployAuth, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor)
	if err == nil || !strings.Contains(err.Error(), "E_ACQUISITION_FROZEN") || executor.count() != 0 {
		t.Fatalf("frozen deploy result=%v calls=%d", err, executor.count())
	}
	retirement, retirementData := item.retirementPlan()
	retirementAuth, retirementObservation, retirementAttestation := item.authority(retirement, retirementData)
	if err := item.store.Apply(context.Background(), ApplyInput{PlanData: retirementData, AuthorizationData: retirementAuth, ObservationData: retirementObservation, AttestationData: retirementAttestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor); err != nil {
		t.Fatal(err)
	}
	if executor.count() != 6 {
		t.Fatalf("retirement calls=%d", executor.count())
	}
	if _, err := os.Stat(item.store.path("evidence", "retirement-complete.json")); err != nil {
		t.Fatal("terminal retirement evidence absent")
	}
}

func TestRecoveryQuarantineRequiresIntactJournalAndKeepsFence(t *testing.T) {
	item := newFixture(t)
	plan, data := item.plan()
	authorization, observation, attestation := item.authority(plan, data)
	executor := &recordingExecutor{failureAt: 1}
	_ = item.store.Apply(context.Background(), ApplyInput{PlanData: data, AuthorizationData: authorization, ObservationData: observation, AttestationData: attestation, Now: item.now, Clock: func() time.Time { return item.now }}, executor)
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
	resolved, err := item.store.ResolveQuarantine(digest, "put-admin", strings.Repeat("9", 64), item.now, syntheticOperatorPassphrase)
	if err != nil || resolved.Disposition != "reconciled-abandoned" {
		t.Fatalf("resolve quarantine: %v", err)
	}
	if _, err := os.Stat(item.store.path("journal", "mutation.lock")); !os.IsNotExist(err) {
		t.Fatal("resolved quarantine retained local fence")
	}
	if !item.store.IsFrozen() {
		t.Fatal("resolved quarantine cleared acquisition freeze")
	}
	first := item.store.path("journal", digest, "000000-consumed.json")
	if err := os.WriteFile(first, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := item.store.VerifyJournal(digest); err == nil {
		t.Fatal("corrupt journal accepted")
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
	executor := CommandExecutor{NPMPath: npm, NPMPathSHA256: SHA256(script), WorkerRoot: root, WorkerLockSHA256: SHA256(lock), ProfilePath: filepath.Join(root, "live"), ProfileSHA256: SHA256(profile), TerminalProfilePath: filepath.Join(root, "terminal"), TerminalProfileSHA256: SHA256(terminal), TerminalEntryPointPath: filepath.Join(root, "entry"), TerminalEntryPointSHA256: SHA256([]byte("entry")), RuntimeHome: filepath.Join(root, "home"), Timeout: time.Second, skipGitVerificationForTest: true}
	if err := os.WriteFile(filepath.Join(root, "live"), []byte("substituted"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := executor.Invoke(context.Background(), Invocation{Action: "worker.deploy", DeploymentCredential: []byte("synthetic")}); err == nil || !strings.Contains(err.Error(), "E_TOOLCHAIN_CHANGED") {
		t.Fatalf("substituted execution input accepted: %v", err)
	}
}

func TestCommandExecutorUsesClosedArgvEnvAndStdin(t *testing.T) {
	root := t.TempDir()
	worker := filepath.Join(root, "worker")
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
	npm := filepath.Join(root, "npm")
	script := `#!/bin/sh
set -eu
[ "${UNSAFE_AMBIENT-unset}" = unset ]
[ "$CLOUDFLARE_API_TOKEN" = deployment-canary ]
[ "$1" = exec ] && [ "$2" = --prefix ] && [ "$4" = -- ] && [ "$5" = wrangler ]
[ "$6" = secret ] && [ "$7" = put ] && [ "$8" = CRABBOX_ADMIN_TOKEN ]
IFS= read -r secret
[ "$secret" = worker-canary ]
`
	if err := os.WriteFile(npm, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UNSAFE_AMBIENT", "must-not-be-inherited")
	executor := CommandExecutor{NPMPath: npm, NPMPathSHA256: SHA256([]byte(script)), WorkerRoot: root, WorkerLockSHA256: SHA256(lock), ProfilePath: filepath.Join(root, "live.jsonc"), ProfileSHA256: SHA256(profile), TerminalProfilePath: filepath.Join(root, "terminal.jsonc"), TerminalProfileSHA256: SHA256(terminal), RuntimeHome: filepath.Join(root, "home"), Timeout: 3 * time.Second, skipGitVerificationForTest: true}
	err := executor.Invoke(context.Background(), Invocation{Action: "worker.secret.put", RequestID: "put", SecretName: "CRABBOX_ADMIN_TOKEN", Secret: []byte("worker-canary\n"), DeploymentCredential: []byte("deployment-canary")})
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
	if err := executor.invokeCloudflare(context.Background(), Invocation{Action: "worker.version.delete", VersionID: "version-123", DeploymentCredential: []byte("credential-canary")}); err != nil {
		t.Fatal(err)
	}
	if observed.Method != http.MethodDelete || observed.URL.Host != "api.cloudflare.com" || observed.URL.Path != "/client/v4/accounts/account-1/workers/workers/"+WorkerName+"/versions/version-123" || observed.URL.RawQuery != "" {
		t.Fatalf("unexpected request: %s %s", observed.Method, observed.URL.String())
	}
	if observed.Header.Get("Authorization") != "Bearer credential-canary" {
		t.Fatal("credential missing from protected request channel")
	}
	if err := executor.invokeCloudflare(context.Background(), Invocation{Action: "worker.version.delete", VersionID: "latest", DeploymentCredential: []byte("x")}); err == nil {
		t.Fatal("moving latest version accepted")
	}
}

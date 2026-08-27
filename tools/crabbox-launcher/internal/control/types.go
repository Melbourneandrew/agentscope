package control

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	SchemaVersion                 = 1
	WorkerName                    = "agentscope-crabbox-development"
	OwnerRole                     = "owner-plan"
	BillingRole                   = "billing-observation"
	SlotEvidenceRole              = "operator-slot-evidence"
	RecoveryRole                  = "recovery-retirement"
	JournalRole                   = "journal-evidence"
	AuthorizationDomain           = "agentscope-crabbox-owner-authorization-v1"
	RetirementAuthorizationDomain = "agentscope-crabbox-retirement-authorization-v1"
	ObservationDomain             = "agentscope-crabbox-billing-observation-v1"
	FreezeDomain                  = "agentscope-crabbox-acquisition-freeze-v1"
	RecoveryDomain                = "agentscope-crabbox-recovery-decision-v1"
	RetirementDomain              = "agentscope-crabbox-retirement-cloud-absence-v1"
	RetirementFinalizationDomain  = "agentscope-crabbox-retirement-finalization-v1"
	RetirementCompletionDomain    = "agentscope-crabbox-retirement-completion-v1"
	RetirementEvidenceDomain      = "agentscope-crabbox-retirement-evidence-v1"
	CanonicalAdmissionSHA256      = "947f1c128ca030d89c3e6100ce96a159fc4b045afb36b1cf1ef02276e16e2357"
	CanonicalPermissionSHA256     = "b8d01f9fe098abc9a67eeba6ee5f8bd18e0b273bbf5bb7766a72e9acc9d2922f"
	CanonicalTerminalEntrySHA256  = "449b7b4f5ee8c639fff349db2c70bfd2ad2fa749e07e53c026f0d22b46f9813e"
	CanonicalCoordinatorCommit    = "8ba71f913bbe57285ae29af45ef0d8ec6712477d"
	CanonicalNodeVersion          = "24.19.0"
	CanonicalNodeArchiveSHA256    = "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
	CanonicalWranglerVersion      = "4.114.0"
	CanonicalWorkerLockSHA256     = "6bf8940bd1b514ab3541485605e24b516242359e3050cfa5645966e398b030fd"
	CanonicalGoVersion            = "1.26.5"
	CanonicalGoArchiveSHA256      = "efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a"
	CanonicalCrabboxClientSHA256  = "52b2da6ffb141c19d35fe777e4b6e7d827ed5c05b3a2101e43f83ad848a9655c"
)

var (
	digestPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,200}$`)
	environmentPattern = regexp.MustCompile(`^asgcf_[a-f0-9]{32}$`)
)

// BuildSourceCommit and BuildSourceTree are injected by the attended installer
// while compiling from the immutable git archive it has just authenticated.
var BuildSourceCommit = "development"
var BuildSourceTree = "development"

type Root struct {
	Algorithm  string `json:"algorithm"`
	Generation int    `json:"generation"`
	KeyID      string `json:"keyId"`
	PublicKey  string `json:"publicKey"`
	Role       string `json:"role"`
	State      string `json:"state"`
}

type Installation struct {
	SchemaVersion            int               `json:"schemaVersion"`
	CanonicalPolicy          bool              `json:"canonicalPolicy"`
	ExecutorUID              int               `json:"executorUid"`
	InstallationID           string            `json:"installationId"`
	EnvironmentID            string            `json:"environmentId"`
	AccountID                string            `json:"accountId"`
	WorkerName               string            `json:"workerName"`
	HetznerProjectID         string            `json:"hetznerProjectId"`
	CoordinatorCommit        string            `json:"coordinatorCommit"`
	AdmissionSHA256          string            `json:"admissionSha256"`
	PermissionManifestSHA256 string            `json:"permissionManifestSha256"`
	LiveProfileSHA256        string            `json:"liveProfileSha256"`
	TerminalProfileSHA256    string            `json:"terminalProfileSha256"`
	TerminalEntryPointSHA256 string            `json:"terminalEntryPointSha256"`
	LauncherSHA256           string            `json:"launcherSha256"`
	LauncherSourceCommit     string            `json:"launcherSourceCommit"`
	LauncherSourceTree       string            `json:"launcherSourceTree"`
	RuntimeClosureSHA256     string            `json:"runtimeClosureSha256"`
	RuntimeTreeSHA256        string            `json:"runtimeTreeSha256"`
	NodeSHA256               string            `json:"nodeSha256"`
	NPMCLISHA256             string            `json:"npmCliSha256"`
	WranglerCLISHA256        string            `json:"wranglerCliSha256"`
	ToolchainIdentity        ToolchainIdentity `json:"toolchainIdentity"`
	Roots                    map[string]Root   `json:"roots"`
}

type ToolchainIdentity struct {
	NodeVersion         string `json:"nodeVersion"`
	NodeArchiveSHA256   string `json:"nodeArchiveSha256"`
	WranglerVersion     string `json:"wranglerVersion"`
	WorkerLockSHA256    string `json:"workerLockSha256"`
	GoVersion           string `json:"goVersion"`
	GoArchiveSHA256     string `json:"goArchiveSha256"`
	CrabboxClientSHA256 string `json:"crabboxClientSha256"`
}

type Operation struct {
	Action                    string  `json:"action"`
	Target                    string  `json:"target"`
	RequestID                 string  `json:"requestId"`
	ProfileSHA256             *string `json:"profileSha256,omitempty"`
	ExpectedPreviousVersionID *string `json:"expectedPreviousVersionId,omitempty"`
	SecretName                *string `json:"secretName,omitempty"`
	SlotID                    *string `json:"slotId,omitempty"`
	SlotVersion               *string `json:"slotVersion,omitempty"`
	VersionID                 *string `json:"versionId,omitempty"`
	CompatibleMigrationTag    *string `json:"compatibleMigrationTag,omitempty"`
	EntryPointSHA256          *string `json:"entryPointSha256,omitempty"`
	ProviderZeroSHA256        *string `json:"providerZeroSha256,omitempty"`
	RetirementTombstoneSHA256 *string `json:"retirementTombstoneSha256,omitempty"`
	Subdomain                 *string `json:"subdomain,omitempty"`
}

type Plan struct {
	SchemaVersion                  int               `json:"schemaVersion"`
	Kind                           string            `json:"kind"`
	AccountID                      string            `json:"accountId"`
	EnvironmentID                  string            `json:"environmentId"`
	WorkerName                     string            `json:"workerName"`
	SourceCommit                   string            `json:"sourceCommit"`
	ToolchainIdentity              ToolchainIdentity `json:"toolchainIdentity"`
	AdmissionSHA256                string            `json:"admissionSha256"`
	PermissionManifestSHA256       string            `json:"permissionManifestSha256"`
	ProfileSHA256                  string            `json:"profileSha256"`
	ObservablePrestateSHA256       string            `json:"observablePrestateSha256"`
	ObservationID                  string            `json:"observationId"`
	CurrentWorkerVersionID         string            `json:"currentWorkerVersionId"`
	DurableObjectNamespaceID       string            `json:"durableObjectNamespaceId"`
	CurrentMigrationTag            string            `json:"currentMigrationTag"`
	CompatibleVersionDetailSHA256  string            `json:"compatibleVersionDetailSha256"`
	HetznerProjectID               string            `json:"hetznerProjectId"`
	ProviderZeroSHA256             *string           `json:"providerZeroSha256"`
	RetirementTombstoneSHA256      *string           `json:"retirementTombstoneSha256"`
	AcquisitionFreezeID            *string           `json:"acquisitionFreezeId"`
	LauncherCredentialRevocationID *string           `json:"launcherCredentialRevocationId"`
	Operations                     []Operation       `json:"operations"`
	RollbackActions                []Operation       `json:"rollbackActions"`
	IssuedAt                       time.Time         `json:"issuedAt"`
	ExpiresAt                      time.Time         `json:"expiresAt"`
	Nonce                          string            `json:"nonce"`
	IntendedTerminalStateSHA256    string            `json:"intendedTerminalStateSha256"`
}

type Quota struct {
	Limit          float64 `json:"limit"`
	Used           float64 `json:"used"`
	SourceIdentity string  `json:"sourceIdentity"`
}

type Observation struct {
	SchemaVersion               int              `json:"schemaVersion"`
	AccountID                   string           `json:"accountId"`
	CredentialRole              string           `json:"credentialRole"`
	WorkersPlan                 string           `json:"workersPlan"`
	PaidOrOverageEnabled        bool             `json:"paidOrOverageEnabled"`
	AllAccountConsumersIncluded bool             `json:"allAccountConsumersIncluded"`
	Quotas                      map[string]Quota `json:"quotas"`
	ObservedAt                  time.Time        `json:"observedAt"`
	ExpiresAt                   time.Time        `json:"expiresAt"`
	ObservationID               string           `json:"observationId"`
}

type Authorization struct {
	SchemaVersion       int       `json:"schemaVersion"`
	Domain              string    `json:"domain"`
	InstallationID      string    `json:"installationId"`
	EnvironmentID       string    `json:"environmentId"`
	PlanSHA256          string    `json:"planSha256"`
	CredentialSetSHA256 string    `json:"credentialSetSha256"`
	Nonce               string    `json:"nonce"`
	IssuedAt            time.Time `json:"issuedAt"`
	ExpiresAt           time.Time `json:"expiresAt"`
	KeyID               string    `json:"keyId"`
	Signature           string    `json:"signature"`
}

type ObservationAttestation struct {
	SchemaVersion     int       `json:"schemaVersion"`
	Domain            string    `json:"domain"`
	InstallationID    string    `json:"installationId"`
	EnvironmentID     string    `json:"environmentId"`
	ObservationID     string    `json:"observationId"`
	ObservationSHA256 string    `json:"observationSha256"`
	IssuedAt          time.Time `json:"issuedAt"`
	ExpiresAt         time.Time `json:"expiresAt"`
	KeyID             string    `json:"keyId"`
	Signature         string    `json:"signature"`
}

type SignedControlRecord struct {
	SchemaVersion  int       `json:"schemaVersion"`
	Domain         string    `json:"domain"`
	InstallationID string    `json:"installationId"`
	EnvironmentID  string    `json:"environmentId"`
	PlanSHA256     string    `json:"planSha256"`
	RequestID      string    `json:"requestId"`
	Disposition    string    `json:"disposition"`
	EvidenceSHA256 string    `json:"evidenceSha256"`
	RecordedAt     time.Time `json:"recordedAt"`
	KeyID          string    `json:"keyId"`
	Signature      string    `json:"signature"`
}

// RetirementEvidence is a human/recovery-authorized statement over the exact
// independently observed retirement prerequisites. A digest-shaped plan field
// is never sufficient on its own.
type RetirementEvidence struct {
	SchemaVersion                  int       `json:"schemaVersion"`
	Domain                         string    `json:"domain"`
	InstallationID                 string    `json:"installationId"`
	EnvironmentID                  string    `json:"environmentId"`
	AccountID                      string    `json:"accountId"`
	HetznerProjectID               string    `json:"hetznerProjectId"`
	WorkerName                     string    `json:"workerName"`
	WorkerVersionID                string    `json:"workerVersionId"`
	DurableObjectNamespaceID       string    `json:"durableObjectNamespaceId"`
	MigrationTag                   string    `json:"migrationTag"`
	AcquisitionFreezeID            string    `json:"acquisitionFreezeId"`
	LauncherCredentialRevocationID string    `json:"launcherCredentialRevocationId"`
	ProviderServers                int       `json:"providerServers"`
	ProviderKeys                   int       `json:"providerKeys"`
	CoordinatorLeases              int       `json:"coordinatorLeases"`
	UnresolvedCreates              int       `json:"unresolvedCreates"`
	ProviderObservationSHA256      string    `json:"providerObservationSha256"`
	CoordinatorObservationSHA256   string    `json:"coordinatorObservationSha256"`
	RetirementTombstoneSHA256      string    `json:"retirementTombstoneSha256"`
	ObservedAt                     time.Time `json:"observedAt"`
	ExpiresAt                      time.Time `json:"expiresAt"`
	KeyID                          string    `json:"keyId"`
	Signature                      string    `json:"signature"`
}

func SHA256(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func strictJSON(data []byte, target any) error {
	if len(data) == 0 || len(data) > 1<<20 || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return errors.New("E_JSON_BOUNDS")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := rejectDuplicateValue(decoder); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF || token != nil {
		return errors.New("E_JSON_TRAILING")
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("E_JSON_SCHEMA: %w", err)
	}
	return nil
}

func ParsePlanCandidate(data []byte) (Plan, error) {
	var plan Plan
	if err := strictJSON(data, &plan); err != nil {
		return plan, err
	}
	return plan, nil
}

func ParseObservationCandidate(data []byte) (Observation, error) {
	var observation Observation
	if err := strictJSON(data, &observation); err != nil {
		return observation, err
	}
	return observation, nil
}

func ParseRetirementEvidenceCandidate(data []byte) (RetirementEvidence, error) {
	var evidence RetirementEvidence
	if err := strictJSON(data, &evidence); err != nil {
		return evidence, err
	}
	return evidence, nil
}

func ParseStateObservationCandidate(data []byte) (StateObservation, error) {
	var observation StateObservation
	if err := strictJSON(data, &observation); err != nil {
		return observation, err
	}
	if observation.SchemaVersion != SchemaVersion || !identifierPattern.MatchString(observation.AccountID) || observation.WorkerName != WorkerName || observation.ObservedAt.IsZero() || len(observation.Surfaces) == 0 {
		return observation, errors.New("E_STATE_OBSERVATION_SCHEMA")
	}
	return observation, nil
}

func ParseSlotReferences(data []byte) (map[string]SlotReference, error) {
	var references map[string]SlotReference
	if err := strictJSON(data, &references); err != nil {
		return nil, err
	}
	return references, nil
}

func ParseToolchainIdentity(data []byte) (ToolchainIdentity, error) {
	var identity ToolchainIdentity
	if err := strictJSON(data, &identity); err != nil {
		return identity, err
	}
	return identity, validateToolchainIdentity(identity)
}

func CoordinatorCommitFromAdmission(data []byte) (string, error) {
	var admission struct {
		Coordinator struct {
			Commit string `json:"commit"`
		} `json:"coordinator"`
	}
	if err := json.Unmarshal(data, &admission); err != nil {
		return "", errors.New("E_ADMISSION_SCHEMA")
	}
	if len(admission.Coordinator.Commit) != 40 || strings.Trim(admission.Coordinator.Commit, "0123456789abcdef") != "" {
		return "", errors.New("E_ADMISSION_COMMIT")
	}
	return admission.Coordinator.Commit, nil
}

func ValidateCanonicalInstallInputs(admission, permissionManifest, liveProfile, terminalProfile, terminalEntryPoint []byte, environmentID string, identity ToolchainIdentity) error {
	if SHA256(admission) != CanonicalAdmissionSHA256 || SHA256(permissionManifest) != CanonicalPermissionSHA256 || SHA256(terminalEntryPoint) != CanonicalTerminalEntrySHA256 {
		return errors.New("E_CANONICAL_POLICY_DIGEST")
	}
	commit, err := CoordinatorCommitFromAdmission(admission)
	if err != nil || commit != CanonicalCoordinatorCommit {
		return errors.New("E_CANONICAL_ADMISSION")
	}
	if err := validateToolchainIdentity(identity); err != nil {
		return err
	}
	if err := validateCanonicalProfile(liveProfile, expectedLiveProfile(environmentID)); err != nil {
		return errors.New("E_LIVE_PROFILE_CANONICAL")
	}
	if err := validateCanonicalProfile(terminalProfile, expectedTerminalProfile()); err != nil {
		return errors.New("E_TERMINAL_PROFILE_CANONICAL")
	}
	return nil
}

func validateCanonicalProfile(data []byte, expected any) error {
	var actual any
	if err := strictJSON(data, &actual); err != nil {
		return err
	}
	if !reflect.DeepEqual(actual, expected) {
		return errors.New("E_PROFILE_PROJECTION")
	}
	return nil
}

func expectedLiveProfile(environmentID string) map[string]any {
	return map[string]any{
		"$schema": "./node_modules/wrangler/config-schema.json", "name": WorkerName, "main": "src/index.ts",
		"compatibility_date": "2026-04-30", "compatibility_flags": []any{"nodejs_compat"},
		"alias":       map[string]any{"cpu-features": "./src/cpu-features.cjs", "./agent.js": "./src/ssh2-agent.cjs", "./crypto/build/Release/sshcrypto.node": "./src/ssh2-native.cjs", "./crypto/poly1305.js": "./src/ssh2-poly1305.cjs"},
		"workers_dev": true, "preview_urls": false,
		"version_metadata": map[string]any{"binding": "CF_VERSION_METADATA"},
		"triggers":         map[string]any{"crons": []any{"*/15 * * * *"}},
		"vars": map[string]any{
			"AGENTSCOPE_CRABBOX_ENVIRONMENT_ID": environmentID, "CRABBOX_DEFAULT_ORG": "agentscope-development", "CRABBOX_SHARED_OWNER": "agentscope-fleet-control",
			"CRABBOX_MAX_ACTIVE_LEASES": "4", "CRABBOX_MAX_ACTIVE_LEASES_PER_OWNER": "4", "CRABBOX_MAX_ACTIVE_LEASES_PER_ORG": "4",
			"CRABBOX_MAX_MONTHLY_USD": "25", "CRABBOX_MAX_MONTHLY_USD_PER_OWNER": "25", "CRABBOX_MAX_MONTHLY_USD_PER_ORG": "25", "CRABBOX_RUN_RETENTION_DAYS": "30",
		},
		"durable_objects": map[string]any{"bindings": []any{map[string]any{"name": "FLEET", "class_name": "FleetDurableObject"}}},
		"migrations":      []any{map[string]any{"tag": "v1", "new_sqlite_classes": []any{"FleetDurableObject"}}},
	}
}

func expectedTerminalProfile() map[string]any {
	return map[string]any{
		"$schema": "./node_modules/wrangler/config-schema.json", "name": WorkerName, "main": "terminal-worker.agentscope.mjs",
		"compatibility_date": "2026-04-30", "compatibility_flags": []any{"nodejs_compat"}, "workers_dev": false, "preview_urls": false,
		"migrations": []any{
			map[string]any{"tag": "v1", "new_sqlite_classes": []any{"FleetDurableObject"}},
			map[string]any{"tag": "v2-retire-fleet-durable-object", "deleted_classes": []any{"FleetDurableObject"}},
		},
	}
}

func validateToolchainIdentity(identity ToolchainIdentity) error {
	if identity.NodeVersion != CanonicalNodeVersion || identity.WranglerVersion != CanonicalWranglerVersion || identity.GoVersion != CanonicalGoVersion || identity.NodeArchiveSHA256 != CanonicalNodeArchiveSHA256 || identity.WorkerLockSHA256 != CanonicalWorkerLockSHA256 || identity.GoArchiveSHA256 != CanonicalGoArchiveSHA256 || identity.CrabboxClientSHA256 != CanonicalCrabboxClientSHA256 {
		return errors.New("E_TOOLCHAIN_VERSION")
	}
	for _, digest := range []string{identity.NodeArchiveSHA256, identity.WorkerLockSHA256, identity.GoArchiveSHA256, identity.CrabboxClientSHA256} {
		if !digestPattern.MatchString(digest) {
			return errors.New("E_TOOLCHAIN_DIGEST")
		}
	}
	return nil
}

func rejectDuplicateValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("E_JSON_PARSE: %w", err)
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("E_JSON_PARSE: %w", err)
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("E_JSON_OBJECT_KEY")
			}
			if _, exists := seen[key]; exists {
				return errors.New("E_JSON_DUPLICATE_KEY")
			}
			seen[key] = struct{}{}
			if err := rejectDuplicateValue(decoder); err != nil {
				return err
			}
		}
	case '[':
		for decoder.More() {
			if err := rejectDuplicateValue(decoder); err != nil {
				return err
			}
		}
	default:
		return errors.New("E_JSON_DELIMITER")
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim(map[json.Delim]rune{'{': '}', '[': ']'}[delimiter]) {
		return errors.New("E_JSON_UNCLOSED")
	}
	return nil
}

func parseRoot(root Root, expectedRole string) (ed25519.PublicKey, error) {
	if root.Role != expectedRole || root.Algorithm != "Ed25519" || root.State != "active" || root.Generation < 1 || !identifierPattern.MatchString(root.KeyID) {
		return nil, errors.New("E_ROOT_ROLE")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(root.PublicKey)
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		return nil, errors.New("E_ROOT_KEY")
	}
	return ed25519.PublicKey(decoded), nil
}

func signaturePayload(value any) ([]byte, error) {
	return json.Marshal(value)
}

func verifyDetached(root Root, role string, signatureText string, payload []byte) error {
	publicKey, err := parseRoot(root, role)
	if err != nil {
		return err
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(signatureText)
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		return errors.New("E_SIGNATURE")
	}
	return nil
}

func ValidateInstallation(installation Installation) error {
	if installation.SchemaVersion != SchemaVersion || !identifierPattern.MatchString(installation.InstallationID) || !environmentPattern.MatchString(installation.EnvironmentID) || !identifierPattern.MatchString(installation.AccountID) || installation.WorkerName != WorkerName || !identifierPattern.MatchString(installation.HetznerProjectID) || len(installation.CoordinatorCommit) != 40 || strings.Trim(installation.CoordinatorCommit, "0123456789abcdef") != "" {
		return errors.New("E_INSTALLATION_IDENTITY")
	}
	if installation.CanonicalPolicy && (installation.ExecutorUID <= 0 || len(installation.LauncherSourceCommit) != 40 || strings.Trim(installation.LauncherSourceCommit, "0123456789abcdef") != "" || len(installation.LauncherSourceTree) != 40 || strings.Trim(installation.LauncherSourceTree, "0123456789abcdef") != "") {
		return errors.New("E_EXECUTOR_IDENTITY")
	}
	for _, digest := range []string{installation.AdmissionSHA256, installation.PermissionManifestSHA256, installation.LiveProfileSHA256, installation.TerminalProfileSHA256, installation.TerminalEntryPointSHA256, installation.LauncherSHA256, installation.RuntimeClosureSHA256, installation.RuntimeTreeSHA256, installation.NodeSHA256, installation.NPMCLISHA256, installation.WranglerCLISHA256} {
		if !digestPattern.MatchString(digest) {
			return errors.New("E_INSTALLATION_DIGEST")
		}
	}
	if installation.CanonicalPolicy && validateToolchainIdentity(installation.ToolchainIdentity) != nil {
		return errors.New("E_INSTALLATION_TOOLCHAIN")
	}
	if !installation.CanonicalPolicy {
		for _, digest := range []string{installation.ToolchainIdentity.NodeArchiveSHA256, installation.ToolchainIdentity.WorkerLockSHA256, installation.ToolchainIdentity.GoArchiveSHA256, installation.ToolchainIdentity.CrabboxClientSHA256} {
			if !digestPattern.MatchString(digest) {
				return errors.New("E_INSTALLATION_TOOLCHAIN")
			}
		}
	}
	roles := []string{OwnerRole, BillingRole, SlotEvidenceRole, RecoveryRole, JournalRole}
	seenKeys := map[string]struct{}{}
	for _, role := range roles {
		root, ok := installation.Roots[role]
		if !ok {
			return errors.New("E_ROOT_MISSING")
		}
		if _, err := parseRoot(root, role); err != nil {
			return err
		}
		if _, exists := seenKeys[root.PublicKey]; exists {
			return errors.New("E_ROOT_ALIAS")
		}
		seenKeys[root.PublicKey] = struct{}{}
	}
	if len(installation.Roots) != len(roles) {
		return errors.New("E_ROOT_EXTRA")
	}
	return nil
}

func requiredQuotaNames() []string {
	return []string{"durableObjectRequestsDaily", "durableObjectStorageGb", "pagesFunctionsRequestsDaily", "workersCpuMsDaily", "workersRequestsDaily"}
}

func ValidateObservation(data []byte, attestationData []byte, installation Installation, now time.Time) (Observation, error) {
	var observation Observation
	if err := strictJSON(data, &observation); err != nil {
		return observation, err
	}
	var attestation ObservationAttestation
	if err := strictJSON(attestationData, &attestation); err != nil {
		return observation, err
	}
	if attestation.Signature == "" {
		return observation, errors.New("E_OBSERVATION_SIGNATURE")
	}
	signature := attestation.Signature
	attestation.Signature = ""
	payload, _ := signaturePayload(attestation)
	if err := verifyDetached(installation.Roots[BillingRole], BillingRole, signature, payload); err != nil {
		return observation, err
	}
	if attestation.SchemaVersion != SchemaVersion || attestation.Domain != ObservationDomain || attestation.InstallationID != installation.InstallationID || attestation.EnvironmentID != installation.EnvironmentID || attestation.ObservationID != observation.ObservationID || attestation.ObservationSHA256 != SHA256(data) || attestation.KeyID != installation.Roots[BillingRole].KeyID {
		return observation, errors.New("E_OBSERVATION_BINDING")
	}
	if err := ValidateObservationCandidate(observation, installation, now); err != nil {
		return observation, err
	}
	return observation, nil
}

func ValidateObservationCandidate(observation Observation, installation Installation, now time.Time) error {
	if observation.SchemaVersion != SchemaVersion || observation.AccountID != installation.AccountID || observation.CredentialRole != "billing-product-read-only" || observation.WorkersPlan != "free-no-overage" || observation.PaidOrOverageEnabled || !observation.AllAccountConsumersIncluded || !identifierPattern.MatchString(observation.ObservationID) {
		return errors.New("E_OBSERVATION_PLAN")
	}
	if observation.ExpiresAt.Before(now) || observation.ObservedAt.After(now) || observation.ExpiresAt.Sub(observation.ObservedAt) > 15*time.Minute || now.Sub(observation.ObservedAt) > 15*time.Minute {
		return errors.New("E_OBSERVATION_STALE")
	}
	names := make([]string, 0, len(observation.Quotas))
	for name, quota := range observation.Quotas {
		names = append(names, name)
		if quota.Limit <= 0 || quota.Used < 0 || quota.Used > quota.Limit || quota.Used*100 >= quota.Limit*80 || !identifierPattern.MatchString(quota.SourceIdentity) {
			return errors.New("E_OBSERVATION_QUOTA")
		}
	}
	sort.Strings(names)
	if fmt.Sprint(names) != fmt.Sprint(requiredQuotaNames()) {
		return errors.New("E_OBSERVATION_QUOTA_SET")
	}
	return nil
}

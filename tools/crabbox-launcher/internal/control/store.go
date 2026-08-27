package control

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type Store struct {
	Root string
}

var journalEventNamePattern = regexp.MustCompile(`^[0-9]{6}-[A-Za-z0-9-]+\.json$`)

type Event struct {
	SchemaVersion  int       `json:"schemaVersion"`
	Sequence       int       `json:"sequence"`
	PlanSHA256     string    `json:"planSha256"`
	RequestID      string    `json:"requestId"`
	State          string    `json:"state"`
	PreviousSHA256 string    `json:"previousSha256"`
	RecordedAt     time.Time `json:"recordedAt"`
	DetailCode     string    `json:"detailCode"`
	StateSHA256    string    `json:"stateSha256,omitempty"`
	IdentitySHA256 string    `json:"identitySha256,omitempty"`
	ReceiptSHA256  string    `json:"receiptSha256,omitempty"`
	KeyID          string    `json:"keyId"`
	Signature      string    `json:"signature"`
}

type SlotMetadata struct {
	SchemaVersion     int       `json:"schemaVersion"`
	EnvironmentID     string    `json:"environmentId"`
	Role              string    `json:"role"`
	SecretName        *string   `json:"secretName"`
	SlotID            string    `json:"slotId"`
	SlotVersion       string    `json:"slotVersion"`
	SupersedesSlotID  string    `json:"supersedesSlotId,omitempty"`
	SupersedesVersion string    `json:"supersedesVersion,omitempty"`
	CiphertextSHA256  string    `json:"ciphertextSha256"`
	CreatedAt         time.Time `json:"createdAt"`
	KeyID             string    `json:"keyId"`
	Signature         string    `json:"signature"`
}

func NewStore(root string) Store { return Store{Root: root} }

func (store Store) path(parts ...string) string {
	return filepath.Join(append([]string{store.Root}, parts...)...)
}

func validateOwnedPath(path string, wantDir bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || (info.Mode()&os.ModeType != 0 && !(wantDir && info.IsDir())) || info.Mode().Perm()&os.FileMode(0o077) != 0 {
		return errors.New("E_STATE_PATH")
	}
	if err := validatePlatformFile(info, wantDir); err != nil {
		return err
	}
	if wantDir && !info.IsDir() {
		return errors.New("E_STATE_DIRECTORY")
	}
	if !wantDir && (!info.Mode().IsRegular() || info.Sys() == nil) {
		return errors.New("E_STATE_FILE")
	}
	return nil
}

func validateProtectedReadablePath(path string, wantDir bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 || (wantDir && !info.IsDir()) || (!wantDir && !info.Mode().IsRegular()) {
		return errors.New("E_PROTECTED_PATH")
	}
	return validatePlatformFile(info, wantDir)
}

func writeExclusive(path string, value []byte, mode os.FileMode) error {
	parent := filepath.Dir(path)
	if err := validateOwnedPath(parent, true); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(path)
		}
	}()
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if _, err := file.Write(value); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	directory, err := os.Open(parent)
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return err
	}
	committed = true
	return nil
}

func writeAtomicExclusive(path string, value []byte, mode os.FileMode) error {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	staging := path + ".staging-" + fmt.Sprintf("%x", random)
	if err := writeExclusive(staging, value, mode); err != nil {
		return err
	}
	defer os.Remove(staging)
	// link(2) publishes a fully durable file and, unlike rename(2), cannot
	// replace a destination won by a concurrent writer.
	if err := os.Link(staging, path); err != nil {
		return err
	}
	if err := os.Remove(staging); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func readPrivate(path string) ([]byte, error) {
	if err := reconcileAtomicExclusiveStaging(path); err != nil {
		return nil, err
	}
	if err := validateOwnedPath(path, false); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

func reconcileAtomicExclusiveStaging(path string) error {
	parent, base := filepath.Dir(path), filepath.Base(path)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return err
	}
	prefix := base + ".staging-"
	changed := false
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		staging := filepath.Join(parent, entry.Name())
		info, infoErr := os.Lstat(staging)
		if infoErr != nil {
			if os.IsNotExist(infoErr) {
				continue
			}
			return infoErr
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("E_STATE_PATH")
		}
		if err := os.Remove(staging); err != nil && !os.IsNotExist(err) {
			return err
		}
		changed = true
	}
	if changed {
		return syncDirectory(parent)
	}
	return nil
}

func readProtected(path string) ([]byte, error) {
	if err := validateProtectedReadablePath(path, false); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

func (store Store) LoadInstallation() (Installation, error) {
	var installation Installation
	data, err := readPrivate(store.path("policy", "installation.json"))
	if err != nil {
		return installation, err
	}
	if err := strictJSON(data, &installation); err != nil {
		return installation, err
	}
	if err := ValidateInstallation(installation); err != nil {
		return installation, err
	}
	for name, digest := range map[string]string{"admission.json": installation.AdmissionSHA256, "permission-manifest.json": installation.PermissionManifestSHA256, "wrangler.live.jsonc": installation.LiveProfileSHA256, "wrangler.terminal.jsonc": installation.TerminalProfileSHA256, "terminal-worker.agentscope.mjs": installation.TerminalEntryPointSHA256} {
		value, err := readProtected(store.path("policy", name))
		if err != nil || SHA256(value) != digest {
			return installation, errors.New("E_POLICY_CHANGED")
		}
	}
	return installation, nil
}

func generateRoot(role string) (Root, ed25519.PrivateKey, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Root{}, nil, err
	}
	digest := SHA256(publicKey)
	return Root{Algorithm: "Ed25519", Generation: 1, KeyID: role + ":" + digest[:16], PublicKey: base64.StdEncoding.EncodeToString(publicKey), Role: role, State: "active"}, privateKey, nil
}

type InstallInput struct {
	Root                                 string
	InstallationID                       string
	EnvironmentID                        string
	AccountID                            string
	HetznerProjectID                     string
	CoordinatorCommit                    string
	AdmissionSHA256                      string
	PermissionManifestSHA256             string
	LiveProfileSHA256                    string
	TerminalProfileSHA256                string
	Launcher                             []byte
	LauncherSourceCommit                 string
	LauncherSourceTree                   string
	Admission                            []byte
	PermissionManifest                   []byte
	LiveProfile                          []byte
	TerminalProfile                      []byte
	TerminalEntryPoint                   []byte
	RuntimeClosure                       []byte
	RuntimeClosureSHA256                 string
	ToolchainIdentity                    ToolchainIdentity
	OperatorPassphrase                   []byte
	ExecutorUID                          int
	skipCanonicalPolicyValidationForTest bool
}

func Install(input InstallInput) (Installation, error) {
	if _, err := os.Lstat(input.Root); err == nil {
		return Installation{}, errors.New("E_INSTALL_EXISTS")
	} else if !os.IsNotExist(err) {
		return Installation{}, err
	}
	if len(input.Launcher) == 0 || len(input.Launcher) > 64<<20 {
		return Installation{}, errors.New("E_LAUNCHER_ARTIFACT")
	}
	if !input.skipCanonicalPolicyValidationForTest && (BuildSourceCommit != input.LauncherSourceCommit || BuildSourceTree != input.LauncherSourceTree) {
		return Installation{}, errors.New("E_LAUNCHER_SOURCE_BINDING")
	}
	if input.AdmissionSHA256 != SHA256(input.Admission) || input.PermissionManifestSHA256 != SHA256(input.PermissionManifest) || input.LiveProfileSHA256 != SHA256(input.LiveProfile) || input.TerminalProfileSHA256 != SHA256(input.TerminalProfile) || input.RuntimeClosureSHA256 != SHA256(input.RuntimeClosure) {
		return Installation{}, errors.New("E_INSTALL_INPUT_BINDING")
	}
	if !input.skipCanonicalPolicyValidationForTest {
		if err := ValidateCanonicalInstallInputs(input.Admission, input.PermissionManifest, input.LiveProfile, input.TerminalProfile, input.TerminalEntryPoint, input.EnvironmentID, input.ToolchainIdentity); err != nil {
			return Installation{}, err
		}
	}
	commit, err := CoordinatorCommitFromAdmission(input.Admission)
	if err != nil || commit != input.CoordinatorCommit {
		return Installation{}, errors.New("E_INSTALL_COMMIT")
	}
	stagingRandom := make([]byte, 16)
	if _, err := rand.Read(stagingRandom); err != nil {
		return Installation{}, err
	}
	stagingRoot := input.Root + ".install-" + fmt.Sprintf("%x", stagingRandom)
	defer os.RemoveAll(stagingRoot)
	oldUmask := setPrivateUmask()
	defer restoreUmask(oldUmask)
	for _, directory := range []string{stagingRoot, filepath.Join(stagingRoot, "bin"), filepath.Join(stagingRoot, "policy"), filepath.Join(stagingRoot, "keys"), filepath.Join(stagingRoot, "slots"), filepath.Join(stagingRoot, "journal"), filepath.Join(stagingRoot, "evidence"), filepath.Join(stagingRoot, "runtime"), filepath.Join(stagingRoot, "toolchain")} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			return Installation{}, err
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			return Installation{}, err
		}
	}
	roots := map[string]Root{}
	for _, role := range []string{OwnerRole, BillingRole, SlotEvidenceRole, RecoveryRole, JournalRole} {
		root, privateKey, err := generateRoot(role)
		if err != nil {
			return Installation{}, err
		}
		roots[role] = root
		keyData := []byte(base64.StdEncoding.EncodeToString(privateKey) + "\n")
		if role == OwnerRole || role == RecoveryRole || role == BillingRole {
			keyData, err = sealKey(privateKey, input.OperatorPassphrase)
			if err == nil {
				keyData = append(keyData, '\n')
			}
		}
		if err != nil {
			return Installation{}, err
		}
		if err := writeExclusive(filepath.Join(stagingRoot, "keys", role+".key"), keyData, 0o600); err != nil {
			return Installation{}, err
		}
		zeroBytes(privateKey)
	}
	credentialKey := make([]byte, 32)
	if _, err := rand.Read(credentialKey); err != nil {
		return Installation{}, err
	}
	if err := writeExclusive(filepath.Join(stagingRoot, "keys", "credential-store.key"), []byte(base64.StdEncoding.EncodeToString(credentialKey)+"\n"), 0o600); err != nil {
		zeroBytes(credentialKey)
		return Installation{}, err
	}
	zeroBytes(credentialKey)
	runtimeIdentity, err := extractRuntimeClosure(input.RuntimeClosure, filepath.Join(stagingRoot, "toolchain"), input.ToolchainIdentity.WorkerLockSHA256)
	if err != nil {
		return Installation{}, err
	}
	if !input.skipCanonicalPolicyValidationForTest {
		if input.ExecutorUID <= 0 || os.Chown(filepath.Join(stagingRoot, "runtime"), input.ExecutorUID, -1) != nil || os.Chmod(filepath.Join(stagingRoot, "runtime"), 0o700) != nil || os.Chmod(stagingRoot, 0o711) != nil || os.Chmod(filepath.Join(stagingRoot, "toolchain"), 0o555) != nil {
			return Installation{}, errors.New("E_EXECUTOR_IDENTITY")
		}
	}
	installation := Installation{SchemaVersion: SchemaVersion, CanonicalPolicy: !input.skipCanonicalPolicyValidationForTest, InstallationID: input.InstallationID, EnvironmentID: input.EnvironmentID, AccountID: input.AccountID, WorkerName: WorkerName, HetznerProjectID: input.HetznerProjectID, CoordinatorCommit: input.CoordinatorCommit, AdmissionSHA256: input.AdmissionSHA256, PermissionManifestSHA256: input.PermissionManifestSHA256, LiveProfileSHA256: input.LiveProfileSHA256, TerminalProfileSHA256: input.TerminalProfileSHA256, TerminalEntryPointSHA256: SHA256(input.TerminalEntryPoint), LauncherSHA256: SHA256(input.Launcher), LauncherSourceCommit: input.LauncherSourceCommit, LauncherSourceTree: input.LauncherSourceTree, RuntimeClosureSHA256: input.RuntimeClosureSHA256, RuntimeTreeSHA256: runtimeIdentity.TreeSHA256, NodeSHA256: runtimeIdentity.NodeSHA256, NPMCLISHA256: runtimeIdentity.NPMCLISHA256, WranglerCLISHA256: runtimeIdentity.WranglerCLISHA256, ToolchainIdentity: input.ToolchainIdentity, Roots: roots}
	installation.ExecutorUID = input.ExecutorUID
	if err := ValidateInstallation(installation); err != nil {
		return Installation{}, err
	}
	data, _ := json.MarshalIndent(installation, "", "  ")
	if err := writeExclusive(filepath.Join(stagingRoot, "bin", "agentscope-crabbox-control"), input.Launcher, 0o500); err != nil {
		return Installation{}, err
	}
	if err := writeExclusive(filepath.Join(stagingRoot, "policy", "installation.json"), append(data, '\n'), 0o600); err != nil {
		return Installation{}, err
	}
	for name, value := range map[string][]byte{"admission.json": input.Admission, "permission-manifest.json": input.PermissionManifest, "wrangler.live.jsonc": input.LiveProfile, "wrangler.terminal.jsonc": input.TerminalProfile, "terminal-worker.agentscope.mjs": input.TerminalEntryPoint} {
		if len(value) == 0 || len(value) > 1<<20 {
			return Installation{}, errors.New("E_POLICY_ARTIFACT")
		}
		if err := writeExclusive(filepath.Join(stagingRoot, "policy", name), value, 0o600); err != nil {
			return Installation{}, err
		}
		if !input.skipCanonicalPolicyValidationForTest {
			if err := os.Chmod(filepath.Join(stagingRoot, "policy", name), 0o444); err != nil {
				return Installation{}, errors.New("E_POLICY_MODE")
			}
		}
	}
	if !input.skipCanonicalPolicyValidationForTest {
		if err := os.Chmod(filepath.Join(stagingRoot, "policy"), 0o555); err != nil {
			return Installation{}, errors.New("E_POLICY_MODE")
		}
	}
	if err := os.Rename(stagingRoot, input.Root); err != nil {
		return Installation{}, err
	}
	parent, err := os.Open(filepath.Dir(input.Root))
	if err != nil {
		return Installation{}, err
	}
	defer parent.Close()
	if err := parent.Sync(); err != nil {
		return Installation{}, err
	}
	return installation, nil
}

func (store Store) privateKey(role string, passphrase []byte) (ed25519.PrivateKey, error) {
	data, err := readPrivate(store.path("keys", role+".key"))
	if err != nil {
		return nil, err
	}
	var decoded []byte
	if role == OwnerRole || role == RecoveryRole || role == BillingRole {
		decoded, err = unsealKey(data, passphrase)
	} else {
		decoded, err = base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(string(data)))
	}
	if err != nil {
		return nil, err
	}
	if len(decoded) != ed25519.PrivateKeySize {
		return nil, errors.New("E_PRIVATE_KEY")
	}
	return ed25519.PrivateKey(decoded), nil
}

func (store Store) SignAuthorization(planData []byte, plan Plan, now time.Time, passphrase []byte) (Authorization, error) {
	installation, err := store.LoadInstallation()
	if err != nil {
		return Authorization{}, err
	}
	if err := ValidatePlanCandidate(plan, installation, now); err != nil {
		return Authorization{}, err
	}
	role := OwnerRole
	domain := AuthorizationDomain
	if plan.Kind == "retire" {
		role = RecoveryRole
		domain = RetirementAuthorizationDomain
	}
	credentialSetSHA256, err := store.CredentialSetSHA256()
	if err != nil {
		return Authorization{}, err
	}
	authorization := Authorization{SchemaVersion: SchemaVersion, Domain: domain, InstallationID: installation.InstallationID, EnvironmentID: installation.EnvironmentID, PlanSHA256: SHA256(planData), CredentialSetSHA256: credentialSetSHA256, Nonce: plan.Nonce, IssuedAt: now, ExpiresAt: plan.ExpiresAt, KeyID: installation.Roots[role].KeyID}
	payload, _ := signaturePayload(authorization)
	privateKey, err := store.privateKey(role, passphrase)
	if err != nil {
		return Authorization{}, err
	}
	defer zeroBytes(privateKey)
	authorization.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return authorization, nil
}

func (store Store) SignObservation(data []byte, observation Observation, now time.Time, passphrase []byte) (ObservationAttestation, error) {
	installation, err := store.LoadInstallation()
	if err != nil {
		return ObservationAttestation{}, err
	}
	if err := ValidateObservationCandidate(observation, installation, now); err != nil {
		return ObservationAttestation{}, err
	}
	attestation := ObservationAttestation{SchemaVersion: SchemaVersion, Domain: ObservationDomain, InstallationID: installation.InstallationID, EnvironmentID: installation.EnvironmentID, ObservationID: observation.ObservationID, ObservationSHA256: SHA256(data), IssuedAt: now, ExpiresAt: observation.ExpiresAt, KeyID: installation.Roots[BillingRole].KeyID}
	payload, _ := signaturePayload(attestation)
	privateKey, err := store.privateKey(BillingRole, passphrase)
	if err != nil {
		return ObservationAttestation{}, err
	}
	defer zeroBytes(privateKey)
	attestation.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return attestation, nil
}

func (store Store) SignRetirementEvidence(evidence RetirementEvidence, now time.Time, passphrase []byte) (RetirementEvidence, error) {
	installation, err := store.LoadInstallation()
	if err != nil {
		return evidence, err
	}
	if evidence.Signature != "" || evidence.SchemaVersion != SchemaVersion || evidence.Domain != RetirementEvidenceDomain || evidence.InstallationID != installation.InstallationID || evidence.EnvironmentID != installation.EnvironmentID || evidence.AccountID != installation.AccountID || evidence.HetznerProjectID != installation.HetznerProjectID || evidence.WorkerName != WorkerName || evidence.ProviderServers != 0 || evidence.ProviderKeys != 0 || evidence.CoordinatorLeases != 0 || evidence.UnresolvedCreates != 0 || !digestPattern.MatchString(evidence.ProviderObservationSHA256) || !digestPattern.MatchString(evidence.CoordinatorObservationSHA256) || !digestPattern.MatchString(evidence.RetirementTombstoneSHA256) || evidence.ObservedAt.After(now) || evidence.ExpiresAt.Before(now) || evidence.ExpiresAt.Sub(evidence.ObservedAt) > 15*time.Minute {
		return evidence, errors.New("E_RETIREMENT_EVIDENCE_STATE")
	}
	evidence.KeyID = installation.Roots[RecoveryRole].KeyID
	payload, _ := signaturePayload(evidence)
	privateKey, err := store.privateKey(RecoveryRole, passphrase)
	if err != nil {
		return evidence, err
	}
	defer zeroBytes(privateKey)
	evidence.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return evidence, nil
}

func (store Store) signControlRecord(record SignedControlRecord, role string, passphrase []byte) (SignedControlRecord, error) {
	installation, err := store.LoadInstallation()
	if err != nil {
		return record, err
	}
	record.SchemaVersion, record.InstallationID, record.EnvironmentID = SchemaVersion, installation.InstallationID, installation.EnvironmentID
	record.KeyID = installation.Roots[role].KeyID
	payload, _ := signaturePayload(record)
	privateKey, err := store.privateKey(role, passphrase)
	if err != nil {
		return record, err
	}
	defer zeroBytes(privateKey)
	record.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return record, nil
}

func verifyControlRecord(record SignedControlRecord, root Root, role string) error {
	signature := record.Signature
	record.Signature = ""
	payload, _ := signaturePayload(record)
	if record.SchemaVersion != SchemaVersion || record.KeyID != root.KeyID {
		return errors.New("E_CONTROL_RECORD")
	}
	return verifyDetached(root, role, signature, payload)
}

func (store Store) Freeze(reason string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	if !identifierPattern.MatchString(reason) {
		return SignedControlRecord{}, errors.New("E_FREEZE_REASON")
	}
	guard, err := store.acquireAdmissionGuard()
	if err != nil {
		return SignedControlRecord{}, err
	}
	defer releaseAdmissionGuard(guard)
	incidentID := SHA256([]byte(store.Root + "\x00" + reason + "\x00" + now.UTC().Format(time.RFC3339Nano)))
	record, err := store.signControlRecord(SignedControlRecord{Domain: FreezeDomain, PlanSHA256: incidentID, RequestID: reason, Disposition: "frozen", RecordedAt: now}, RecoveryRole, passphrase)
	if err != nil {
		return record, err
	}
	data, _ := json.MarshalIndent(record, "", "  ")
	if err := writeAtomicExclusive(store.path("journal", "acquisition.freeze"), append(data, '\n'), 0o600); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) IsFrozen() bool {
	_, err := os.Lstat(store.path("journal", "acquisition.freeze"))
	if err == nil {
		return true
	}
	// The durable global mutation fence is also acquisition-freeze authority
	// while a request is in the invoking-uncertain state. This makes the
	// fail-stop prefix itself sufficient even when no recovery passphrase is
	// available to the applying process.
	fenceData, fenceErr := readPrivate(store.path("journal", "mutation.lock"))
	if fenceErr != nil {
		return false
	}
	planSHA256 := strings.TrimSpace(string(fenceData))
	if !digestPattern.MatchString(planSHA256) {
		return true
	}
	last, lastErr := store.lastEvent(planSHA256)
	return lastErr != nil || last.State == "invoking-uncertain"
}

func (store Store) currentFreeze() (SignedControlRecord, error) {
	data, err := readPrivate(store.path("journal", "acquisition.freeze"))
	if err != nil {
		return SignedControlRecord{}, err
	}
	installation, err := store.LoadInstallation()
	if err != nil {
		return SignedControlRecord{}, err
	}
	var record SignedControlRecord
	if strictJSON(data, &record) != nil || record.Domain != FreezeDomain || record.Disposition != "frozen" || verifyControlRecord(record, installation.Roots[RecoveryRole], RecoveryRole) != nil {
		return SignedControlRecord{}, errors.New("E_FREEZE_EVIDENCE")
	}
	return record, nil
}

func (store Store) hasResolvedRecovery(freeze SignedControlRecord) bool {
	if !digestPattern.MatchString(freeze.PlanSHA256) || !identifierPattern.MatchString(freeze.RequestID) || !digestPattern.MatchString(freeze.EvidenceSHA256) {
		return false
	}
	installation, err := store.LoadInstallation()
	if err != nil {
		return false
	}
	data, err := readPrivate(store.path("journal", freeze.PlanSHA256, "recovery-resolved.json"))
	if err != nil {
		return false
	}
	var record SignedControlRecord
	return strictJSON(data, &record) == nil && record.Domain == RecoveryDomain && record.PlanSHA256 == freeze.PlanSHA256 && record.RequestID == freeze.RequestID && record.Disposition == "reconciled-abandoned" && record.EvidenceSHA256 == freeze.EvidenceSHA256 && verifyControlRecord(record, installation.Roots[RecoveryRole], RecoveryRole) == nil
}

func (store Store) Thaw(evidenceSHA256 string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	if !digestPattern.MatchString(evidenceSHA256) {
		return SignedControlRecord{}, errors.New("E_THAW_PREREQUISITE")
	}
	guard, err := store.acquireAdmissionGuard()
	if err != nil {
		return SignedControlRecord{}, err
	}
	defer releaseAdmissionGuard(guard)
	installation, err := store.LoadInstallation()
	if err != nil {
		return SignedControlRecord{}, err
	}
	thawPath := store.path("journal", "thaw-"+evidenceSHA256+".json")
	var existing SignedControlRecord
	if data, readErr := readPrivate(thawPath); readErr == nil {
		if strictJSON(data, &existing) != nil || existing.Domain != RecoveryDomain || existing.Disposition != "thawed" || existing.EvidenceSHA256 != evidenceSHA256 || !digestPattern.MatchString(existing.PlanSHA256) || !identifierPattern.MatchString(existing.RequestID) || verifyControlRecord(existing, installation.Roots[RecoveryRole], RecoveryRole) != nil {
			return SignedControlRecord{}, errors.New("E_THAW_BINDING")
		}
		if !store.IsFrozen() {
			return existing, nil
		}
	} else if !os.IsNotExist(readErr) {
		return SignedControlRecord{}, readErr
	}
	freeze, err := store.currentFreeze()
	if err != nil {
		return SignedControlRecord{}, errors.New("E_THAW_PREREQUISITE")
	}
	if freeze.EvidenceSHA256 == "" {
		resolutionPath := store.path("journal", "incident-resolved-"+freeze.PlanSHA256+".json")
		var resolution SignedControlRecord
		if data, readErr := readPrivate(resolutionPath); readErr == nil {
			if strictJSON(data, &resolution) != nil || resolution.Domain != RecoveryDomain || resolution.PlanSHA256 != freeze.PlanSHA256 || resolution.RequestID != freeze.RequestID || resolution.Disposition != "incident-resolved" || resolution.EvidenceSHA256 != evidenceSHA256 || verifyControlRecord(resolution, installation.Roots[RecoveryRole], RecoveryRole) != nil {
				return SignedControlRecord{}, errors.New("E_THAW_PREREQUISITE")
			}
		} else if !os.IsNotExist(readErr) {
			return SignedControlRecord{}, readErr
		} else {
			resolution, err = store.signControlRecord(SignedControlRecord{Domain: RecoveryDomain, PlanSHA256: freeze.PlanSHA256, RequestID: freeze.RequestID, Disposition: "incident-resolved", EvidenceSHA256: evidenceSHA256, RecordedAt: now}, RecoveryRole, passphrase)
			if err != nil {
				return SignedControlRecord{}, err
			}
			data, _ := json.MarshalIndent(resolution, "", "  ")
			if err := writeAtomicExclusive(resolutionPath, append(data, '\n'), 0o600); err != nil {
				return SignedControlRecord{}, err
			}
		}
	} else if freeze.EvidenceSHA256 != evidenceSHA256 || !store.hasResolvedRecovery(freeze) {
		return SignedControlRecord{}, errors.New("E_THAW_PREREQUISITE")
	}
	if err := store.ensureNoActiveMutation(); err != nil {
		return SignedControlRecord{}, err
	}
	record := existing
	if record.Signature == "" {
		record, err = store.signControlRecord(SignedControlRecord{Domain: RecoveryDomain, PlanSHA256: freeze.PlanSHA256, RequestID: freeze.RequestID, Disposition: "thawed", EvidenceSHA256: evidenceSHA256, RecordedAt: now}, RecoveryRole, passphrase)
		if err != nil {
			return record, err
		}
		data, _ := json.MarshalIndent(record, "", "  ")
		if err := writeAtomicExclusive(thawPath, append(data, '\n'), 0o600); err != nil {
			return record, err
		}
	} else if record.PlanSHA256 != freeze.PlanSHA256 || record.RequestID != freeze.RequestID {
		return SignedControlRecord{}, errors.New("E_THAW_PREREQUISITE")
	}
	if err := os.Remove(store.path("journal", "acquisition.freeze")); err != nil {
		return record, err
	}
	if err := syncDirectory(store.path("journal")); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) freezeForRecovery(planSHA256, requestID, evidenceSHA256 string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	record, err := store.signControlRecord(SignedControlRecord{Domain: FreezeDomain, PlanSHA256: planSHA256, RequestID: requestID, Disposition: "frozen", EvidenceSHA256: evidenceSHA256, RecordedAt: now}, RecoveryRole, passphrase)
	if err != nil {
		return record, err
	}
	data, _ := json.MarshalIndent(record, "", "  ")
	if err := writeAtomicExclusive(store.path("journal", "acquisition.freeze"), append(data, '\n'), 0o600); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) VerifyFreeze(expectedID string) error {
	data, err := readPrivate(store.path("journal", "acquisition.freeze"))
	if err != nil {
		return errors.New("E_FREEZE_REQUIRED")
	}
	var record SignedControlRecord
	if err := strictJSON(data, &record); err != nil {
		return err
	}
	installation, err := store.LoadInstallation()
	if err != nil {
		return err
	}
	signature := record.Signature
	record.Signature = ""
	payload, _ := signaturePayload(record)
	if record.Domain != FreezeDomain || record.InstallationID != installation.InstallationID || record.EnvironmentID != installation.EnvironmentID || record.RequestID != expectedID || record.Disposition != "frozen" || record.KeyID != installation.Roots[RecoveryRole].KeyID || verifyDetached(installation.Roots[RecoveryRole], RecoveryRole, signature, payload) != nil {
		return errors.New("E_FREEZE_EVIDENCE")
	}
	return nil
}

func (store Store) RecoverQuarantine(planSHA256, requestID, evidenceSHA256 string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	if !digestPattern.MatchString(planSHA256) || !identifierPattern.MatchString(requestID) || !digestPattern.MatchString(evidenceSHA256) {
		return SignedControlRecord{}, errors.New("E_RECOVERY_INPUT")
	}
	guard, err := store.acquireAdmissionGuard()
	if err != nil {
		return SignedControlRecord{}, err
	}
	defer releaseAdmissionGuard(guard)
	if err := store.VerifyJournal(planSHA256); err != nil {
		return SignedControlRecord{}, err
	}
	last, err := store.lastEvent(planSHA256)
	recoverable := map[string]bool{"consumed": true, "invoking-uncertain": true, "observed-committed": true, "credential-roles-validated": true, "reconciled-terminal": true}
	if err != nil || last.RequestID != requestID || !recoverable[last.State] {
		return SignedControlRecord{}, errors.New("E_RECOVERY_PREFIX")
	}
	record, err := store.signControlRecord(SignedControlRecord{Domain: RecoveryDomain, PlanSHA256: planSHA256, RequestID: requestID, Disposition: "quarantine", EvidenceSHA256: evidenceSHA256, RecordedAt: now}, RecoveryRole, passphrase)
	if err != nil {
		return record, err
	}
	data, _ := json.MarshalIndent(record, "", "  ")
	if err := writeAtomicExclusive(store.path("journal", planSHA256, "recovery-quarantine.json"), append(data, '\n'), 0o600); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) ResolveQuarantine(planSHA256, requestID, evidenceSHA256 string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	if !digestPattern.MatchString(planSHA256) || !identifierPattern.MatchString(requestID) || !digestPattern.MatchString(evidenceSHA256) {
		return SignedControlRecord{}, errors.New("E_RECOVERY_INPUT")
	}
	guard, err := store.acquireAdmissionGuard()
	if err != nil {
		return SignedControlRecord{}, err
	}
	defer releaseAdmissionGuard(guard)
	if err := store.VerifyJournal(planSHA256); err != nil {
		return SignedControlRecord{}, err
	}
	quarantineData, err := readPrivate(store.path("journal", planSHA256, "recovery-quarantine.json"))
	if err != nil {
		return SignedControlRecord{}, errors.New("E_RECOVERY_NOT_QUARANTINED")
	}
	var quarantine SignedControlRecord
	if err := strictJSON(quarantineData, &quarantine); err != nil {
		return SignedControlRecord{}, err
	}
	installation, err := store.LoadInstallation()
	if err != nil {
		return SignedControlRecord{}, err
	}
	signature := quarantine.Signature
	quarantine.Signature = ""
	payload, _ := signaturePayload(quarantine)
	if quarantine.Domain != RecoveryDomain || quarantine.PlanSHA256 != planSHA256 || quarantine.RequestID != requestID || !digestPattern.MatchString(quarantine.EvidenceSHA256) || quarantine.Disposition != "quarantine" || quarantine.KeyID != installation.Roots[RecoveryRole].KeyID || verifyDetached(installation.Roots[RecoveryRole], RecoveryRole, signature, payload) != nil {
		return SignedControlRecord{}, errors.New("E_RECOVERY_BINDING")
	}
	fenceData, fenceErr := readPrivate(store.path("journal", "mutation.lock"))
	fenceIdentity := strings.TrimSpace(string(fenceData))
	hasFence := fenceErr == nil && fenceIdentity == planSHA256
	malformedFence := fenceErr == nil && !digestPattern.MatchString(fenceIdentity)
	last, lastErr := store.lastEvent(planSHA256)
	definiteNoncommit := lastErr == nil && last.State == "consumed" && requestID == "plan"
	alreadyTerminal := lastErr == nil && ((last.State == "abandoned-definite-noncommit" && requestID == "plan") || (last.State == "abandoned-reconciled" && last.RequestID == requestID && last.ReceiptSHA256 == evidenceSHA256) || (last.State == "reconciled-terminal" && requestID == "plan"))
	if !hasFence && !(definiteNoncommit && malformedFence) && !definiteNoncommit && !alreadyTerminal {
		return SignedControlRecord{}, errors.New("E_MUTATION_FENCE")
	}
	if fenceErr == nil && !hasFence && !malformedFence {
		return SignedControlRecord{}, errors.New("E_MUTATION_FENCE")
	}
	if _, freezeErr := os.Lstat(store.path("journal", "acquisition.freeze")); os.IsNotExist(freezeErr) {
		if _, err := store.freezeForRecovery(planSHA256, requestID, evidenceSHA256, now, passphrase); err != nil {
			return SignedControlRecord{}, err
		}
	} else if freezeErr != nil {
		return SignedControlRecord{}, freezeErr
	}
	resolvedPath := store.path("journal", planSHA256, "recovery-resolved.json")
	var record SignedControlRecord
	if existing, readErr := readPrivate(resolvedPath); readErr == nil {
		if strictJSON(existing, &record) != nil || verifyControlRecord(record, installation.Roots[RecoveryRole], RecoveryRole) != nil || record.Domain != RecoveryDomain || record.PlanSHA256 != planSHA256 || record.RequestID != requestID || record.Disposition != "reconciled-abandoned" || record.EvidenceSHA256 != evidenceSHA256 {
			return SignedControlRecord{}, errors.New("E_RECOVERY_RESOLUTION_BINDING")
		}
	} else if !os.IsNotExist(readErr) {
		return SignedControlRecord{}, readErr
	} else {
		record, err = store.signControlRecord(SignedControlRecord{Domain: RecoveryDomain, PlanSHA256: planSHA256, RequestID: requestID, Disposition: "reconciled-abandoned", EvidenceSHA256: evidenceSHA256, RecordedAt: now}, RecoveryRole, passphrase)
		if err != nil {
			return record, err
		}
		data, _ := json.MarshalIndent(record, "", "  ")
		if err := writeAtomicExclusive(resolvedPath, append(data, '\n'), 0o600); err != nil {
			return record, err
		}
	}
	if !alreadyTerminal && definiteNoncommit {
		sequence, previous, sequenceErr := store.nextSequence(planSHA256)
		if sequenceErr != nil {
			return record, sequenceErr
		}
		if _, eventErr := store.appendEvent(Event{SchemaVersion: SchemaVersion, Sequence: sequence, PlanSHA256: planSHA256, RequestID: "plan", State: "abandoned-definite-noncommit", PreviousSHA256: previous, RecordedAt: now, DetailCode: "RECOVERED"}); eventErr != nil {
			return record, eventErr
		}
	} else if !alreadyTerminal {
		sequence, previous, sequenceErr := store.nextSequence(planSHA256)
		if sequenceErr != nil {
			return record, sequenceErr
		}
		if _, eventErr := store.appendEvent(Event{SchemaVersion: SchemaVersion, Sequence: sequence, PlanSHA256: planSHA256, RequestID: requestID, State: "abandoned-reconciled", PreviousSHA256: previous, RecordedAt: now, DetailCode: "ABANDONED", ReceiptSHA256: evidenceSHA256}); eventErr != nil {
			return record, eventErr
		}
	}
	retirementTerminal := false
	if lastErr == nil && last.State == "reconciled-terminal" {
		planData, readErr := readPrivate(store.path("journal", planSHA256, "plan.json"))
		var plan Plan
		if readErr != nil || strictJSON(planData, &plan) != nil || SHA256(planData) != planSHA256 {
			return record, errors.New("E_RECOVERY_PLAN_BINDING")
		}
		if plan.Kind == "retire" && plan.RetirementTombstoneSHA256 != nil {
			retirementTerminal = true
			if err := store.recordRetirement(planSHA256, *plan.RetirementTombstoneSHA256, now); err != nil && !os.IsExist(err) {
				return record, err
			}
		}
	}
	if !retirementTerminal && (hasFence || (definiteNoncommit && malformedFence)) {
		if err := os.Remove(store.path("journal", "mutation.lock")); err != nil {
			return record, err
		}
	}
	if err := syncDirectory(store.path("journal")); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) lastEvent(planDigest string) (Event, error) {
	var event Event
	entries, err := os.ReadDir(store.path("journal", planDigest))
	if err != nil {
		return event, err
	}
	var names []string
	for _, entry := range entries {
		if journalEventNamePattern.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return event, errors.New("E_JOURNAL_EMPTY")
	}
	data, err := readPrivate(store.path("journal", planDigest, names[len(names)-1]))
	if err != nil {
		return event, err
	}
	if err := strictJSON(data, &event); err != nil {
		return event, err
	}
	return event, nil
}

func (store Store) recordRetirement(planDigest, tombstoneDigest string, now time.Time) error {
	path := store.path("evidence", "retirement-cloud-absence.json")
	if existing, readErr := readPrivate(path); readErr == nil {
		installation, err := store.LoadInstallation()
		if err != nil {
			return err
		}
		var record SignedControlRecord
		if strictJSON(existing, &record) != nil || verifyControlRecord(record, installation.Roots[JournalRole], JournalRole) != nil || record.Domain != RetirementDomain || record.PlanSHA256 != planDigest || record.RequestID != "retirement" || record.Disposition != "cloud-resources-absent" || record.EvidenceSHA256 != tombstoneDigest {
			return errors.New("E_RETIREMENT_RECORD_BINDING")
		}
		return nil
	} else if !os.IsNotExist(readErr) {
		return readErr
	}
	record, err := store.signControlRecord(SignedControlRecord{Domain: RetirementDomain, PlanSHA256: planDigest, RequestID: "retirement", Disposition: "cloud-resources-absent", EvidenceSHA256: tombstoneDigest, RecordedAt: now}, JournalRole, nil)
	if err != nil {
		return err
	}
	data, _ := json.MarshalIndent(record, "", "  ")
	return writeAtomicExclusive(path, append(data, '\n'), 0o600)
}

func (store Store) FinalizeRetirement(planDigest, deploymentRevocationID, planReadRevocationID, hetznerWorkerRevocationID, hetznerInventoryRevocationID, hetznerRecoveryRevocationID string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	identities := []string{deploymentRevocationID, planReadRevocationID, hetznerWorkerRevocationID, hetznerInventoryRevocationID, hetznerRecoveryRevocationID}
	if !digestPattern.MatchString(planDigest) {
		return SignedControlRecord{}, errors.New("E_RETIREMENT_FINALIZATION_INPUT")
	}
	seen := map[string]struct{}{}
	for _, identity := range identities {
		if !identifierPattern.MatchString(identity) {
			return SignedControlRecord{}, errors.New("E_RETIREMENT_FINALIZATION_INPUT")
		}
		if _, exists := seen[identity]; exists {
			return SignedControlRecord{}, errors.New("E_RETIREMENT_FINALIZATION_ALIAS")
		}
		seen[identity] = struct{}{}
	}
	guard, err := store.acquireAdmissionGuard()
	if err != nil {
		return SignedControlRecord{}, err
	}
	defer releaseAdmissionGuard(guard)
	installation, err := store.LoadInstallation()
	if err != nil {
		return SignedControlRecord{}, err
	}
	retirementData, err := readPrivate(store.path("evidence", "retirement-cloud-absence.json"))
	if err != nil {
		return SignedControlRecord{}, errors.New("E_RETIREMENT_NOT_TERMINAL")
	}
	var retirement SignedControlRecord
	if strictJSON(retirementData, &retirement) != nil || retirement.Domain != RetirementDomain || retirement.PlanSHA256 != planDigest || retirement.RequestID != "retirement" || retirement.Disposition != "cloud-resources-absent" || verifyControlRecord(retirement, installation.Roots[JournalRole], JournalRole) != nil {
		return SignedControlRecord{}, errors.New("E_RETIREMENT_RECORD_BINDING")
	}
	last, err := store.lastEvent(planDigest)
	if err != nil || last.State != "reconciled-terminal" {
		return SignedControlRecord{}, errors.New("E_RETIREMENT_NOT_TERMINAL")
	}
	fenceData, err := readPrivate(store.path("journal", "mutation.lock"))
	if err != nil || strings.TrimSpace(string(fenceData)) != planDigest || !store.IsFrozen() {
		return SignedControlRecord{}, errors.New("E_RETIREMENT_FENCE")
	}
	evidenceData, _ := json.Marshal(identities)
	evidenceSHA256 := SHA256(evidenceData)
	recordPath := store.path("evidence", "retirement-finalized.json")
	var record SignedControlRecord
	if existing, readErr := readPrivate(recordPath); readErr == nil {
		if strictJSON(existing, &record) != nil || record.Domain != RetirementFinalizationDomain || record.PlanSHA256 != planDigest || record.RequestID != "credential-revocations" || record.Disposition != "finalized" || record.EvidenceSHA256 != evidenceSHA256 || verifyControlRecord(record, installation.Roots[RecoveryRole], RecoveryRole) != nil {
			return SignedControlRecord{}, errors.New("E_RETIREMENT_FINALIZATION_BINDING")
		}
	} else if !os.IsNotExist(readErr) {
		return SignedControlRecord{}, readErr
	} else {
		record, err = store.signControlRecord(SignedControlRecord{Domain: RetirementFinalizationDomain, PlanSHA256: planDigest, RequestID: "credential-revocations", Disposition: "finalized", EvidenceSHA256: evidenceSHA256, RecordedAt: now}, RecoveryRole, passphrase)
		if err != nil {
			return record, err
		}
	}
	if err := store.retireLocalCredentials(); err != nil {
		return record, err
	}
	if _, readErr := readPrivate(recordPath); os.IsNotExist(readErr) {
		data, _ := json.MarshalIndent(record, "", "  ")
		if err := writeAtomicExclusive(recordPath, append(data, '\n'), 0o600); err != nil {
			return record, err
		}
	} else if readErr != nil {
		return record, readErr
	}
	if err := os.Remove(store.path("journal", "mutation.lock")); err != nil && !os.IsNotExist(err) {
		return record, err
	}
	if err := syncDirectory(store.path("journal")); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) retireLocalCredentials() error {
	slotsRoot := store.path("slots")
	entries, err := os.ReadDir(slotsRoot)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(slotsRoot, entry.Name())
		if !entry.IsDir() || validateOwnedPath(path, true) != nil {
			return errors.New("E_RETIREMENT_CREDENTIAL_PATH")
		}
		children, err := os.ReadDir(path)
		if err != nil {
			return err
		}
		for _, child := range children {
			childPath := filepath.Join(path, child.Name())
			if child.IsDir() || validateOwnedPath(childPath, false) != nil {
				return errors.New("E_RETIREMENT_CREDENTIAL_PATH")
			}
			if err := os.Remove(childPath); err != nil {
				return err
			}
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	if err := syncDirectory(slotsRoot); err != nil {
		return err
	}
	keyPath := store.path("keys", "credential-store.key")
	if err := os.Remove(keyPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDirectory(store.path("keys"))
}

func (store Store) VerifyJournal(planDigest string) error {
	installation, err := store.LoadInstallation()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(store.path("journal", planDigest))
	if err != nil {
		return err
	}
	var names []string
	for _, entry := range entries {
		if journalEventNamePattern.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	previous := strings.Repeat("0", 64)
	for index, name := range names {
		data, err := readPrivate(store.path("journal", planDigest, name))
		if err != nil {
			return err
		}
		var event Event
		if err := strictJSON(data, &event); err != nil {
			return err
		}
		signature := event.Signature
		event.Signature = ""
		payload, _ := signaturePayload(event)
		for _, digest := range []string{event.StateSHA256, event.IdentitySHA256, event.ReceiptSHA256} {
			if digest != "" && !digestPattern.MatchString(digest) {
				return errors.New("E_JOURNAL_EVIDENCE")
			}
		}
		if name != fmt.Sprintf("%06d-%s.json", event.Sequence, event.State) || event.Sequence != index || event.PlanSHA256 != planDigest || event.PreviousSHA256 != previous || event.KeyID != installation.Roots[JournalRole].KeyID || verifyDetached(installation.Roots[JournalRole], JournalRole, signature, payload) != nil {
			return errors.New("E_JOURNAL_CHAIN")
		}
		previous = SHA256(data)
	}
	if len(names) == 0 {
		return errors.New("E_JOURNAL_EMPTY")
	}
	return nil
}

var credentialRoles = map[string]*string{
	"cloudflare-deployment":  nil,
	"cloudflare-plan-read":   nil,
	"hetzner-worker":         stringPointer("HETZNER_TOKEN"),
	"crabbox-shared":         stringPointer("CRABBOX_SHARED_TOKEN"),
	"crabbox-admin":          stringPointer("CRABBOX_ADMIN_TOKEN"),
	"hetzner-inventory-read": nil,
	"hetzner-recovery":       nil,
}

func stringPointer(value string) *string { return &value }

func (store Store) EnrollCredential(environmentID, role, slotID, slotVersion string, value []byte, now time.Time) (SlotMetadata, error) {
	if len(value) < 16 || len(value) > 8192 || !identifierPattern.MatchString(slotID) || !identifierPattern.MatchString(slotVersion) {
		return SlotMetadata{}, errors.New("E_SLOT_VALUE")
	}
	secretName, allowed := credentialRoles[role]
	if !allowed {
		return SlotMetadata{}, errors.New("E_SLOT_ROLE")
	}
	guard, err := store.acquireAdmissionGuard()
	if err != nil {
		return SlotMetadata{}, err
	}
	defer releaseAdmissionGuard(guard)
	directory := store.path("slots", slotID)
	if err := os.Mkdir(directory, 0o700); err != nil && !os.IsExist(err) {
		return SlotMetadata{}, err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return SlotMetadata{}, err
	}
	secretPath, metadataPath := filepath.Join(directory, slotVersion+".secret"), filepath.Join(directory, slotVersion+".json")
	if err := reconcileAtomicExclusiveStaging(secretPath); err != nil {
		return SlotMetadata{}, err
	}
	if err := reconcileAtomicExclusiveStaging(metadataPath); err != nil {
		return SlotMetadata{}, err
	}
	_, secretErr := os.Lstat(secretPath)
	_, metadataErr := os.Lstat(metadataPath)
	if secretErr == nil && os.IsNotExist(metadataErr) {
		if err := os.Remove(secretPath); err != nil {
			return SlotMetadata{}, errors.New("E_SLOT_INCOMPLETE_RECOVERY")
		}
		if err := syncDirectory(directory); err != nil {
			return SlotMetadata{}, errors.New("E_SLOT_INCOMPLETE_RECOVERY")
		}
	} else if secretErr == nil || metadataErr == nil || (secretErr != nil && !os.IsNotExist(secretErr)) || (metadataErr != nil && !os.IsNotExist(metadataErr)) {
		return SlotMetadata{}, errors.New("E_SLOT_VERSION_EXISTS")
	}
	existing, existingErr := store.credentialMetadata()
	if existingErr != nil && !errors.Is(existingErr, os.ErrNotExist) {
		return SlotMetadata{}, existingErr
	}
	current := existing[role]
	if current.SlotID == slotID && current.SlotVersion == slotVersion {
		return SlotMetadata{}, errors.New("E_SLOT_VERSION_EXISTS")
	}
	credentialKey, err := store.credentialKey()
	if err != nil {
		return SlotMetadata{}, err
	}
	defer zeroBytes(credentialKey)
	sealedValue, err := sealCredential(value, credentialKey, environmentID+":"+role+":"+slotID+":"+slotVersion)
	if err != nil {
		return SlotMetadata{}, err
	}
	metadata := SlotMetadata{SchemaVersion: SchemaVersion, EnvironmentID: environmentID, Role: role, SecretName: secretName, SlotID: slotID, SlotVersion: slotVersion, CiphertextSHA256: SHA256(sealedValue), CreatedAt: now}
	if current.Role != "" {
		metadata.SupersedesSlotID = current.SlotID
		metadata.SupersedesVersion = current.SlotVersion
	}
	installation, err := store.LoadInstallation()
	if err != nil {
		return SlotMetadata{}, err
	}
	metadata.KeyID = installation.Roots[SlotEvidenceRole].KeyID
	payload, _ := signaturePayload(metadata)
	privateKey, err := store.privateKey(SlotEvidenceRole, nil)
	if err != nil {
		return SlotMetadata{}, err
	}
	defer zeroBytes(privateKey)
	metadata.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	if err := writeAtomicExclusive(secretPath, sealedValue, 0o600); err != nil {
		return SlotMetadata{}, err
	}
	data, _ := json.MarshalIndent(metadata, "", "  ")
	if err := writeAtomicExclusive(metadataPath, append(data, '\n'), 0o600); err != nil {
		return SlotMetadata{}, err
	}
	return metadata, nil
}

func (store Store) ResolveSecrets(plan Plan) (map[string][]byte, error) {
	if plan.Kind == "retire" {
		metadata, err := store.credentialMetadata()
		if err != nil {
			return nil, err
		}
		roleForSecret := map[string]string{"CRABBOX_ADMIN_TOKEN": "crabbox-admin", "CRABBOX_SHARED_TOKEN": "crabbox-shared", "HETZNER_TOKEN": "hetzner-worker"}
		for index, secretName := range canonicalSecrets {
			operation, item := plan.Operations[index+2], metadata[roleForSecret[secretName]]
			if operation.SlotID == nil || operation.SlotVersion == nil || item.SlotID != *operation.SlotID || item.SlotVersion != *operation.SlotVersion {
				return nil, errors.New("E_SLOT_BINDING")
			}
		}
		return map[string][]byte{}, nil
	}
	if plan.Kind != "deploy" && plan.Kind != "rotate-secrets" {
		return map[string][]byte{}, nil
	}
	installation, err := store.LoadInstallation()
	if err != nil {
		return nil, err
	}
	resolved := map[string][]byte{}
	currentMetadata, err := store.credentialMetadata()
	if err != nil {
		return nil, err
	}
	seenSlots := map[string]struct{}{}
	roleForSecret := map[string]string{"CRABBOX_ADMIN_TOKEN": "crabbox-admin", "CRABBOX_SHARED_TOKEN": "crabbox-shared", "HETZNER_TOKEN": "hetzner-worker"}
	for _, secretName := range canonicalSecrets {
		var operation *Operation
		for index := range plan.Operations {
			if plan.Operations[index].Action == "worker.secret.put" && plan.Operations[index].SecretName != nil && *plan.Operations[index].SecretName == secretName {
				operation = &plan.Operations[index]
				break
			}
		}
		if operation == nil || operation.SlotID == nil || operation.SlotVersion == nil {
			return nil, errors.New("E_SLOT_BINDING")
		}
		current := currentMetadata[roleForSecret[secretName]]
		if current.SlotID != *operation.SlotID || current.SlotVersion != *operation.SlotVersion {
			return nil, errors.New("E_SLOT_SUPERSEDED")
		}
		key := *operation.SlotID + ":" + *operation.SlotVersion
		if _, exists := seenSlots[key]; exists {
			return nil, errors.New("E_SLOT_ALIAS")
		}
		seenSlots[key] = struct{}{}
		metadataData, err := readPrivate(store.path("slots", *operation.SlotID, *operation.SlotVersion+".json"))
		if err != nil {
			return nil, errors.New("E_SLOT_METADATA")
		}
		var metadata SlotMetadata
		if err := strictJSON(metadataData, &metadata); err != nil {
			return nil, err
		}
		signature := metadata.Signature
		metadata.Signature = ""
		payload, _ := signaturePayload(metadata)
		if err := verifyDetached(installation.Roots[SlotEvidenceRole], SlotEvidenceRole, signature, payload); err != nil || metadata.EnvironmentID != installation.EnvironmentID || metadata.SecretName == nil || *metadata.SecretName != secretName || metadata.Role != roleForSecret[secretName] || metadata.SlotID != *operation.SlotID || metadata.SlotVersion != *operation.SlotVersion || metadata.KeyID != installation.Roots[SlotEvidenceRole].KeyID {
			return nil, errors.New("E_SLOT_BINDING")
		}
		sealedValue, err := readPrivate(store.path("slots", metadata.SlotID, metadata.SlotVersion+".secret"))
		if err != nil {
			return nil, errors.New("E_SLOT_RESOLUTION")
		}
		if SHA256(sealedValue) != metadata.CiphertextSHA256 {
			return nil, errors.New("E_SLOT_CIPHERTEXT")
		}
		credentialKey, err := store.credentialKey()
		if err != nil {
			return nil, err
		}
		value, err := unsealCredential(sealedValue, credentialKey, metadata.EnvironmentID+":"+metadata.Role+":"+metadata.SlotID+":"+metadata.SlotVersion)
		zeroBytes(credentialKey)
		if err != nil {
			return nil, err
		}
		resolved[secretName] = value
	}
	for left := 0; left < len(canonicalSecrets); left++ {
		for right := left + 1; right < len(canonicalSecrets); right++ {
			leftValue, rightValue := resolved[canonicalSecrets[left]], resolved[canonicalSecrets[right]]
			if len(leftValue) == len(rightValue) && subtle.ConstantTimeCompare(leftValue, rightValue) == 1 {
				ZeroSecrets(resolved)
				return nil, errors.New("E_SLOT_EQUAL")
			}
		}
	}
	return resolved, nil
}

func (store Store) CredentialSetSHA256() (string, error) {
	return store.credentialSetSHA256(true)
}

func (store Store) credentialBindingSHA256() (string, error) {
	return store.credentialSetSHA256(false)
}

func (store Store) credentialSetSHA256(requireValues bool) (string, error) {
	metadata, err := store.credentialMetadataWithValues(requireValues)
	if err != nil {
		return "", err
	}
	if len(metadata) != len(credentialRoles) {
		return "", errors.New("E_CREDENTIAL_SET_INCOMPLETE")
	}
	var identities []string
	seenSlots := map[string]struct{}{}
	for role, item := range metadata {
		identity := item.SlotID + ":" + item.SlotVersion
		if _, exists := seenSlots[identity]; exists {
			return "", errors.New("E_CREDENTIAL_SLOT_ALIAS")
		}
		seenSlots[identity] = struct{}{}
		identities = append(identities, role+":"+item.SlotID+":"+item.SlotVersion+":"+item.CiphertextSHA256+":"+item.KeyID)
	}
	sort.Strings(identities)
	data, _ := json.Marshal(identities)
	return SHA256(data), nil
}

func (store Store) credentialMetadata() (map[string]SlotMetadata, error) {
	return store.credentialMetadataWithValues(true)
}

func (store Store) credentialMetadataWithValues(requireValues bool) (map[string]SlotMetadata, error) {
	installation, err := store.LoadInstallation()
	if err != nil {
		return nil, err
	}
	byRole := map[string][]SlotMetadata{}
	entries, err := os.ReadDir(store.path("slots"))
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			return nil, errors.New("E_SLOT_DIRECTORY")
		}
		versions, err := os.ReadDir(store.path("slots", entry.Name()))
		if err != nil {
			return nil, err
		}
		pairs := map[string]map[string]bool{}
		for _, version := range versions {
			extension := filepath.Ext(version.Name())
			if version.IsDir() || (extension != ".json" && extension != ".secret") {
				return nil, errors.New("E_SLOT_VERSION_FILE")
			}
			base := strings.TrimSuffix(version.Name(), extension)
			if !identifierPattern.MatchString(base) || pairs[base][extension] {
				return nil, errors.New("E_SLOT_VERSION_FILE")
			}
			if pairs[base] == nil {
				pairs[base] = map[string]bool{}
			}
			pairs[base][extension] = true
		}
		for _, pair := range pairs {
			if !pair[".json"] || (requireValues && !pair[".secret"]) {
				return nil, errors.New("E_SLOT_VERSION_INCOMPLETE")
			}
		}
		for _, version := range versions {
			if strings.HasSuffix(version.Name(), ".json") {
				data, err := readPrivate(store.path("slots", entry.Name(), version.Name()))
				if err != nil {
					return nil, err
				}
				var metadata SlotMetadata
				if err := strictJSON(data, &metadata); err != nil {
					return nil, err
				}
				signature := metadata.Signature
				metadata.Signature = ""
				payload, _ := signaturePayload(metadata)
				if err := verifyDetached(installation.Roots[SlotEvidenceRole], SlotEvidenceRole, signature, payload); err != nil || metadata.EnvironmentID != installation.EnvironmentID || metadata.KeyID != installation.Roots[SlotEvidenceRole].KeyID {
					return nil, errors.New("E_SLOT_BINDING")
				}
				metadata.Signature = signature
				if !digestPattern.MatchString(metadata.CiphertextSHA256) {
					return nil, errors.New("E_SLOT_CIPHERTEXT")
				}
				sealedDigestValid := true
				if requireValues {
					sealed, err := readPrivate(store.path("slots", entry.Name(), metadata.SlotVersion+".secret"))
					sealedDigestValid = err == nil && SHA256(sealed) == metadata.CiphertextSHA256
				}
				if !sealedDigestValid || metadata.SlotID != entry.Name() || version.Name() != metadata.SlotVersion+".json" {
					return nil, errors.New("E_SLOT_CIPHERTEXT")
				}
				if _, exists := credentialRoles[metadata.Role]; !exists {
					return nil, errors.New("E_SLOT_ROLE")
				}
				byRole[metadata.Role] = append(byRole[metadata.Role], metadata)
			}
		}
	}
	result := map[string]SlotMetadata{}
	for role, versions := range byRole {
		identities := map[string]SlotMetadata{}
		referenced := map[string]int{}
		for _, metadata := range versions {
			identity := metadata.SlotID + ":" + metadata.SlotVersion
			if _, exists := identities[identity]; exists {
				return nil, errors.New("E_SLOT_VERSION_ALIAS")
			}
			identities[identity] = metadata
		}
		for _, metadata := range versions {
			if metadata.SupersedesSlotID == "" && metadata.SupersedesVersion == "" {
				continue
			}
			if metadata.SupersedesSlotID == "" || metadata.SupersedesVersion == "" {
				return nil, errors.New("E_SLOT_SUPERSESSION")
			}
			previous := metadata.SupersedesSlotID + ":" + metadata.SupersedesVersion
			if _, exists := identities[previous]; !exists || referenced[previous] != 0 {
				return nil, errors.New("E_SLOT_SUPERSESSION")
			}
			referenced[previous]++
		}
		var heads []SlotMetadata
		for identity, metadata := range identities {
			if referenced[identity] == 0 {
				heads = append(heads, metadata)
			}
		}
		if len(heads) != 1 {
			return nil, errors.New("E_SLOT_SUPERSESSION")
		}
		current := heads[0]
		seen := map[string]struct{}{}
		for current.SupersedesSlotID != "" {
			identity := current.SlotID + ":" + current.SlotVersion
			if _, exists := seen[identity]; exists {
				return nil, errors.New("E_SLOT_SUPERSESSION")
			}
			seen[identity] = struct{}{}
			current = identities[current.SupersedesSlotID+":"+current.SupersedesVersion]
		}
		if len(seen)+1 != len(versions) {
			return nil, errors.New("E_SLOT_SUPERSESSION")
		}
		result[role] = heads[0]
	}
	return result, nil
}

func (store Store) ResolveCredential(role string) ([]byte, error) {
	metadata, err := store.credentialMetadata()
	if err != nil {
		return nil, err
	}
	item, exists := metadata[role]
	if !exists {
		return nil, errors.New("E_CREDENTIAL_MISSING")
	}
	sealedValue, err := readPrivate(store.path("slots", item.SlotID, item.SlotVersion+".secret"))
	if err != nil {
		return nil, err
	}
	if SHA256(sealedValue) != item.CiphertextSHA256 {
		return nil, errors.New("E_SLOT_CIPHERTEXT")
	}
	key, err := store.credentialKey()
	if err != nil {
		return nil, err
	}
	defer zeroBytes(key)
	return unsealCredential(sealedValue, key, item.EnvironmentID+":"+item.Role+":"+item.SlotID+":"+item.SlotVersion)
}

func (store Store) credentialKey() ([]byte, error) {
	data, err := readPrivate(store.path("keys", "credential-store.key"))
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(key) != 32 {
		return nil, errors.New("E_CREDENTIAL_STORE_KEY")
	}
	return key, nil
}

func ZeroSecrets(secrets map[string][]byte) {
	for _, value := range secrets {
		for index := range value {
			value[index] = 0
		}
	}
}

func (store Store) acquireFence(planDigest string) (*os.File, error) {
	path := store.path("journal", "mutation.lock")
	if err := writeAtomicExclusive(path, []byte(planDigest+"\n"), 0o600); err != nil {
		return nil, errors.New("E_MUTATION_FENCE")
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		return nil, errors.New("E_MUTATION_FENCE")
	}
	return file, nil
}

func (store Store) resumeFence(planDigest string) (*os.File, error) {
	path := store.path("journal", "mutation.lock")
	data, err := readPrivate(path)
	if os.IsNotExist(err) {
		return nil, errors.New("E_MUTATION_FENCE_ABSENT")
	}
	if err != nil || strings.TrimSpace(string(data)) != planDigest {
		return nil, errors.New("E_MUTATION_FENCE")
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		return nil, errors.New("E_MUTATION_FENCE")
	}
	return file, nil
}

func (store Store) acquireAdmissionGuard() (*os.File, error) {
	path := store.path("journal", "admission.guard")
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0o600); err != nil || lockFile(file) != nil {
		file.Close()
		return nil, errors.New("E_ADMISSION_GUARD")
	}
	return file, nil
}

func releaseAdmissionGuard(file *os.File) {
	_ = unlockFile(file)
	_ = file.Close()
}

func (store Store) ensureNoActiveMutation() error {
	if _, err := os.Lstat(store.path("journal", "mutation.lock")); err == nil {
		return errors.New("E_MUTATION_FENCE")
	} else if !os.IsNotExist(err) {
		return err
	}
	entries, err := os.ReadDir(store.path("journal"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !digestPattern.MatchString(entry.Name()) {
			continue
		}
		last, err := store.lastEvent(entry.Name())
		if err != nil {
			return errors.New("E_JOURNAL_UNCLASSIFIED")
		}
		if last.State != "reconciled-terminal" && last.State != "abandoned-definite-noncommit" && last.State != "abandoned-reconciled" {
			return errors.New("E_JOURNAL_UNCLASSIFIED")
		}
	}
	return nil
}

func (store Store) releaseFence(file *os.File) error {
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Remove(store.path("journal", "mutation.lock")); err != nil {
		return err
	}
	return syncDirectory(store.path("journal"))
}

func (store Store) consumePlan(planDigest string, planData []byte, now time.Time) (string, error) {
	if SHA256(planData) != planDigest {
		return "", errors.New("E_PLAN_DIGEST")
	}
	directory := store.path("journal", planDigest)
	event := Event{SchemaVersion: SchemaVersion, Sequence: 0, PlanSHA256: planDigest, RequestID: "plan", State: "consumed", PreviousSHA256: strings.Repeat("0", 64), RecordedAt: now, DetailCode: "OK"}
	data, err := store.signedEventBytes(event)
	if err != nil {
		return "", err
	}
	staging := store.path("journal", ".consume-"+planDigest)
	if err := os.Mkdir(staging, 0o700); err != nil {
		if os.IsExist(err) {
			return "", errors.New("E_PLAN_REPLAY")
		}
		return "", err
	}
	if err := writeExclusive(filepath.Join(staging, "plan.json"), planData, 0o600); err != nil {
		return "", err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(staging)
		}
	}()
	if err := writeExclusive(filepath.Join(staging, "000000-consumed.json"), data, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(staging, directory); err != nil {
		if os.IsExist(err) {
			return "", errors.New("E_PLAN_REPLAY")
		}
		return "", err
	}
	if err := syncDirectory(store.path("journal")); err != nil {
		return "", err
	}
	committed = true
	return SHA256(data), nil
}

func (store Store) appendEvent(event Event) (string, error) {
	data, err := store.signedEventBytes(event)
	if err != nil {
		return "", err
	}
	path := store.path("journal", event.PlanSHA256, fmt.Sprintf("%06d-%s.json", event.Sequence, event.State))
	if err := writeAtomicExclusive(path, data, 0o600); err != nil {
		return "", err
	}
	return SHA256(data), nil
}

func (store Store) signedEventBytes(event Event) ([]byte, error) {
	installation, err := store.LoadInstallation()
	if err != nil {
		return nil, err
	}
	event.KeyID = installation.Roots[JournalRole].KeyID
	payload, _ := signaturePayload(event)
	privateKey, err := store.privateKey(JournalRole, nil)
	if err != nil {
		return nil, err
	}
	defer zeroBytes(privateKey)
	event.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	data, _ := json.MarshalIndent(event, "", "  ")
	return append(data, '\n'), nil
}

func (store Store) nextSequence(planDigest string) (int, string, error) {
	entries, err := os.ReadDir(store.path("journal", planDigest))
	if err != nil {
		return 0, "", err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type().IsRegular() && journalEventNamePattern.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return 0, "", errors.New("E_JOURNAL_EMPTY")
	}
	data, err := readPrivate(store.path("journal", planDigest, names[len(names)-1]))
	if err != nil {
		return 0, "", err
	}
	return len(names), SHA256(data), nil
}

func CopyBounded(destination io.Writer, source io.Reader, limit int64) error {
	written, err := io.CopyN(destination, source, limit+1)
	if err != nil && err != io.EOF {
		return err
	}
	if written > limit {
		return errors.New("E_OUTPUT_LIMIT")
	}
	return nil
}

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
	KeyID          string    `json:"keyId"`
	Signature      string    `json:"signature"`
}

type SlotMetadata struct {
	SchemaVersion    int       `json:"schemaVersion"`
	EnvironmentID    string    `json:"environmentId"`
	Role             string    `json:"role"`
	SecretName       *string   `json:"secretName"`
	SlotID           string    `json:"slotId"`
	SlotVersion      string    `json:"slotVersion"`
	CiphertextSHA256 string    `json:"ciphertextSha256"`
	CreatedAt        time.Time `json:"createdAt"`
	KeyID            string    `json:"keyId"`
	Signature        string    `json:"signature"`
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

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func readPrivate(path string) ([]byte, error) {
	if err := validateOwnedPath(path, false); err != nil {
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
		value, err := readPrivate(store.path("policy", name))
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
	Root                     string
	InstallationID           string
	EnvironmentID            string
	AccountID                string
	HetznerProjectID         string
	CoordinatorCommit        string
	AdmissionSHA256          string
	PermissionManifestSHA256 string
	LiveProfileSHA256        string
	TerminalProfileSHA256    string
	Launcher                 []byte
	Admission                []byte
	PermissionManifest       []byte
	LiveProfile              []byte
	TerminalProfile          []byte
	TerminalEntryPoint       []byte
	LiveProfilePath          string
	TerminalProfilePath      string
	TerminalEntryPointPath   string
	NPMPath                  string
	NPMPathSHA256            string
	CrabboxSource            string
	ToolchainIdentity        ToolchainIdentity
	OperatorPassphrase       []byte
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
	if input.AdmissionSHA256 != SHA256(input.Admission) || input.PermissionManifestSHA256 != SHA256(input.PermissionManifest) || input.LiveProfileSHA256 != SHA256(input.LiveProfile) || input.TerminalProfileSHA256 != SHA256(input.TerminalProfile) || !filepath.IsAbs(input.NPMPath) || !filepath.IsAbs(input.CrabboxSource) || !filepath.IsAbs(input.LiveProfilePath) || !filepath.IsAbs(input.TerminalProfilePath) || !filepath.IsAbs(input.TerminalEntryPointPath) {
		return Installation{}, errors.New("E_INSTALL_INPUT_BINDING")
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
	for _, directory := range []string{stagingRoot, filepath.Join(stagingRoot, "bin"), filepath.Join(stagingRoot, "policy"), filepath.Join(stagingRoot, "keys"), filepath.Join(stagingRoot, "slots"), filepath.Join(stagingRoot, "journal"), filepath.Join(stagingRoot, "evidence"), filepath.Join(stagingRoot, "runtime")} {
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
	installation := Installation{SchemaVersion: SchemaVersion, InstallationID: input.InstallationID, EnvironmentID: input.EnvironmentID, AccountID: input.AccountID, WorkerName: WorkerName, HetznerProjectID: input.HetznerProjectID, CoordinatorCommit: input.CoordinatorCommit, AdmissionSHA256: input.AdmissionSHA256, PermissionManifestSHA256: input.PermissionManifestSHA256, LiveProfileSHA256: input.LiveProfileSHA256, TerminalProfileSHA256: input.TerminalProfileSHA256, TerminalEntryPointSHA256: SHA256(input.TerminalEntryPoint), LiveProfilePath: input.LiveProfilePath, TerminalProfilePath: input.TerminalProfilePath, TerminalEntryPointPath: input.TerminalEntryPointPath, LauncherSHA256: SHA256(input.Launcher), NPMPath: input.NPMPath, NPMPathSHA256: input.NPMPathSHA256, CrabboxSource: input.CrabboxSource, ToolchainIdentity: input.ToolchainIdentity, Roots: roots}
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

func (store Store) Freeze(reason string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	if !identifierPattern.MatchString(reason) {
		return SignedControlRecord{}, errors.New("E_FREEZE_REASON")
	}
	record, err := store.signControlRecord(SignedControlRecord{Domain: FreezeDomain, RequestID: reason, Disposition: "frozen", RecordedAt: now}, RecoveryRole, passphrase)
	if err != nil {
		return record, err
	}
	data, _ := json.MarshalIndent(record, "", "  ")
	if err := writeExclusive(store.path("journal", "acquisition.freeze"), append(data, '\n'), 0o600); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) IsFrozen() bool {
	_, err := os.Lstat(store.path("journal", "acquisition.freeze"))
	return err == nil
}

func (store Store) RecoverQuarantine(planSHA256, requestID, evidenceSHA256 string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	if !digestPattern.MatchString(planSHA256) || !identifierPattern.MatchString(requestID) || !digestPattern.MatchString(evidenceSHA256) {
		return SignedControlRecord{}, errors.New("E_RECOVERY_INPUT")
	}
	if err := store.VerifyJournal(planSHA256); err != nil {
		return SignedControlRecord{}, err
	}
	record, err := store.signControlRecord(SignedControlRecord{Domain: RecoveryDomain, PlanSHA256: planSHA256, RequestID: requestID, Disposition: "quarantine", EvidenceSHA256: evidenceSHA256, RecordedAt: now}, RecoveryRole, passphrase)
	if err != nil {
		return record, err
	}
	data, _ := json.MarshalIndent(record, "", "  ")
	if err := writeExclusive(store.path("journal", planSHA256, "recovery-quarantine.json"), append(data, '\n'), 0o600); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) ResolveQuarantine(planSHA256, requestID, evidenceSHA256 string, now time.Time, passphrase []byte) (SignedControlRecord, error) {
	if !digestPattern.MatchString(planSHA256) || !identifierPattern.MatchString(requestID) || !digestPattern.MatchString(evidenceSHA256) {
		return SignedControlRecord{}, errors.New("E_RECOVERY_INPUT")
	}
	if err := store.VerifyJournal(planSHA256); err != nil {
		return SignedControlRecord{}, err
	}
	if _, err := readPrivate(store.path("journal", planSHA256, "recovery-quarantine.json")); err != nil {
		return SignedControlRecord{}, errors.New("E_RECOVERY_NOT_QUARANTINED")
	}
	fenceData, err := readPrivate(store.path("journal", "mutation.lock"))
	if err != nil || strings.TrimSpace(string(fenceData)) != planSHA256 {
		return SignedControlRecord{}, errors.New("E_MUTATION_FENCE")
	}
	if !store.IsFrozen() {
		if _, err := store.Freeze("recovery-quarantine", now, passphrase); err != nil {
			return SignedControlRecord{}, err
		}
	}
	record, err := store.signControlRecord(SignedControlRecord{Domain: RecoveryDomain, PlanSHA256: planSHA256, RequestID: requestID, Disposition: "reconciled-abandoned", EvidenceSHA256: evidenceSHA256, RecordedAt: now}, RecoveryRole, passphrase)
	if err != nil {
		return record, err
	}
	data, _ := json.MarshalIndent(record, "", "  ")
	if err := writeExclusive(store.path("journal", planSHA256, "recovery-resolved.json"), append(data, '\n'), 0o600); err != nil {
		return record, err
	}
	if err := os.Remove(store.path("journal", "mutation.lock")); err != nil {
		return record, err
	}
	if err := syncDirectory(store.path("journal")); err != nil {
		return record, err
	}
	return record, nil
}

func (store Store) recordRetirement(planDigest, tombstoneDigest string, now time.Time) error {
	record, err := store.signControlRecord(SignedControlRecord{Domain: RetirementDomain, PlanSHA256: planDigest, RequestID: "retirement", Disposition: "terminal", EvidenceSHA256: tombstoneDigest, RecordedAt: now}, JournalRole, nil)
	if err != nil {
		return err
	}
	data, _ := json.MarshalIndent(record, "", "  ")
	return writeExclusive(store.path("evidence", "retirement-complete.json"), append(data, '\n'), 0o600)
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
	if existing, _ := store.credentialMetadata(); existing[role].Role != "" {
		return SlotMetadata{}, errors.New("E_SLOT_ROLE_EXISTS")
	}
	directory := store.path("slots", slotID)
	if err := os.Mkdir(directory, 0o700); err != nil && !os.IsExist(err) {
		return SlotMetadata{}, err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return SlotMetadata{}, err
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
	if err := writeExclusive(filepath.Join(directory, slotVersion+".secret"), sealedValue, 0o600); err != nil {
		return SlotMetadata{}, err
	}
	data, _ := json.MarshalIndent(metadata, "", "  ")
	if err := writeExclusive(filepath.Join(directory, slotVersion+".json"), append(data, '\n'), 0o600); err != nil {
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
			operation, item := plan.Operations[index], metadata[roleForSecret[secretName]]
			if operation.SlotID == nil || operation.SlotVersion == nil || item.SlotID != *operation.SlotID || item.SlotVersion != *operation.SlotVersion {
				return nil, errors.New("E_SLOT_BINDING")
			}
		}
		return map[string][]byte{}, nil
	}
	if plan.Kind != "deploy" {
		return map[string][]byte{}, nil
	}
	installation, err := store.LoadInstallation()
	if err != nil {
		return nil, err
	}
	resolved := map[string][]byte{}
	seenSlots := map[string]struct{}{}
	roleForSecret := map[string]string{"CRABBOX_ADMIN_TOKEN": "crabbox-admin", "CRABBOX_SHARED_TOKEN": "crabbox-shared", "HETZNER_TOKEN": "hetzner-worker"}
	for index, secretName := range canonicalSecrets {
		operation := plan.Operations[index]
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
	metadata, err := store.credentialMetadata()
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
	installation, err := store.LoadInstallation()
	if err != nil {
		return nil, err
	}
	result := map[string]SlotMetadata{}
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
				if _, exists := credentialRoles[metadata.Role]; !exists {
					return nil, errors.New("E_SLOT_ROLE")
				}
				if result[metadata.Role].Role != "" {
					return nil, errors.New("E_SLOT_ROLE_ALIAS")
				}
				result[metadata.Role] = metadata
			}
		}
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
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, errors.New("E_MUTATION_FENCE")
	}
	if _, err := fmt.Fprintf(file, "%s\n", planDigest); err != nil {
		file.Close()
		return nil, err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return nil, err
	}
	if err := syncDirectory(store.path("journal")); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
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

func (store Store) consumePlan(planDigest string, now time.Time) (string, error) {
	directory := store.path("journal", planDigest)
	if err := os.Mkdir(directory, 0o700); err != nil {
		if os.IsExist(err) {
			return "", errors.New("E_PLAN_REPLAY")
		}
		return "", err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return "", err
	}
	if err := syncDirectory(store.path("journal")); err != nil {
		return "", err
	}
	event := Event{SchemaVersion: SchemaVersion, Sequence: 0, PlanSHA256: planDigest, RequestID: "plan", State: "consumed", PreviousSHA256: strings.Repeat("0", 64), RecordedAt: now, DetailCode: "OK"}
	return store.appendEvent(event)
}

func (store Store) appendEvent(event Event) (string, error) {
	installation, err := store.LoadInstallation()
	if err != nil {
		return "", err
	}
	event.KeyID = installation.Roots[JournalRole].KeyID
	payload, _ := signaturePayload(event)
	privateKey, err := store.privateKey(JournalRole, nil)
	if err != nil {
		return "", err
	}
	defer zeroBytes(privateKey)
	event.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	data, _ := json.MarshalIndent(event, "", "  ")
	path := store.path("journal", event.PlanSHA256, fmt.Sprintf("%06d-%s.json", event.Sequence, event.State))
	if err := writeExclusive(path, append(data, '\n'), 0o600); err != nil {
		return "", err
	}
	return SHA256(append(data, '\n')), nil
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
		_, _ = io.Copy(io.Discard, source)
		return errors.New("E_OUTPUT_LIMIT")
	}
	return nil
}

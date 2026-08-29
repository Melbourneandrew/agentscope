package control

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type UpgradeInput struct {
	InstallInput
	Now                            time.Time
	predecessorSourceCommitForTest string
	afterStagingForTest            func() error
	afterInstallationForTest       func() error
	afterLauncherForTest           func() error
}

func installationGeneration(installation Installation) int {
	if installation.SchemaVersion == 1 {
		return 1
	}
	return installation.LauncherGeneration
}

func stageUpgradeReplacement(stagePath string, value []byte, mode os.FileMode) error {
	data, err := readPrivate(stagePath)
	if os.IsNotExist(err) {
		if err := writeAtomicExclusive(stagePath, value, mode); err != nil {
			return err
		}
		data, err = readPrivate(stagePath)
	}
	if err != nil || SHA256(data) != SHA256(value) {
		return errors.New("E_UPGRADE_STAGE")
	}
	info, err := os.Lstat(stagePath)
	if err != nil || info.Mode().Perm() != mode.Perm() {
		return errors.New("E_UPGRADE_STAGE")
	}
	return nil
}

func commitUpgradeReplacement(stagePath, path string, value []byte) error {
	if err := validateProtectedReadablePath(path, false); err != nil {
		return err
	}
	parent := filepath.Dir(path)
	if err := validateProtectedReadablePath(parent, true); err != nil {
		return err
	}
	data, err := readPrivate(stagePath)
	if err != nil || SHA256(data) != SHA256(value) {
		return errors.New("E_UPGRADE_STAGE")
	}
	if err := os.Rename(stagePath, path); err != nil {
		return err
	}
	if err := syncDirectory(parent); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(stagePath))
}

func (store Store) signLauncherUpgrade(record LauncherUpgradeRecord) (LauncherUpgradeRecord, error) {
	installation, err := store.LoadInstallation()
	if err != nil {
		return record, err
	}
	record.SchemaVersion = SchemaVersion
	record.Domain = LauncherUpgradeDomain
	record.KeyID = installation.Roots[JournalRole].KeyID
	payload, _ := signaturePayload(record)
	privateKey, err := store.privateKey(JournalRole, nil)
	if err != nil {
		return record, err
	}
	defer zeroBytes(privateKey)
	record.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return record, nil
}

func verifyLauncherUpgrade(record LauncherUpgradeRecord, installation Installation) error {
	signature := record.Signature
	record.Signature = ""
	payload, _ := signaturePayload(record)
	if record.SchemaVersion != SchemaVersion || record.Domain != LauncherUpgradeDomain || record.InstallationID != installation.InstallationID || record.EnvironmentID != installation.EnvironmentID || record.Generation < 2 || !digestPattern.MatchString(record.PreviousInstallationSHA256) || !digestPattern.MatchString(record.PreviousLauncherSHA256) || !digestPattern.MatchString(record.LauncherSHA256) || !digestPattern.MatchString(record.RuntimeTreeSHA256) || !digestPattern.MatchString(record.InstallationSHA256) || len(record.PreviousSourceCommit) != 40 || strings.Trim(record.PreviousSourceCommit, "0123456789abcdef") != "" || len(record.PreviousSourceTree) != 40 || strings.Trim(record.PreviousSourceTree, "0123456789abcdef") != "" || len(record.SourceCommit) != 40 || strings.Trim(record.SourceCommit, "0123456789abcdef") != "" || len(record.SourceTree) != 40 || strings.Trim(record.SourceTree, "0123456789abcdef") != "" || record.RecordedAt.IsZero() || record.KeyID != installation.Roots[JournalRole].KeyID {
		return errors.New("E_UPGRADE_RECORD")
	}
	return verifyDetached(installation.Roots[JournalRole], JournalRole, signature, payload)
}

func (store Store) signLauncherUpgradeCompletion(completion LauncherUpgradeCompletion, installation Installation) (LauncherUpgradeCompletion, error) {
	completion.SchemaVersion = SchemaVersion
	completion.Domain = LauncherUpgradeCompleteDomain
	completion.KeyID = installation.Roots[JournalRole].KeyID
	payload, _ := signaturePayload(completion)
	privateKey, err := store.privateKey(JournalRole, nil)
	if err != nil {
		return completion, err
	}
	defer zeroBytes(privateKey)
	completion.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	return completion, nil
}

func verifyLauncherUpgradeCompletion(completion LauncherUpgradeCompletion, record LauncherUpgradeRecord, installation Installation) error {
	signature := completion.Signature
	completion.Signature = ""
	payload, _ := signaturePayload(completion)
	if completion.SchemaVersion != SchemaVersion || completion.Domain != LauncherUpgradeCompleteDomain || completion.InstallationID != installation.InstallationID || completion.EnvironmentID != installation.EnvironmentID || completion.Generation != record.Generation || completion.UpgradeSHA256 == "" || completion.InstallationSHA256 != record.InstallationSHA256 || completion.LauncherSHA256 != record.LauncherSHA256 || completion.RecordedAt.Before(record.RecordedAt) || completion.KeyID != installation.Roots[JournalRole].KeyID {
		return errors.New("E_UPGRADE_COMPLETION")
	}
	return verifyDetached(installation.Roots[JournalRole], JournalRole, signature, payload)
}

func ensureUpgradeDirectory(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return err
	}
	return validateOwnedPath(path, true)
}

func removeUpgradeStage(path string) {
	_ = filepath.Walk(path, func(current string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() {
			_ = os.Chmod(current, 0o700)
		}
		return nil
	})
	_ = os.RemoveAll(path)
}

func validateUpgradeCandidate(input UpgradeInput, current Installation) (RuntimeIdentity, error) {
	if len(input.Launcher) == 0 || len(input.Launcher) > 64<<20 || input.RuntimeClosureSHA256 != SHA256(input.RuntimeClosure) {
		return RuntimeIdentity{}, errors.New("E_UPGRADE_ARTIFACT")
	}
	if input.InstallationID != current.InstallationID || input.EnvironmentID != current.EnvironmentID || input.AccountID != current.AccountID || input.HetznerProjectID != current.HetznerProjectID || input.ExecutorUID != current.ExecutorUID || input.CoordinatorCommit != current.CoordinatorCommit || input.AdmissionSHA256 != current.AdmissionSHA256 || input.PermissionManifestSHA256 != current.PermissionManifestSHA256 || input.LiveProfileSHA256 != current.LiveProfileSHA256 || input.TerminalProfileSHA256 != current.TerminalProfileSHA256 || SHA256(input.TerminalEntryPoint) != current.TerminalEntryPointSHA256 || input.ToolchainIdentity != current.ToolchainIdentity {
		return RuntimeIdentity{}, errors.New("E_UPGRADE_IDENTITY")
	}
	if input.AdmissionSHA256 != SHA256(input.Admission) || input.PermissionManifestSHA256 != SHA256(input.PermissionManifest) || input.LiveProfileSHA256 != SHA256(input.LiveProfile) || input.TerminalProfileSHA256 != SHA256(input.TerminalProfile) {
		return RuntimeIdentity{}, errors.New("E_UPGRADE_INPUT_BINDING")
	}
	if !input.skipCanonicalPolicyValidationForTest {
		if BuildSourceCommit != input.LauncherSourceCommit || BuildSourceTree != input.LauncherSourceTree {
			return RuntimeIdentity{}, errors.New("E_LAUNCHER_SOURCE_BINDING")
		}
		if err := ValidateCanonicalInstallInputs(input.Admission, input.PermissionManifest, input.LiveProfile, input.TerminalProfile, input.TerminalEntryPoint, input.EnvironmentID, input.ToolchainIdentity); err != nil {
			return RuntimeIdentity{}, err
		}
	}
	commit, err := CoordinatorCommitFromAdmission(input.Admission)
	if err != nil || commit != current.CoordinatorCommit {
		return RuntimeIdentity{}, errors.New("E_UPGRADE_COORDINATOR")
	}
	stage, err := os.MkdirTemp(filepath.Dir(input.Root), ".agentscope-crabbox-upgrade-runtime-")
	if err != nil {
		return RuntimeIdentity{}, err
	}
	defer removeUpgradeStage(stage)
	if err := os.Chmod(stage, 0o700); err != nil {
		return RuntimeIdentity{}, err
	}
	identity, err := extractRuntimeClosure(input.RuntimeClosure, filepath.Join(stage, "toolchain"), input.ToolchainIdentity.WorkerLockSHA256)
	if err != nil {
		return RuntimeIdentity{}, err
	}
	if identity.TreeSHA256 != current.RuntimeTreeSHA256 || identity.NodeSHA256 != current.NodeSHA256 || identity.NPMCLISHA256 != current.NPMCLISHA256 || identity.WranglerCLISHA256 != current.WranglerCLISHA256 {
		return RuntimeIdentity{}, errors.New("E_UPGRADE_RUNTIME_DRIFT")
	}
	return identity, nil
}

func Upgrade(input UpgradeInput) (Installation, error) {
	if input.Now.IsZero() {
		input.Now = time.Now().UTC()
	} else {
		input.Now = input.Now.UTC()
	}
	store := NewStore(input.Root)
	guard, err := store.acquireAdmissionGuardUnchecked()
	if err != nil {
		return Installation{}, err
	}
	defer releaseAdmissionGuard(guard)
	current, err := store.LoadInstallation()
	if err != nil {
		return Installation{}, err
	}
	predecessor := BuildUpgradePredecessorCommit
	if input.skipCanonicalPolicyValidationForTest {
		predecessor = input.predecessorSourceCommitForTest
	}
	if len(predecessor) != 40 || strings.Trim(predecessor, "0123456789abcdef") != "" || predecessor == input.LauncherSourceCommit {
		return Installation{}, errors.New("E_UPGRADE_PREDECESSOR")
	}
	if _, err := validateUpgradeCandidate(input, current); err != nil {
		return Installation{}, err
	}
	if _, err := verifyRuntimeClosure(store.path("toolchain"), current); err != nil {
		return Installation{}, err
	}
	if err := store.ensureNoActiveMutation(); err != nil {
		return Installation{}, err
	}
	retirement, err := store.retirementStatusLocked()
	if err != nil || retirement.CloudAbsenceRecorded || retirement.FinalizationRecorded || retirement.Finalized {
		return Installation{}, errors.New("E_UPGRADE_RETIREMENT_STATE")
	}

	launcherSHA256 := SHA256(input.Launcher)
	installationPath := store.path("policy", "installation.json")
	currentInstallationData, err := readPrivate(installationPath)
	if err != nil {
		return Installation{}, err
	}
	launcherPath := store.path("bin", "agentscope-crabbox-control")
	launcherData, err := readPrivate(launcherPath)
	if err != nil {
		return Installation{}, err
	}

	var previous Installation
	var generation int
	if current.LauncherSourceCommit == input.LauncherSourceCommit && current.LauncherSourceTree == input.LauncherSourceTree && current.LauncherSHA256 == launcherSHA256 {
		if current.SchemaVersion != 2 || current.PreviousLauncherCommit != predecessor {
			return Installation{}, errors.New("E_UPGRADE_REPLAY")
		}
		previous = current
		previous.LauncherSHA256 = current.PreviousLauncherSHA256
		previous.LauncherSourceCommit = current.PreviousLauncherCommit
		previous.LauncherSourceTree = current.PreviousLauncherTree
		generation = current.LauncherGeneration
		if SHA256(launcherData) != current.PreviousLauncherSHA256 && SHA256(launcherData) != launcherSHA256 {
			return Installation{}, errors.New("E_UPGRADE_LAUNCHER_STATE")
		}
	} else {
		if current.LauncherSourceCommit != predecessor || current.LauncherSourceCommit == input.LauncherSourceCommit || current.LauncherSHA256 == launcherSHA256 || SHA256(launcherData) != current.LauncherSHA256 {
			return Installation{}, errors.New("E_UPGRADE_PREDECESSOR")
		}
		previous = current
		generation = installationGeneration(current) + 1
	}

	next := current
	if current.LauncherSourceCommit != input.LauncherSourceCommit {
		next.SchemaVersion = 2
		next.LauncherGeneration = generation
		next.PreviousLauncherSHA256 = current.LauncherSHA256
		next.PreviousLauncherCommit = current.LauncherSourceCommit
		next.PreviousLauncherTree = current.LauncherSourceTree
		next.LauncherSHA256 = launcherSHA256
		next.LauncherSourceCommit = input.LauncherSourceCommit
		next.LauncherSourceTree = input.LauncherSourceTree
	}
	if err := ValidateInstallation(next); err != nil {
		return Installation{}, err
	}
	nextData, _ := json.MarshalIndent(next, "", "  ")
	nextData = append(nextData, '\n')
	previousDataSHA256 := SHA256(currentInstallationData)
	if current.LauncherSourceCommit == input.LauncherSourceCommit {
		previousDataSHA256 = ""
	}

	upgradesRoot := store.path("journal", "launcher-upgrades")
	if err := ensureUpgradeDirectory(upgradesRoot); err != nil {
		return Installation{}, err
	}
	upgradeRoot := filepath.Join(upgradesRoot, fmt.Sprintf("%06d-%s", generation, launcherSHA256))
	if err := ensureUpgradeDirectory(upgradeRoot); err != nil {
		return Installation{}, err
	}
	intentPath := filepath.Join(upgradeRoot, "intent.json")
	var record LauncherUpgradeRecord
	intentData, intentErr := readPrivate(intentPath)
	if os.IsNotExist(intentErr) {
		if previousDataSHA256 == "" {
			return Installation{}, errors.New("E_UPGRADE_RECORD_MISSING")
		}
		record = LauncherUpgradeRecord{InstallationID: current.InstallationID, EnvironmentID: current.EnvironmentID, Generation: generation, PreviousInstallationSHA256: previousDataSHA256, PreviousLauncherSHA256: previous.LauncherSHA256, PreviousSourceCommit: previous.LauncherSourceCommit, PreviousSourceTree: previous.LauncherSourceTree, LauncherSHA256: launcherSHA256, SourceCommit: input.LauncherSourceCommit, SourceTree: input.LauncherSourceTree, RuntimeTreeSHA256: current.RuntimeTreeSHA256, InstallationSHA256: SHA256(nextData), RecordedAt: input.Now}
		record, err = store.signLauncherUpgrade(record)
		if err != nil {
			return Installation{}, err
		}
		intentData, _ = json.MarshalIndent(record, "", "  ")
		intentData = append(intentData, '\n')
		if err := writeAtomicExclusive(intentPath, intentData, 0o600); err != nil {
			return Installation{}, err
		}
	} else if intentErr != nil || strictJSON(intentData, &record) != nil {
		return Installation{}, errors.New("E_UPGRADE_RECORD")
	}
	if err := verifyLauncherUpgrade(record, current); err != nil || record.Generation != generation || record.PreviousLauncherSHA256 != previous.LauncherSHA256 || record.PreviousSourceCommit != predecessor || record.LauncherSHA256 != launcherSHA256 || record.SourceCommit != input.LauncherSourceCommit || record.SourceTree != input.LauncherSourceTree || record.RuntimeTreeSHA256 != current.RuntimeTreeSHA256 || record.InstallationSHA256 != SHA256(nextData) {
		return Installation{}, errors.New("E_UPGRADE_RECORD")
	}

	installationNeedsReplacement := SHA256(currentInstallationData) != record.InstallationSHA256
	launcherNeedsReplacement := SHA256(launcherData) != launcherSHA256
	installationStagePath := filepath.Join(upgradeRoot, "installation.next")
	launcherStagePath := filepath.Join(upgradeRoot, "launcher.next")
	if installationNeedsReplacement {
		if current.LauncherSourceCommit != previous.LauncherSourceCommit || SHA256(currentInstallationData) != record.PreviousInstallationSHA256 {
			return Installation{}, errors.New("E_UPGRADE_INSTALLATION_STATE")
		}
		if err := stageUpgradeReplacement(installationStagePath, nextData, 0o600); err != nil {
			return Installation{}, err
		}
	}
	if launcherNeedsReplacement {
		if SHA256(launcherData) != record.PreviousLauncherSHA256 {
			return Installation{}, errors.New("E_UPGRADE_LAUNCHER_STATE")
		}
		if err := stageUpgradeReplacement(launcherStagePath, input.Launcher, 0o500); err != nil {
			return Installation{}, err
		}
	}
	if input.afterStagingForTest != nil {
		if err := input.afterStagingForTest(); err != nil {
			return Installation{}, err
		}
	}
	if installationNeedsReplacement {
		if err := commitUpgradeReplacement(installationStagePath, installationPath, nextData); err != nil {
			return Installation{}, err
		}
		if input.afterInstallationForTest != nil {
			if err := input.afterInstallationForTest(); err != nil {
				return Installation{}, err
			}
		}
	}
	if data, err := readPrivate(installationPath); err != nil || SHA256(data) != record.InstallationSHA256 {
		return Installation{}, errors.New("E_UPGRADE_INSTALLATION_STATE")
	}
	if launcherNeedsReplacement {
		if err := commitUpgradeReplacement(launcherStagePath, launcherPath, input.Launcher); err != nil {
			return Installation{}, err
		}
		if input.afterLauncherForTest != nil {
			if err := input.afterLauncherForTest(); err != nil {
				return Installation{}, err
			}
		}
	}
	if data, err := readPrivate(launcherPath); err != nil || SHA256(data) != launcherSHA256 {
		return Installation{}, errors.New("E_UPGRADE_LAUNCHER_STATE")
	}

	completionPath := filepath.Join(upgradeRoot, "completion.json")
	completionData, completionErr := readPrivate(completionPath)
	if os.IsNotExist(completionErr) {
		completion := LauncherUpgradeCompletion{InstallationID: next.InstallationID, EnvironmentID: next.EnvironmentID, Generation: generation, UpgradeSHA256: SHA256(intentData), InstallationSHA256: record.InstallationSHA256, LauncherSHA256: launcherSHA256, RecordedAt: input.Now}
		if completion.RecordedAt.Before(record.RecordedAt) {
			completion.RecordedAt = record.RecordedAt
		}
		completion, err = store.signLauncherUpgradeCompletion(completion, next)
		if err != nil {
			return Installation{}, err
		}
		completionData, _ = json.MarshalIndent(completion, "", "  ")
		completionData = append(completionData, '\n')
		if err := writeAtomicExclusive(completionPath, completionData, 0o600); err != nil {
			return Installation{}, err
		}
	} else if completionErr != nil {
		return Installation{}, errors.New("E_UPGRADE_COMPLETION")
	}
	var completion LauncherUpgradeCompletion
	if strictJSON(completionData, &completion) != nil || completion.UpgradeSHA256 != SHA256(intentData) || verifyLauncherUpgradeCompletion(completion, record, next) != nil {
		return Installation{}, errors.New("E_UPGRADE_COMPLETION")
	}
	return next, nil
}

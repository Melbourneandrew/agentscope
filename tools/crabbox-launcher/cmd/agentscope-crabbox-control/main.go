package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Melbourneandrew/agentscope/tools/crabbox-launcher/internal/control"
)

const productionRoot = "/Library/Application Support/Agentscope/CrabboxControl"

func fail(code string) {
	_, _ = fmt.Fprintf(os.Stderr, "agentscope-crabbox-control: %s\n", code)
	os.Exit(1)
}

func requireRoot() {
	if os.Geteuid() != 0 {
		fail("E_ROOT_REQUIRED")
	}
}

func stateRoot() string {
	if value := os.Getenv("AGENTSCOPE_CRABBOX_TEST_ROOT"); value != "" {
		return value
	}
	return productionRoot
}

func verifyInstalledExecutable() {
	installation, err := control.NewStore(stateRoot()).LoadInstallation()
	if err != nil {
		fail(errorCode(err))
	}
	if stateRoot() == productionRoot && !installation.CanonicalPolicy {
		fail("E_CANONICAL_POLICY_REQUIRED")
	}
	executable, err := os.Executable()
	if err != nil {
		fail("E_EXECUTABLE")
	}
	physical, err := filepath.EvalSymlinks(executable)
	if err != nil {
		fail("E_EXECUTABLE")
	}
	expected := filepath.Join(stateRoot(), "bin", "agentscope-crabbox-control")
	if physical != expected {
		fail("E_LAUNCHER_IDENTITY")
	}
	data, err := readBounded(physical)
	if err != nil || control.SHA256(data) != installation.LauncherSHA256 {
		fail("E_LAUNCHER_IDENTITY")
	}
}

func readBounded(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 64<<20 {
		return nil, errors.New("E_INPUT_FILE")
	}
	return os.ReadFile(path)
}

func emit(value any) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fail("E_OUTPUT")
	}
	data = append(data, '\n')
	if _, err := os.Stdout.Write(data); err != nil {
		fail("E_OUTPUT")
	}
}

func install(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	installationID := flags.String("installation-id", "", "immutable installation identity")
	environmentID := flags.String("environment-id", "", "immutable coordinator environment identity")
	accountID := flags.String("account-id", "", "approved Cloudflare account identity")
	projectID := flags.String("hetzner-project-id", "", "dedicated Hetzner project identity")
	executorUID := flags.Int("executor-uid", 0, "dedicated no-login execution principal uid")
	launcherSourceCommit := flags.String("launcher-source-commit", "", "authenticated launcher source commit")
	launcherSourceTree := flags.String("launcher-source-tree", "", "authenticated launcher source tree")
	admission := flags.String("admission", "", "canonical admission file")
	manifest := flags.String("permission-manifest", "", "canonical permission manifest")
	liveProfile := flags.String("live-profile", "", "canonical live profile")
	terminalProfile := flags.String("terminal-profile", "", "canonical terminal profile")
	terminalEntryPoint := flags.String("terminal-entry-point", "", "canonical terminal Worker entry point")
	runtimeClosurePath := flags.String("runtime-closure", "", "exact attended runtime closure archive")
	runtimeClosureSHA256 := flags.String("runtime-closure-sha256", "", "human-reviewed runtime closure digest")
	toolchainIdentityPath := flags.String("toolchain-identity", "", "canonical toolchain identity")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		fail("E_ARGUMENTS")
	}
	executable, err := os.Executable()
	if err != nil {
		fail("E_EXECUTABLE")
	}
	launcher, err := readBounded(executable)
	if err != nil {
		fail(err.Error())
	}
	files := []*string{admission, manifest, liveProfile, terminalProfile, terminalEntryPoint}
	digests := make([]string, len(files))
	contents := make([][]byte, len(files))
	for index, path := range files {
		value, err := readBounded(*path)
		if err != nil {
			fail(err.Error())
		}
		digests[index] = control.SHA256(value)
		contents[index] = value
	}
	toolchainData, err := readBounded(*toolchainIdentityPath)
	if err != nil {
		fail(errorCode(err))
	}
	toolchainIdentity, err := control.ParseToolchainIdentity(toolchainData)
	if err != nil {
		fail(errorCode(err))
	}
	coordinatorCommit, err := control.CoordinatorCommitFromAdmission(contents[0])
	if err != nil {
		fail(errorCode(err))
	}
	runtimeInfo, statErr := os.Lstat(*runtimeClosurePath)
	if statErr != nil || !runtimeInfo.Mode().IsRegular() || runtimeInfo.Mode()&os.ModeSymlink != 0 || runtimeInfo.Size() <= 0 || runtimeInfo.Size() > 768<<20 {
		fail("E_RUNTIME_ARCHIVE")
	}
	runtimeClosure, err := os.ReadFile(*runtimeClosurePath)
	if err != nil || control.SHA256(runtimeClosure) != *runtimeClosureSHA256 {
		fail("E_RUNTIME_ARCHIVE")
	}
	passphrase, err := confirmedSecret("Create operator authorization passphrase: ", "Re-enter operator authorization passphrase: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(passphrase)
	installed, err := control.Install(control.InstallInput{Root: stateRoot(), ExecutorUID: *executorUID, InstallationID: *installationID, EnvironmentID: *environmentID, AccountID: *accountID, HetznerProjectID: *projectID, CoordinatorCommit: coordinatorCommit, LauncherSourceCommit: *launcherSourceCommit, LauncherSourceTree: *launcherSourceTree, AdmissionSHA256: digests[0], PermissionManifestSHA256: digests[1], LiveProfileSHA256: digests[2], TerminalProfileSHA256: digests[3], Launcher: launcher, Admission: contents[0], PermissionManifest: contents[1], LiveProfile: contents[2], TerminalProfile: contents[3], TerminalEntryPoint: contents[4], RuntimeClosure: runtimeClosure, RuntimeClosureSHA256: *runtimeClosureSHA256, ToolchainIdentity: toolchainIdentity, OperatorPassphrase: passphrase})
	if err != nil {
		fail(errorCode(err))
	}
	emit(map[string]any{"schemaVersion": 1, "installed": true, "installationId": installed.InstallationID, "environmentId": installed.EnvironmentID, "launcherSha256": installed.LauncherSHA256, "cloudMutation": false, "cloudCredentialReceipt": false, "operatorAuthorizationInitialized": true, "next": []string{"enroll the seven closed credential slots through the attended prompt", "record a fresh signed billing observation", "import and authorize one exact deployment plan"}})
}

func authorize(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("authorize", flag.ContinueOnError)
	planPath := flags.String("plan", "", "exact plan file")
	output := flags.String("output", "", "new authorization output")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *planPath == "" || *output == "" {
		fail("E_ARGUMENTS")
	}
	planData, err := readBounded(*planPath)
	if err != nil {
		fail(errorCode(err))
	}
	plan, err := control.ParsePlanCandidate(planData)
	if err != nil {
		fail(errorCode(err))
	}
	installation, err := control.NewStore(stateRoot()).LoadInstallation()
	if err != nil {
		fail(errorCode(err))
	}
	if err := control.ValidatePlanCandidate(plan, installation, time.Now().UTC()); err != nil {
		fail(errorCode(err))
	}
	emit(map[string]any{"schemaVersion": 1, "authorizationPreview": true, "planSha256": control.SHA256(planData), "kind": plan.Kind, "accountId": plan.AccountID, "environmentId": plan.EnvironmentID, "workerName": plan.WorkerName, "profileSha256": plan.ProfileSHA256, "observablePrestateSha256": plan.ObservablePrestateSHA256, "observationId": plan.ObservationID, "expiresAt": plan.ExpiresAt, "operations": plan.Operations, "rollbackActions": plan.RollbackActions})
	confirmation, err := control.ReadSecretFromTTY(fmt.Sprintf("Authorize %s plan %s for %s? Type AUTHORIZE: ", plan.Kind, control.SHA256(planData), plan.WorkerName))
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(confirmation)
	if string(confirmation) != "AUTHORIZE" {
		fail("E_OWNER_REJECTED")
	}
	passphrase, err := control.ReadSecretFromTTY("Operator authorization passphrase: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(passphrase)
	authorization, err := control.NewStore(stateRoot()).SignAuthorization(planData, plan, time.Now().UTC(), passphrase)
	if err != nil {
		fail(errorCode(err))
	}
	writeNew(*output, authorization)
	emit(map[string]any{"schemaVersion": 1, "authorized": true, "planSha256": control.SHA256(planData), "kind": plan.Kind, "secretValuesPresent": false})
}

func buildPlan(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("plan-build", flag.ContinueOnError)
	kind := flags.String("kind", "", "closed plan kind")
	statePath := flags.String("state", "", "exact state observation")
	observationID := flags.String("observation-id", "", "billing observation identity")
	slotsPath := flags.String("slots", "", "nonsecret slot/version map")
	accountSubdomain := flags.String("account-subdomain", "", "one-time account workers.dev subdomain")
	rollbackVersion := flags.String("rollback-version", "", "exact rollback version")
	providerZero := flags.String("provider-zero-sha256", "", "signed provider-zero evidence digest")
	tombstone := flags.String("retirement-tombstone-sha256", "", "retirement tombstone digest")
	freezeID := flags.String("acquisition-freeze-id", "", "signed acquisition freeze identity")
	revocationID := flags.String("launcher-revocation-id", "", "launcher credential revocation identity")
	output := flags.String("output", "", "new plan output")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *kind == "" || *statePath == "" || *observationID == "" || *output == "" {
		fail("E_ARGUMENTS")
	}
	stateData, err := readBounded(*statePath)
	if err != nil {
		fail(errorCode(err))
	}
	state, err := control.ParseStateObservationCandidate(stateData)
	if err != nil {
		fail(errorCode(err))
	}
	slots := map[string]control.SlotReference{}
	if *slotsPath != "" {
		data, readErr := readBounded(*slotsPath)
		var parseErr error
		slots, parseErr = control.ParseSlotReferences(data)
		if readErr != nil || parseErr != nil {
			fail("E_PLAN_BUILD_SLOT")
		}
	}
	installation, err := control.NewStore(stateRoot()).LoadInstallation()
	if err != nil {
		fail(errorCode(err))
	}
	plan, err := control.BuildPlan(installation, control.PlanBuildInput{Kind: *kind, State: state, ObservationID: *observationID, Slots: slots, AccountSubdomain: *accountSubdomain, RollbackVersionID: *rollbackVersion, ProviderZeroSHA256: *providerZero, RetirementTombstoneSHA256: *tombstone, AcquisitionFreezeID: *freezeID, LauncherCredentialRevocationID: *revocationID, Now: time.Now().UTC()})
	if err != nil {
		fail(errorCode(err))
	}
	writeNew(*output, plan)
	data, _ := json.MarshalIndent(plan, "", "  ")
	data = append(data, '\n')
	emit(map[string]any{"schemaVersion": 1, "planBuilt": true, "kind": plan.Kind, "planSha256": control.SHA256(data), "operations": plan.Operations, "expiresAt": plan.ExpiresAt, "cloudMutation": false})
}

func signObservation(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("observation-admit", flag.ContinueOnError)
	observationPath := flags.String("observation", "", "billing/product observation")
	output := flags.String("output", "", "new attestation output")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *observationPath == "" || *output == "" {
		fail("E_ARGUMENTS")
	}
	data, err := readBounded(*observationPath)
	if err != nil {
		fail(errorCode(err))
	}
	observation, err := control.ParseObservationCandidate(data)
	if err != nil {
		fail(errorCode(err))
	}
	installation, err := control.NewStore(stateRoot()).LoadInstallation()
	if err != nil {
		fail(errorCode(err))
	}
	if err := control.ValidateObservationCandidate(observation, installation, time.Now().UTC()); err != nil {
		fail(errorCode(err))
	}
	emit(map[string]any{"schemaVersion": 1, "observationPreview": true, "observationSha256": control.SHA256(data), "accountId": observation.AccountID, "workersPlan": observation.WorkersPlan, "paidOrOverageEnabled": observation.PaidOrOverageEnabled, "allAccountConsumersIncluded": observation.AllAccountConsumersIncluded, "quotas": observation.Quotas, "observedAt": observation.ObservedAt, "expiresAt": observation.ExpiresAt})
	confirmation, err := control.ReadSecretFromTTY(fmt.Sprintf("Confirm independent Free/no-overage observation %s for %s? Type OBSERVED: ", observation.ObservationID, observation.AccountID))
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(confirmation)
	if string(confirmation) != "OBSERVED" {
		fail("E_OWNER_REJECTED")
	}
	passphrase, err := control.ReadSecretFromTTY("Billing observation authorization passphrase: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(passphrase)
	attestation, err := control.NewStore(stateRoot()).SignObservation(data, observation, time.Now().UTC(), passphrase)
	if err != nil {
		fail(errorCode(err))
	}
	writeNew(*output, attestation)
	emit(map[string]any{"schemaVersion": 1, "observationAdmitted": true, "observationId": observation.ObservationID, "secretValuesPresent": false})
}

func admitRetirementEvidence(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("retirement-evidence-admit", flag.ContinueOnError)
	evidencePath := flags.String("evidence", "", "exact independently produced zero-state evidence")
	output := flags.String("output", "", "new signed evidence output")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *evidencePath == "" || *output == "" {
		fail("E_ARGUMENTS")
	}
	data, err := readBounded(*evidencePath)
	if err != nil {
		fail(errorCode(err))
	}
	evidence, err := control.ParseRetirementEvidenceCandidate(data)
	if err != nil {
		fail("E_RETIREMENT_EVIDENCE_SCHEMA")
	}
	emit(map[string]any{"schemaVersion": 1, "retirementEvidencePreview": true, "accountId": evidence.AccountID, "environmentId": evidence.EnvironmentID, "workerName": evidence.WorkerName, "providerServers": evidence.ProviderServers, "providerKeys": evidence.ProviderKeys, "coordinatorLeases": evidence.CoordinatorLeases, "unresolvedCreates": evidence.UnresolvedCreates, "providerObservationSha256": evidence.ProviderObservationSHA256, "coordinatorObservationSha256": evidence.CoordinatorObservationSHA256, "retirementTombstoneSha256": evidence.RetirementTombstoneSHA256, "expiresAt": evidence.ExpiresAt})
	confirmation, err := control.ReadSecretFromTTY("Admit these exact retirement prerequisites? Type RETIRE: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(confirmation)
	if string(confirmation) != "RETIRE" {
		fail("E_OWNER_REJECTED")
	}
	passphrase, err := control.ReadSecretFromTTY("Recovery authorization passphrase: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(passphrase)
	signed, err := control.NewStore(stateRoot()).SignRetirementEvidence(evidence, time.Now().UTC(), passphrase)
	if err != nil {
		fail(errorCode(err))
	}
	writeNew(*output, signed)
	emit(map[string]any{"schemaVersion": 1, "retirementEvidenceAdmitted": true, "secretValuesPresent": false})
}

func enrollSecret(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("secret-enroll", flag.ContinueOnError)
	role := flags.String("role", "", "closed credential role")
	slot := flags.String("slot", "", "opaque slot identity")
	version := flags.String("version", "", "immutable slot version")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		fail("E_ARGUMENTS")
	}
	first, err := confirmedSecret("Enter secret value: ", "Re-enter secret value: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(first)
	installation, err := control.NewStore(stateRoot()).LoadInstallation()
	if err != nil {
		fail(errorCode(err))
	}
	metadata, err := control.NewStore(stateRoot()).EnrollCredential(installation.EnvironmentID, *role, *slot, *version, first, time.Now().UTC())
	if err != nil {
		fail(errorCode(err))
	}
	emit(map[string]any{"schemaVersion": 1, "enrolled": true, "role": metadata.Role, "slotId": metadata.SlotID, "slotVersion": metadata.SlotVersion, "secretValuePresent": false})
}

func applyPlan(args []string, retirement bool) {
	startedAt := time.Now().UTC()
	commandContext, cancel := context.WithDeadline(context.Background(), startedAt.Add(10*time.Minute))
	defer cancel()
	requireRoot()
	flags := flag.NewFlagSet("apply", flag.ContinueOnError)
	planPath := flags.String("plan", "", "exact plan")
	authorizationPath := flags.String("authorization", "", "installed-root authorization")
	observationPath := flags.String("observation", "", "billing observation")
	attestationPath := flags.String("observation-attestation", "", "billing attestation")
	retirementEvidencePath := flags.String("retirement-evidence", "", "signed independent retirement prerequisites")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		fail("E_ARGUMENTS")
	}
	paths := []*string{planPath, authorizationPath, observationPath, attestationPath}
	values := make([][]byte, len(paths))
	for index, path := range paths {
		value, err := readBounded(*path)
		if err != nil {
			fail(errorCode(err))
		}
		values[index] = value
	}
	var retirementEvidence []byte
	if retirement {
		if *retirementEvidencePath == "" {
			fail("E_RETIREMENT_EVIDENCE_REQUIRED")
		}
		var readErr error
		retirementEvidence, readErr = readBounded(*retirementEvidencePath)
		if readErr != nil {
			fail(errorCode(readErr))
		}
	} else if *retirementEvidencePath != "" {
		fail("E_RETIREMENT_SCOPE")
	}
	plan, err := control.ParsePlanCandidate(values[0])
	if err != nil {
		fail(errorCode(err))
	}
	if retirement != (plan.Kind == "retire") {
		fail("E_COMMAND_PLAN_KIND")
	}
	installation, err := control.NewStore(stateRoot()).LoadInstallation()
	if err != nil {
		fail(errorCode(err))
	}
	executor := control.CommandExecutor{AccountID: installation.AccountID, ExecutorUID: installation.ExecutorUID, ProtectedRoot: filepath.Join(stateRoot(), "toolchain"), Installation: installation, ProfilePath: filepath.Join(stateRoot(), "policy", "wrangler.live.jsonc"), ProfileSHA256: installation.LiveProfileSHA256, TerminalProfilePath: filepath.Join(stateRoot(), "policy", "wrangler.terminal.jsonc"), TerminalProfileSHA256: installation.TerminalProfileSHA256, TerminalEntryPointPath: filepath.Join(stateRoot(), "policy", "terminal-worker.agentscope.mjs"), TerminalEntryPointSHA256: installation.TerminalEntryPointSHA256, RuntimeHome: filepath.Join(stateRoot(), "runtime"), Timeout: 5 * time.Minute}
	input := control.ApplyInput{PlanData: values[0], AuthorizationData: values[1], ObservationData: values[2], AttestationData: values[3], RetirementEvidenceData: retirementEvidence, Now: time.Now().UTC()}
	observer := control.CloudflareObserver{AccountID: installation.AccountID}
	if err := commandContext.Err(); err != nil {
		fail("E_COMMAND_DEADLINE")
	}
	if err := control.NewStore(stateRoot()).Apply(commandContext, input, executor, observer); err != nil {
		fail(errorCode(err))
	}
	emit(map[string]any{"schemaVersion": 1, "applied": true, "planSha256": control.SHA256(values[0]), "secretValuesPresent": false})
}

func status() {
	store := control.NewStore(stateRoot())
	installation, err := store.LoadInstallation()
	if err != nil {
		fail(errorCode(err))
	}
	_, fenceErr := os.Lstat(filepath.Join(stateRoot(), "journal", "mutation.lock"))
	entries, _ := os.ReadDir(filepath.Join(stateRoot(), "slots"))
	_, credentialsErr := store.CredentialSetSHA256()
	emit(map[string]any{"schemaVersion": 1, "installationId": installation.InstallationID, "environmentId": installation.EnvironmentID, "accountId": installation.AccountID, "workerName": installation.WorkerName, "enrolledSlotCount": len(entries), "credentialSetComplete": credentialsErr == nil, "mutationFenceHeld": fenceErr == nil, "acquisitionFrozen": store.IsFrozen(), "cloudAuthenticated": false, "billingObservationReady": false, "deploymentReady": false, "nextHumanSteps": []string{"authenticate the approved personal Cloudflare account through the installed launcher", "enroll the closed credential slots", "confirm and admit an independent Free/no-overage observation", "review and authorize the exact deployment plan"}})
}

func observeState(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("state-observe", flag.ContinueOnError)
	output := flags.String("output", "", "optional new raw state observation file")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		fail("E_ARGUMENTS")
	}
	store := control.NewStore(stateRoot())
	installation, err := store.LoadInstallation()
	if err != nil {
		fail(errorCode(err))
	}
	credential, err := store.ResolveCredential("cloudflare-plan-read")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(credential)
	now := time.Now().UTC()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	observation, err := (control.CloudflareObserver{AccountID: installation.AccountID}).Observe(ctx, credential, now)
	if err != nil {
		fail(errorCode(err))
	}
	if *output != "" {
		writeNew(*output, observation)
	}
	stateDigest, identityDigest, err := observation.Digests()
	if err != nil {
		fail("E_OBSERVER_OUTPUT")
	}
	emit(map[string]any{"schemaVersion": 1, "stateObservation": observation, "stateSha256": stateDigest, "identitySha256": identityDigest, "secretValuesPresent": false})
}

func freeze(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("freeze", flag.ContinueOnError)
	reason := flags.String("reason", "", "stable content-free reason code")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *reason == "" {
		fail("E_ARGUMENTS")
	}
	passphrase, err := control.ReadSecretFromTTY("Recovery authorization passphrase: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(passphrase)
	record, err := control.NewStore(stateRoot()).Freeze(*reason, time.Now().UTC(), passphrase)
	if err != nil {
		fail(errorCode(err))
	}
	emit(map[string]any{"schemaVersion": 1, "frozen": true, "reason": record.RequestID, "secretValuesPresent": false})
}

func recoverQuarantine(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("recover-quarantine", flag.ContinueOnError)
	planDigest := flags.String("plan-sha256", "", "consumed plan digest")
	requestID := flags.String("request-id", "", "uncertain request identity")
	evidenceDigest := flags.String("evidence-sha256", "", "independent reconciliation evidence digest")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		fail("E_ARGUMENTS")
	}
	confirmation, err := control.ReadSecretFromTTY("Quarantine this uncertain mutation without replay? Type QUARANTINE: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(confirmation)
	if string(confirmation) != "QUARANTINE" {
		fail("E_OWNER_REJECTED")
	}
	passphrase, err := control.ReadSecretFromTTY("Recovery authorization passphrase: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(passphrase)
	record, err := control.NewStore(stateRoot()).RecoverQuarantine(*planDigest, *requestID, *evidenceDigest, time.Now().UTC(), passphrase)
	if err != nil {
		fail(errorCode(err))
	}
	emit(map[string]any{"schemaVersion": 1, "quarantined": true, "planSha256": record.PlanSHA256, "requestId": record.RequestID, "mutationRetried": false})
}

func recoverResolve(args []string) {
	requireRoot()
	flags := flag.NewFlagSet("recover-resolve", flag.ContinueOnError)
	planDigest := flags.String("plan-sha256", "", "quarantined plan digest")
	requestID := flags.String("request-id", "", "uncertain request identity")
	evidenceDigest := flags.String("evidence-sha256", "", "independent terminal reconciliation evidence digest")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		fail("E_ARGUMENTS")
	}
	confirmation, err := control.ReadSecretFromTTY("Resolve this quarantine as abandoned, retain acquisition freeze, and release only the local fence? Type RESOLVED: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(confirmation)
	if string(confirmation) != "RESOLVED" {
		fail("E_OWNER_REJECTED")
	}
	passphrase, err := control.ReadSecretFromTTY("Recovery authorization passphrase: ")
	if err != nil {
		fail(errorCode(err))
	}
	defer zero(passphrase)
	record, err := control.NewStore(stateRoot()).ResolveQuarantine(*planDigest, *requestID, *evidenceDigest, time.Now().UTC(), passphrase)
	if err != nil {
		fail(errorCode(err))
	}
	emit(map[string]any{"schemaVersion": 1, "resolved": true, "planSha256": record.PlanSHA256, "acquisitionFrozen": true, "mutationRetried": false})
}

func writeNew(path string, value any) {
	data, _ := json.MarshalIndent(value, "", "  ")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		fail("E_OUTPUT_FILE")
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		fail("E_OUTPUT_FILE")
	}
	if _, err := file.Write(append(data, '\n')); err != nil || file.Sync() != nil {
		fail("E_OUTPUT_FILE")
	}
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
func equal(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	result := byte(0)
	for index := range left {
		result |= left[index] ^ right[index]
	}
	return result == 0
}

func confirmedSecret(firstPrompt, secondPrompt string) ([]byte, error) {
	first, err := control.ReadSecretFromTTY(firstPrompt)
	if err != nil {
		return nil, err
	}
	second, err := control.ReadSecretFromTTY(secondPrompt)
	if err != nil {
		zero(first)
		return nil, err
	}
	defer zero(second)
	if !equal(first, second) {
		zero(first)
		return nil, errors.New("E_SECRET_CONFIRMATION")
	}
	return first, nil
}

func errorCode(err error) string {
	value := err.Error()
	if strings.HasPrefix(value, "E_") {
		if index := strings.IndexAny(value, ": "); index > 0 {
			return value[:index]
		}
		return value
	}
	return "E_INTERNAL"
}

func main() {
	if len(os.Args) < 2 {
		fail("E_COMMAND")
	}
	if os.Args[1] != "install" {
		verifyInstalledExecutable()
	}
	switch os.Args[1] {
	case "install":
		install(os.Args[2:])
	case "status":
		status()
	case "state-observe":
		observeState(os.Args[2:])
	case "plan-build":
		buildPlan(os.Args[2:])
	case "authorize":
		authorize(os.Args[2:])
	case "observation-admit":
		signObservation(os.Args[2:])
	case "retirement-evidence-admit":
		admitRetirementEvidence(os.Args[2:])
	case "credential-enroll":
		enrollSecret(os.Args[2:])
	case "apply":
		applyPlan(os.Args[2:], false)
	case "retire":
		applyPlan(os.Args[2:], true)
	case "freeze":
		freeze(os.Args[2:])
	case "recover-quarantine":
		recoverQuarantine(os.Args[2:])
	case "recover-resolve":
		recoverResolve(os.Args[2:])
	default:
		fail("E_COMMAND")
	}
}

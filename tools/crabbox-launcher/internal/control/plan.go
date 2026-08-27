package control

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

type SlotReference struct {
	SlotID      string `json:"slotId"`
	SlotVersion string `json:"slotVersion"`
}

type PlanBuildInput struct {
	Kind                           string
	State                          StateObservation
	ObservationID                  string
	Slots                          map[string]SlotReference
	AccountSubdomain               string
	RollbackVersionID              string
	ProviderZeroSHA256             string
	RetirementTombstoneSHA256      string
	AcquisitionFreezeID            string
	LauncherCredentialRevocationID string
	Now                            time.Time
}

func BuildPlan(installation Installation, input PlanBuildInput) (Plan, error) {
	if input.State.AccountID != installation.AccountID || input.State.WorkerName != WorkerName || !identifierPattern.MatchString(input.ObservationID) {
		return Plan{}, errors.New("E_PLAN_BUILD_STATE")
	}
	stateDigest, _, err := input.State.Digests()
	if err != nil {
		return Plan{}, err
	}
	nonce, err := randomIdentifier("plan")
	if err != nil {
		return Plan{}, err
	}
	currentVersion := currentWorkerVersionID(input.State.Surfaces["scriptDeployments"])
	if currentVersion == "" {
		currentVersion = "absent"
	}
	namespace := currentNamespaceID(input.State.Surfaces["durableObjects"])
	if namespace == "" {
		namespace = "absent"
	}
	migration := currentMigrationTag(input.State.Surfaces["workerSettings"])
	if migration == "" {
		migration = "absent"
	}
	if currentVersion != "absent" && (namespace == "absent" || migration == "absent") {
		return Plan{}, errors.New("E_PLAN_BUILD_RESOURCE_IDENTITY")
	}
	profile := installation.LiveProfileSHA256
	if input.Kind == "retire" {
		profile = installation.TerminalProfileSHA256
	}
	plan := Plan{
		SchemaVersion: SchemaVersion, Kind: input.Kind, AccountID: installation.AccountID, EnvironmentID: installation.EnvironmentID, WorkerName: WorkerName,
		SourceCommit: installation.CoordinatorCommit, ToolchainIdentity: installation.ToolchainIdentity, AdmissionSHA256: installation.AdmissionSHA256,
		PermissionManifestSHA256: installation.PermissionManifestSHA256, ProfileSHA256: profile, ObservablePrestateSHA256: stateDigest, ObservationID: input.ObservationID,
		CurrentWorkerVersionID: currentVersion, DurableObjectNamespaceID: namespace, CurrentMigrationTag: migration, HetznerProjectID: installation.HetznerProjectID,
		IssuedAt: input.Now.UTC(), ExpiresAt: input.Now.UTC().Add(10 * time.Minute), Nonce: nonce,
	}
	request := func(prefix string) string {
		value, randomErr := randomIdentifier(prefix)
		if randomErr != nil {
			err = randomErr
		}
		return value
	}
	switch input.Kind {
	case "deploy":
		profileCopy, previous := profile, currentVersion
		plan.Operations = append(plan.Operations, Operation{Action: "worker.deploy", Target: WorkerName, RequestID: request("deploy"), ProfileSHA256: &profileCopy, ExpectedPreviousVersionID: &previous})
		if currentVersion == "absent" {
			if err := appendSecretOperations(&plan, input.Slots, request); err != nil {
				return Plan{}, err
			}
		} else {
			if len(input.Slots) != 0 {
				return Plan{}, errors.New("E_PLAN_BUILD_UNEXPECTED_SLOT")
			}
			if !compatibleCoordinatorVersion(input.State.Surfaces["rollbackVersionDetail"], currentVersion, migration, namespace, installation.CoordinatorCommit) {
				return Plan{}, errors.New("E_PLAN_BUILD_VERSION_COMPATIBILITY")
			}
			version, tag := currentVersion, migration
			plan.RollbackActions = []Operation{{Action: "worker.rollback", Target: WorkerName, RequestID: request("rollback"), VersionID: &version, CompatibleMigrationTag: &tag}}
		}
	case "rotate-secrets":
		if currentVersion == "absent" {
			return Plan{}, errors.New("E_PLAN_BUILD_WORKER_ABSENT")
		}
		if err := appendSecretOperations(&plan, input.Slots, request); err != nil {
			return Plan{}, err
		}
	case "rollback":
		if !identifierPattern.MatchString(input.RollbackVersionID) || input.RollbackVersionID == "latest" {
			return Plan{}, errors.New("E_PLAN_BUILD_VERSION")
		}
		detail, ok := input.State.Surfaces["rollbackVersionDetail"].(map[string]any)
		if !ok || !compatibleCoordinatorVersion(detail, input.RollbackVersionID, migration, namespace, installation.CoordinatorCommit) {
			return Plan{}, errors.New("E_PLAN_BUILD_VERSION_COMPATIBILITY")
		}
		version, tag := input.RollbackVersionID, migration
		plan.Operations = []Operation{{Action: "worker.rollback", Target: WorkerName, RequestID: request("rollback"), VersionID: &version, CompatibleMigrationTag: &tag}}
	case "account-workers-dev-enable":
		if input.AccountSubdomain == "" || (!surfaceAbsent(input.State.Surfaces["accountWorkersDev"]) && mapString(input.State.Surfaces["accountWorkersDev"], "subdomain") != "") {
			return Plan{}, errors.New("E_PLAN_BUILD_SUBDOMAIN")
		}
		subdomain := input.AccountSubdomain
		plan.Operations = []Operation{{Action: "account.workersDev.enable", Target: installation.AccountID, RequestID: request("account-workers-dev"), Subdomain: &subdomain}}
	case "retire":
		if len(input.Slots) != len(canonicalSecrets) {
			return Plan{}, errors.New("E_PLAN_BUILD_SLOT")
		}
		for _, value := range []string{input.ProviderZeroSHA256, input.RetirementTombstoneSHA256} {
			if !digestPattern.MatchString(value) {
				return Plan{}, errors.New("E_PLAN_BUILD_RETIREMENT")
			}
		}
		if !identifierPattern.MatchString(input.AcquisitionFreezeID) || !identifierPattern.MatchString(input.LauncherCredentialRevocationID) {
			return Plan{}, errors.New("E_PLAN_BUILD_RETIREMENT")
		}
		plan.ProviderZeroSHA256, plan.RetirementTombstoneSHA256 = pointerString(input.ProviderZeroSHA256), pointerString(input.RetirementTombstoneSHA256)
		plan.AcquisitionFreezeID, plan.LauncherCredentialRevocationID = pointerString(input.AcquisitionFreezeID), pointerString(input.LauncherCredentialRevocationID)
		plan.Operations = []Operation{{Action: "worker.schedule.delete", Target: WorkerName, RequestID: request("schedule-delete")}, {Action: "worker.scriptWorkersDev.disable", Target: WorkerName, RequestID: request("workers-dev-disable")}}
		for _, secret := range canonicalSecrets {
			ref, ok := input.Slots[secret]
			if !ok {
				return Plan{}, errors.New("E_PLAN_BUILD_SLOT")
			}
			secretCopy, slot, version := secret, ref.SlotID, ref.SlotVersion
			plan.Operations = append(plan.Operations, Operation{Action: "worker.secret.delete", Target: WorkerName, RequestID: request("secret-delete"), SecretName: &secretCopy, SlotID: &slot, SlotVersion: &version})
		}
		profileCopy, entry, zero, tombstone := profile, installation.TerminalEntryPointSHA256, input.ProviderZeroSHA256, input.RetirementTombstoneSHA256
		plan.Operations = append(plan.Operations, Operation{Action: "worker.terminalArtifact.deploy", Target: WorkerName, RequestID: request("terminal-deploy"), ProfileSHA256: &profileCopy, EntryPointSHA256: &entry, ProviderZeroSHA256: &zero, RetirementTombstoneSHA256: &tombstone})
		for _, versionID := range versionIDs(input.State.Surfaces["scriptVersions"]) {
			if versionID == currentVersion {
				continue
			}
			version := versionID
			plan.Operations = append(plan.Operations, Operation{Action: "worker.version.delete", Target: WorkerName, RequestID: request("version-delete"), VersionID: &version})
		}
		plan.Operations = append(plan.Operations, Operation{Action: "worker.delete", Target: WorkerName, RequestID: request("worker-delete")})
	default:
		return Plan{}, errors.New("E_PLAN_BUILD_KIND")
	}
	if err != nil {
		return Plan{}, err
	}
	plan.IntendedTerminalStateSHA256 = terminalContractSHA256(plan)
	if err := ValidatePlanCandidate(plan, installation, input.Now); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

func compatibleCoordinatorVersion(raw any, versionID, migration, namespace, sourceCommit string) bool {
	detail, ok := raw.(map[string]any)
	if !ok || fmt.Sprint(detail["id"]) != versionID || currentMigrationTag(detail) != migration || !bindingPresent(detail, "FLEET", "FleetDurableObject", namespace) {
		return false
	}
	annotations, ok := detail["annotations"].(map[string]any)
	return ok && fmt.Sprint(annotations["workers/message"]) == "agentscope-source:"+sourceCommit
}

func appendSecretOperations(plan *Plan, slots map[string]SlotReference, request func(string) string) error {
	if len(slots) != len(canonicalSecrets) {
		return errors.New("E_PLAN_BUILD_SLOT")
	}
	for _, secret := range canonicalSecrets {
		ref, ok := slots[secret]
		if !ok || !identifierPattern.MatchString(ref.SlotID) || !identifierPattern.MatchString(ref.SlotVersion) {
			return errors.New("E_PLAN_BUILD_SLOT")
		}
		secretCopy, slot, version := secret, ref.SlotID, ref.SlotVersion
		plan.Operations = append(plan.Operations, Operation{Action: "worker.secret.put", Target: WorkerName, RequestID: request("put"), SecretName: &secretCopy, SlotID: &slot, SlotVersion: &version})
	}
	return nil
}

func randomIdentifier(prefix string) (string, error) {
	value := make([]byte, 12)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%s", prefix, hex.EncodeToString(value)), nil
}

func pointerString(value string) *string { return &value }

func currentDeploymentID(value any) string {
	if item, ok := value.(map[string]any); ok {
		if id := fmt.Sprint(item["id"]); id != "" && id != "<nil>" {
			return id
		}
		if deployments, ok := item["deployments"].([]any); ok && len(deployments) > 0 {
			if first, ok := deployments[0].(map[string]any); ok {
				return fmt.Sprint(first["id"])
			}
		}
	}
	return ""
}

func currentWorkerVersionID(value any) string {
	item, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	deployments := objectSlice(item["deployments"])
	if len(deployments) > 0 {
		item = deployments[0]
	}
	versions := objectSlice(item["versions"])
	if len(versions) != 1 || fmt.Sprint(versions[0]["percentage"]) != "100" {
		return ""
	}
	return fmt.Sprint(versions[0]["version_id"])
}

func currentNamespaceID(value any) string {
	for _, item := range objectSlice(value) {
		if fmt.Sprint(item["script"]) == WorkerName && fmt.Sprint(item["class"]) == "FleetDurableObject" {
			return fmt.Sprint(item["id"])
		}
	}
	return ""
}

func currentMigrationTag(value any) string {
	settings, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	if tag := fmt.Sprint(settings["migration_tag"]); tag != "" && tag != "<nil>" {
		return tag
	}
	if migration, ok := settings["migrations"].(map[string]any); ok {
		if tag := fmt.Sprint(migration["new_tag"]); tag != "" && tag != "<nil>" {
			return tag
		}
	}
	if migrations := objectSlice(settings["migrations"]); len(migrations) > 0 {
		return fmt.Sprint(migrations[len(migrations)-1]["tag"])
	}
	return ""
}

func versionIDs(value any) []string {
	result := []string{}
	for _, item := range objectSlice(value) {
		if id := fmt.Sprint(item["id"]); identifierPattern.MatchString(id) {
			result = append(result, id)
		}
	}
	return result
}

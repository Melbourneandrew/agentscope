package control

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var canonicalSecrets = []string{"CRABBOX_ADMIN_TOKEN", "CRABBOX_SHARED_TOKEN", "HETZNER_TOKEN"}

func ValidatePlan(data []byte, authorizationData []byte, installation Installation, credentialSetSHA256 string, now time.Time) (Plan, error) {
	var plan Plan
	if err := strictJSON(data, &plan); err != nil {
		return plan, err
	}
	var authorization Authorization
	if err := strictJSON(authorizationData, &authorization); err != nil {
		return plan, err
	}
	if authorization.Signature == "" {
		return plan, errors.New("E_AUTHORIZATION_SIGNATURE")
	}
	signature := authorization.Signature
	authorization.Signature = ""
	payload, _ := signaturePayload(authorization)
	role := OwnerRole
	domain := AuthorizationDomain
	if plan.Kind == "retire" {
		role = RecoveryRole
		domain = RetirementAuthorizationDomain
	}
	if err := verifyDetached(installation.Roots[role], role, signature, payload); err != nil {
		return plan, err
	}
	if authorization.SchemaVersion != SchemaVersion || authorization.Domain != domain || authorization.InstallationID != installation.InstallationID || authorization.EnvironmentID != installation.EnvironmentID || authorization.PlanSHA256 != SHA256(data) || authorization.CredentialSetSHA256 != credentialSetSHA256 || authorization.Nonce != plan.Nonce || authorization.KeyID != installation.Roots[role].KeyID {
		return plan, errors.New("E_AUTHORIZATION_BINDING")
	}
	if authorization.IssuedAt.After(now) || authorization.ExpiresAt.Before(now) || authorization.ExpiresAt.After(plan.ExpiresAt) {
		return plan, errors.New("E_AUTHORIZATION_STALE")
	}
	if err := validatePlanIdentity(plan, installation, now); err != nil {
		return plan, err
	}
	if err := validateSequence(plan, installation); err != nil {
		return plan, err
	}
	return plan, nil
}

func ValidateRetirementEvidence(data []byte, plan Plan, installation Installation, now time.Time) (RetirementEvidence, error) {
	var evidence RetirementEvidence
	if err := strictJSON(data, &evidence); err != nil {
		return evidence, err
	}
	signature := evidence.Signature
	evidence.Signature = ""
	payload, _ := signaturePayload(evidence)
	if signature == "" || verifyDetached(installation.Roots[RecoveryRole], RecoveryRole, signature, payload) != nil {
		return evidence, errors.New("E_RETIREMENT_EVIDENCE_SIGNATURE")
	}
	if _, err := base64.StdEncoding.Strict().DecodeString(signature); err != nil {
		return evidence, errors.New("E_RETIREMENT_EVIDENCE_SIGNATURE")
	}
	if evidence.SchemaVersion != SchemaVersion || evidence.Domain != RetirementEvidenceDomain || evidence.InstallationID != installation.InstallationID || evidence.EnvironmentID != installation.EnvironmentID || evidence.AccountID != installation.AccountID || evidence.HetznerProjectID != installation.HetznerProjectID || evidence.WorkerName != WorkerName || evidence.WorkerVersionID != plan.CurrentWorkerVersionID || evidence.DurableObjectNamespaceID != plan.DurableObjectNamespaceID || evidence.MigrationTag != plan.CurrentMigrationTag || plan.AcquisitionFreezeID == nil || evidence.AcquisitionFreezeID != *plan.AcquisitionFreezeID || plan.LauncherCredentialRevocationID == nil || evidence.LauncherCredentialRevocationID != *plan.LauncherCredentialRevocationID || plan.ProviderZeroSHA256 == nil || evidence.ProviderObservationSHA256 != *plan.ProviderZeroSHA256 || plan.RetirementTombstoneSHA256 == nil || evidence.RetirementTombstoneSHA256 != *plan.RetirementTombstoneSHA256 {
		return evidence, errors.New("E_RETIREMENT_EVIDENCE_BINDING")
	}
	if evidence.ProviderServers != 0 || evidence.ProviderKeys != 0 || evidence.CoordinatorLeases != 0 || evidence.UnresolvedCreates != 0 || !digestPattern.MatchString(evidence.ProviderObservationSHA256) || !digestPattern.MatchString(evidence.CoordinatorObservationSHA256) || !digestPattern.MatchString(evidence.RetirementTombstoneSHA256) || evidence.ObservedAt.After(now) || evidence.ExpiresAt.Before(now) || evidence.ExpiresAt.Sub(evidence.ObservedAt) > 15*time.Minute {
		return evidence, errors.New("E_RETIREMENT_EVIDENCE_STATE")
	}
	return evidence, nil
}

func ValidatePlanCandidate(plan Plan, installation Installation, now time.Time) error {
	if err := validatePlanIdentity(plan, installation, now); err != nil {
		return err
	}
	return validateSequence(plan, installation)
}

func validatePlanIdentity(plan Plan, installation Installation, now time.Time) error {
	if plan.SchemaVersion != SchemaVersion || plan.AccountID != installation.AccountID || plan.EnvironmentID != installation.EnvironmentID || plan.WorkerName != installation.WorkerName || plan.HetznerProjectID != installation.HetznerProjectID || plan.AdmissionSHA256 != installation.AdmissionSHA256 || plan.PermissionManifestSHA256 != installation.PermissionManifestSHA256 || !identifierPattern.MatchString(plan.Nonce) {
		return errors.New("E_PLAN_IDENTITY")
	}
	if plan.SourceCommit != installation.CoordinatorCommit || !identifierPattern.MatchString(plan.ObservationID) || !identifierPattern.MatchString(plan.CurrentWorkerVersionID) || !identifierPattern.MatchString(plan.DurableObjectNamespaceID) || !identifierPattern.MatchString(plan.CurrentMigrationTag) {
		return errors.New("E_PLAN_RESOURCE_IDENTITY")
	}
	expectedProfile := installation.LiveProfileSHA256
	if plan.Kind == "retire" {
		expectedProfile = installation.TerminalProfileSHA256
	}
	if plan.ProfileSHA256 != expectedProfile {
		return errors.New("E_PLAN_PROFILE")
	}
	if plan.ToolchainIdentity != installation.ToolchainIdentity {
		return errors.New("E_PLAN_TOOLCHAIN")
	}
	if plan.IssuedAt.After(now) || plan.ExpiresAt.Before(now) || plan.ExpiresAt.Sub(plan.IssuedAt) > 15*time.Minute {
		return errors.New("E_PLAN_STALE")
	}
	for _, digest := range []string{plan.ProfileSHA256, plan.ObservablePrestateSHA256, plan.IntendedTerminalStateSHA256, plan.ToolchainIdentity.NodeArchiveSHA256, plan.ToolchainIdentity.WorkerLockSHA256, plan.ToolchainIdentity.GoArchiveSHA256, plan.ToolchainIdentity.CrabboxClientSHA256} {
		if !digestPattern.MatchString(digest) {
			return errors.New("E_PLAN_DIGEST")
		}
	}
	if plan.IntendedTerminalStateSHA256 != terminalContractSHA256(plan) {
		return errors.New("E_TERMINAL_CONTRACT")
	}
	if plan.Kind == "retire" {
		if plan.ProviderZeroSHA256 == nil || plan.RetirementTombstoneSHA256 == nil || plan.AcquisitionFreezeID == nil || plan.LauncherCredentialRevocationID == nil {
			return errors.New("E_RETIREMENT_AUTHORITY")
		}
		if !digestPattern.MatchString(*plan.ProviderZeroSHA256) || !digestPattern.MatchString(*plan.RetirementTombstoneSHA256) {
			return errors.New("E_RETIREMENT_DIGEST")
		}
	} else if plan.ProviderZeroSHA256 != nil || plan.RetirementTombstoneSHA256 != nil || plan.AcquisitionFreezeID != nil || plan.LauncherCredentialRevocationID != nil {
		return errors.New("E_RETIREMENT_SCOPE")
	}
	return nil
}

func terminalContractSHA256(plan Plan) string {
	contract := map[string]any{
		"accountId":                plan.AccountID,
		"environmentId":            plan.EnvironmentID,
		"kind":                     plan.Kind,
		"permissionManifestSha256": plan.PermissionManifestSHA256,
		"profileSha256":            plan.ProfileSHA256,
		"workerName":               plan.WorkerName,
	}
	if plan.Kind == "retire" {
		contract["cron"] = "absent"
		contract["durableObjectClass"] = "deleted:FleetDurableObject"
		contract["providerZeroSha256"] = plan.ProviderZeroSHA256
		contract["retirementTombstoneSha256"] = plan.RetirementTombstoneSHA256
		contract["secretNames"] = []string{}
		contract["scriptWorkersDev"] = false
		contract["worker"] = "absent"
	} else if plan.Kind == "account-workers-dev-enable" {
		subdomain := "invalid"
		if len(plan.Operations) == 1 && plan.Operations[0].Subdomain != nil {
			subdomain = *plan.Operations[0].Subdomain
		}
		contract["accountWorkersDev"] = "enabled:" + subdomain
		contract["worker"] = "unchanged"
	} else {
		contract["cron"] = "*/15 * * * *"
		contract["durableObjectBinding"] = "FLEET"
		contract["durableObjectClass"] = "FleetDurableObject"
		contract["migrationTag"] = plan.CurrentMigrationTag
		contract["secretNames"] = canonicalSecrets
		contract["scriptWorkersDev"] = true
		contract["worker"] = "present"
	}
	data, _ := json.Marshal(contract)
	return SHA256(data)
}

func validateSequence(plan Plan, installation Installation) error {
	switch plan.Kind {
	case "deploy":
		expectedRollbacks := 1
		if plan.CurrentWorkerVersionID == "absent" {
			expectedRollbacks = 0
		}
		if len(plan.Operations) != 4 || len(plan.RollbackActions) != expectedRollbacks {
			return errors.New("E_DEPLOY_SEQUENCE")
		}
		for index, secret := range canonicalSecrets {
			if err := validateSecretOperation(plan.Operations[index], "worker.secret.put", secret, plan); err != nil {
				return err
			}
		}
		deploy := plan.Operations[3]
		if deploy.Action != "worker.deploy" || deploy.Target != WorkerName || deploy.ProfileSHA256 == nil || *deploy.ProfileSHA256 != plan.ProfileSHA256 || deploy.ExpectedPreviousVersionID == nil || *deploy.ExpectedPreviousVersionID != plan.CurrentWorkerVersionID || deploy.RequestID == "" || hasUnexpectedFields(deploy, "profile") {
			return errors.New("E_DEPLOY_OPERATION")
		}
		if expectedRollbacks == 1 {
			rollback := plan.RollbackActions[0]
			if rollback.Action != "worker.rollback" || rollback.Target != WorkerName || rollback.VersionID == nil || rollback.CompatibleMigrationTag == nil || *rollback.CompatibleMigrationTag != plan.CurrentMigrationTag || hasUnexpectedFields(rollback, "rollback") {
				return errors.New("E_ROLLBACK_OPERATION")
			}
		}
	case "rollback":
		if len(plan.Operations) != 1 || len(plan.RollbackActions) != 0 || plan.Operations[0].Action != "worker.rollback" || plan.Operations[0].VersionID == nil || plan.Operations[0].CompatibleMigrationTag == nil || *plan.Operations[0].CompatibleMigrationTag != plan.CurrentMigrationTag || hasUnexpectedFields(plan.Operations[0], "rollback") {
			return errors.New("E_ROLLBACK_SEQUENCE")
		}
	case "account-workers-dev-enable":
		if len(plan.Operations) != 1 || len(plan.RollbackActions) != 0 || plan.Operations[0].Action != "account.workersDev.enable" || plan.Operations[0].Target != installation.AccountID || plan.Operations[0].Subdomain == nil || !regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`).MatchString(*plan.Operations[0].Subdomain) || hasUnexpectedFields(plan.Operations[0], "account-subdomain") {
			return errors.New("E_ACCOUNT_WORKERS_DEV_SEQUENCE")
		}
	case "retire":
		if err := validateRetirementSequence(plan, installation); err != nil {
			return err
		}
	default:
		return errors.New("E_PLAN_KIND")
	}
	seenRequests := map[string]struct{}{}
	for _, operation := range append(append([]Operation{}, plan.Operations...), plan.RollbackActions...) {
		if !identifierPattern.MatchString(operation.RequestID) {
			return errors.New("E_REQUEST_ID")
		}
		if _, exists := seenRequests[operation.RequestID]; exists {
			return errors.New("E_REQUEST_REPLAY")
		}
		seenRequests[operation.RequestID] = struct{}{}
	}
	return nil
}

func validateSecretOperation(operation Operation, action, secret string, plan Plan) error {
	if operation.Action != action || operation.Target != WorkerName || operation.SecretName == nil || *operation.SecretName != secret {
		return fmt.Errorf("E_SECRET_OPERATION_%s", secret)
	}
	if action == "worker.secret.put" {
		if operation.SlotID == nil || operation.SlotVersion == nil || !identifierPattern.MatchString(*operation.SlotID) || !identifierPattern.MatchString(*operation.SlotVersion) || hasUnexpectedFields(operation, "secret-put") {
			return fmt.Errorf("E_SECRET_OPERATION_%s", secret)
		}
	} else if operation.SlotID == nil || operation.SlotVersion == nil || !identifierPattern.MatchString(*operation.SlotID) || !identifierPattern.MatchString(*operation.SlotVersion) || hasUnexpectedFields(operation, "secret-delete") {
		return fmt.Errorf("E_SECRET_OPERATION_%s", secret)
	}
	return nil
}

func hasUnexpectedFields(operation Operation, shape string) bool {
	allowed := map[string]bool{}
	switch shape {
	case "secret-put":
		allowed["secretName"], allowed["slotId"], allowed["slotVersion"] = true, true, true
	case "secret-delete":
		allowed["secretName"], allowed["slotId"], allowed["slotVersion"] = true, true, true
	case "profile":
		allowed["profileSha256"], allowed["expectedPreviousVersionId"] = true, true
	case "rollback":
		allowed["versionId"], allowed["compatibleMigrationTag"] = true, true
	case "terminal":
		allowed["profileSha256"], allowed["entryPointSha256"], allowed["providerZeroSha256"], allowed["retirementTombstoneSha256"] = true, true, true, true
	case "version":
		allowed["versionId"] = true
	case "none":
	case "account-subdomain":
		allowed["subdomain"] = true
	default:
		return true
	}
	present := map[string]bool{
		"profileSha256": operation.ProfileSHA256 != nil, "expectedPreviousVersionId": operation.ExpectedPreviousVersionID != nil,
		"secretName": operation.SecretName != nil, "slotId": operation.SlotID != nil, "slotVersion": operation.SlotVersion != nil,
		"versionId": operation.VersionID != nil, "compatibleMigrationTag": operation.CompatibleMigrationTag != nil,
		"entryPointSha256": operation.EntryPointSHA256 != nil, "providerZeroSha256": operation.ProviderZeroSHA256 != nil,
		"retirementTombstoneSha256": operation.RetirementTombstoneSHA256 != nil,
		"subdomain":                 operation.Subdomain != nil,
	}
	for field, exists := range present {
		if exists && !allowed[field] {
			return true
		}
	}
	return false
}

func validateRetirementSequence(plan Plan, installation Installation) error {
	if len(plan.Operations) < 7 || len(plan.RollbackActions) != 0 {
		return errors.New("E_RETIREMENT_SEQUENCE")
	}
	if plan.Operations[0].Action != "worker.schedule.delete" || plan.Operations[0].Target != WorkerName || hasUnexpectedFields(plan.Operations[0], "none") || plan.Operations[1].Action != "worker.scriptWorkersDev.disable" || plan.Operations[1].Target != WorkerName || hasUnexpectedFields(plan.Operations[1], "none") {
		return errors.New("E_RETIREMENT_DRAIN_SEQUENCE")
	}
	for index, secret := range canonicalSecrets {
		if err := validateSecretOperation(plan.Operations[index+2], "worker.secret.delete", secret, plan); err != nil {
			return err
		}
	}
	terminal := plan.Operations[5]
	if terminal.Action != "worker.terminalArtifact.deploy" || terminal.Target != WorkerName || terminal.ProfileSHA256 == nil || *terminal.ProfileSHA256 != plan.ProfileSHA256 || terminal.EntryPointSHA256 == nil || *terminal.EntryPointSHA256 != installation.TerminalEntryPointSHA256 || terminal.ProviderZeroSHA256 == nil || plan.ProviderZeroSHA256 == nil || *terminal.ProviderZeroSHA256 != *plan.ProviderZeroSHA256 || terminal.RetirementTombstoneSHA256 == nil || plan.RetirementTombstoneSHA256 == nil || *terminal.RetirementTombstoneSHA256 != *plan.RetirementTombstoneSHA256 || hasUnexpectedFields(terminal, "terminal") {
		return errors.New("E_TERMINAL_DEPLOYMENT")
	}
	for _, operation := range plan.Operations[6 : len(plan.Operations)-1] {
		if operation.Action != "worker.version.delete" || operation.Target != WorkerName || operation.VersionID == nil || hasUnexpectedFields(operation, "version") {
			return errors.New("E_VERSION_DELETE")
		}
	}
	last := plan.Operations[len(plan.Operations)-1]
	if last.Action != "worker.delete" || last.Target != WorkerName || hasUnexpectedFields(last, "none") {
		return errors.New("E_WORKER_DELETE")
	}
	return nil
}

package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Invocation struct {
	Action                    string
	RequestID                 string
	SecretName                string
	Secret                    []byte
	DeploymentCredential      []byte
	VersionID                 string
	ExpectedPreviousVersionID string
	Terminal                  bool
}

type MutationReceipt struct {
	RequestID      string `json:"requestId"`
	Action         string `json:"action"`
	ResponseSHA256 string `json:"responseSha256"`
}

type Executor interface {
	Invoke(context.Context, Invocation) (MutationReceipt, error)
}

type ApplyInput struct {
	PlanData               []byte
	AuthorizationData      []byte
	ObservationData        []byte
	AttestationData        []byte
	RetirementEvidenceData []byte
	Now                    time.Time
	Clock                  func() time.Time
}

func (store Store) Apply(ctx context.Context, input ApplyInput, executor Executor, observer StateObserver) error {
	clock := input.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	installation, err := store.LoadInstallation()
	if err != nil {
		return err
	}
	credentialSetSHA256, err := store.CredentialSetSHA256()
	if err != nil {
		return err
	}
	plan, err := ValidatePlan(input.PlanData, input.AuthorizationData, installation, credentialSetSHA256, input.Now)
	if err != nil {
		return err
	}
	observation, err := ValidateObservation(input.ObservationData, input.AttestationData, installation, input.Now)
	if err != nil {
		return err
	}
	if observation.ObservationID != plan.ObservationID {
		return errors.New("E_OBSERVATION_ID")
	}
	if store.IsFrozen() && plan.Kind != "retire" {
		return errors.New("E_ACQUISITION_FROZEN")
	}
	if plan.Kind == "retire" {
		if !store.IsFrozen() || plan.AcquisitionFreezeID == nil {
			return errors.New("E_FREEZE_REQUIRED")
		}
		if err := store.VerifyFreeze(*plan.AcquisitionFreezeID); err != nil {
			return err
		}
		if _, err := ValidateRetirementEvidence(input.RetirementEvidenceData, plan, installation, input.Now); err != nil {
			return err
		}
	}
	if observer == nil {
		return errors.New("E_OBSERVER_REQUIRED")
	}
	planDigest := SHA256(input.PlanData)
	guard, err := store.acquireAdmissionGuard()
	if err != nil {
		return err
	}
	defer releaseAdmissionGuard(guard)
	if err := store.ensureNoActiveMutation(); err != nil {
		return err
	}
	previous, err := store.consumePlan(planDigest, input.Now)
	if err != nil {
		return err
	}
	fence, err := store.acquireFence(planDigest)
	if err != nil {
		return err
	}
	released := false
	defer func() {
		if !released {
			_ = fence.Close()
		}
	}()
	secrets, err := store.ResolveSecrets(plan)
	if err != nil {
		return err
	}
	defer ZeroSecrets(secrets)
	deploymentCredential, err := store.ResolveCredential("cloudflare-deployment")
	if err != nil {
		return err
	}
	defer zeroBytes(deploymentCredential)
	readCredential, err := store.ResolveCredential("cloudflare-plan-read")
	if err != nil {
		return err
	}
	defer zeroBytes(readCredential)
	authorityDeadline := plan.ExpiresAt
	if observation.ExpiresAt.Before(authorityDeadline) {
		authorityDeadline = observation.ExpiresAt
	}
	operationContext, cancel := context.WithDeadline(ctx, authorityDeadline)
	defer cancel()
	currentState, err := observer.Observe(operationContext, readCredential, clock())
	if err != nil {
		return err
	}
	currentDigest, currentIdentityDigest, err := currentState.Digests()
	if err != nil || currentDigest != plan.ObservablePrestateSHA256 {
		return errors.New("E_OBSERVABLE_PRESTATE")
	}
	for _, identity := range []string{plan.CurrentWorkerVersionID, plan.DurableObjectNamespaceID, plan.CurrentMigrationTag} {
		if identity == "absent" || identity == "none" {
			continue
		}
		if !stateContainsIdentity(currentState, identity) {
			return errors.New("E_PRESTATE_RESOURCE_IDENTITY")
		}
	}
	for _, operation := range plan.Operations {
		now := clock()
		if now.After(plan.ExpiresAt) || now.After(observation.ExpiresAt) {
			return errors.New("E_AUTHORITY_EXPIRED_DURING_APPLY")
		}
		sequence, chain, err := store.nextSequence(planDigest)
		if err != nil || chain != previous {
			return errors.New("E_JOURNAL_CHAIN")
		}
		freshState, err := observer.Observe(operationContext, readCredential, now)
		if err != nil {
			return err
		}
		freshDigest, freshIdentityDigest, err := freshState.Digests()
		if err != nil || freshDigest != currentDigest || freshIdentityDigest != currentIdentityDigest {
			return errors.New("E_REMOTE_STATE_DRIFT")
		}
		started := Event{SchemaVersion: SchemaVersion, Sequence: sequence, PlanSHA256: planDigest, RequestID: operation.RequestID, State: "invoking-uncertain", PreviousSHA256: previous, RecordedAt: now, DetailCode: "PENDING", StateSHA256: freshDigest, IdentitySHA256: freshIdentityDigest}
		previous, err = store.appendEvent(started)
		if err != nil {
			return err
		}
		invocation := Invocation{Action: operation.Action, RequestID: operation.RequestID, DeploymentCredential: deploymentCredential, Terminal: plan.Kind == "retire"}
		if operation.SecretName != nil && operation.Action == "worker.secret.put" {
			invocation.SecretName = *operation.SecretName
			invocation.Secret = secrets[*operation.SecretName]
		} else if operation.SecretName != nil {
			invocation.SecretName = *operation.SecretName
		}
		if operation.VersionID != nil {
			invocation.VersionID = *operation.VersionID
		}
		if operation.ExpectedPreviousVersionID != nil {
			invocation.ExpectedPreviousVersionID = *operation.ExpectedPreviousVersionID
		}
		receipt, err := executor.Invoke(operationContext, invocation)
		if err != nil {
			return fmt.Errorf("E_OUTCOME_UNCERTAIN: %w", err)
		}
		postTime := clock()
		if postTime.After(authorityDeadline) {
			return errors.New("E_AUTHORITY_EXPIRED_DURING_APPLY")
		}
		_, postDigest, postIdentityDigest, err := observeChangedState(operationContext, observer, readCredential, currentDigest, clock)
		if err != nil {
			return fmt.Errorf("E_OUTCOME_UNCERTAIN: %w", err)
		}
		receiptData, _ := json.Marshal(receipt)
		completed := Event{SchemaVersion: SchemaVersion, Sequence: sequence + 1, PlanSHA256: planDigest, RequestID: operation.RequestID, State: "observed-committed", PreviousSHA256: previous, RecordedAt: postTime, DetailCode: "OK", StateSHA256: postDigest, IdentitySHA256: postIdentityDigest, ReceiptSHA256: SHA256(receiptData)}
		previous, err = store.appendEvent(completed)
		if err != nil {
			return err
		}
		currentDigest, currentIdentityDigest = postDigest, postIdentityDigest
	}
	terminalState, err := observer.Observe(operationContext, readCredential, clock())
	if err != nil {
		return err
	}
	terminalDigest, terminalIdentityDigest, err := terminalState.Digests()
	if err != nil || terminalDigest != currentDigest || terminalIdentityDigest != currentIdentityDigest {
		return errors.New("E_TERMINAL_STATE_DRIFT")
	}
	if err := ValidateTerminalObservation(plan, terminalState); err != nil {
		return err
	}
	sequence, chain, err := store.nextSequence(planDigest)
	if err != nil || chain != previous {
		return errors.New("E_JOURNAL_CHAIN")
	}
	_, err = store.appendEvent(Event{SchemaVersion: SchemaVersion, Sequence: sequence, PlanSHA256: planDigest, RequestID: "plan", State: "reconciled-terminal", PreviousSHA256: previous, RecordedAt: clock(), DetailCode: "OK", StateSHA256: currentDigest, IdentitySHA256: currentIdentityDigest})
	if err != nil {
		return err
	}
	if plan.Kind == "retire" && plan.RetirementTombstoneSHA256 != nil {
		if err := store.recordRetirement(planDigest, *plan.RetirementTombstoneSHA256, clock()); err != nil {
			return err
		}
	}
	if err := store.releaseFence(fence); err != nil {
		return err
	}
	released = true
	return nil
}

func observeChangedState(ctx context.Context, observer StateObserver, credential []byte, previousDigest string, clock func() time.Time) (StateObservation, string, string, error) {
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		state, err := observer.Observe(ctx, credential, clock())
		if err != nil {
			return StateObservation{}, "", "", err
		}
		digest, identityDigest, err := state.Digests()
		if err != nil {
			return StateObservation{}, "", "", err
		}
		if digest != previousDigest {
			return state, digest, identityDigest, nil
		}
		select {
		case <-ctx.Done():
			return StateObservation{}, "", "", errors.New("E_STATE_OBSERVATION_DEADLINE")
		case <-deadline.C:
			return StateObservation{}, "", "", errors.New("E_STATE_NOT_OBSERVED")
		case <-ticker.C:
		}
	}
}

func stateContainsIdentity(state StateObservation, expected string) bool {
	for _, identity := range state.IdentitySet {
		if strings.HasSuffix(identity, "="+expected) {
			return true
		}
	}
	return false
}

type CommandExecutor struct {
	AccountID                      string
	ProtectedRoot                  string
	Installation                   Installation
	ProfilePath                    string
	ProfileSHA256                  string
	TerminalProfilePath            string
	TerminalProfileSHA256          string
	TerminalEntryPointPath         string
	TerminalEntryPointSHA256       string
	RuntimeHome                    string
	Timeout                        time.Duration
	HTTPClient                     *http.Client
	skipRuntimeVerificationForTest bool
}

func (executor CommandExecutor) Invoke(ctx context.Context, invocation Invocation) (MutationReceipt, error) {
	if err := executor.verifyImmutableInputs(invocation.Action, invocation.Terminal); err != nil {
		return MutationReceipt{}, err
	}
	if invocation.Action == "worker.schedule.delete" || invocation.Action == "worker.scriptWorkersDev.disable" || invocation.Action == "worker.secret.delete" || invocation.Action == "worker.version.delete" || invocation.Action == "worker.delete" {
		return executor.invokeCloudflare(ctx, invocation)
	}
	args, stdin, err := executor.command(invocation)
	if err != nil {
		return MutationReceipt{}, err
	}
	deadline := executor.Timeout
	if deadline <= 0 || deadline > 5*time.Minute {
		deadline = 5 * time.Minute
	}
	commandContext, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	paths := runtimePaths(executor.ProtectedRoot)
	command := exec.Command(paths.node, append([]string{paths.wranglerCLI}, args...)...)
	configureProcessGroup(command)
	command.Dir = paths.workerRoot
	command.Env = []string{
		"CI=1",
		"HOME=" + executor.RuntimeHome,
		"NO_COLOR=1",
		"PATH=/usr/bin:/bin",
		"XDG_CONFIG_HOME=" + filepath.Join(executor.RuntimeHome, "config"),
		"CLOUDFLARE_API_TOKEN=" + string(invocation.DeploymentCredential),
	}
	if stdin != nil {
		command.Stdin = stdin
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return MutationReceipt{}, errors.New("E_EXECUTOR_PIPE")
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return MutationReceipt{}, errors.New("E_EXECUTOR_PIPE")
	}
	if err := command.Start(); err != nil {
		return MutationReceipt{}, errors.New("E_EXECUTOR_START")
	}
	tracked := map[int]struct{}{}
	var trackedMu sync.Mutex
	trackerDone := make(chan struct{})
	trackerStopped := make(chan struct{})
	go func() {
		defer close(trackerStopped)
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				trackedMu.Lock()
				for _, pid := range snapshotDescendants(command) {
					tracked[pid] = struct{}{}
				}
				trackedMu.Unlock()
			case <-trackerDone:
				return
			}
		}
	}()
	defer func() {
		close(trackerDone)
		<-trackerStopped
		trackedMu.Lock()
		pids := make([]int, 0, len(tracked))
		for pid := range tracked {
			pids = append(pids, pid)
		}
		trackedMu.Unlock()
		killDescendants(pids)
	}()
	outputDone := make(chan error, 2)
	go func() {
		err := CopyBounded(ioDiscard{}, stdout, 64<<10)
		if err != nil {
			_ = stdout.Close()
		}
		outputDone <- err
	}()
	go func() {
		err := CopyBounded(ioDiscard{}, stderr, 64<<10)
		if err != nil {
			_ = stderr.Close()
		}
		outputDone <- err
	}()
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()
	var waitErr error
	select {
	case waitErr = <-waitDone:
	case <-commandContext.Done():
		trackedMu.Lock()
		for _, pid := range snapshotDescendants(command) {
			tracked[pid] = struct{}{}
		}
		trackedMu.Unlock()
		_ = terminateProcessGroup(command)
		select {
		case waitErr = <-waitDone:
		case <-time.After(2 * time.Second):
			_ = killProcessGroup(command)
			select {
			case waitErr = <-waitDone:
			case <-time.After(2 * time.Second):
				_ = stdout.Close()
				_ = stderr.Close()
				return MutationReceipt{}, errors.New("E_EXECUTOR_UNJOINED")
			}
		}
	}
	_ = stdout.Close()
	_ = stderr.Close()
	var outputErrors []error
	for len(outputErrors) < 2 {
		select {
		case outputErr := <-outputDone:
			outputErrors = append(outputErrors, outputErr)
		case <-time.After(2 * time.Second):
			return MutationReceipt{}, errors.New("E_EXECUTOR_DRAIN_TIMEOUT")
		}
	}
	if commandContext.Err() != nil {
		return MutationReceipt{}, errors.New("E_EXECUTOR_TIMEOUT")
	}
	if outputErrors[0] != nil || outputErrors[1] != nil {
		return MutationReceipt{}, errors.New("E_EXECUTOR_OUTPUT")
	}
	if waitErr != nil {
		return MutationReceipt{}, errors.New("E_EXECUTOR_FAILURE")
	}
	return MutationReceipt{RequestID: invocation.RequestID, Action: invocation.Action, ResponseSHA256: SHA256([]byte("process-exit-success:" + invocation.RequestID))}, nil
}

func (executor CommandExecutor) invokeCloudflare(ctx context.Context, invocation Invocation) (MutationReceipt, error) {
	if !identifierPattern.MatchString(executor.AccountID) {
		return MutationReceipt{}, errors.New("E_ACCOUNT_ID")
	}
	path := "/client/v4/accounts/" + executor.AccountID + "/workers/scripts/" + WorkerName
	method := http.MethodDelete
	var bodyBytes []byte
	if invocation.Action == "worker.schedule.delete" {
		path += "/schedules"
		method = http.MethodPut
		bodyBytes = []byte("[]")
	} else if invocation.Action == "worker.scriptWorkersDev.disable" {
		path += "/subdomain"
		method = http.MethodPost
		bodyBytes = []byte(`{"enabled":false,"previews_enabled":false}`)
	} else if invocation.Action == "worker.secret.delete" {
		allowed := false
		for _, secret := range canonicalSecrets {
			if invocation.SecretName == secret {
				allowed = true
			}
		}
		if !allowed {
			return MutationReceipt{}, errors.New("E_SECRET_NAME")
		}
		path += "/secrets/" + invocation.SecretName
	} else if invocation.Action == "worker.version.delete" {
		if !identifierPattern.MatchString(invocation.VersionID) || invocation.VersionID == "latest" {
			return MutationReceipt{}, errors.New("E_VERSION_ID")
		}
		path = "/client/v4/accounts/" + executor.AccountID + "/workers/workers/" + WorkerName + "/versions/" + invocation.VersionID
	}
	deadline := executor.Timeout
	if deadline <= 0 || deadline > 5*time.Minute {
		deadline = 5 * time.Minute
	}
	requestContext, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, method, "https://api.cloudflare.com"+path, bytes.NewReader(bodyBytes))
	if err != nil {
		return MutationReceipt{}, errors.New("E_CLOUDFLARE_REQUEST")
	}
	request.Header.Set("Authorization", "Bearer "+string(invocation.DeploymentCredential))
	request.Header.Set("Accept", "application/json")
	if len(bodyBytes) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	client := executor.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: deadline}
	}
	response, err := client.Do(request)
	if err != nil {
		return MutationReceipt{}, errors.New("E_CLOUDFLARE_OUTCOME_UNKNOWN")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	if err != nil || len(body) > 64<<10 {
		return MutationReceipt{}, errors.New("E_CLOUDFLARE_OUTPUT")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return MutationReceipt{}, errors.New("E_CLOUDFLARE_FAILURE")
	}
	var envelope cloudflareEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil || !envelope.Success {
		return MutationReceipt{}, errors.New("E_CLOUDFLARE_ENVELOPE")
	}
	return MutationReceipt{RequestID: invocation.RequestID, Action: invocation.Action, ResponseSHA256: SHA256(body)}, nil
}

func verifiedFileDigest(path, expected string) error {
	if err := validateOwnedPath(path, false); err != nil {
		return errors.New("E_TOOLCHAIN_FILE")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 64<<20 {
		return errors.New("E_TOOLCHAIN_FILE")
	}
	data, err := os.ReadFile(path)
	if err != nil || SHA256(data) != expected {
		return errors.New("E_TOOLCHAIN_CHANGED")
	}
	return nil
}

func (executor CommandExecutor) verifyImmutableInputs(action string, terminal bool) error {
	if !filepath.IsAbs(executor.ProtectedRoot) {
		return errors.New("E_TOOLCHAIN_PATH")
	}
	if !executor.skipRuntimeVerificationForTest {
		if _, err := verifyRuntimeClosure(executor.ProtectedRoot, executor.Installation); err != nil {
			return err
		}
	}
	profile, digest := executor.ProfilePath, executor.ProfileSHA256
	if terminal || action == "worker.terminalArtifact.deploy" {
		profile, digest = executor.TerminalProfilePath, executor.TerminalProfileSHA256
		if err := verifiedFileDigest(executor.TerminalEntryPointPath, executor.TerminalEntryPointSHA256); err != nil {
			return err
		}
	}
	return verifiedFileDigest(profile, digest)
}

type ioDiscard struct{}

func (ioDiscard) Write(value []byte) (int, error) { return len(value), nil }

func zeroBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func (executor CommandExecutor) command(invocation Invocation) ([]string, *bytes.Reader, error) {
	config := executor.ProfilePath
	var action []string
	var stdin *bytes.Reader
	switch invocation.Action {
	case "worker.secret.put":
		action = []string{"secret", "put", invocation.SecretName, "--config", config, "--name", WorkerName}
		stdin = bytes.NewReader(invocation.Secret)
	case "worker.deploy":
		action = []string{"deploy", "--config", config, "--name", WorkerName, "--strict", "--no-autoconfig"}
	case "worker.rollback":
		action = []string{"rollback", invocation.VersionID, "--config", config, "--name", WorkerName, "--yes"}
	case "worker.terminalArtifact.deploy":
		action = []string{"deploy", "--config", executor.TerminalProfilePath, "--name", WorkerName, "--strict", "--no-autoconfig"}
	default:
		return nil, nil, errors.New("E_ACTION_CLOSED")
	}
	return action, stdin, nil
}

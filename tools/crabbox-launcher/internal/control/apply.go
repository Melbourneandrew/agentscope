package control

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type Invocation struct {
	Action               string
	RequestID            string
	SecretName           string
	Secret               []byte
	DeploymentCredential []byte
	VersionID            string
	Terminal             bool
}

type Executor interface {
	Invoke(context.Context, Invocation) error
}

type ApplyInput struct {
	PlanData          []byte
	AuthorizationData []byte
	ObservationData   []byte
	AttestationData   []byte
	Now               time.Time
	Clock             func() time.Time
}

func (store Store) Apply(ctx context.Context, input ApplyInput, executor Executor) error {
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
	planDigest := SHA256(input.PlanData)
	fence, err := store.acquireFence(planDigest)
	if err != nil {
		return err
	}
	release := false
	defer func() {
		if release {
			_ = store.releaseFence(fence)
		} else {
			_ = fence.Close()
		}
	}()
	previous, err := store.consumePlan(planDigest, input.Now)
	if err != nil {
		release = true
		return err
	}
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
	for _, operation := range plan.Operations {
		now := clock()
		if now.After(plan.ExpiresAt) || now.After(observation.ExpiresAt) {
			return errors.New("E_AUTHORITY_EXPIRED_DURING_APPLY")
		}
		sequence, chain, err := store.nextSequence(planDigest)
		if err != nil || chain != previous {
			return errors.New("E_JOURNAL_CHAIN")
		}
		started := Event{SchemaVersion: SchemaVersion, Sequence: sequence, PlanSHA256: planDigest, RequestID: operation.RequestID, State: "invoking-uncertain", PreviousSHA256: previous, RecordedAt: now, DetailCode: "PENDING"}
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
		if err := executor.Invoke(ctx, invocation); err != nil {
			return fmt.Errorf("E_OUTCOME_UNCERTAIN: %w", err)
		}
		completed := Event{SchemaVersion: SchemaVersion, Sequence: sequence + 1, PlanSHA256: planDigest, RequestID: operation.RequestID, State: "observed-committed", PreviousSHA256: previous, RecordedAt: clock(), DetailCode: "OK"}
		previous, err = store.appendEvent(completed)
		if err != nil {
			return err
		}
	}
	sequence, chain, err := store.nextSequence(planDigest)
	if err != nil || chain != previous {
		return errors.New("E_JOURNAL_CHAIN")
	}
	_, err = store.appendEvent(Event{SchemaVersion: SchemaVersion, Sequence: sequence, PlanSHA256: planDigest, RequestID: "plan", State: "reconciled-terminal", PreviousSHA256: previous, RecordedAt: clock(), DetailCode: "OK"})
	if err != nil {
		return err
	}
	if plan.Kind == "retire" && plan.RetirementTombstoneSHA256 != nil {
		if err := store.recordRetirement(planDigest, *plan.RetirementTombstoneSHA256, clock()); err != nil {
			return err
		}
	}
	release = true
	return nil
}

type CommandExecutor struct {
	AccountID                  string
	NPMPath                    string
	NPMPathSHA256              string
	WorkerRoot                 string
	CoordinatorCommit          string
	WorkerLockSHA256           string
	ProfilePath                string
	ProfileSHA256              string
	TerminalProfilePath        string
	TerminalProfileSHA256      string
	TerminalEntryPointPath     string
	TerminalEntryPointSHA256   string
	RuntimeHome                string
	Timeout                    time.Duration
	HTTPClient                 *http.Client
	skipGitVerificationForTest bool
}

func (executor CommandExecutor) Invoke(ctx context.Context, invocation Invocation) error {
	if err := executor.verifyImmutableInputs(invocation.Action, invocation.Terminal); err != nil {
		return err
	}
	if invocation.Action == "worker.secret.delete" || invocation.Action == "worker.version.delete" || invocation.Action == "worker.delete" {
		return executor.invokeCloudflare(ctx, invocation)
	}
	args, stdin, err := executor.command(invocation)
	if err != nil {
		return err
	}
	deadline := executor.Timeout
	if deadline <= 0 || deadline > 5*time.Minute {
		deadline = 5 * time.Minute
	}
	commandContext, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	command := exec.Command(executor.NPMPath, args...)
	configureProcessGroup(command)
	command.Dir = filepath.Join(executor.WorkerRoot, "worker")
	command.Env = []string{
		"CI=1",
		"HOME=" + executor.RuntimeHome,
		"NO_COLOR=1",
		"PATH=" + filepath.Dir(executor.NPMPath) + ":/usr/bin:/bin",
		"XDG_CONFIG_HOME=" + filepath.Join(executor.RuntimeHome, "config"),
		"CLOUDFLARE_API_TOKEN=" + string(invocation.DeploymentCredential),
	}
	if stdin != nil {
		command.Stdin = stdin
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return errors.New("E_EXECUTOR_PIPE")
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return errors.New("E_EXECUTOR_PIPE")
	}
	if err := command.Start(); err != nil {
		return errors.New("E_EXECUTOR_START")
	}
	outputDone := make(chan error, 2)
	go func() { outputDone <- CopyBounded(ioDiscard{}, stdout, 64<<10) }()
	go func() { outputDone <- CopyBounded(ioDiscard{}, stderr, 64<<10) }()
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()
	var waitErr error
	select {
	case waitErr = <-waitDone:
	case <-commandContext.Done():
		_ = terminateProcessGroup(command)
		select {
		case waitErr = <-waitDone:
		case <-time.After(5 * time.Second):
			_ = killProcessGroup(command)
			waitErr = <-waitDone
		}
	}
	firstOutputErr, secondOutputErr := <-outputDone, <-outputDone
	if commandContext.Err() != nil {
		return errors.New("E_EXECUTOR_TIMEOUT")
	}
	if firstOutputErr != nil || secondOutputErr != nil {
		return errors.New("E_EXECUTOR_OUTPUT")
	}
	if waitErr != nil {
		return errors.New("E_EXECUTOR_FAILURE")
	}
	return nil
}

func (executor CommandExecutor) invokeCloudflare(ctx context.Context, invocation Invocation) error {
	if !identifierPattern.MatchString(executor.AccountID) {
		return errors.New("E_ACCOUNT_ID")
	}
	path := "/client/v4/accounts/" + executor.AccountID + "/workers/scripts/" + WorkerName
	if invocation.Action == "worker.secret.delete" {
		allowed := false
		for _, secret := range canonicalSecrets {
			if invocation.SecretName == secret {
				allowed = true
			}
		}
		if !allowed {
			return errors.New("E_SECRET_NAME")
		}
		path += "/secrets/" + invocation.SecretName
	} else if invocation.Action == "worker.version.delete" {
		if !identifierPattern.MatchString(invocation.VersionID) || invocation.VersionID == "latest" {
			return errors.New("E_VERSION_ID")
		}
		path = "/client/v4/accounts/" + executor.AccountID + "/workers/workers/" + WorkerName + "/versions/" + invocation.VersionID
	}
	deadline := executor.Timeout
	if deadline <= 0 || deadline > 5*time.Minute {
		deadline = 5 * time.Minute
	}
	requestContext, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodDelete, "https://api.cloudflare.com"+path, nil)
	if err != nil {
		return errors.New("E_CLOUDFLARE_REQUEST")
	}
	request.Header.Set("Authorization", "Bearer "+string(invocation.DeploymentCredential))
	request.Header.Set("Accept", "application/json")
	client := executor.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: deadline}
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("E_CLOUDFLARE_OUTCOME_UNKNOWN")
	}
	defer response.Body.Close()
	if err := CopyBounded(io.Discard, response.Body, 64<<10); err != nil {
		return errors.New("E_CLOUDFLARE_OUTPUT")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("E_CLOUDFLARE_FAILURE")
	}
	return nil
}

func verifiedFileDigest(path, expected string) error {
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
	if !filepath.IsAbs(executor.NPMPath) || !filepath.IsAbs(executor.WorkerRoot) {
		return errors.New("E_TOOLCHAIN_PATH")
	}
	if err := verifiedFileDigest(executor.NPMPath, executor.NPMPathSHA256); err != nil {
		return err
	}
	if err := verifiedFileDigest(filepath.Join(executor.WorkerRoot, "worker", "package-lock.json"), executor.WorkerLockSHA256); err != nil {
		return err
	}
	if !executor.skipGitVerificationForTest {
		if err := executor.verifyGitSource(); err != nil {
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

func (executor CommandExecutor) verifyGitSource() error {
	if len(executor.CoordinatorCommit) != 40 {
		return errors.New("E_SOURCE_COMMIT")
	}
	commands := [][]string{{"rev-parse", "HEAD"}, {"diff", "--quiet", "--no-ext-diff", "HEAD", "--"}, {"diff", "--cached", "--quiet", "--no-ext-diff", "--"}}
	for index, args := range commands {
		command := exec.Command("/usr/bin/git", append([]string{"-C", executor.WorkerRoot}, args...)...)
		command.Env = []string{"HOME=" + executor.RuntimeHome, "PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0"}
		output, err := command.Output()
		if err != nil {
			return errors.New("E_SOURCE_CHANGED")
		}
		if index == 0 && string(bytes.TrimSpace(output)) != executor.CoordinatorCommit {
			return errors.New("E_SOURCE_COMMIT")
		}
	}
	return nil
}

type ioDiscard struct{}

func (ioDiscard) Write(value []byte) (int, error) { return len(value), nil }

func zeroBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func (executor CommandExecutor) command(invocation Invocation) ([]string, *bytes.Reader, error) {
	base := []string{"exec", "--prefix", filepath.Join(executor.WorkerRoot, "worker"), "--", "wrangler"}
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
	return append(base, action...), stdin, nil
}

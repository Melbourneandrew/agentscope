//go:build unix

package control

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func commandExecutorFixture(t *testing.T, script string) CommandExecutor {
	t.Helper()
	root := t.TempDir()
	paths := runtimePaths(root)
	if err := os.MkdirAll(paths.workerRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(paths.node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(paths.wranglerCLI), 0o700); err != nil {
		t.Fatal(err)
	}
	profile, terminal := []byte("profile"), []byte("terminal")
	for path, data := range map[string][]byte{
		filepath.Join(root, "live.jsonc"):     profile,
		filepath.Join(root, "terminal.jsonc"): terminal,
		paths.wranglerCLI:                     []byte("placeholder"),
		paths.node:                            []byte("#!/bin/sh\nset -eu\n" + script),
	} {
		if err := os.WriteFile(path, data, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return CommandExecutor{
		AccountID:                      "account-canary",
		Installation:                   Installation{AccountID: "account-canary"},
		ProtectedRoot:                  root,
		ProfilePath:                    filepath.Join(root, "live.jsonc"),
		ProfileSHA256:                  SHA256(profile),
		TerminalProfilePath:            filepath.Join(root, "terminal.jsonc"),
		TerminalProfileSHA256:          SHA256(terminal),
		RuntimeHome:                    filepath.Join(root, "home"),
		Timeout:                        3 * time.Second,
		skipRuntimeVerificationForTest: true,
	}
}

func invokeExecutorFixture(executor CommandExecutor) (MutationReceipt, error) {
	return executor.Invoke(context.Background(), Invocation{
		Action:               "worker.deploy",
		RequestID:            "request-1",
		SourceCommit:         strings.Repeat("a", 40),
		DeploymentCredential: []byte("deployment-canary"),
	})
}

func TestCommandExecutorJoinsDelayedOutputDrainsAfterWait(t *testing.T) {
	executor := commandExecutorFixture(t, "printf stdout\nprintf stderr >&2\n")
	waitReturned := make(chan struct{})
	executor.waitCommandForTest = func(command *exec.Cmd) error {
		err := command.Wait()
		close(waitReturned)
		return err
	}
	executor.copyOutputForTest = func(reader io.Reader) error {
		<-waitReturned
		return CopyBounded(ioDiscard{}, reader, 64<<10)
	}
	receipt, err := invokeExecutorFixture(executor)
	if err != nil {
		t.Fatalf("delayed post-wait drain failed: %v", err)
	}
	if receipt.RequestID != "request-1" || receipt.Action != "worker.deploy" {
		t.Fatalf("unexpected receipt: %+v", receipt)
	}
}

func TestCommandExecutorRejectsOutputOverflow(t *testing.T) {
	executor := commandExecutorFixture(t, "/usr/bin/perl -e 'print \"x\" x 65537'\n")
	_, err := invokeExecutorFixture(executor)
	if err == nil || err.Error() != "E_EXECUTOR_OUTPUT" {
		t.Fatalf("unexpected overflow result: %v", err)
	}
}

func TestCommandExecutorPreservesChildFailure(t *testing.T) {
	executor := commandExecutorFixture(t, "printf failure >&2\nexit 7\n")
	_, err := invokeExecutorFixture(executor)
	if err == nil || err.Error() != "E_EXECUTOR_FAILURE" {
		t.Fatalf("unexpected child failure result: %v", err)
	}
}

func TestCommandExecutorDoesNotStartAfterAuthorityExpires(t *testing.T) {
	startedPath := filepath.Join(t.TempDir(), "started")
	executor := commandExecutorFixture(t, "touch '"+startedPath+"'\n")
	ctx, cancel := context.WithCancel(context.Background())
	executor.beforeCommandStartForTest = cancel
	_, err := executor.Invoke(ctx, Invocation{
		Action:               "worker.deploy",
		RequestID:            "request-1",
		SourceCommit:         strings.Repeat("a", 40),
		DeploymentCredential: []byte("deployment-canary"),
	})
	if err == nil || err.Error() != "E_EXECUTOR_TIMEOUT" {
		t.Fatalf("unexpected expired-authority result: %v", err)
	}
	if _, err := os.Stat(startedPath); !os.IsNotExist(err) {
		t.Fatalf("expired authority started child: %v", err)
	}
}

func TestCommandExecutorBoundsNonsettlingOutputDrainAndCleansHolder(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "holder.pid")
	executor := commandExecutorFixture(t, "/bin/sleep 10 &\nholder=$!\nprintf '%s\\n' \"$holder\" > '"+pidPath+"'\n/bin/sleep 0.2\nexit 0\n")
	executor.drainTimeoutForTest = 100 * time.Millisecond
	started := time.Now()
	_, err := invokeExecutorFixture(executor)
	if err == nil || err.Error() != "E_EXECUTOR_DRAIN_TIMEOUT" {
		t.Fatalf("unexpected nonsettling drain result: %v", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("nonsettling drain was not bounded: %s", time.Since(started))
	}
	data, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pipe-holding child %d survived drain cleanup", pid)
}

func TestCommandExecutorNeverReturnsWithUnjoinedOutputDrain(t *testing.T) {
	executor := commandExecutorFixture(t, "exit 0\n")
	executor.drainTimeoutForTest = 50 * time.Millisecond
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	waitReturned := make(chan struct{})
	executor.waitCommandForTest = func(command *exec.Cmd) error {
		err := command.Wait()
		close(waitReturned)
		return err
	}
	executor.copyOutputForTest = func(io.Reader) error {
		entered <- struct{}{}
		<-release
		return nil
	}
	result := make(chan error, 1)
	go func() {
		_, err := invokeExecutorFixture(executor)
		result <- err
	}()
	for index := 0; index < 2; index++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("output drain did not start")
		}
	}
	select {
	case <-waitReturned:
	case <-time.After(time.Second):
		t.Fatal("command wait did not return")
	}
	select {
	case err := <-result:
		t.Fatalf("Invoke returned with unjoined output drain: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-result:
		if err == nil || err.Error() != "E_EXECUTOR_DRAIN_TIMEOUT" {
			t.Fatalf("unexpected joined drain result: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Invoke did not return after both output drains joined")
	}
}

func TestCommandExecutorNeverReturnsWithUnjoinedProcessWait(t *testing.T) {
	executor := commandExecutorFixture(t, "exit 0\n")
	executor.Timeout = 50 * time.Millisecond
	executor.processJoinTimeoutForTest = 50 * time.Millisecond
	waitEntered := make(chan struct{})
	waitExceeded := make(chan struct{})
	release := make(chan struct{})
	executor.processWaitExceededForTest = func() { close(waitExceeded) }
	executor.waitCommandForTest = func(command *exec.Cmd) error {
		close(waitEntered)
		<-release
		return command.Wait()
	}
	result := make(chan error, 1)
	go func() {
		_, err := invokeExecutorFixture(executor)
		result <- err
	}()
	select {
	case <-waitEntered:
	case <-time.After(time.Second):
		t.Fatal("process wait did not start")
	}
	select {
	case <-waitExceeded:
	case <-time.After(time.Second):
		t.Fatal("process wait did not exceed both bounded joins")
	}
	select {
	case err := <-result:
		t.Fatalf("Invoke returned with unjoined process wait: %v", err)
	default:
	}
	close(release)
	select {
	case err := <-result:
		if err == nil || err.Error() != "E_EXECUTOR_UNJOINED" {
			t.Fatalf("unexpected joined process result: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Invoke did not return after process wait and drains joined")
	}
}

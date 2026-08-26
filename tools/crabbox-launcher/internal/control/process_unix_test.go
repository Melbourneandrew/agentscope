//go:build unix

package control

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestExecutorTimeoutKillsDescendantProcessGroup(t *testing.T) {
	root := t.TempDir()
	paths := runtimePaths(root)
	worker := paths.workerRoot
	if err := os.MkdirAll(worker, 0o700); err != nil {
		t.Fatal(err)
	}
	lock, profile, terminal := []byte("lock"), []byte("profile"), []byte("terminal")
	for path, data := range map[string][]byte{filepath.Join(worker, "package-lock.json"): lock, filepath.Join(root, "live"): profile, filepath.Join(root, "terminal"): terminal} {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	pidPath := filepath.Join(root, "descendant.pid")
	script := "#!/bin/sh\n(sleep 100) &\necho $! > " + pidPath + "\nwait\n"
	npm := paths.node
	if err := os.MkdirAll(filepath.Dir(paths.node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(paths.wranglerCLI), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.wranglerCLI, []byte("placeholder"), 0o500); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(npm, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	executor := CommandExecutor{ProtectedRoot: root, ProfilePath: filepath.Join(root, "live"), ProfileSHA256: SHA256(profile), TerminalProfilePath: filepath.Join(root, "terminal"), TerminalProfileSHA256: SHA256(terminal), RuntimeHome: filepath.Join(root, "home"), Timeout: 2 * time.Second, skipRuntimeVerificationForTest: true}
	_, err := executor.Invoke(context.Background(), Invocation{Action: "worker.deploy", DeploymentCredential: []byte("synthetic")})
	if err == nil || !strings.Contains(err.Error(), "E_EXECUTOR_TIMEOUT") {
		t.Fatalf("unexpected timeout: %v", err)
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
		err = syscall.Kill(pid, 0)
		if err == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("descendant %d survived process-group cleanup", pid)
}

func TestExecutorTimeoutKillsSetsidPipeHolderWithinBound(t *testing.T) {
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
	for path, data := range map[string][]byte{filepath.Join(root, "live"): []byte("live"), filepath.Join(root, "terminal"): []byte("terminal"), paths.wranglerCLI: []byte("placeholder")} {
		if err := os.WriteFile(path, data, 0o500); err != nil {
			t.Fatal(err)
		}
	}
	pidPath := filepath.Join(root, "setsid.pid")
	script := "#!/bin/sh\n/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); open(F, \">" + pidPath + "\"); print F \"$$\\n\"; close(F); sleep 100' &\nwait\n"
	if err := os.WriteFile(paths.node, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	executor := CommandExecutor{ProtectedRoot: root, ProfilePath: filepath.Join(root, "live"), ProfileSHA256: SHA256([]byte("live")), TerminalProfilePath: filepath.Join(root, "terminal"), TerminalProfileSHA256: SHA256([]byte("terminal")), RuntimeHome: filepath.Join(root, "home"), Timeout: 600 * time.Millisecond, skipRuntimeVerificationForTest: true}
	started := time.Now()
	_, err := executor.Invoke(context.Background(), Invocation{Action: "worker.deploy", DeploymentCredential: []byte("synthetic")})
	if err == nil || time.Since(started) > 5*time.Second {
		t.Fatalf("escaped descendant was not bounded: %v elapsed=%s", err, time.Since(started))
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
	t.Fatalf("setsid descendant %d survived protected cleanup", pid)
}

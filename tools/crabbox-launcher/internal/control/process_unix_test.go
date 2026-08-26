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
	worker := filepath.Join(root, "worker")
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
	npm := filepath.Join(root, "npm")
	if err := os.WriteFile(npm, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	executor := CommandExecutor{NPMPath: npm, NPMPathSHA256: SHA256([]byte(script)), WorkerRoot: root, WorkerLockSHA256: SHA256(lock), ProfilePath: filepath.Join(root, "live"), ProfileSHA256: SHA256(profile), TerminalProfilePath: filepath.Join(root, "terminal"), TerminalProfileSHA256: SHA256(terminal), RuntimeHome: filepath.Join(root, "home"), Timeout: 2 * time.Second, skipGitVerificationForTest: true}
	err := executor.Invoke(context.Background(), Invocation{Action: "worker.deploy", DeploymentCredential: []byte("synthetic")})
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

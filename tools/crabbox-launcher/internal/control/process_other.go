//go:build !unix

package control

import (
	"errors"
	"os/exec"
	"time"
)

func configureProcessGroup(command *exec.Cmd)                 {}
func terminateProcessGroup(command *exec.Cmd) error           { return command.Process.Kill() }
func killProcessGroup(command *exec.Cmd) error                { return command.Process.Kill() }
func snapshotDescendants(command *exec.Cmd) []int             { return nil }
func killDescendants(pids []int, expectedUID int)             {}
func configureExecutionCredential(command *exec.Cmd, uid int) {}
func uidProcessesPresent(uid int) bool                        { return true }
func terminateUIDProcessSet(uid int, timeout time.Duration) error {
	return errors.New("E_EXECUTOR_PROCESS_SET_UNSUPPORTED")
}

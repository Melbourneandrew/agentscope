//go:build !unix

package control

import "os/exec"

func configureProcessGroup(command *exec.Cmd)       {}
func terminateProcessGroup(command *exec.Cmd) error { return command.Process.Kill() }
func killProcessGroup(command *exec.Cmd) error      { return command.Process.Kill() }
func snapshotDescendants(command *exec.Cmd) []int   { return nil }
func killDescendants(pids []int)                    {}

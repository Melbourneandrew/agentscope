//go:build unix

package control

import (
	"bytes"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func configureProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcessGroup(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	return syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
}

func killProcessGroup(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	return syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
}

func snapshotDescendants(command *exec.Cmd) []int {
	if command.Process == nil {
		return nil
	}
	probe := exec.Command("/bin/ps", "-axo", "pid=,ppid=")
	probe.Env = []string{"PATH=/usr/bin:/bin"}
	output, err := probe.Output()
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		fields := strings.Fields(string(line))
		if len(fields) != 2 {
			continue
		}
		pid, first := strconv.Atoi(fields[0])
		ppid, second := strconv.Atoi(fields[1])
		if first == nil && second == nil {
			children[ppid] = append(children[ppid], pid)
		}
	}
	var result []int
	queue := []int{command.Process.Pid}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range children[parent] {
			result = append(result, child)
			queue = append(queue, child)
		}
	}
	return result
}

func killDescendants(pids []int) {
	for index := len(pids) - 1; index >= 0; index-- {
		if pids[index] > 1 && pids[index] != os.Getpid() {
			_ = syscall.Kill(pids[index], syscall.SIGKILL)
		}
	}
}

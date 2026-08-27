//go:build unix

package control

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func configureProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func configureExecutionCredential(command *exec.Cmd, uid int) {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.Credential = &syscall.Credential{Uid: uint32(uid), Gid: uint32(uid)}
}

func uidProcessIDs(uid int) ([]int, error) {
	probe := exec.Command("/bin/ps", "-axo", "pid=,uid=")
	probe.Env = []string{"PATH=/usr/bin:/bin"}
	output, err := probe.Output()
	if err != nil {
		return nil, err
	}
	result := []int{}
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		fields := strings.Fields(string(line))
		if len(fields) != 2 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		processUID, uidErr := strconv.Atoi(fields[1])
		if pidErr == nil && uidErr == nil && processUID == uid && pid > 1 {
			result = append(result, pid)
		}
	}
	return result, nil
}

func uidProcessesPresent(uid int) bool {
	pids, err := uidProcessIDs(uid)
	return err != nil || len(pids) != 0
}

func terminateUIDProcessSet(uid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	signal := syscall.SIGTERM
	for {
		pids, err := uidProcessIDs(uid)
		if err != nil {
			return errors.New("E_EXECUTOR_PROCESS_SET")
		}
		if len(pids) == 0 {
			return nil
		}
		for _, pid := range pids {
			_ = syscall.Kill(pid, signal)
		}
		if time.Now().After(deadline) {
			return errors.New("E_EXECUTOR_PROCESS_SET_UNJOINED")
		}
		time.Sleep(25 * time.Millisecond)
		if time.Until(deadline) < timeout/2 {
			signal = syscall.SIGKILL
		}
	}
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

func killDescendants(pids []int, expectedUID int) {
	currentUIDs := map[int]int{}
	probe := exec.Command("/bin/ps", "-axo", "pid=,uid=")
	probe.Env = []string{"PATH=/usr/bin:/bin"}
	if output, err := probe.Output(); err == nil {
		for _, line := range bytes.Split(output, []byte{'\n'}) {
			fields := strings.Fields(string(line))
			if len(fields) != 2 {
				continue
			}
			pid, pidErr := strconv.Atoi(fields[0])
			uid, uidErr := strconv.Atoi(fields[1])
			if pidErr == nil && uidErr == nil {
				currentUIDs[pid] = uid
			}
		}
	}
	for index := len(pids) - 1; index >= 0; index-- {
		if pids[index] > 1 && pids[index] != os.Getpid() && (expectedUID < 0 || currentUIDs[pids[index]] == expectedUID) {
			_ = syscall.Kill(pids[index], syscall.SIGKILL)
		}
	}
}

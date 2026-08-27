//go:build darwin

package control

import (
	"bufio"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
)

func ReadSecretFromTTY(prompt string) ([]byte, error) {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return nil, errors.New("E_TTY_REQUIRED")
	}
	defer tty.Close()
	disable := exec.Command("/bin/stty", "-echo")
	disable.Stdin = tty
	disable.Stdout = tty
	disable.Stderr = tty
	if err := disable.Run(); err != nil {
		return nil, errors.New("E_TTY_ECHO")
	}
	defer func() {
		restore := exec.Command("/bin/stty", "echo")
		restore.Stdin = tty
		restore.Stdout = tty
		restore.Stderr = tty
		_ = restore.Run()
		_, _ = tty.WriteString("\n")
	}()
	if _, err := tty.WriteString(prompt); err != nil {
		return nil, errors.New("E_TTY_WRITE")
	}
	value, err := bufio.NewReader(io.LimitReader(tty, 8193)).ReadString('\n')
	if err != nil {
		return nil, errors.New("E_TTY_READ")
	}
	return []byte(strings.TrimSuffix(value, "\n")), nil
}

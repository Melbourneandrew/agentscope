//go:build unix

package control

import (
	"errors"
	"os"
	"syscall"
)

func validatePlatformFile(info os.FileInfo, wantDir bool) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("E_STATE_OWNER")
	}
	if !wantDir && stat.Nlink != 1 {
		return errors.New("E_STATE_LINK")
	}
	return nil
}

func lockFile(file *os.File) error   { return syscall.Flock(int(file.Fd()), syscall.LOCK_EX) }
func unlockFile(file *os.File) error { return syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }

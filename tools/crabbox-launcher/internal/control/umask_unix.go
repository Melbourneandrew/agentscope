//go:build unix

package control

import "syscall"

func setPrivateUmask() int   { return syscall.Umask(0o077) }
func restoreUmask(value int) { syscall.Umask(value) }

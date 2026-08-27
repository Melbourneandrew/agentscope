//go:build !unix

package control

func setPrivateUmask() int { return 0 }
func restoreUmask(int)     {}

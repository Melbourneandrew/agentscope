//go:build !darwin

package control

import "errors"

func ReadSecretFromTTY(string) ([]byte, error) {
	return nil, errors.New("E_TTY_PLATFORM")
}

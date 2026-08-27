package control

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
)

const keyDerivationRounds = 200000

type sealedPrivateKey struct {
	SchemaVersion int    `json:"schemaVersion"`
	Algorithm     string `json:"algorithm"`
	Rounds        int    `json:"rounds"`
	Salt          string `json:"salt"`
	Nonce         string `json:"nonce"`
	Ciphertext    string `json:"ciphertext"`
}

func deriveKey(passphrase, salt []byte, rounds int) []byte {
	result := make([]byte, 32)
	block := append(append([]byte{}, salt...), 0, 0, 0, 1)
	mac := hmac.New(sha256.New, passphrase)
	_, _ = mac.Write(block)
	previous := mac.Sum(nil)
	copy(result, previous)
	for index := 1; index < rounds; index++ {
		mac = hmac.New(sha256.New, passphrase)
		_, _ = mac.Write(previous)
		previous = mac.Sum(nil)
		for offset := range result {
			result[offset] ^= previous[offset]
		}
	}
	zeroBytes(previous)
	zeroBytes(block)
	return result
}

func sealKey(privateKey, passphrase []byte) ([]byte, error) {
	if len(passphrase) < 20 || len(passphrase) > 1024 {
		return nil, errors.New("E_OPERATOR_PASSPHRASE")
	}
	salt, nonce := make([]byte, 32), make([]byte, 12)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	key := deriveKey(passphrase, salt, keyDerivationRounds)
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ciphertext := gcm.Seal(nil, nonce, privateKey, []byte("agentscope-crabbox-protected-key-v1"))
	record := sealedPrivateKey{SchemaVersion: SchemaVersion, Algorithm: "PBKDF2-HMAC-SHA256+A256GCM", Rounds: keyDerivationRounds, Salt: base64.StdEncoding.EncodeToString(salt), Nonce: base64.StdEncoding.EncodeToString(nonce), Ciphertext: base64.StdEncoding.EncodeToString(ciphertext)}
	return json.Marshal(record)
}

func unsealKey(data, passphrase []byte) ([]byte, error) {
	var record sealedPrivateKey
	if err := strictJSON(data, &record); err != nil {
		return nil, err
	}
	if record.SchemaVersion != SchemaVersion || record.Algorithm != "PBKDF2-HMAC-SHA256+A256GCM" || record.Rounds != keyDerivationRounds {
		return nil, errors.New("E_SEALED_KEY_FORMAT")
	}
	salt, err := base64.StdEncoding.Strict().DecodeString(record.Salt)
	if err != nil || len(salt) != 32 {
		return nil, errors.New("E_SEALED_KEY_FORMAT")
	}
	nonce, err := base64.StdEncoding.Strict().DecodeString(record.Nonce)
	if err != nil || len(nonce) != 12 {
		return nil, errors.New("E_SEALED_KEY_FORMAT")
	}
	ciphertext, err := base64.StdEncoding.Strict().DecodeString(record.Ciphertext)
	if err != nil {
		return nil, errors.New("E_SEALED_KEY_FORMAT")
	}
	key := deriveKey(passphrase, salt, record.Rounds)
	defer zeroBytes(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, []byte("agentscope-crabbox-protected-key-v1"))
	if err != nil {
		return nil, errors.New("E_OPERATOR_AUTHENTICATION")
	}
	return plaintext, nil
}

func sealCredential(value, key []byte, binding string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(nonce, gcm.Seal(nil, nonce, value, []byte(binding))...), nil
}

func unsealCredential(value, key []byte, binding string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(value) < gcm.NonceSize() {
		return nil, errors.New("E_CREDENTIAL_CIPHERTEXT")
	}
	plaintext, err := gcm.Open(nil, value[:gcm.NonceSize()], value[gcm.NonceSize():], []byte(binding))
	if err != nil {
		return nil, errors.New("E_CREDENTIAL_CIPHERTEXT")
	}
	return plaintext, nil
}

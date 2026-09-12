# Codex 0.149.1 discovery identities

This directory contains no redistributed Codex program bytes. The production
CLI policy records only hashes and sizes used to recognize an already-installed
Codex release without executing it.

The identities were derived from the credential-free npm registry records for
`@openai/codex@0.149.1` and its npm-alias platform packages. The wrapper tarball
is `https://registry.npmjs.org/@openai/codex/-/codex-0.149.1.tgz`, integrity
`sha512-6q5pbcpFbJbqOpkubSDBwXmktQ55aD8eUzGzBF1zASob2DjwhBKDSNGtdZKalfrNJUdTDTPDMmzCXEXs5tMBYA==`,
and SHA-256
`1616304fd7883b46d8887cf336496e2ae0cdf9a637b7bdf8824baa98c22c5b7b`.
Its registry metadata names npm signing key
`SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U` and provenance endpoint
`https://registry.npmjs.org/-/npm/v1/attestations/@openai%2fcodex@0.149.1`.

The admitted platform packages are:

- `0.149.1-linux-x64`: integrity
  `sha512-Of5fGYgr7tAMsyj6vhXb4/RM/UoA3Zq8BLegUBDC09UNy1XTLGYP/2XD+UX8z3qh0NDwxYdCjFIWdDNijKZggQ==`,
  tarball SHA-256
  `734f865ed62d8be68796e7913651bbc69ad7c63a8c01ee28524ad69b4c9ab401`,
  provenance endpoint
  `https://registry.npmjs.org/-/npm/v1/attestations/@openai%2fcodex@0.149.1-linux-x64`.
- `0.149.1-darwin-arm64`: integrity
  `sha512-6X84kTCbnTgPIJ2EdcPsrvwS0Wxsqpa+bCswGmRf4BjhcQ5nPMnBC6yCAaCMj+vrbXQHj+L6sa9FaR4QkmA1qw==`,
  tarball SHA-256
  `151f8b96af0529c1267e7438d2cbc6d26213922fa017b96540abaf5f07d792d2`,
  provenance endpoint
  `https://registry.npmjs.org/-/npm/v1/attestations/@openai%2fcodex@0.149.1-darwin-arm64`.

Both platform registry records name the same npm signing key. Trusted scenario
material preparation independently verifies registry integrity, signatures,
and published provenance before installation; these recognition hashes do not
confer release admission or redistribution authority.

#!/bin/sh
set -eu

# Networked immutable-input preparation for CI only. This verifies the complete
# nonsecret installer path and exits before privilege, credentials, or cloud.
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$repository_root"
verification_root=$(mktemp -d "${TMPDIR:-/tmp}/agentscope-crabbox-installer-verify.XXXXXX")
cleanup() {
  chmod -R u+w "$verification_root" 2>/dev/null || true
  rm -rf -- "$verification_root"
}
trap cleanup EXIT HUP INT TERM

go_archive="$verification_root/go1.26.5.darwin-arm64.tar.gz"
node_archive="$verification_root/node-v24.19.0-darwin-arm64.tar.gz"
curl --fail --location --proto '=https' --tlsv1.2 --output "$go_archive" https://go.dev/dl/go1.26.5.darwin-arm64.tar.gz
curl --fail --location --proto '=https' --tlsv1.2 --output "$node_archive" https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz
printf '%s  %s\n' efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a "$go_archive" | shasum -a 256 -c -
printf '%s  %s\n' 8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d "$node_archive" | shasum -a 256 -c -

source="$verification_root/crabbox"
git clone --quiet https://github.com/openclaw/crabbox.git "$source"
git -C "$source" checkout --quiet 8ba71f913bbe57285ae29af45ef0d8ec6712477d
mkdir -m 0700 "$verification_root/go"
tar -xzf "$go_archive" -C "$verification_root/go"
mkdir -m 0700 "$verification_root/node"
tar -xzf "$node_archive" -C "$verification_root/node"
admitted_node="$verification_root/node/node-v24.19.0-darwin-arm64/bin/node"
client="$verification_root/crabbox-client"
(
  cd "$source"
  env -i HOME="$verification_root" PATH="$verification_root/go/go/bin:/usr/bin:/bin" GOTOOLCHAIN=local CGO_ENABLED=0 \
    "$verification_root/go/go/bin/go" build -trimpath -ldflags='-s -w -X github.com/openclaw/crabbox/internal/cli.version=0.46.0' -o "$client" ./cmd/crabbox
)
printf '%s  %s\n' 52b2da6ffb141c19d35fe777e4b6e7d827ed5c05b3a2101e43f83ad848a9655c "$client" | shasum -a 256 -c -
test "$($client version)" = 0.46.0

record="$verification_root/operator-record.json"
printf '%s\n' '{"environmentId":"asgcf_0123456789abcdef0123456789abcdef","workerName":"agentscope-crabbox-development","cloudflarePlan":"free","accountMode":"owner-personal-shared"}' > "$record"
live_profile="$source/worker/wrangler.agentscope.jsonc"
"$admitted_node" "$repository_root/scripts/crabbox-coordinator-profile.mjs" --source "$source" --record "$record" --output "$live_profile" >/dev/null
terminal_profile="$source/worker/wrangler.agentscope-terminal.jsonc"
"$admitted_node" --input-type=module -e 'import {readFile,writeFile} from "node:fs/promises"; import {expectedTerminalProfile} from "./scripts/lib/crabbox-coordinator-policy.mjs"; const admission=JSON.parse(await readFile("./ops/crabbox-coordinator/admission.json","utf8")); await writeFile(process.argv[1], JSON.stringify(expectedTerminalProfile(admission), null, 2)+"\n", {mode:0o600,flag:"wx"});' "$terminal_profile"

toolchain="$verification_root/toolchain.json"
printf '%s\n' '{"nodeVersion":"24.19.0","nodeArchiveSha256":"8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d","wranglerVersion":"4.114.0","workerLockSha256":"6bf8940bd1b514ab3541485605e24b516242359e3050cfa5645966e398b030fd","goVersion":"1.26.5","goArchiveSha256":"efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a","crabboxClientSha256":"52b2da6ffb141c19d35fe777e4b6e7d827ed5c05b3a2101e43f83ad848a9655c"}' > "$toolchain"

AGENTSCOPE_CRABBOX_INSTALLER_VERIFY_ONLY=1 "$repository_root/ops/crabbox-coordinator/install-protected-launcher.sh" \
  install-ci asgcf_0123456789abcdef0123456789abcdef account-ci project-ci "$source" \
  "$go_archive" "$node_archive" "$toolchain" "$live_profile" "$terminal_profile" \
  "$repository_root/ops/crabbox-coordinator/terminal-worker.agentscope.mjs"

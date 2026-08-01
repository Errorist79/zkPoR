#!/usr/bin/env bash
# Bootstrap the exact pinned toolchain on a fresh Linux or macOS machine.
# Idempotent: it skips a tool that already reports the pinned version. All
# versions come from versions.env, and the last step proves each one.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/versions.env"

# The pinned releases give an artifact for these platforms only. The check is
# here, so an unsupported host fails before the first download.
PLATFORM="$(uname -s)_$(uname -m)"
case "$PLATFORM" in
  Linux_x86_64|Darwin_arm64|Darwin_x86_64) ;;
  *) echo "unsupported platform: ${PLATFORM}"; exit 1 ;;
esac

NOIRUP_BIN="$HOME/.nargo/bin/noirup"
NARGO_BIN="$HOME/.nargo/bin/nargo"
BB_BIN_DIR="$HOME/.bb/bin"
BB_SEMVER="${BB_VERSION#v}"
STELLAR_BIN_DIR="$HOME/.local/bin"
STELLAR_BIN="$STELLAR_BIN_DIR/stellar"

# Each function reports the version that the host has now, and reports nothing
# when the tool is absent. The install step and the final check both use these
# functions, so one tool keeps one definition of the version that it reports.
# rust-toolchain.toml applies inside the repository, so rustc answers there.
rustc_installed()   { ( cd "$ROOT_DIR" && rustc --version 2>/dev/null ) | awk '{print $2}'; }
nargo_installed()   { "$NARGO_BIN" --version 2>/dev/null | head -1 | awk '{print $NF}'; }
bb_installed()      { "$BB_BIN_DIR/bb" --version 2>/dev/null | head -1; }
stellar_installed() { "$STELLAR_BIN" --version 2>/dev/null | head -1 | awk '{print $2}'; }

echo "### Rust toolchain (rust-toolchain.toml pins ${RUST_VERSION} + wasm32v1-none) ###"
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
( cd "$ROOT_DIR" && rustup show >/dev/null )   # triggers toolchain + target install
rustc --version

echo "### nargo ${NARGO_VERSION} ###"
# The installed version is the test, not the presence of the file, so a new pin
# replaces an old binary instead of keeping it.
if [ "$(nargo_installed)" != "${NARGO_VERSION}" ]; then
  [ -x "$NOIRUP_BIN" ] || curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
  "$NOIRUP_BIN" -v "${NARGO_VERSION}"
fi
"$NARGO_BIN" --version | head -1

echo "### Docker ###"
# This script does not install Docker. An install needs root, and it changes a
# host that runs other services, so the owner of the host makes that decision.
# The script stops here instead, because the soundness gate needs a localnet
# container, and a host that cannot run the native bb needs a container for bb.
command -v docker >/dev/null 2>&1 || { echo "docker is not installed; install docker, then run this script again"; exit 1; }
docker info >/dev/null 2>&1 || { echo "the docker daemon does not answer; start docker, then run this script again"; exit 1; }
docker --version

echo "### bb ${BB_VERSION} ###"
# The official bb release needs a newer glibc and libstdc++ than some hosts
# have. A comparison of version numbers is not sufficient, because two libraries
# set the limit. The script runs the downloaded binary one time, and it keeps
# the binary only if the run succeeds. If the run fails, bb runs in a container,
# and $HOME/.bb/bin/bb becomes a wrapper that calls that container. The image
# tag follows BB_VERSION, so a version bump cannot use the image of an older bb.
BB_IMAGE="zkpor-bb:${BB_SEMVER}"
BB_RELEASE_URL="https://github.com/AztecProtocol/aztec-packages/releases/download/${BB_VERSION}"
BB_LINUX_AMD64_TARBALL="barretenberg-amd64-linux.tar.gz"

# A wrapper whose image is gone reports no version, and the script repairs it.
if [ "$(bb_installed)" != "${BB_SEMVER}" ]; then
  case "$PLATFORM" in
    Linux_x86_64)  file="$BB_LINUX_AMD64_TARBALL" ;;
    Darwin_arm64)  file="barretenberg-arm64-darwin.tar.gz" ;;
    Darwin_x86_64) file="barretenberg-amd64-darwin.tar.gz" ;;
  esac
  mkdir -p "$BB_BIN_DIR"
  bb_stage="$(mktemp -d)"
  curl -fL "${BB_RELEASE_URL}/${file}" -o /tmp/bb.tar.gz
  tar -xzf /tmp/bb.tar.gz -C "$bb_stage"
  chmod +x "$bb_stage/bb"
  if "$bb_stage/bb" --version >/dev/null 2>&1; then
    mv "$bb_stage"/* "$BB_BIN_DIR/"
  else
    echo "this host cannot run the native bb ${BB_VERSION}; bb runs in a container"
    if ! docker image inspect "$BB_IMAGE" >/dev/null 2>&1; then
      echo "building ${BB_IMAGE}"
      docker build -t "$BB_IMAGE" \
        --build-arg "BB_TARBALL_URL=${BB_RELEASE_URL}/${BB_LINUX_AMD64_TARBALL}" - <<'DOCKERFILE'
FROM ubuntu:24.04
ARG BB_TARBALL_URL
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libstdc++6 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fL "$BB_TARBALL_URL" -o /tmp/bb.tar.gz \
 && tar -xzf /tmp/bb.tar.gz -C /usr/local/bin \
 && rm /tmp/bb.tar.gz \
 && chmod +x /usr/local/bin/bb
DOCKERFILE
    fi
    # The container keeps the downloaded CRS, so a proof does not fetch it again.
    cat > "$BB_BIN_DIR/bb" <<EOF
#!/usr/bin/env bash
mkdir -p "\$HOME/.bb-crs"
exec docker run --rm -i \\
  -v "\$PWD":"\$PWD" \\
  -v "\$HOME/.bb-crs":/root/.bb-crs \\
  -w "\$PWD" ${BB_IMAGE} bb "\$@"
EOF
    chmod +x "$BB_BIN_DIR/bb"
  fi
  rm -rf "$bb_stage" /tmp/bb.tar.gz
fi
"$BB_BIN_DIR/bb" --version

echo "### stellar-cli ${STELLAR_CLI_VERSION} (must match Protocol ${PROTOCOL_VERSION}) ###"
# The test reads the path that this script writes. Another stellar earlier on
# PATH can then not hide a wrong version here.
if [ "$(stellar_installed)" != "${STELLAR_CLI_VERSION}" ]; then
  case "$PLATFORM" in
    Linux_x86_64)  triple="x86_64-unknown-linux-gnu" ;;
    Darwin_arm64)  triple="aarch64-apple-darwin" ;;
    Darwin_x86_64) triple="x86_64-apple-darwin" ;;
  esac
  mkdir -p "$STELLAR_BIN_DIR"
  url="https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${triple}.tar.gz"
  curl -fL "$url" -o /tmp/stellar.tar.gz
  tar -xzf /tmp/stellar.tar.gz -C "$STELLAR_BIN_DIR"
  chmod +x "$STELLAR_BIN"
  rm -f /tmp/stellar.tar.gz
fi
echo "PATH must include \$HOME/.local/bin \$HOME/.nargo/bin \$HOME/.bb/bin \$HOME/.cargo/bin"
"$STELLAR_BIN" --version | head -1

echo "### Version check against the pins ###"
version_mismatch=0
check_pinned() {
  if [ "$2" != "$3" ]; then
    echo "MISMATCH ${1}: the pin is ${2}, the host has ${3:-nothing}"
    version_mismatch=1
  fi
}
check_pinned rustc   "$RUST_VERSION"         "$(rustc_installed)"
check_pinned nargo   "$NARGO_VERSION"        "$(nargo_installed)"
check_pinned bb      "$BB_SEMVER"            "$(bb_installed)"
check_pinned stellar "$STELLAR_CLI_VERSION"  "$(stellar_installed)"
[ "$version_mismatch" -eq 0 ] || { echo "the toolchain does not match the pins"; exit 1; }
echo "rustc, nargo, bb and stellar match the pins"

echo "### Done. Pinned toolchain ready. ###"

#!/usr/bin/env bash
# Bootstrap the exact pinned toolchain on a fresh (Linux) machine.
# Idempotent: skips anything already present. Versions come from versions.env.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/versions.env"

echo "### Rust toolchain (rust-toolchain.toml pins ${RUST_VERSION} + wasm32v1-none) ###"
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
( cd "$ROOT_DIR" && rustup show >/dev/null )   # triggers toolchain + target install
rustc --version

echo "### nargo ${NARGO_VERSION} ###"
if [ ! -x "$HOME/.nargo/bin/nargo" ]; then
  curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
  "$HOME/.nargo/bin/noirup" -v "${NARGO_VERSION}"
fi
"$HOME/.nargo/bin/nargo" --version | head -1

echo "### bb ${BB_VERSION} ###"
# The official bb release needs a newer glibc and libstdc++ than some hosts
# have. A comparison of version numbers is not sufficient, because two libraries
# set the limit. The script runs the downloaded binary one time, and it keeps
# the binary only if the run succeeds. If the run fails, bb runs in a container,
# and $HOME/.bb/bin/bb becomes a wrapper that calls that container. The image
# tag follows BB_VERSION, so a version bump cannot use the image of an older bb.
BB_BIN_DIR="$HOME/.bb/bin"
BB_IMAGE="zkpor-bb:${BB_VERSION#v}"
BB_RELEASE_URL="https://github.com/AztecProtocol/aztec-packages/releases/download/${BB_VERSION}"
BB_LINUX_AMD64_TARBALL="barretenberg-amd64-linux.tar.gz"

# The installed version is the test, not the presence of the file. A wrapper
# whose image is gone reports nothing, and the script then repairs it.
if [ "$("$BB_BIN_DIR/bb" --version 2>/dev/null || true)" != "${BB_VERSION#v}" ]; then
  case "$(uname -s)_$(uname -m)" in
    Linux_x86_64)  file="$BB_LINUX_AMD64_TARBALL" ;;
    Darwin_arm64)  file="barretenberg-arm64-darwin.tar.gz" ;;
    Darwin_x86_64) file="barretenberg-amd64-darwin.tar.gz" ;;
    *) echo "unsupported platform"; exit 1 ;;
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
    command -v docker >/dev/null 2>&1 || { echo "bb needs docker here, and docker is not installed"; exit 1; }
    docker info >/dev/null 2>&1 || { echo "bb needs docker here, and the docker daemon does not answer"; exit 1; }
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
NEED_STELLAR=1
if command -v stellar >/dev/null 2>&1 && stellar --version | grep -q "stellar ${STELLAR_CLI_VERSION}"; then NEED_STELLAR=0; fi
if [ "$NEED_STELLAR" -eq 1 ]; then
  mkdir -p "$HOME/.local/bin"
  url="https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
  curl -fL "$url" -o /tmp/stellar.tar.gz
  tar -xzf /tmp/stellar.tar.gz -C "$HOME/.local/bin"
  chmod +x "$HOME/.local/bin/stellar"
fi
echo "PATH must include \$HOME/.local/bin \$HOME/.nargo/bin \$HOME/.bb/bin \$HOME/.cargo/bin"
"$HOME/.local/bin/stellar" --version 2>/dev/null | head -1 || stellar --version | head -1

echo "### Done. Pinned toolchain ready. ###"

#!/usr/bin/env bash
#
# ISP Billing Backend — Build & Push script (independent of the legacy platform).
#
# Builds the FastAPI backend image from ./docker/Dockerfile and (optionally)
# pushes it to a container registry for deployment on a VPS via Docker Compose.
#
# Usage:
#   ./build.sh                     # build only (DEPLOY=false)
#   DEPLOY=true ./build.sh         # build + push (if REGISTRY_TOKEN set)
#   DEPLOY=true SCAN=1 ./build.sh  # build + scan + push
#
set -euo pipefail

# ── Configuration (override via environment) ─────────────────────────────
APP_NAME=${APP_NAME:-isp-billing-backend}
DEPLOY=${DEPLOY:-false}                     # set DEPLOY=true to push + tag :latest
SCAN=${SCAN:-1}                             # 1 = run Trivy scan on the filesystem
REGISTRY=${REGISTRY:-ghcr.io}
REGISTRY_NAMESPACE=${REGISTRY_NAMESPACE:-${GITHUB_REPOSITORY_OWNER:-isp-billing}}
IMAGE_REPO="${REGISTRY}/${REGISTRY_NAMESPACE}/${APP_NAME}"

if [[ -z ${GITHUB_SHA:-} ]]; then
  GIT_COMMIT_ID=$(git rev-parse --short=8 HEAD || echo "localbuild")
else
  GIT_COMMIT_ID=${GITHUB_SHA::8}
fi

info() { echo -e "[INFO]   $1"; }
success() { echo -e "[OK]     $1"; }
warn() { echo -e "[WARN]   $1"; }
error() { echo -e "[ERROR]  $1" >&2; exit 1; }

# ── Prerequisite checks ──────────────────────────────────────────────────
for tool in git docker; do
  command -v "$tool" >/dev/null 2>&1 || error "$tool is required"
done
success "Prerequisite checks passed"

# ── Build ────────────────────────────────────────────────────────────────
info "Building image ${IMAGE_REPO}:${GIT_COMMIT_ID}"
DOCKER_BUILDKIT=1 docker build -f docker/Dockerfile \
  -t "${IMAGE_REPO}:${GIT_COMMIT_ID}" \
  -t "${IMAGE_REPO}:latest" \
  . || error "docker build failed"

success "Docker build complete"

# ── Security scan (opt-in) ───────────────────────────────────────────────
if [[ ${SCAN} == 1 ]] && command -v trivy >/dev/null 2>&1; then
  info "Running Trivy filesystem scan..."
  trivy fs . --exit-code "${TRIVY_ECODE:-1}" --format table || true
fi

# ── Push (only when DEPLOY=true) ─────────────────────────────────────────
if [[ ${DEPLOY} != "true" ]]; then
  warn "DEPLOY=false -> skipping push"
  exit 0
fi

if [[ -z ${REGISTRY_TOKEN:-} ]] && [[ -z ${GITHUB_TOKEN:-} ]]; then
  error "REGISTRY_TOKEN (or GITHUB_TOKEN) must be set to push to the registry"
fi

info "Logging in to ${REGISTRY}..."
echo "${REGISTRY_TOKEN:-${GITHUB_TOKEN}}" | docker login "${REGISTRY}" \
  -u "${REGISTRY_USERNAME:-}" --password-stdin || error "docker login failed"

docker push "${IMAGE_REPO}:${GIT_COMMIT_ID}" || error "push failed"
success "Image pushed to ${IMAGE_REPO}:${GIT_COMMIT_ID}"

docker push "${IMAGE_REPO}:latest" || warn "push of :latest skipped"

success "Build & push complete for ${APP_NAME}"

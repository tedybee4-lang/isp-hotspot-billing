# Golden fixtures: the exact bootstrap artifacts real routers receive.
#
# Committed deliberately. A generated script is what a customer's router
# actually runs, so it must be reviewable in a diff rather than only observable
# by deploying to hardware and reading a terminal.
#
# bootstrap-ros724-chr.rsc - MikroTik CHR, RouterOS 7.24.4, x86_64.
#   Regenerate with:
#     npx vite-node src/test/gen-bootstrap.ts 7.24.4 x86_64 \
#       src/test/fixtures/bootstrap-ros724-chr.rsc
#   The fixture test fails if the committed copy drifts from the generator,
#   so this file cannot silently go stale.
// Reproduces EXACTLY what router-provision returns to a real router, so the
// generated artifact can be inspected and audited offline.
//
// It imports the same fixture the test suite validates. It does NOT re-declare
// the claim trailer: an earlier copy of this file did, drifted from production,
// and then "audited" a file nobody serves - which is how a fixed bug was
// reported as still present.
import { writeFileSync } from 'node:fs'
import { bootstrap } from './bootstrap-fixture'

const raw = process.argv[2] ?? '7.24.4'
const arch = process.argv[3] ?? 'x86_64'
const out = process.argv[4] ?? 'tmp-bootstrap.rsc'

const file = bootstrap(raw, arch)
writeFileSync(out, file)
console.log(`wrote ${out}: ${file.length} bytes, ${file.split('\n').length} lines`)
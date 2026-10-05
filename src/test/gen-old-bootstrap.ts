// Reproduces the ACTUAL bootstrap the pre-96182b6 generator produced for a
// RouterOS 7.24.4 CHR, extracted from that commit's own source in git history.
//
// This is not a hand-written approximation of the bug. It is the real output of
// the real broken code, so the regression test proves the validator catches the
// production defect rather than some invented one.
import { writeFileSync } from 'node:fs'
// The extracted pre-96182b6 modules. They are historical source, kept verbatim
// except for repointed sibling imports, and are executed only to reproduce the
// real broken output as a regression fixture.
import { buildRouterScript as buildOld } from './broken-generator/capabilities-old.ts'
import { buildDiscoveryScript as discoverOld } from './broken-generator/discovery-old.ts'

const TAG = 'abcd1234'
// The options the panel passes for a HotSpot+PPPoE ISP router. These only shape
// the content; the defect being reproduced is the SYNTAX of the emitted blocks.
const file = [
  buildOld({
    tag: TAG,
    role: 'both',
    hotspotInterfaces: ['ether2'],
    pppoeInterfaces: ['ether3'],
    wanInterface: 'ether1',
    dns: ['1.1.1.1', '8.8.8.8'],
    sessionTimeoutMin: 30,
    idleTimeoutMin: 5,
    radiusServer: '10.10.0.1',
    radiusEnabled: true,
  }),
  // The claim trailer exactly as router-provision emitted it at that commit.
  ':put ("ISPFlow: registered as " . $identity);',
  ':put ("ISPFlow: RouterOS " . $version . " on " . $board-name);',
  '',
  discoverOld({
    reportUrl: 'https://demo.supabase.co/functions/v1/router-provision/report',
    token: 'd'.repeat(48),
    major: 7,
    tag: TAG,
  }),
].join('\n')

writeFileSync(process.argv[2] ?? 'tmp-old.rsc', file)
console.log(`wrote ${process.argv[2] ?? 'tmp-old.rsc'}: ${file.length} bytes`)
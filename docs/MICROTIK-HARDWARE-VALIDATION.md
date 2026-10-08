# MikroTik hardware validation checklist

**Status: NOT PERFORMED.**

No physical MikroTik has been available while any of this was written. Every
router assertion in the test suite runs against a mock `RouterClient`, which
accepts any parameter key and returns whatever the test tells it to. That is
enough to prove *what the platform intends to send* and *that it never removes
anything*, and it is not enough to prove any of it works on a device.

This document exists so that the first real router is a checklist rather than an
investigation.

---

## 0. The bootstrap import — test this FIRST, before anything else

Everything below is worthless until the router will run the file the platform
sends it. Three real CHRs (RouterOS 7.24.4, x86_64) have already driven four
successive defects in that one file, all of which are now fixed:

| # | Observed on hardware | Cause |
|---|---|---|
| 1 | `Script Error: expected end of command (line 5)` | a standalone `do={...}` block, which is an *argument*, not a statement |
| 2 | `failure: please use 'output' option` | `keep-result=yes` combined with `output=file` |
| 3 | `status: failed`, `code: 400`, `0 KiB` | `board-name` (`CHR innotek GmbH VirtualBox`) concatenated raw into the request target; the gateway rejected the URL |
| 4 | `$identity` / `$version` / `$board-name` undefined | the claim trailer printed variables nothing had ever assigned |

The generated script is now checked by a RouterOS-aware validator
(`src/test/routeros-validate.ts`) that tokenises the script and asserts no
standalone `do=`, no undefined variable, balanced blocks, valid `/tool fetch`
options, no destructive command, no unescaped JSON and no RouterOS 6
assumption. It is proven to reject each of the four defects above.

That proof is not a hand-written sample. `src/test/fixtures/bootstrap-BROKEN-pre96182b6.rsc`
is the **actual output of the actual pre-96182b6 generator**, extracted from git
(`96182b6~1`) and executed (`src/test/gen-old-bootstrap.ts`). It is 41091 bytes
with **7 standalone `do={` blocks** and undefined `$identity`, `$version` and
`$board-name` - the reported failure, reproduced. A test asserts the validator
rejects it with line numbers, and that the current generator passes.

To regenerate both fixtures:

```bash
npx vite-node src/test/gen-old-bootstrap.ts \
  src/test/fixtures/bootstrap-BROKEN-pre96182b6.rsc
npx vite-node src/test/gen-bootstrap.ts 7.24.4 x86_64 \
  src/test/fixtures/bootstrap-ros724-chr.rsc
```

**That is still not proof.** A validator models RouterOS as understood. The
following must be confirmed on the device:

| # | Check | Expected | Result |
|---|---|---|---|
| 0.1 | Paste the generated command into a CHR terminal | `/tool fetch` downloads, `/import` runs | |
| 0.2 | `/import` output | no `Script Error`; no line/column failure | |
| 0.3 | Terminal shows `registered as <identity>` | the router's own identity, not blank | |
| 0.4 | Terminal shows `HTTPS management is available on port 8080` | present on 7.1+; **absent** on 6.x | |
| 0.5 | `/ip service print` | exactly one `api`, one `api-ssl`, one `www-ssl`; re-running adds none | |
| 0.6 | Discovery reports | `Starting ISPFlow router discovery...` then per-survey posts | |
| 0.7 | A survey on an absent menu | e.g. `ISPFlow: wireless not reported: ...`, and the script **continues** | |
| 0.8 | Panel → Network Status | board, RouterOS version and architecture populated | |
| 0.9 | Router-initiated command channel on a newly claimed router | heartbeat polls `/commands` with certificate verification; only the authenticated router receives its own generated script | |
| 0.10 | Safe hAP-like WAN/LAN discovery | HotSpot portal assets install only with one bound DHCP WAN and one existing bridged LAN/DHCP/DNS topology; ambiguity makes no network changes | |
| 0.11 | No local users and no HotSpot RADIUS backend | portal reports authentication unavailable; do **not** claim customer service is ready | |

The pull channel is additive to the bootstrap; it is not a server-side push.
Routers whose already-installed heartbeat script only POSTs to `/ping` cannot
receive this update through that one-way request. They need one run of the
updated bootstrap (or an independently reachable management connection) before
they can poll. A successful portal install is also not proof that a subscriber
can authenticate: the platform records whether existing local HotSpot users or
a HotSpot-enabled RADIUS server were detected.

Watch specifically for the failure the mock cannot catch: whether
`:onerror` inside a `{}` block is honoured on your firmware, and whether
`/tool fetch http-data=(...)` accepts the parenthesised concatenation on 7.24.4.

---

## 0a. READ THIS BEFORE TESTING AGAIN: redeploy the function

The router downloads the bootstrap from the **deployed Supabase Edge Function**,
not from this repository. Pushing a fix here changes nothing until:

```bash
supabase functions deploy router-provision --no-verify-jwt
```

Only then does a fresh provisioning command return the corrected script. A
provisioning session also caches nothing, but the **token is single-use**, so
generate a new command (and therefore a new token) after deploying.

**How to tell which build you are testing.** The generated script's size is a
reliable fingerprint, because every fix changed it — but size alone is a
heuristic, so the generator now emits two marker comments that are not:

| Build | Approximate size | Marker / contains |
|---|---|---|
| before `96182b6` | ~38 KiB | standalone `do={/ip service`, `$identity`, "RouterOS 6 has no WireGuard" |
| `96182b6` | ~40 KiB | `do={` fixed, capability messages fixed |
| `7864582` | ~40 KiB | `keep-result=yes` removed |
| `27644af` – `528c90a` | **~55–57 KiB** | URL 400 fixed, escaping added — and the hand-escaping path |
| `6158b2d` and later | **~31 KiB** | `# ISPFlow-BOOTSTRAP-GENERATOR-528C90`, `# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR`, `:serialize to=json` |

So:

| Downloaded | Meaning |
|---|---|
| no markers, any size | a deploy that predates `6158b2d` |
| ~31 KiB + both markers | current generator, RouterOS 7.13+ serialize path |
| ~31 KiB + markers, `[:replace` present | a build that took the ROS6/unknown fallback — the `vm` did not parse |
| ~55–57 KiB | hand-escaping path, pre-`6158b2d` **or** a `vm` the server could not read |

### The 55 KiB incident: the deploy was not the bug

A correct deploy continued to return ~55 KiB of `[:replace]`-escaped script,
HTTP 200 the whole time, and the router failed with
`Script Error: syntax error (line 56 column 36)` on `/import file-name=$f`.
Three separate things had to be established before the cause was visible:

1. **The endpoint was fine.** Fetching it directly with a good `vm` returned
   32,471 bytes of the new generator. Fetching it with `vm=7.` returned 58,413
   bytes of the escape path. The generator was not stale — the *input* was.
2. **The router sent `vm=7.`** because the command contained
   `:local ispFlowMinor [:pick $ispFlowVer 2 2]`. RouterOS `:pick <s> <start>
   <end>` is start-inclusive and **end-exclusive**, not `(start, length)`:

   ```
   :put [:pick "abcde" 1 3]   ->  bc      (not "bcd")
   :put [:pick "abcde" 2 2]   ->  ""      always empty
   ```

   So the minor was `""` for every version, `vm` arrived as `"7."`, and the
   server — correctly — found no version in it and served the conservative
   fallback regardless of which generator was deployed.
3. **The test agreed with the bug.** `claimUrl()` in `bootstrap-syntax.test.ts`
   modelled `:pick` as `(start, len) => slice(start, start + len)`. Mirroring
   the generated code is what makes it a test; mirroring the same *wrong
   assumption* made it a restatement. Both sides computed minor = `24` and the
   case passed.

The fix pads the version with `..` so a second dot always exists, then cuts at
it with `:find`'s search-after-index argument — no conditional, no nil case,
and `:pick` always starts at 0, where the two interpretations cannot differ:

```
:local ispFlowVerRaw [/system/resource/get version];
:local ispFlowVer ($ispFlowVerRaw . "..");
:local ispFlowDot1 [:find $ispFlowVer "."];
:local ispFlowDot2 [:find $ispFlowVer "." $ispFlowDot1];
:local ispFlowVm [:pick $ispFlowVer 0 $ispFlowDot2];
```

| `version` | `vm` sent |
|---|---|
| `7.24.4` | `7.24` |
| `7.9.2` | `7.9` |
| `7.24` | `7.24` |
| `6.49.10 (long-term)` | `6.49` — no space reaches the URL |

The validator now rejects a zero-width `[:pick x N N]` outright, so this class
of defect fails in CI rather than on a customer's terminal.

### Live verification

Proven against production with a freshly minted single-use token, on
`router-provision` v18 (project `dcqcunmdhyonaewwuama`), requesting
`?token=…&vm=7.24&arch=x86_64` exactly as the CHR command does:

| Check | Result |
|---|---|
| HTTP status | `200`, `content-type: text/plain` |
| Size | **32,471 bytes / 700 lines (31.7 KiB)** |
| `# ISPFlow-BOOTSTRAP-GENERATOR-528C90` | present |
| `# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR` | present |
| `:serialize to=json` | present |
| `method=POST` | present |
| `check-certificate=yes` | present |
| `http-header-field="Content-Type:application/json"` | present |
| `[:replace`, `:replace` | **absent** |
| `JSON.stringify`, `JSON.parse` | **absent** |
| `http-method` | **absent** |
| `keep-result=no` | **absent** |
| `$identity`, `$version`, `$board-name` | **absent** |
| `validateRouterOsScript(…, { mode: 'serialize' })` | **clean** |

Control probes against the same deployment: `vm=7.` and an absent `vm` both
return **58,413 bytes of the escape path containing `:replace`**, which is the
failure that was being reported. That is how the cause was localised to the
command's `vm` rather than to the deploy.

**The survey payload fix.** Every discovery POST now carries
`http-header-field="Content-Type:application/json"`. The report endpoint
branches on content-type and calls `req.formData()` otherwise, which threw for
every RouterOS survey body and was caught as `payload = {}` — surveys were
recorded as reported with no data in them.

The committed golden fixture
(`src/test/fixtures/bootstrap-ros724-chr.rsc`) is the exact output for
RouterOS 7.24.4 / x86_64 CHR, and a test fails if it drifts from the generator,
so it can be diffed against what the router actually downloaded.

---

## 1. RouterOS API audit

Every `RouterClient.run` path the staged engine issues, and what to check on the
device. **Path correctness below is from the RouterOS API reference and from the
platform's own existing, working handlers — it has not been executed against
hardware.**

Confidence legend:

- **A** — the path exists in the API; the platform already calls it elsewhere.
- **B** — the path exists; verify the property spellings on first contact.
- **C** — verify carefully. Something here is known to differ by firmware.

### 1.1 Discovery and management

| Path | Conf | Notes for the tester |
|---|---|---|
| `/interface/print` | A | Used by the pre-existing capabilities survey. Returns `.id`, `name`, `type`, `disabled` (`"true"`/`"false"`), `comment`. |
| `/file/print` | A | `name`, `size` are what the backup stage reads. Confirm `size` is present, not just `name`. |
| `/ip/service/print` | A | `name`, `port`, `disabled`. Connectivity requires `name="api"` and `disabled != "true"`. |
| `/system/identity/print` | A | Returns the router's name in `name`. |
| `/system/identity/set` | A | Takes `name`. |

### 1.2 Backup

| Path | Conf | Notes |
|---|---|---|
| `/system/backup/save` | **B** | Property is `name` (no `password`, deliberately). Confirm the file then appears in `/file/print` **under the exact name passed**. If RouterOS normalises the name, the verification stage will fail — which is correct behaviour, but better found now than on a customer's router. |

### 1.3 WireGuard (RouterOS 7.1+)

| Path | Conf | Notes |
|---|---|---|
| `/interface/wireguard/print` | B | Absent on RouterOS 6; the stage treats "no such command" as the unsupported signal. **Verify a 6.x box actually rejects the path** rather than returning an empty list — an empty list would read as "supported but no tunnels" and the stage would create one. |
| `/interface/wireguard/add` | **C** | Property is **`listen-port`** (hyphen). `listen_port` was a real bug, now fixed; confirm the tunnel actually listens on 13231 afterwards. |

### 1.4 RADIUS

| Path | Conf | Notes |
|---|---|---|
| `/radius/print` | A | `name`, `address`, `secret`, `disabled`. `secret` is read **only** to test that one exists; the value is never recorded. |
| `/radius/add` | B | `address` must include the port: `"<host>:1812"`. `timeout=1500ms` — confirm the duration format is accepted. |
| `/radius/set` | **B** | Addressed with `.id`. See §2. |

### 1.5 HotSpot

| Path | Conf | Notes |
|---|---|---|
| `/ip/hotspot/print` | A | `interface`, `name`, `.id`. |
| `/ip/hotspot/add` | B | `interface` must be a **bridge or a physical port**. A HotSpot server on a port that is a bridge *member* is rejected — this is the most likely first-run failure. `idle-timeout`/`keepalive-timeout` take `5m`-style values. |
| `/ip/hotspot/set` | **B** | Addressed with `.id`. |
| `/ip/hotspot/user/print` | A | `name`. |
| `/ip/hotspot/user/add` | B | `name`, `password`, `profile`, `comment`. |
| `/ip/hotspot/user/profile/print` | A | `name`, `rate-limit`. |
| `/ip/hotspot/user/profile/add` | **B** | **`rate-limit` format is the highest-risk item here.** Confirm `20M/5M`, `100M`, `1G`, `500k/250k` are accepted verbatim. A rejected rate-limit fails the stage — correct, but find it now. |
| `/ip/hotspot/user/profile/set` | **B** | Addressed with `.id`. |

### 1.6 PPPoE

| Path | Conf | Notes |
|---|---|---|
| `/interface/pppoe-server/print` | A | `service`, `name`, `.id`. |
| `/interface/pppoe-server/add` | **B** | `service` is the interface. `local-address`/`remote-address` must be full ranges. `one-session-per-host=yes` — confirm the boolean spelling. `profile` must reference an existing `/ppp/profile` or the add is rejected. |
| `/interface/pppoe-server/set` | **B** | Addressed with `.id`. |
| `/ppp/profile/print` | A | `name`, `local-address`, `remote-address`. |
| `/ppp/profile/add` | B | Same range format. |
| `/ppp/profile/set` | **B** | Addressed with `.id`. |
| `/ppp/secret/print` | A | `name`. |
| `/ppp/secret/add` | B | `name`, `password`, `service`, `profile`. |

### 1.7 Firewall

| Path | Conf | Notes |
|---|---|---|
| `/ip/firewall/nat/print` | A | `out-interface`, `action`, `chain`, `name`, `comment`. |
| `/ip/firewall/nat/add` | B | `chain=srcnat`, `action=masquerade`, `out-interface`, `name`, `comment`. |
| `/ip/firewall/nat/set` | **B** | Addressed with `.id`. |
| `/ip/firewall/filter/print` | A | |
| `/ip/firewall/filter/add` | **B** | `in-interface` accepts a comma-separated list. `chain=input`, `action=accept`. |

### 1.8 Scheduler

| Path | Conf | Notes |
|---|---|---|
| `/system/scheduler/print` | A | `name`, `comment`, `interval`. |
| `/system/scheduler/add` | **B** | `interval=10m`; `on-event` takes a **command path**, not a script name. The value is `/log/info message="..."` — confirm the quoting survives the API transport. |

### 1.9 Pools (discovery only)

| Path | Conf | Notes |
|---|---|---|
| `/ip/pool/print` | B | `name`, `ranges`, `next-pool`. Newly added to the survey so pools can be resolved instead of typed. Verify `ranges` is returned as a bare `a.b.c.d-e.f.g.h` with no prefix. |
| `/ip/address/print` | B | `address`, `interface`, `network`. Recorded for context. |

---

## 2. Row addressing — verify this FIRST

Every `/set` above passes `.id` as the **parameter key**, because the API encodes
parameters as `=key=value` words and `.id=*A` is how one row is addressed.

This was a real bug, found by this audit. The engine originally passed `numbers`,
which is a *value* property that appears in `print` output. Passing it as a key
asks RouterOS to set a property called "numbers", which either errors or
modifies unintended rows. A mock cannot catch this, and on hardware it would
have been a silent misconfiguration across six code paths.

It is now centralised in one `addressing()` helper, and a test asserts that no
`/set` anywhere in the engine passes `numbers`.

**First thing to check on the first device:** run one `/set` with `.id` and
confirm exactly one row changed.

---

## 3. What the platform refuses to do

Asserted by tests, and worth checking on hardware because "we don't think it does
this" is not the same as "it did not do this":

- [ ] No `/remove` appears in any stage's recorded calls.
- [ ] Existing masquerade on the WAN is **adopted**, not duplicated. Count
      `/ip firewall nat print` rows with `out-interface=<wan>` and
      `action=masquerade` before and after — the count must be unchanged.
- [ ] A legacy `NETISP:`-tagged object is adopted in place and **not renamed**.
      `/system identity print` must still contain the NETISP marker.
- [ ] A HotSpot server on an **unselected** interface is untouched.
- [ ] VLANs, bridges and routes are untouched — no stage reads or writes them.
- [ ] The backup file exists on the router and was never uploaded anywhere.

---

## 4. Hardware test plan — first real router

Record actual results in the Result column. Do not mark a row passed on the
strength of a unit test.

### 4.1 Setup

| # | Test | Expected | Result |
|---|---|---|---|
| 0 | Record RouterOS version and board | Appear in `nodes.routeros_version` / `board_name` | |
| 1 | Run the generated command on the router | Router registers, claims its token, appears in the panel | |
| 2 | Fresh RouterOS 7, full run | All 13 stages settle; session reaches `online` only after the gate agrees | |
| 3 | **Existing WAN** configured beforehand | WAN preserved; one masquerade on it, not two | |
| 4 | **Existing bridge** — bridge the LAN first | Bridge preserved; HotSpot created on the selected bridge or port | |
| 5 | **Existing NAT** — masquerade already present | Adopted in place; count unchanged | |
| 6 | **Existing firewall rules** added first | All still present after provisioning | |
| 7 | **Existing VLANs** with filtering enabled | Untouched | |
| 8 | HotSpot login with a real subscriber | Session established, correct rate limit on the profile | |
| 9 | Read the rate limit in Winbox | Matches the package the ISP sold | |
| 10 | PPPoE dial with a real account | Session established, address inside the resolved range | |
| 11 | RADIUS authentication | `Access-Accept` in the FreeRADIUS log; no silent local fallback | |
| 12 | RADIUS accounting | `Accounting-Start`/`Stop` arrive; duration correct | |
| 13 | Change a package speed, re-run sync | Router shows the new limit; **no redeploy** | |
| 14 | Customer sync | Active subscribers present; **suspended/expired are not**; no payment record changed | |
| 15 | Heartbeat | `nodes.last_heartbeat_at` advances; router appears online | |
| 16 | **Reconfigure** — run provisioning a second time | No duplicates. Compare `/ip hotspot print`, `/ip firewall nat print`, `/ppp profile print` counts before and after — identical | |
| 17 | **Sync** on an already-provisioned router | Reports "already present", writes nothing | |
| 18 | **Worker restart** mid-run (kill it during RADIUS) | Resumes at RADIUS; completed stages untouched | |
| 19 | **Router disconnect / reconnect** (power cycle) | Session preserved; not marked online while unreachable; reconnects on its own | |
| 20 | **Legacy NETISP router** | NETISP objects adopted, not renamed; no duplicates | |

### 4.2 Safety

| # | Test | Expected | Result |
|---|---|---|---|
| 21 | **Lockout attempt** — assign every port to a customer service | **REFUSED**, message naming the ports at risk and a remedy | |
| 22 | Lockout override with no verified out-of-band path | **STILL REFUSED** | |
| 23 | Lockout override WITH a verified console server | Permitted, and the override is recorded | |

### 4.3 Capability and failure paths

| # | Test | Expected | Result |
|---|---|---|---|
| 24 | RouterOS 6, optional tunnel | `secure_tunnel` = `unsupported`, run continues, router reaches online | |
| 25 | RouterOS 6, tunnel **required** | `secure_tunnel` = **failed**, run stops, router **not** online | |
| 26 | Low-memory router (RB941/RB951) | Provisioning completes; heartbeat uses the long interval, not 30s | |
| 27 | RADIUS unreachable, RADIUS required | RADIUS stage **fails**; router **not** reported healthy | |
| 28 | Backup fails (fill the router's storage) | Backup stage fails; **nothing else was changed** | |
| 29 | Package with an unreadable speed (`"fast"`) | `package_sync` **fails**, names the package; no profile written | |

### 4.4 Package → profile spot checks

Read these values in Winbox against a real router:

| Package in the dashboard | Expected `rate-limit` |
|---|---|
| 5 Mbps / 2 Mbps | `5M/2M` |
| 20 Mbps / 10 Mbps | `20M/10M` |
| 100 Mbps / 100 Mbps | `100M` |
| 1 Gbps / 1 Gbps | `1G` |
| 512 Kbps / 256 Kbps | `500k/250k` |

**Not** `1G` for 100 Mbps. **Not** `10G` for 1 Gbps. **Not** `20MM/10MM`.

---

## 5. If a stage fails on hardware

Every stage records the RouterOS calls it made, sanitised, in its
`provisioning_stages.detail` column. Each entry has:

```
{ at, command, operation, params, ok, rows, durationMs, error }
```

Credential values are replaced with `[redacted]` **before** the record is built —
passwords, API secrets, RADIUS shared secrets, WireGuard keys, subscriber
credentials and tokens. Keys are kept, so `"password": "[redacted]"` tells you a
credential was sent and rejected, without exposing it.

To diagnose: open the stage's `detail`, find the entry with `ok: false`, read
`command` + `params` + `error`. That is the exact call that failed.

---

## 6. What is and is not known

**Tested (against mocks):** stage ordering and resume, the ONLINE gate, lockout
refusal and its override, package→profile formatting, object-name sanitisation,
secret redaction, pool-resolution arithmetic, WireGuard capability classification,
tenant isolation, legacy-tag adoption, and that no stage issues a `/remove`.

**Not tested:** every RouterOS path, property name, error string and firmware
difference in this document. The confidence column is an estimate from the API
reference, not a result.

---

## 7. RouterOS 6 / 7 compatibility matrix

Derived from `supabase/functions/_shared/compat.ts`, which is the platform's
existing authority on this. "Behaviour" is what provisioning does when the
feature is unavailable on the selected configuration.

| Feature | ROS6 | ROS7 | Minimum | Behaviour when unavailable |
|---|---|---|---|---|
| REST | no | yes | 7.1 | Not used by the worker. Panel falls back to API. |
| API | yes | yes | all | **REQUIRED.** Absent → connectivity stage FAILS. |
| API-SSL | 6.49+ | yes | 6.49 | Optional; falls back to plain API, and the fact is recorded. |
| WireGuard | no | yes | 7.1 | Optional → `unsupported`. **Required → FAILED.** |
| HotSpot | yes | yes | all | Optional → `unsupported`. **Selected → FAILED** if absent. |
| PPPoE | yes | yes | all | Optional → `unsupported`. **Selected → FAILED** if absent. |
| RADIUS | yes | yes | all | **Required → FAILED**, including when no secret is stored. |
| Firewall / NAT | yes | yes | all | Required; failure stops the run. |
| Bridge | yes | yes | all | Read only. Never written by provisioning. |
| VLAN filtering | 6.41+ | yes | 6.41 | Read only. Never written by provisioning. |
| Scheduler | yes | yes | all | Optional → `unsupported`; the worker still polls. |
| `/ip pool` | yes | yes | all | Required for PPPoE/HotSpot allocation; no pool → stage FAILS. |
| `/ip address` | yes | yes | all | Read only, for context. |
| `/system/backup/save` | yes | yes | all | **Required.** Failure stops the run before anything changes. |

The rule this matrix encodes, and the one the code enforces: a REQUIRED feature
that is unavailable **FAILS**; an OPTIONAL one is **SKIPPED/UNSUPPORTED**; and
neither is ever allowed to become "success" and reach ONLINE.

### Two ambiguities the hardware test must settle

1. **How does a RouterOS 6 box answer `/interface/wireguard/print`?** The code now
   treats "rejects the path" and "answers with an empty list" differently — an
   old firmware answering with an empty list is classified unsupported using the
   version as a second signal — but the real behaviour is unverified.
2. **Does `/ip/pool/print` return `ranges` bare, or with a prefix?** The parser
   accepts `10.0.0.2-10.0.0.100` and comma-separated lists, and rejects anything
   else rather than guessing. If RouterOS emits something else, the parser will
   refuse the pool and PPPoE will fail visibly rather than silently.
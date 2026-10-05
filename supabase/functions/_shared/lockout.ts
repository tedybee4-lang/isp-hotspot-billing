// =============================================================================
//  Management lockout detection.
//
//  This is the check that stops ISPFlow locking an ISP out of its own router.
//
//  The failure it prevents is specific and expensive: an ISP picks "WAN,
//  HotSpot on ether2, PPPoE on ether3", every free port gets consumed, and the
//  only interface that could reach the router is now a HotSpot server that
// needs the router to be reachable in order to authenticate. From the ISP's
//  side the router has vanished, and because provisioning runs from the
//  router's own terminal it may be unrecoverable without physical access.
//
//  The rule is not "warn sometimes". A configuration that would leave the
//  operator with NO way back is refused, and the only way past it is a
//  replacement path that has been checked to exist.
//
//  Everything here works from DISCOVERED state, never from assumptions. A port
//  is "management" because it holds a management address or belongs to the
//  bridge that does - not because it is called ether1.
// =============================================================================

export interface DiscoveredInterface {
  name: string
  type?: string
  running?: boolean | string
  disabled?: boolean | string
  comment?: string | null
}

export interface DiscoveredAddress {
  address: string
  interface: string
  network?: string
}

export interface DiscoveredBridge {
  name: string
}

/**
 * A port assignment the ISP has chosen.
 *
 * `management` is explicit and separate from `lan`, because "this port is LAN"
 * and "this port is how I reach the box" are different claims, and conflating
 * them is what removes the way back.
 */
export interface PortSelection {
  wan: string | null
  hotspot: string[]
  pppoe: string[]
  management: string[]
  /** Set only when an administrator has explicitly overridden the refusal. */
  acceptLockout?: boolean
  /**
   * The out-of-band way back in, offered in exchange for the acceptance.
   *
   * An override is only honoured when this describes a path that has been
   * verified to exist. The alternatives are all real - a second Ethernet
   * segment to the LAN bridge, an existing out-of-band console server, an
   * ISP technician on site - and each of them leaves the router reachable
   * without depending on the configuration being applied. `verified` is the
   * operator asserting they have checked it, and it is recorded.
   */
  replacementPath?: {
    kind: 'second-lan-segment' | 'console-server' | 'on-site' | 'none'
    /** Must be true for the override to count. */
    verified?: boolean
    note?: string
  }
}

export interface LockoutAssessment {
  safe: boolean
  managementAfter: string[]
  losingManagement: string[]
  /** The reason, phrased for an ISP rather than an engineer. */
  message: string | null
  remedy: string | null
}

const truthy = (v: unknown): boolean => v === true || v === 'true' || v === 'yes'

/** The ports that carry a usable management address today. */
export function managementPorts(
  interfaces: DiscoveredInterface[],
  addresses: DiscoveredAddress[],
  bridges: DiscoveredBridge[],
): Set<string> {
  const out = new Set<string>()
  const bridgeNames = new Set(bridges.map((b) => b.name))

  // An address on a bridge is an address on the LAN, and that is management for
  // a router reached from the LAN - overwhelmingly the common case.
  for (const addr of addresses) {
    if (!addr.interface || addr.interface === 'lo') continue
    const iface = interfaces.find((i) => i.name === addr.interface)
    if (truthy(iface?.disabled)) continue
    if (bridgeNames.has(addr.interface) || iface?.type === 'bridge') {
      out.add(addr.interface)
    }
  }
  // A port commented as management is treated as management even without an
  // address: operators label these, and the label is the strongest signal
  // available about intent.
  for (const iface of interfaces) {
    if (/\b(mgmt|management|admin)\b/.test((iface.comment ?? '').toLowerCase())) {
      out.add(iface.name)
    }
  }
  return out
}

/**
 * Would this assignment leave the operator with a way back in?
 *
 * A port survives as management when it is NOT assigned to a customer service
 * and the operator has nominated it. WAN is deliberately excluded: the upstream
 * link is how the router reaches the internet, not how a human reaches the
 * router.
 */
export function assessLockout(
  selection: PortSelection,
  discovered: {
    interfaces: DiscoveredInterface[]
    addresses?: DiscoveredAddress[]
    bridges?: DiscoveredBridge[]
  },
): LockoutAssessment {
  const current = managementPorts(
    discovered.interfaces,
    discovered.addresses ?? [],
    discovered.bridges ?? [],
  )

  const consumed = new Set<string>([...selection.hotspot, ...selection.pppoe])
  if (selection.wan) consumed.add(selection.wan)

  const nominated = new Set(
    selection.management.filter(
      (n) => discovered.interfaces.some((i) => i.name === n && !truthy(i.disabled)),
    ),
  )
  // A current management port survives only if it is BOTH kept and nominated:
  // keeping it silently while the operator nominated something else would leave
  // the real path in a state nobody intends.
  const surviving = new Set<string>()
  for (const port of nominated) {
    if (!consumed.has(port)) surviving.add(port)
  }
  for (const port of current) {
    if (!consumed.has(port) && nominated.has(port)) surviving.add(port)
  }

  const losing = [...current].filter((p) => consumed.has(p))
  const unassigned = discovered.interfaces
    .filter((i) => !truthy(i.disabled))
    .map((i) => i.name)
    .filter((p) => !consumed.has(p))

  if (surviving.size > 0) {
    return {
      safe: true,
      managementAfter: [...surviving],
      losingManagement: losing,
      message: losing.length
        ? `Port(s) ${losing.join(', ')} currently carry management and are being reassigned. ` +
          `Management will be available on ${[...surviving].join(', ')}.`
        : null,
      remedy: null,
    }
  }

  // A path that keeps the router reachable independent of this configuration.
  const replacement =
    selection.replacementPath?.kind !== undefined &&
    selection.replacementPath.kind !== 'none' &&
    selection.replacementPath.verified === true
      ? selection.replacementPath
      : null

  // `acceptLockout` is NOT a bypass on its own. A checkbox that says "I accept
  // that I might lose this router" is not a way back in, and honouring it alone
  // would let one click do irreversible damage on a device the platform may be
  // hundreds of kilometres from. The override counts only alongside a checked
  // out-of-band path; without one the answer stays no, and says why.
  const overridden = selection.acceptLockout === true && replacement !== null

  if (overridden) {
    const why =
      `This configuration removes every in-band way to manage the router, and ` +
      `proceeding is only possible because you confirmed a ` +
      `${replacement!.kind.replace(/-/g, ' ')} is in place.`
    return {
      safe: true,
      managementAfter: [],
      losingManagement: losing,
      message:
        (losing.length
          ? `Port(s) ${losing.join(', ')} currently carry management and are being reassigned. `
          : 'No nominated management port exists on this router. ') +
        why +
        (replacement!.note ? ` (${replacement!.note})` : ''),
      remedy: null,
    }
  }

  return {
    safe: false,
    managementAfter: [],
    losingManagement: losing,
    message:
      'This configuration would remove every way to manage the router. ' +
      (losing.length
        ? `Port(s) ${losing.join(', ')} currently carry management and are being reassigned.`
        : 'No nominated management port exists on this router.') +
      (selection.acceptLockout === true
        ? ' Ticking "accept" is not enough on its own: confirm a way to reach ' +
          'the router that does not depend on this configuration, such as a ' +
          'second segment to the LAN bridge or a console server.'
        : ''),
    remedy: unassigned.length
      ? `Leave at least one port for management. Unassigned ports available: ${unassigned.join(', ')}.`
      : 'Every port on this router is assigned. Free one up, or use a router with more ports, ' +
        'before applying a configuration that changes management.',
  }
}
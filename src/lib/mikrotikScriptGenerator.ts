import type { HotspotPlan } from '../data/mockData';

/**
 * RouterOS script generator adapted from the provisioning patterns in the
 * uploaded ISP Billing Backend:
 * - WAN is never allowed into the customer bridge.
 * - Customer ports are moved into a dedicated bridge.
 * - DHCP gives the router gateway as DNS so HotSpot interception works.
 * - NAT is tied to the selected WAN.
 * - HotSpot and PPPoE objects are created idempotently.
 * - All platform-owned objects use an ISPFlow comment/tag.
 * - No reset, default bridge deletion, or destructive "clean slate" is used.
 *
 * This module generates a pasteable .rsc file for RouterOS 6 and 7.
 */

export interface MikrotikConfigParams {
  hotspotInterface: string;
  wanInterface: string;
  hotspotIP: string;
  hotspotNetmask: string;
  dhcpPoolStart: string;
  dhcpPoolEnd: string;
  dnsServer1: string;
  dnsServer2: string;
  hotspotProfileName: string;
  hotspotServerName: string;
  dnsName: string;
  loginPage: string;
  sessionTimeout: string;
  systemIdentity: string;
  adminPassword: string;
  timezone: string;
  ntpServer: string;
  enableQueues: boolean;
  enableFirewall: boolean;
  enableNAT: boolean;
  enableWalledGarden: boolean;

  /** Comma-separated customer ports/interfaces. Example: ether2,wlan1 */
  clientInterfaces?: string;
  /** Interface that will run the PPPoE server when enabled. */
  pppoeInterface?: string;
  enablePppoe?: boolean;
  bridgeName?: string;
  pppoePoolStart?: string;
  pppoePoolEnd?: string;
  radiusServer?: string;
  radiusSecret?: string;
  radiusEnabled?: boolean;
  captivePortalHost?: string;
}

function rosQuote(value: string): string {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/\"/g, '\\"')}"`;
}

function cleanName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function parseIPv4(value: string): [number, number, number, number] {
  const parts = value.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${value}`);
  }
  return parts as [number, number, number, number];
}

function ipToInt(parts: [number, number, number, number]): number {
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function intToIp(value: number): string {
  const n = value >>> 0;
  return [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ].join('.');
}

function networkOf(ip: string, prefix: number): string {
  const n = ipToInt(parseIPv4(ip));
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp(n & mask);
}

function validatePrefix(prefix: number): number {
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 30) {
    throw new Error(`Unsupported IPv4 prefix: /${prefix}. Use /1-/30 for a client network.`);
  }
  return prefix;
}

function parseGateway(value: string, fallbackPrefix: string): { ip: string; prefix: number } {
  const raw = value.trim();
  const [ip, prefixText] = raw.split('/');
  const prefix = validatePrefix(Number(prefixText || fallbackPrefix));
  parseIPv4(ip);
  return { ip, prefix };
}

function compareIPv4(a: string, b: string): number {
  const pa = parseIPv4(a);
  const pb = parseIPv4(b);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function speedToKbpsInternal(speed: string): number {
  const raw = String(speed ?? '').trim().toLowerCase().replace(',', '.');
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(gbps|gbit|mbps|mbit|kbps|kbit)?/);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = match[2] ?? 'mbps';
  if (unit.startsWith('gb')) return Math.round(n * 1024 * 1024);
  if (unit.startsWith('kb')) return Math.max(1, Math.round(n));
  return Math.max(1, Math.round(n * 1024));
}

/** Exported because the existing plans preview uses the same conversion. */
export function speedToKbps(speed: string): number {
  return speedToKbpsInternal(speed);
}

function rateLimit(plan: HotspotPlan): string {
  const down = speedToKbpsInternal(plan.speedLimit);
  const up = speedToKbpsInternal(plan.uploadLimit || plan.speedLimit);
  return `${Math.max(1, up)}k/${Math.max(1, down)}k`;
}

function profileName(plan: HotspotPlan): string {
  return cleanName(plan.name.toLowerCase(), `plan-${plan.id}`);
}

function poolRange(start: string, end: string): string {
  parseIPv4(start);
  parseIPv4(end);
  return `${start}-${end}`;
}

function hostFromUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname;
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  }
}

function ensureBlock(menu: string, match: string, add: string): string[] {
  return [
    `:if ([:len [${menu} find where ${match}]] = 0) do={`,
    `    ${add}`,
    '};',
  ];
}

function setOrAddBlock(menu: string, match: string, setCommand: string, addCommand: string): string[] {
  return [
    `:local ispflowItem [${menu} find where ${match}];`,
    ':if ([:len $ispflowItem] = 0) do={',
    `    ${addCommand}`,
    '} else={',
    `    ${setCommand}`,
    '};',
  ];
}
export function generateMikrotikScript(
  params: MikrotikConfigParams,
  plans: HotspotPlan[],
): string {
  const hotspot = parseGateway(params.hotspotIP, params.hotspotNetmask);
  const hotspotNetwork = networkOf(hotspot.ip, hotspot.prefix);
  const wan = params.wanInterface.trim() || 'ether1';
  const bridge = cleanName(params.bridgeName || 'ispflow-hotspot', 'ispflow-hotspot');
  const hotspotProfile = cleanName(params.hotspotProfileName, 'ispflow-hs-profile');
  const hotspotServer = cleanName(params.hotspotServerName, 'ispflow-hotspot');
  const hotspotPool = 'ispflow-hotspot-pool';
  const pppoePool = 'ispflow-pppoe-pool';
  const pppoeInterface = (params.pppoeInterface || 'ether3').trim();
  const customerInterfaces = (params.clientInterfaces || params.hotspotInterface || 'ether2')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  const dns2 = params.dnsServer2.trim() || '1.1.1.1';
  const hotspotDomain = hostFromUrl(params.dnsName);
  const portalHost = hostFromUrl(params.captivePortalHost || '');
  const radiusEnabled = Boolean(
    params.radiusEnabled && params.radiusServer?.trim() && params.radiusSecret?.trim(),
  );
  const enablePppoe = Boolean(params.enablePppoe);
  const hotspotPlans = plans.filter((p) => p.type === 'hotspot');
  const pppoePlans = plans.filter((p) => p.type === 'fiber');

  // Pool ordering validation (DHCP + PPPoE).

  if (compareIPv4(params.dhcpPoolStart, params.dhcpPoolEnd) > 0) {
    throw new Error(`DHCP pool end "${params.dhcpPoolEnd}" is lower than start "${params.dhcpPoolStart}".`);
  }
  if (enablePppoe && compareIPv4(params.pppoePoolStart || '10.20.0.2', params.pppoePoolEnd || '10.20.3.254') > 0) {
    throw new Error('PPPoE pool end is lower than pool start.');
  }

  // Critical safeguard from the source generator: never bridge the WAN.
  const safeInterfaces = customerInterfaces.filter((name) => name !== wan);
  const wanWasRemoved = safeInterfaces.length !== customerInterfaces.length;
  if (!safeInterfaces.length) {
    throw new Error(`No customer interface remains after excluding WAN "${wan}".`);
  }

  const dns1 = params.dnsServer1.trim() || '8.8.8.8';
  if (params.dnsServer1.trim()) parseIPv4(params.dnsServer1);
  if (params.dnsServer2.trim()) parseIPv4(params.dnsServer2);






  const L: string[] = [
    '# =============================================================================',
    '# ISPFlow MikroTik Provisioning Script',
    '# Generated by the ISPFlow RouterOS generator',
    '# =============================================================================',
    '# SAFETY:',
    '# - WAN is excluded from the customer bridge automatically.',
    '# - The router configuration is never reset by this script.',
    '# - Existing unrelated router configuration is not deleted.',
    '# - ISPFlow-owned objects are identified with comments.',
    '# - Re-running this script is designed to be idempotent.',
    '# =============================================================================',
    '',
    '# -----------------------------------------------------------------------------',
    '# 1. SYSTEM IDENTITY / TIME',
    '# -----------------------------------------------------------------------------',
    `/system identity set name=${rosQuote(params.systemIdentity.trim() || 'ISPFlow-Router')}`,
    '',
    '# RouterOS 7 uses servers=; RouterOS 6 uses primary/secondary. The runtime',
    '# version check keeps this single .rsc compatible with both families.',
    `:if ([:pick [/system resource get version] 0 1] = "7") do={`,
    `    /system ntp client set enabled=yes servers=${params.ntpServer.trim() || 'time.cloudflare.com'},time.google.com`,
    '} else={',
    `    /system ntp client set enabled=yes primary-ntp=${rosQuote(params.ntpServer.trim() || 'pool.ntp.org')} secondary-ntp=time.google.com`,
    '};',
    '',
    `:do { /system clock set time-zone-name=${rosQuote(params.timezone.trim() || 'Africa/Nairobi')} } on-error={`,
    '    :do { /system clock set time-zone-autodetect=yes } on-error={};',
    '};',
    '',
    '# -----------------------------------------------------------------------------',
    '# 2. CUSTOMER BRIDGE — WAN-SAFE',
    '# -----------------------------------------------------------------------------',
    `# WAN selected: ${wan}`,
    `# Customer interfaces: ${safeInterfaces.join(', ')}`,
    wanWasRemoved ? `# WARNING: WAN "${wan}" was removed from the requested bridge list.` : '# WAN was not present in the customer bridge list.',
    ...ensureBlock(
      '/interface bridge',
      `name=${rosQuote(bridge)}`,
      `/interface bridge add name=${rosQuote(bridge)} comment=${rosQuote('ISPFlow:customer-bridge')}`,
    ),
    `:do { /interface bridge settings set [find bridge=${rosQuote(bridge)}] use-ip-firewall=yes } on-error={};`,
    '',
  ];

  for (const port of safeInterfaces) {
    L.push(
      `# Move ${port} into the ISPFlow customer bridge. WAN ${wan} is never moved.`,
      `:do { /interface bridge port remove [find where interface=${rosQuote(port)}] } on-error={};`,
      ...ensureBlock(
        '/interface bridge port',
        `interface=${rosQuote(port)}`,
        `/interface bridge port add interface=${rosQuote(port)} bridge=${rosQuote(bridge)} hw=no comment=${rosQuote('ISPFlow:customer-port')}`,
      ),
      '',
    );
  }

  L.push(
    '# -----------------------------------------------------------------------------',
    '# 3. HOTSPOT GATEWAY / IP POOL / DHCP / DNS',
    '# -----------------------------------------------------------------------------',
    ...setOrAddBlock(
      '/ip address',
      `address=${rosQuote(`${hotspot.ip}/${hotspot.prefix}`)}`,
      `/ip address set $ispflowItem interface=${rosQuote(bridge)} comment=${rosQuote('ISPFlow:hotspot-gateway')}`,
      `/ip address add address=${rosQuote(`${hotspot.ip}/${hotspot.prefix}`)} interface=${rosQuote(bridge)} comment=${rosQuote('ISPFlow:hotspot-gateway')}`,
    ),
    ...ensureBlock(
      '/ip pool',
      `name=${rosQuote(hotspotPool)}`,
      `/ip pool add name=${rosQuote(hotspotPool)} ranges=${rosQuote(poolRange(params.dhcpPoolStart, params.dhcpPoolEnd))} comment=${rosQuote('ISPFlow:hotspot-pool')}`,
    ),
    `/ip dns set servers=${dns1},${dns2} allow-remote-requests=yes`,
    ...ensureBlock(
      '/ip dhcp-server network',
      `comment=${rosQuote('ISPFlow:hotspot-dhcp-network')}`,
      `/ip dhcp-server network add address=${rosQuote(hotspotNetwork + '/' + hotspot.prefix)} gateway=${rosQuote(hotspot.ip)} dns-server=${rosQuote(hotspot.ip)} comment=${rosQuote('ISPFlow:hotspot-dhcp-network')}`,
    ),
    ...ensureBlock(
      '/ip dhcp-server',
      `name=${rosQuote('ispflow-hotspot-dhcp')}`,
      `/ip dhcp-server add name=${rosQuote('ispflow-hotspot-dhcp')} interface=${rosQuote(bridge)} address-pool=${rosQuote(hotspotPool)} lease-time=1h disabled=no comment=${rosQuote('ISPFlow:hotspot-dhcp')}`,
    ),
    '',
    '# DNS static entry keeps the captive portal hostname on the gateway.',
    ...(hotspotDomain
      ? ensureBlock(
          '/ip dns static',
          `name=${rosQuote(hotspotDomain)}`,
          `/ip dns static add name=${rosQuote(hotspotDomain)} address=${rosQuote(hotspot.ip)} comment=${rosQuote('ISPFlow:captive-portal-dns')}`,
        )
      : []),
    '',
    '# -----------------------------------------------------------------------------',
    '# 4. WAN DHCP + NAT',
    '# -----------------------------------------------------------------------------',
    ...ensureBlock(
      '/ip dhcp-client',
      `interface=${rosQuote(wan)}`,
      `/ip dhcp-client add interface=${rosQuote(wan)} disabled=no comment=${rosQuote('ISPFlow:wan-dhcp')}`,
    ),
  );

  if (params.enableNAT) {
    L.push(
      ...ensureBlock(
        '/ip firewall nat',
        `comment=${rosQuote('ISPFlow:masquerade')}`,
        `/ip firewall nat add chain=srcnat action=masquerade out-interface=${rosQuote(wan)} comment=${rosQuote('ISPFlow:masquerade')}`,
      ),
    );
  }
  L.push(
    '',
    '# -----------------------------------------------------------------------------',
    '# 5. HOTSPOT',
    '# -----------------------------------------------------------------------------',
    ...setOrAddBlock(
      '/ip hotspot profile',
      `name=${rosQuote(hotspotProfile)}`,
      `/ip hotspot profile set $ispflowItem hotspot-address=${rosQuote(hotspot.ip)} dns-name=${rosQuote(hotspotDomain || 'hotspot.local')} html-directory=hotspot login-by=http-pap,http-chap,mac-cookie http-cookie-lifetime=1d use-radius=${radiusEnabled ? 'yes' : 'no'} comment=${rosQuote('ISPFlow:hotspot-profile')}`,
      `/ip hotspot profile add name=${rosQuote(hotspotProfile)} hotspot-address=${rosQuote(hotspot.ip)} dns-name=${rosQuote(hotspotDomain || 'hotspot.local')} html-directory=hotspot login-by=http-pap,http-chap,mac-cookie http-cookie-lifetime=1d use-radius=${radiusEnabled ? 'yes' : 'no'} comment=${rosQuote('ISPFlow:hotspot-profile')}`,
    ),
    ...setOrAddBlock(
      '/ip hotspot',
      `name=${rosQuote(hotspotServer)}`,
      `/ip hotspot set $ispflowItem interface=${rosQuote(bridge)} address-pool=${rosQuote(hotspotPool)} profile=${rosQuote(hotspotProfile)} disabled=no`,
      `/ip hotspot add name=${rosQuote(hotspotServer)} interface=${rosQuote(bridge)} address-pool=${rosQuote(hotspotPool)} profile=${rosQuote(hotspotProfile)} disabled=no comment=${rosQuote('ISPFlow:hotspot-server')}`,
    ),
    `:do { /ip hotspot ip-binding add address=${rosQuote(hotspot.ip)} type=bypassed comment=${rosQuote('ISPFlow:gateway-bypass')} } on-error={};`,
    '',
  );

  // HotSpot profiles are created/updated from the plans. This is what makes the
  // generated script useful to the billing platform instead of a demo-only AP.
  for (const plan of hotspotPlans) {
    const name = profileName(plan);
    const rate = rateLimit(plan);
    const shared = Math.max(1, Math.floor(plan.sharedUsers || 1));
    const durationHours = Math.max(0, Math.floor(plan.durationHours || 0));
    const session = durationHours > 0 ? `${String(durationHours).padStart(2, '0')}:00:00` : 'none';
    L.push(
      `# HotSpot plan: ${plan.name}`,
      ...setOrAddBlock(
        '/ip hotspot user profile',
        `name=${rosQuote(name)}`,
        `/ip hotspot user profile set $ispflowItem rate-limit=${rosQuote(rate)} shared-users=${shared} session-timeout=${session} address-pool=${rosQuote(hotspotPool)} comment=${rosQuote(`ISPFlow:plan:${plan.id}`)}`,
        `/ip hotspot user profile add name=${rosQuote(name)} rate-limit=${rosQuote(rate)} shared-users=${shared} session-timeout=${session} address-pool=${rosQuote(hotspotPool)} comment=${rosQuote(`ISPFlow:plan:${plan.id}`)}`,
      ),
      '',
    );
  }

  if (params.enableWalledGarden) {
    const hosts = new Set<string>([
      hotspotDomain,
      portalHost,
      '*.safaricom.co.ke',
      '*.mpesa.co.ke',
      '*.mpesa.in',
      '*.payhero.co.ke',
      '*.supabase.co',
    ].filter(Boolean));
    L.push(
      '# -----------------------------------------------------------------------------',
      '# 6. WALLED GARDEN / PRE-AUTH ACCESS',
      '# -----------------------------------------------------------------------------',
    );
    for (const host of hosts) {
      L.push(
        ...ensureBlock(
          '/ip hotspot walled-garden',
          `dst-host=${rosQuote(host)}`,
          `/ip hotspot walled-garden add dst-host=${rosQuote(host)} action=allow comment=${rosQuote('ISPFlow:portal')}`,
        ),
      );
    }
    L.push(
      `:do { /ip hotspot walled-garden ip add dst-address=0.0.0.0/0 protocol=udp dst-port=53 action=accept comment=${rosQuote('ISPFlow:dns')}; } on-error={};`,
      `:do { /ip hotspot walled-garden ip add dst-address=0.0.0.0/0 protocol=tcp dst-port=53 action=accept comment=${rosQuote('ISPFlow:dns')}; } on-error={};`,
      '',
    );
  }

  if (enablePppoe) {
    L.push(
      '# -----------------------------------------------------------------------------',
      '# 7. PPPoE',
      '# -----------------------------------------------------------------------------',
      `# PPPoE service interface: ${pppoeInterface}`,
      ...ensureBlock(
        '/ip pool',
        `name=${rosQuote(pppoePool)}`,
        `/ip pool add name=${rosQuote(pppoePool)} ranges=${rosQuote(poolRange(params.pppoePoolStart || '10.20.0.2', params.pppoePoolEnd || '10.20.3.254'))} comment=${rosQuote('ISPFlow:pppoe-pool')}`,
      ),
      ...setOrAddBlock(
        '/ppp profile',
        `name=${rosQuote('ispflow-pppoe-profile')}`,
        `/ppp profile set $ispflowItem local-address=${rosQuote('10.20.0.1')} remote-address=${rosQuote(pppoePool)} dns-server=${rosQuote('10.20.0.1')} use-ipv6=no comment=${rosQuote('ISPFlow:pppoe-profile')}`,
        `/ppp profile add name=${rosQuote('ispflow-pppoe-profile')} local-address=${rosQuote('10.20.0.1')} remote-address=${rosQuote(pppoePool)} dns-server=${rosQuote('10.20.0.1')} use-ipv6=no comment=${rosQuote('ISPFlow:pppoe-profile')}`,
      ),
      ...setOrAddBlock(
        '/interface pppoe-server server',
        `service-name=${rosQuote('ispflow-pppoe')}`,
        `/interface pppoe-server server set $ispflowItem interface=${rosQuote(pppoeInterface)} default-profile=${rosQuote('ispflow-pppoe-profile')} disabled=no`,
        `/interface pppoe-server server add service-name=${rosQuote('ispflow-pppoe')} interface=${rosQuote(pppoeInterface)} default-profile=${rosQuote('ispflow-pppoe-profile')} authentication=pap,chap disabled=no comment=${rosQuote('ISPFlow:pppoe-server')}`,
      ),
      '',
    );

    for (const plan of pppoePlans) {
      const name = profileName(plan);
      L.push(
        `# PPPoE plan profile: ${plan.name}`,
        ...setOrAddBlock(
          '/ppp profile',
          `name=${rosQuote(name)}`,
          `/ppp profile set $ispflowItem rate-limit=${rosQuote(rateLimit(plan))} comment=${rosQuote(`ISPFlow:plan:${plan.id}`)}`,
          `/ppp profile add name=${rosQuote(name)} rate-limit=${rosQuote(rateLimit(plan))} comment=${rosQuote(`ISPFlow:plan:${plan.id}`)}`,
        ),
        '',
      );
    }
  }

  if (radiusEnabled) {
    L.push(
      '# -----------------------------------------------------------------------------',
      '# 8. RADIUS',
      '# -----------------------------------------------------------------------------',
      ...ensureBlock(
        '/radius',
        `comment=${rosQuote('ISPFlow:RADIUS')}`,
        `/radius add service=hotspot,ppp address=${rosQuote(params.radiusServer!.trim())} secret=${rosQuote(params.radiusSecret!.trim())} authentication-port=1812 accounting-port=1813 timeout=3000ms comment=${rosQuote('ISPFlow:RADIUS')}`,
      ),
      '/ppp aaa set use-radius=yes accounting=yes interim-update=5m',
      '/radius incoming set accept=yes port=3799',
      '',
    );
  }

  if (params.enableFirewall) {
    L.push(
      '# -----------------------------------------------------------------------------',
      '# 9. SAFE FIREWALL BASELINE',
      '# -----------------------------------------------------------------------------',
      '# Deliberately no blanket DROP rule: this generator must not lock the operator out.',
      ...ensureBlock(
        '/ip firewall filter',
        `comment=${rosQuote('ISPFlow:established')}`,
        `/ip firewall filter add chain=input connection-state=established,related action=accept comment=${rosQuote('ISPFlow:established')}`,
      ),
      ...ensureBlock(
        '/ip firewall filter',
        `comment=${rosQuote('ISPFlow:icmp')}`,
        `/ip firewall filter add chain=input protocol=icmp action=accept comment=${rosQuote('ISPFlow:icmp')}`,
      ),
      ...ensureBlock(
        '/ip firewall filter',
        `comment=${rosQuote('ISPFlow:dhcp')}`,
        `/ip firewall filter add chain=input in-interface=${rosQuote(bridge)} protocol=udp dst-port=67-68 action=accept comment=${rosQuote('ISPFlow:dhcp')}`,
      ),
      ...ensureBlock(
        '/ip firewall filter',
        `comment=${rosQuote('ISPFlow:dns')}`,
        `/ip firewall filter add chain=input in-interface=${rosQuote(bridge)} protocol=udp dst-port=53 action=accept comment=${rosQuote('ISPFlow:dns')}`,
      ),
      ...ensureBlock(
        '/ip firewall filter',
        `comment=${rosQuote('ISPFlow:api-lan')}`,
        `/ip firewall filter add chain=input in-interface=${rosQuote(bridge)} protocol=tcp dst-port=8728,8729 action=accept comment=${rosQuote('ISPFlow:api-lan')}`,
      ),
      ...ensureBlock(
        '/ip firewall filter',
        `comment=${rosQuote('ISPFlow:api-wan-drop')}`,
        `/ip firewall filter add chain=input in-interface=${rosQuote(wan)} protocol=tcp dst-port=8728,8729 action=drop comment=${rosQuote('ISPFlow:api-wan-drop')}`,
      ),
      '',
    );
  }

  if (params.enableQueues) {
    L.push(
      '# -----------------------------------------------------------------------------',
      '# 10. GLOBAL HOTSPOT QUEUE',
      '# -----------------------------------------------------------------------------',
      ...ensureBlock(
        '/queue simple',
        `comment=${rosQuote('ISPFlow:hotspot-global')}`,
        `/queue simple add name=${rosQuote('ISPFlow-HotSpot-Global')} target=${rosQuote(hotspotNetwork + '/' + hotspot.prefix)} max-limit=100M/100M comment=${rosQuote('ISPFlow:hotspot-global')}`,
      ),
      '',
    );
  }

  // Management services are opened only for the API the billing platform needs.
  // Winbox remains untouched so the operator's existing access policy is preserved.
  L.push(
    '# -----------------------------------------------------------------------------',
    '# 11. MANAGEMENT API',
    '# -----------------------------------------------------------------------------',
    ':do { /ip service set [find name="api"] disabled=no port=8728 } on-error={};',
    ':do { /ip service set [find name="api-ssl"] disabled=no port=8729 } on-error={};',
    '',
    '# -----------------------------------------------------------------------------',
    '# 12. OPTIONAL ADMIN PASSWORD',
    '# -----------------------------------------------------------------------------',
    '# The UI default is blank. A password is only changed when the operator explicitly enters one.',
    ...(params.adminPassword.trim()
      ? [`:do { /user set [find name="admin"] password=${rosQuote(params.adminPassword.trim())} } on-error={};`]
      : ['# No admin password was supplied; existing credentials are untouched.']),
    '',
    '# -----------------------------------------------------------------------------',
    '# 13. VERIFICATION',
    '# -----------------------------------------------------------------------------',
    '/system resource print',
    '/interface print',
    `/interface bridge print where name=${rosQuote(bridge)}`,
    `/ip address print where interface=${rosQuote(bridge)}`,
    `/ip route print where dst-address=0.0.0.0/0`,
    `/ip dhcp-server print where name=${rosQuote('ispflow-hotspot-dhcp')}`,
    `/ip hotspot print where name=${rosQuote(hotspotServer)}`,
    enablePppoe ? `/interface pppoe-server server print where service-name=${rosQuote('ispflow-pppoe')}` : '# PPPoE disabled.',
    '',
    '# =============================================================================',
    '# ISPFlow PROVISIONING COMPLETE',
    '# =============================================================================',
    '# WAN: ' + wan,
    '# HotSpot bridge: ' + bridge,
    '# HotSpot clients: ' + safeInterfaces.join(', '),
    '# HotSpot gateway: ' + hotspot.ip + '/' + hotspot.prefix,
    '# PPPoE: ' + (enablePppoe ? pppoeInterface : 'disabled'),
    '# Plans: ' + plans.length,
    '# =============================================================================',
    '',
  );

  return L.join('\n');
}


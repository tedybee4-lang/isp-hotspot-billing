import { describe, expect, it } from 'vitest';
import { generateMikrotikScript, speedToKbps } from '../lib/mikrotikScriptGenerator';
import type { HotspotPlan } from '../data/mockData';

const plans: HotspotPlan[] = [
  {
    id: 'hs-1',
    name: '15 Mbps',
    duration: '30 days',
    durationHours: 720,
    price: 1500,
    speedLimit: '15 Mbps',
    uploadLimit: '5 Mbps',
    sharedUsers: 1,
    dataLimit: 'Unlimited',
    type: 'hotspot',
  },
  {
    id: 'ppp-1',
    name: '20 Mbps Fiber',
    duration: '30 days',
    durationHours: 720,
    price: 2500,
    speedLimit: '20 Mbps',
    uploadLimit: '10 Mbps',
    sharedUsers: 1,
    dataLimit: 'Unlimited',
    type: 'fiber',
  },
];

const base = {
  hotspotInterface: 'ether2',
  wanInterface: 'ether1',
  hotspotIP: '10.10.0.1',
  hotspotNetmask: '24',
  dhcpPoolStart: '10.10.0.10',
  dhcpPoolEnd: '10.10.0.254',
  dnsServer1: '8.8.8.8',
  dnsServer2: '1.1.1.1',
  hotspotProfileName: 'ispflow-hs-profile',
  hotspotServerName: 'ispflow-hotspot',
  dnsName: 'login.ispflow.net',
  loginPage: 'login.html',
  sessionTimeout: '00:05:00',
  systemIdentity: 'test-router',
  adminPassword: '',
  timezone: 'Africa/Nairobi',
  ntpServer: 'pool.ntp.org',
  enableQueues: true,
  enableFirewall: true,
  enableNAT: true,
  enableWalledGarden: true,
  clientInterfaces: 'ether2,wlan1',
  pppoeInterface: 'ether3',
  enablePppoe: true,
  bridgeName: 'ispflow-hotspot',
  pppoePoolStart: '10.20.0.2',
  pppoePoolEnd: '10.20.3.254',
  radiusEnabled: false,
  radiusServer: '',
  radiusSecret: '',
  captivePortalHost: '',
};

describe('ISPFlow MikroTik generator', () => {
  it('converts plan speeds to RouterOS kbps correctly', () => {
    expect(speedToKbps('15 Mbps')).toBe(15360);
    expect(speedToKbps('1 Gbps')).toBe(1048576);
    expect(speedToKbps('512 Kbps')).toBe(512);
  });

  it('keeps the WAN out of the customer bridge', () => {
    const script = generateMikrotikScript(
      { ...base, clientInterfaces: 'ether1,ether2,wlan1' },
      plans,
    );

    expect(script).toContain('WARNING: WAN "ether1" was removed');
    expect(script).not.toContain('bridge port add interface="ether1"');
    expect(script).toContain('bridge port add interface="ether2"');
    expect(script).toContain('bridge port add interface="wlan1"');
  });

  it('throws when no customer interface remains after removing WAN', () => {
    expect(() =>
      generateMikrotikScript({ ...base, clientInterfaces: 'ether1' }, plans),
    ).toThrow(/No customer interface remains after excluding WAN "ether1"/);
  });
  it('respects a custom WAN interface', () => {
    const script = generateMikrotikScript(
      { ...base, wanInterface: 'ether2', clientInterfaces: 'ether1,wlan1' },
      plans,
    );
    expect(script).not.toContain('bridge port add interface="ether2"');
    expect(script).toContain('bridge port add interface="ether1"');
    expect(script).toContain('bridge port add interface="wlan1"');
    expect(script).toContain('out-interface="ether2"');
  });

  it('generates DHCP with the router gateway as DNS', () => {
    const script = generateMikrotikScript(base, plans);
    expect(script).toContain('dns-server="10.10.0.1"');
    expect(script).toContain('address="10.10.0.0/24"');
    expect(script).toContain('out-interface="ether1"');
  });

  it('generates HotSpot and PPPoE from plans', () => {
    const script = generateMikrotikScript(base, plans);
    expect(script).toContain('/ip hotspot add name="ispflow-hotspot"');
    expect(script).toContain('rate-limit="5120k/15360k"');
    expect(script).toContain('/interface pppoe-server server add service-name="ispflow-pppoe"');
    expect(script).toContain('rate-limit="10240k/20480k"');
  });

  it('disables PPPoE when enablePppoe is false', () => {
    const script = generateMikrotikScript({ ...base, enablePppoe: false }, plans);
    expect(script).not.toContain('/interface pppoe-server');
    expect(script).not.toContain('/ip pool add name="ispflow-pppoe-pool"');
    expect(script).not.toContain('/ppp profile add name="ispflow-pppoe-profile"');
  });

  it('configures RADIUS only when server and secret are provided', () => {
    const script = generateMikrotikScript(
      { ...base, radiusEnabled: true, radiusServer: '10.5.5.5', radiusSecret: 's3cr3t' },
      plans,
    );
    expect(script).toContain('/radius add service=hotspot,ppp');
    expect(script).toContain('secret="s3cr3t"');
    expect(script).toContain('ISPFlow:RADIUS');
  });

  it('does not emit RADIUS without a server or secret', () => {
    const script = generateMikrotikScript(
      { ...base, radiusEnabled: true, radiusServer: '', radiusSecret: '' },
      plans,
    );
    expect(script).not.toContain('/radius add');
    expect(script).not.toContain('ISPFlow:RADIUS');
  });

  it('does not emit a hard-coded admin password', () => {
    const script = generateMikrotikScript(base, plans);
    expect(script).not.toContain('Ultr@F@ib@2026!');
    expect(script).not.toContain('ULTRAFAIBA ISP');
    expect(script).toContain('No admin password was supplied');
  });

  it('validates IPv4 addresses', () => {
    expect(() => generateMikrotikScript({ ...base, hotspotIP: '999.1.1.1' }, plans)).toThrow(/Invalid IPv4 address/);
    expect(() => generateMikrotikScript({ ...base, dnsServer1: '1.2.3' }, plans)).toThrow(/Invalid IPv4 address/);
  });

  it('validates subnet prefixes', () => {
    expect(() => generateMikrotikScript({ ...base, hotspotNetmask: '33' }, plans)).toThrow(/Unsupported IPv4 prefix/);
    expect(() => generateMikrotikScript({ ...base, hotspotNetmask: '0' }, plans)).toThrow(/Unsupported IPv4 prefix/);
  });

  it('validates DHCP pool ordering', () => {
    expect(() =>
      generateMikrotikScript({ ...base, dhcpPoolStart: '10.10.0.200', dhcpPoolEnd: '10.10.0.10' }, plans),
    ).toThrow();
  });

  it('does not reset the router', () => {
    const script = generateMikrotikScript(base, plans);
    expect(script).not.toContain('/system reset-configuration');
  });

  it('never places the WAN in bridge ports', () => {
    const script = generateMikrotikScript(
      { ...base, wanInterface: 'ether1', clientInterfaces: 'ether1,ether2,wlan1' },
      plans,
    );
    const bridgePorts = script.match(/\/interface bridge port add/g) || [];
    for (const line of bridgePorts) {
      expect(line).not.toContain('interface="ether1"');
    }
  });

  it('is deterministic', () => {
    const a = generateMikrotikScript(base, plans);
    const b = generateMikrotikScript(base, plans);
    expect(a).toBe(b);
  });
});


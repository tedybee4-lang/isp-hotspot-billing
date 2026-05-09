import { useState, useRef } from 'react';
import { Settings, Copy, CheckCircle, Download, Terminal, Shield, Wifi, HardDrive, ChevronDown, ChevronUp, Zap, AlertTriangle } from 'lucide-react';
import { HotspotPlan } from '../data/mockData';

interface MikrotikConfigProps {
  plans: HotspotPlan[];
  darkMode: boolean;
}

interface ConfigParams {
  // Network
  hotspotInterface: string;
  wanInterface: string;
  hotspotIP: string;
  hotspotNetmask: string;
  dhcpPoolStart: string;
  dhcpPoolEnd: string;
  dnsServer1: string;
  dnsServer2: string;
  // Hotspot
  hotspotProfileName: string;
  hotspotServerName: string;
  dnsName: string;
  loginPage: string;
  sessionTimeout: string;
  // System
  systemIdentity: string;
  adminPassword: string;
  timezone: string;
  ntpServer: string;
  // Bandwidth (from plans)
  enableQueues: boolean;
  enableFirewall: boolean;
  enableNAT: boolean;
  enableWalledGarden: boolean;
}

const DEFAULT_PARAMS: ConfigParams = {
  hotspotInterface: 'ether2',
  wanInterface: 'ether1',
  hotspotIP: '10.10.0.1',
  hotspotNetmask: '24',
  dhcpPoolStart: '10.10.0.10',
  dhcpPoolEnd: '10.10.0.254',
  dnsServer1: '8.8.8.8',
  dnsServer2: '8.8.4.4',
  hotspotProfileName: 'ultrafaiba-profile',
  hotspotServerName: 'ultrafaiba-hotspot',
  dnsName: 'login.ultrafaiba.net',
  loginPage: 'login.html',
  sessionTimeout: '00:05:00',
  systemIdentity: 'Ultrafaiba-RB941',
  adminPassword: 'Ultr@F@ib@2026!',
  timezone: 'Africa/Nairobi',
  ntpServer: 'pool.ntp.org',
  enableQueues: true,
  enableFirewall: true,
  enableNAT: true,
  enableWalledGarden: true,
};

function speedToKbps(speed: string): number {
  const num = parseInt(speed);
  return num * 1024; // Mbps to Kbps
}

function generateScript(params: ConfigParams, plans: HotspotPlan[]): string {
  const hotspotPlans = plans.filter(p => p.type === 'hotspot');
  const fiberPlans = plans.filter(p => p.type === 'fiber');
  const allPlans = [...hotspotPlans, ...fiberPlans];

  let script = `# ═══════════════════════════════════════════════════════════════
# ULTRAFAIBA ISP — MikroTik RB941 Auto Configuration Script
# Generated for: ${params.systemIdentity}
# Hotspot Interface: ${params.hotspotInterface} (Port 2)
# WAN Interface: ${params.wanInterface} (Port 1)
# Date: ${new Date().toISOString().split('T')[0]}
# ═══════════════════════════════════════════════════════════════
# WARNING: This script will reset hotspot, IP, DHCP, firewall,
# and queue configurations. Run on a fresh or backed-up router.
# ═══════════════════════════════════════════════════════════════

`;

  // ─── SECTION 1: SYSTEM IDENTITY & BASICS ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 1: SYSTEM IDENTITY & CLOCK
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/system identity set name="${params.systemIdentity}"
/system clock set time-zone-name=${params.timezone}
/system ntp client set enabled=yes
/system ntp client servers add address=${params.ntpServer}

# Set admin password (CHANGE THIS IMMEDIATELY AFTER SETUP)
/user set [find name=admin] password="${params.adminPassword}"

`;

  // ─── SECTION 2: INTERFACE CONFIGURATION ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 2: INTERFACE CONFIGURATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Rename interfaces for clarity
/interface ethernet set [find default-name=${params.wanInterface}] comment="WAN - Uplink to ISP"
/interface ethernet set [find default-name=${params.hotspotInterface}] comment="HOTSPOT - Client Access Port 2"

# Disable unused interfaces (optional - enable if needed)
/interface ethernet set [find default-name=ether3] comment="Available" disabled=no
/interface ethernet set [find default-name=ether4] comment="Available" disabled=no

`;

  // ─── SECTION 3: IP ADDRESS ASSIGNMENT ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 3: IP ADDRESS ASSIGNMENT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Assign hotspot gateway IP on ${params.hotspotInterface}
/ip address add address=${params.hotspotIP}/${params.hotspotNetmask} interface=${params.hotspotInterface} comment="Ultrafaiba Hotspot Gateway"

# Note: WAN (${params.wanInterface}) should get IP via DHCP from upstream ISP or set static
/ip dhcp-client add interface=${params.wanInterface} disabled=no comment="WAN DHCP Client"

`;

  // ─── SECTION 4: DNS CONFIGURATION ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 4: DNS CONFIGURATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/ip dns set servers=${params.dnsServer1},${params.dnsServer2} allow-remote-requests=yes cache-size=2048KiB cache-max-ttl=1w

# Static DNS entry for hotspot login page
/ip dns static add name=${params.dnsName} address=${params.hotspotIP} comment="Hotspot Login Portal DNS"

`;

  // ─── SECTION 5: DHCP SERVER ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 5: DHCP SERVER ON ${params.hotspotInterface.toUpperCase()}
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Create IP Pool for hotspot clients
/ip pool add name=pool-hotspot ranges=${params.dhcpPoolStart}-${params.dhcpPoolEnd}

# DHCP Network definition
/ip dhcp-server network add address=${params.hotspotIP.split('.').slice(0,3).join('.')}.0/${params.hotspotNetmask} gateway=${params.hotspotIP} dns-server=${params.hotspotIP} comment="Ultrafaiba Hotspot Network"

# DHCP Server
/ip dhcp-server add name=dhcp-hotspot interface=${params.hotspotInterface} address-pool=pool-hotspot lease-time=1h disabled=no comment="Hotspot DHCP Server"

`;

  // ─── SECTION 6: NAT / MASQUERADE ───
  if (params.enableNAT) {
    script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 6: NAT / MASQUERADE (Internet Sharing)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/ip firewall nat add chain=srcnat out-interface=${params.wanInterface} action=masquerade comment="Ultrafaiba NAT Masquerade"

`;
  }

  // ─── SECTION 7: HOTSPOT USER PROFILES (BANDWIDTH) ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 7: HOTSPOT USER PROFILES (Bandwidth Control)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Each plan maps to a user profile with rate-limit (upload/download)
# Format: rate-limit="upload/download" in Kbps
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;

  allPlans.forEach(plan => {
    const downloadKbps = speedToKbps(plan.speedLimit);
    const uploadKbps = plan.uploadLimit ? speedToKbps(plan.uploadLimit) : downloadKbps;
    const profileName = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const sessionTime = plan.type === 'hotspot'
      ? `${String(Math.floor(plan.durationHours)).padStart(2, '0')}:00:00`
      : 'none';
    const speedLabel = plan.uploadLimit
      ? `${plan.speedLimit} down / ${plan.uploadLimit} up`
      : `${plan.speedLimit} symmetrical`;

    script += `# Plan: ${plan.name} | ${speedLabel} | ${plan.duration} | ${plan.price.toLocaleString()} BOB | ${plan.sharedUsers} device(s)
/ip hotspot user profile add name="${profileName}" \\
    rate-limit="${uploadKbps}k/${downloadKbps}k" \\
    shared-users=${plan.sharedUsers} \\
    ${plan.type === 'hotspot' ? `session-timeout=${sessionTime} \\` : ''}
    status-autorefresh=1m \\
    idle-timeout=00:10:00 \\
    keepalive-timeout=00:02:00 \\
    address-pool=pool-hotspot \\
    transparent-proxy=no \\
    comment="${plan.name} - ${speedLabel} - ${plan.sharedUsers} device(s) - ${plan.price.toLocaleString()} BOB/${plan.duration}"

`;
  });

  // ─── SECTION 8: HOTSPOT SERVER PROFILE ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 8: HOTSPOT SERVER PROFILE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/ip hotspot profile add name="${params.hotspotProfileName}" \\
    hotspot-address=${params.hotspotIP} \\
    dns-name=${params.dnsName} \\
    html-directory=hotspot \\
    login-by=http-chap,http-pap,cookie \\
    http-cookie-lifetime=3d \\
    split-user-domain=no \\
    use-radius=no \\
    rate-limit="" \\
    comment="Ultrafaiba Hotspot Server Profile"

`;

  // ─── SECTION 9: HOTSPOT SERVER ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 9: HOTSPOT SERVER ON ${params.hotspotInterface.toUpperCase()} (PORT 2)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/ip hotspot add name="${params.hotspotServerName}" \\
    interface=${params.hotspotInterface} \\
    address-pool=pool-hotspot \\
    profile=${params.hotspotProfileName} \\
    idle-timeout=${params.sessionTimeout} \\
    disabled=no \\
    comment="Ultrafaiba Hotspot Server - Port 2"

`;

  // ─── SECTION 10: WALLED GARDEN ───
  if (params.enableWalledGarden) {
    script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 10: WALLED GARDEN (Allow Before Login)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# These sites are accessible WITHOUT authentication
# Useful for payment portals, captive portal assets, etc.

/ip hotspot walled-garden add dst-host="*.safaricom.co.ke" action=allow comment="M-Pesa Payment Gateway"
/ip hotspot walled-garden add dst-host="*.mpesa.in" action=allow comment="M-Pesa API"
/ip hotspot walled-garden add dst-host="${params.dnsName}" action=allow comment="Hotspot Login Portal"
/ip hotspot walled-garden ip add dst-address=0.0.0.0/0 protocol=udp dst-port=53 action=accept comment="Allow DNS Queries"
/ip hotspot walled-garden ip add dst-address=0.0.0.0/0 protocol=tcp dst-port=53 action=accept comment="Allow DNS TCP"

`;
  }

  // ─── SECTION 11: SAMPLE HOTSPOT USERS ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 11: SAMPLE HOTSPOT USERS (Voucher Codes)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# These are sample voucher codes for testing.
# In production, generate via User Manager or Radius.

`;

  hotspotPlans.forEach(plan => {
    const profileName = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const code1 = 'FAIBA-' + Math.floor(1000 + Math.random() * 8999);
    const code2 = 'FAIBA-' + Math.floor(1000 + Math.random() * 8999);
    const code3 = 'FAIBA-' + Math.floor(1000 + Math.random() * 8999);

    script += `# ${plan.name} vouchers (${plan.duration} / ${plan.speedLimit} / ${plan.price.toLocaleString()} BOB)
/ip hotspot user add name="${code1}" password="${code1}" profile="${profileName}" limit-uptime=${String(Math.floor(plan.durationHours)).padStart(2, '0')}:00:00 comment="${plan.name} - ${plan.price.toLocaleString()} BOB"
/ip hotspot user add name="${code2}" password="${code2}" profile="${profileName}" limit-uptime=${String(Math.floor(plan.durationHours)).padStart(2, '0')}:00:00 comment="${plan.name} - ${plan.price.toLocaleString()} BOB"
/ip hotspot user add name="${code3}" password="${code3}" profile="${profileName}" limit-uptime=${String(Math.floor(plan.durationHours)).padStart(2, '0')}:00:00 comment="${plan.name} - ${plan.price.toLocaleString()} BOB"

`;
  });

  // ─── SECTION 12: QUEUES (BANDWIDTH MANAGEMENT) ───
  if (params.enableQueues) {
    script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 12: QUEUE TREE & SIMPLE QUEUES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Global bandwidth limiter for the hotspot interface
# Adjust max-limit based on your upstream bandwidth

/queue simple add name="Ultrafaiba-Global" target=${params.hotspotInterface} max-limit=100M/100M burst-limit=120M/120M burst-threshold=80M/80M burst-time=10s/10s comment="Global Hotspot Bandwidth Cap"

# Per-plan queue types
/queue type add name=ultrafaiba-pcq kind=pcq pcq-rate=0 pcq-classifier=src-address,dst-address pcq-total-limit=2000KiB pcq-burst-rate=0 pcq-burst-threshold=0 pcq-burst-time=10s pcq-limit=50KiB

`;
  }

  // ─── SECTION 13: FIREWALL ───
  if (params.enableFirewall) {
    script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 13: FIREWALL RULES (Security Hardening)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Input Chain — Protect the router itself
/ip firewall filter add chain=input connection-state=established,related action=accept comment="Accept Established/Related"
/ip firewall filter add chain=input connection-state=invalid action=drop comment="Drop Invalid"
/ip firewall filter add chain=input protocol=icmp action=accept comment="Allow ICMP Ping"
/ip firewall filter add chain=input in-interface=${params.hotspotInterface} protocol=tcp dst-port=8291 action=drop comment="Block Winbox from Hotspot Clients"
/ip firewall filter add chain=input in-interface=${params.hotspotInterface} protocol=tcp dst-port=22 action=drop comment="Block SSH from Hotspot Clients"
/ip firewall filter add chain=input in-interface=${params.hotspotInterface} protocol=tcp dst-port=23 action=drop comment="Block Telnet from Hotspot Clients"
/ip firewall filter add chain=input in-interface=${params.hotspotInterface} protocol=tcp dst-port=80 action=accept comment="Allow HTTP for Hotspot Login"
/ip firewall filter add chain=input in-interface=${params.hotspotInterface} protocol=tcp dst-port=443 action=accept comment="Allow HTTPS for Hotspot Login"
/ip firewall filter add chain=input in-interface=${params.wanInterface} action=drop comment="Drop all WAN input (stealth mode)"

# Forward Chain — Protect hotspot clients from each other
/ip firewall filter add chain=forward connection-state=established,related action=accept comment="Accept Established/Related Forward"
/ip firewall filter add chain=forward connection-state=invalid action=drop comment="Drop Invalid Forward"
/ip firewall filter add chain=forward in-interface=${params.hotspotInterface} out-interface=${params.hotspotInterface} action=drop comment="Block Client-to-Client Traffic"
/ip firewall filter add chain=forward in-interface=${params.hotspotInterface} protocol=tcp dst-port=25 action=drop comment="Block SMTP Spam from Clients"

# DDoS Protection — SYN Flood
/ip firewall filter add chain=input protocol=tcp tcp-flags=syn connection-state=new action=jump jump-target=SYN-Protect comment="SYN Flood Protection"
/ip firewall filter add chain=SYN-Protect protocol=tcp tcp-flags=syn limit=400,5:packet action=accept comment="SYN Rate Limit"
/ip firewall filter add chain=SYN-Protect protocol=tcp tcp-flags=syn action=drop comment="Drop Excess SYN"

# Port Scan Detection
/ip firewall filter add chain=input protocol=tcp psd=21,3s,3,1 action=add-src-to-address-list address-list=port-scanners address-list-timeout=2w comment="Detect Port Scanners"
/ip firewall filter add chain=input src-address-list=port-scanners action=drop comment="Drop Port Scanners"

`;
  }

  // ─── SECTION 14: LOGGING ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 14: LOGGING CONFIGURATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/system logging add topics=hotspot action=memory comment="Log Hotspot Events"
/system logging add topics=dhcp action=memory comment="Log DHCP Events"
/system logging add topics=firewall action=memory comment="Log Firewall Events"

`;

  // ─── SECTION 15: SERVICES SECURITY ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 15: DISABLE UNNECESSARY SERVICES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/ip service set telnet disabled=yes
/ip service set ftp disabled=yes
/ip service set api disabled=yes
/ip service set api-ssl disabled=yes
/ip service set ssh port=2200 comment="SSH on non-standard port"
/ip service set winbox port=8291 comment="Winbox access"
/ip service set www port=80 comment="Web management"

# Disable bandwidth test server (prevents abuse)
/tool bandwidth-server set enabled=no

# Disable neighbor discovery on WAN
/ip neighbor discovery-settings set discover-interface-list=none

# Disable MAC access on WAN
/tool mac-server set allowed-interface-list=none
/tool mac-server mac-winbox set allowed-interface-list=none

`;

  // ─── SECTION 16: FINAL NOTES ───
  script += `# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SECTION 16: CONFIGURATION COMPLETE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# ✅ System Identity:    ${params.systemIdentity}
# ✅ Hotspot Interface:  ${params.hotspotInterface} (Port 2)
# ✅ WAN Interface:      ${params.wanInterface} (Port 1)
# ✅ Hotspot IP:         ${params.hotspotIP}/${params.hotspotNetmask}
# ✅ DHCP Pool:          ${params.dhcpPoolStart} - ${params.dhcpPoolEnd}
# ✅ DNS:                ${params.dnsServer1}, ${params.dnsServer2}
# ✅ Login Portal:       ${params.dnsName}
# ✅ Payment Number:     0724167975 (M-Pesa)
#
# NEXT STEPS:
# 1. Upload custom hotspot login page to /hotspot directory
# 2. Test voucher authentication with sample codes above
# 3. Configure RADIUS server for production voucher management
# 4. Set static WAN IP if not using DHCP from upstream
# 5. Backup this configuration: /system backup save name=ultrafaiba
#
# ═══════════════════════════════════════════════════════════════
# Powered by Ultrafaiba Internet Services
# Support: 0724167975 | support@ultrafaiba.net
# ═══════════════════════════════════════════════════════════════
`;

  return script;
}

export default function MikrotikConfig({ plans, darkMode }: MikrotikConfigProps) {
  const [params, setParams] = useState<ConfigParams>(DEFAULT_PARAMS);
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeSection, setActiveSection] = useState<'safe' | 'configure' | 'preview' | 'guide'>('safe');
  const scriptRef = useRef<HTMLTextAreaElement>(null);

  const generatedScript = generateScript(params, plans);
  const lineCount = generatedScript.split('\n').length;

  const handleCopy = () => {
    navigator.clipboard.writeText(generatedScript).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    });
  };

  const handleDownload = () => {
    const blob = new Blob([generatedScript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ultrafaiba-rb941-config-${new Date().toISOString().split('T')[0]}.rsc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateParam = (key: keyof ConfigParams, value: string | boolean) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const inputClass = `w-full text-xs p-2.5 rounded-xl border font-mono ${darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-300 text-slate-800'}`;
  const labelClass = `block text-[11px] font-bold uppercase tracking-wider mb-1 ${darkMode ? 'text-slate-400' : 'text-slate-600'}`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={`rounded-3xl p-6 md:p-8 border ${darkMode ? 'bg-gradient-to-br from-slate-800 to-slate-900 border-slate-700' : 'bg-gradient-to-br from-indigo-50 to-violet-50 border-indigo-200'}`}>
        <div className="flex flex-col md:flex-row items-start md:items-center gap-4 justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl bg-gradient-to-br from-orange-500 to-red-600 text-white shadow-md">
              <HardDrive className="w-6 h-6" />
            </div>
            <div>
              <h2 className={`text-2xl font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>
                MikroTik RB941 Auto Config
              </h2>
              <p className={`text-xs ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                Generate complete RouterOS configuration script for ISP hotspot on Port 2 (ether2)
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-mono px-2.5 py-1 rounded-lg border ${darkMode ? 'bg-slate-800 border-slate-600 text-orange-400' : 'bg-white border-slate-200 text-orange-600'}`}>
              RouterOS v7.x Compatible
            </span>
            <span className={`text-[10px] font-mono px-2.5 py-1 rounded-lg border ${darkMode ? 'bg-slate-800 border-slate-600 text-emerald-400' : 'bg-white border-slate-200 text-emerald-600'}`}>
              RB941-2nD (hAP lite)
            </span>
          </div>
        </div>
      </div>

      {/* Section Tabs */}
      <div className={`p-1.5 rounded-2xl border ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="flex gap-1">
          {[
            { key: 'safe' as const, label: 'Safe Install', icon: Shield },
            { key: 'configure' as const, label: 'Configure Parameters', icon: Settings },
            { key: 'preview' as const, label: `Script Preview (${lineCount} lines)`, icon: Terminal },
            { key: 'guide' as const, label: 'Setup Guide', icon: Zap },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveSection(tab.key)}
              className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                activeSection === tab.key
                  ? 'bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-md'
                  : darkMode ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-50'
              }`}
            >
              <tab.icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ═══ SAFE INSTALL TAB ═══ */}
      {activeSection === 'safe' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-emerald-950/30 border-emerald-800/50' : 'bg-emerald-50 border-emerald-200'} shadow-xs`}>
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-emerald-600 text-white">
                <Shield className="w-5 h-5" />
              </div>
              <div>
                <h3 className={`font-black text-base ${darkMode ? 'text-white' : 'text-emerald-900'}`}>Existing Router Safe Install</h3>
                <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-emerald-100/80' : 'text-emerald-800'}`}>
                  This mode does not change WAN, DHCP, NAT, firewall, or hotspot IP settings. It only prepares the portal files you upload into the existing <code className="font-mono">/hotspot</code> folder.
                </p>
              </div>
            </div>

            <div className={`mt-4 rounded-2xl p-4 border ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-emerald-100'}`}>
              <h4 className={`font-bold text-sm mb-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>Install Steps</h4>
              <ol className={`space-y-2 text-xs leading-relaxed ${darkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                <li>1. Backup the router first: <code className="font-mono">/system backup save name=before-ultrafaiba</code></li>
                <li>2. Open Winbox and connect to your current MikroTik.</li>
                <li>3. Go to <strong>Files</strong> and open the existing <code className="font-mono">hotspot</code> folder.</li>
                <li>4. Upload the new portal files from <code className="font-mono">public/hotspot/</code>.</li>
                <li>5. Do not run the full script if you already have a working config.</li>
                <li>6. Refresh a connected device and the new Ultrafaiba portal will load automatically.</li>
              </ol>
            </div>
          </div>

          <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
            <h3 className={`font-bold text-sm flex items-center gap-2 mb-4 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              <HardDrive className="w-4 h-4 text-orange-500" />
              Files to Upload
            </h3>
            <div className="space-y-3 text-xs">
              {[
                { file: 'login.html', desc: 'Ultrafaiba branded hotspot login page' },
                { file: 'status.html', desc: 'Session status page' },
                { file: 'logout.html', desc: 'Logout / reconnect page' },
                { file: 'style.css', desc: 'Shared portal styling' },
              ].map((item) => (
                <div key={item.file} className={`p-3 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                  <span className={`block font-mono font-bold ${darkMode ? 'text-orange-400' : 'text-orange-600'}`}>{`/hotspot/${item.file}`}</span>
                  <span className={`${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{item.desc}</span>
                </div>
              ))}
            </div>

            <div className={`mt-4 rounded-xl p-4 border ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <p className={`text-[11px] leading-relaxed ${darkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                If your hotspot already works, this is the safest option. Uploading these files will only change the pages users see, not the live internet settings.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ═══ CONFIGURE TAB ═══ */}
      {activeSection === 'configure' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Network Settings */}
          <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs space-y-4`}>
            <h3 className={`font-bold text-sm flex items-center gap-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              <Wifi className="w-4 h-4 text-orange-500" />
              Network Configuration
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Hotspot Interface</label>
                <input type="text" value={params.hotspotInterface} onChange={e => updateParam('hotspotInterface', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>WAN Interface</label>
                <input type="text" value={params.wanInterface} onChange={e => updateParam('wanInterface', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Hotspot Gateway IP</label>
                <input type="text" value={params.hotspotIP} onChange={e => updateParam('hotspotIP', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Subnet Mask (CIDR)</label>
                <input type="text" value={params.hotspotNetmask} onChange={e => updateParam('hotspotNetmask', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>DHCP Pool Start</label>
                <input type="text" value={params.dhcpPoolStart} onChange={e => updateParam('dhcpPoolStart', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>DHCP Pool End</label>
                <input type="text" value={params.dhcpPoolEnd} onChange={e => updateParam('dhcpPoolEnd', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Primary DNS</label>
                <input type="text" value={params.dnsServer1} onChange={e => updateParam('dnsServer1', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Secondary DNS</label>
                <input type="text" value={params.dnsServer2} onChange={e => updateParam('dnsServer2', e.target.value)} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Hotspot Settings */}
          <div className={`p-5 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs space-y-4`}>
            <h3 className={`font-bold text-sm flex items-center gap-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              <Settings className="w-4 h-4 text-violet-500" />
              Hotspot Settings
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Server Profile Name</label>
                <input type="text" value={params.hotspotProfileName} onChange={e => updateParam('hotspotProfileName', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Hotspot Server Name</label>
                <input type="text" value={params.hotspotServerName} onChange={e => updateParam('hotspotServerName', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>DNS Name (Portal)</label>
                <input type="text" value={params.dnsName} onChange={e => updateParam('dnsName', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Idle Timeout</label>
                <input type="text" value={params.sessionTimeout} onChange={e => updateParam('sessionTimeout', e.target.value)} className={inputClass} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>System Identity</label>
                <input type="text" value={params.systemIdentity} onChange={e => updateParam('systemIdentity', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Admin Password</label>
                <input type="text" value={params.adminPassword} onChange={e => updateParam('adminPassword', e.target.value)} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Feature Toggles */}
          <div className={`p-5 rounded-2xl border lg:col-span-2 ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
            <h3 className={`font-bold text-sm flex items-center gap-2 mb-4 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              <Shield className="w-4 h-4 text-emerald-500" />
              Feature Modules
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { key: 'enableQueues' as const, label: 'Bandwidth Queues', desc: 'Global traffic shaping' },
                { key: 'enableFirewall' as const, label: 'Firewall Rules', desc: 'DDoS & security hardening' },
                { key: 'enableNAT' as const, label: 'NAT Masquerade', desc: 'Internet sharing via WAN' },
                { key: 'enableWalledGarden' as const, label: 'Walled Garden', desc: 'M-Pesa & portal bypass' },
              ].map(feat => (
                <label
                  key={feat.key}
                  className={`p-3 rounded-xl border cursor-pointer transition-all ${
                    params[feat.key]
                      ? darkMode ? 'border-emerald-600 bg-emerald-950/30' : 'border-emerald-400 bg-emerald-50'
                      : darkMode ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <input
                      type="checkbox"
                      checked={params[feat.key] as boolean}
                      onChange={e => updateParam(feat.key, e.target.checked)}
                      className="w-3.5 h-3.5 rounded accent-emerald-500"
                    />
                    <span className={`font-bold text-xs ${darkMode ? 'text-white' : 'text-slate-900'}`}>{feat.label}</span>
                  </div>
                  <span className={`text-[10px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{feat.desc}</span>
                </label>
              ))}
            </div>

            {/* Advanced Settings */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`mt-4 flex items-center gap-1 text-xs font-bold ${darkMode ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'}`}
            >
              {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Advanced Settings
            </button>
            {showAdvanced && (
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className={labelClass}>Timezone</label>
                  <input type="text" value={params.timezone} onChange={e => updateParam('timezone', e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>NTP Server</label>
                  <input type="text" value={params.ntpServer} onChange={e => updateParam('ntpServer', e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Login Page File</label>
                  <input type="text" value={params.loginPage} onChange={e => updateParam('loginPage', e.target.value)} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Hotspot CIDR</label>
                  <input type="text" value={`${params.hotspotIP}/${params.hotspotNetmask}`} disabled className={`${inputClass} opacity-60`} />
                </div>
              </div>
            )}
          </div>

          {/* Plans Preview (read-only from mockData) */}
          <div className={`p-5 rounded-2xl border lg:col-span-2 ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
            <h3 className={`font-bold text-sm flex items-center gap-2 mb-3 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              <Zap className="w-4 h-4 text-amber-500" />
              Bandwidth Profiles Generated from Plans
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className={`border-b ${darkMode ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-500'} uppercase tracking-wider text-[10px] font-bold`}>
                    <th className="p-2">Profile Name</th>
                    <th className="p-2">Plan</th>
                    <th className="p-2">Down / Up</th>
                    <th className="p-2">Duration</th>
                    <th className="p-2">Rate Limit (up/down)</th>
                    <th className="p-2">Devices</th>
                    <th className="p-2">Price</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${darkMode ? 'divide-slate-700' : 'divide-slate-100'}`}>
                  {plans.map(plan => {
                    const profileName = plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    const dlKbps = speedToKbps(plan.speedLimit);
                    const ulKbps = plan.uploadLimit ? speedToKbps(plan.uploadLimit) : dlKbps;
                    return (
                      <tr key={plan.id} className={darkMode ? 'text-slate-300' : 'text-slate-700'}>
                        <td className="p-2 font-mono text-orange-500 font-bold">{profileName}</td>
                        <td className="p-2 font-medium">{plan.name}</td>
                        <td className="p-2 text-[11px]">{plan.speedLimit} ↓ / {plan.uploadLimit || plan.speedLimit} ↑</td>
                        <td className="p-2">{plan.duration}</td>
                        <td className="p-2 font-mono text-[11px]">{ulKbps}k/{dlKbps}k</td>
                        <td className="p-2 font-bold text-center">{plan.sharedUsers}</td>
                        <td className="p-2 font-bold">{plan.price.toLocaleString()} BOB</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══ PREVIEW TAB ═══ */}
      {activeSection === 'preview' && (
        <div className="space-y-4">
          {/* Action Bar */}
          <div className={`flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 p-4 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div>
              <span className={`text-sm font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>Generated RouterOS Script</span>
              <span className={`text-[11px] block ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                {lineCount} lines • 16 sections • Ready for Winbox Terminal or SSH
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                  copied
                    ? 'bg-emerald-600 text-white'
                    : darkMode ? 'bg-slate-700 text-white hover:bg-slate-600' : 'bg-slate-900 text-white hover:bg-slate-800'
                }`}
              >
                {copied ? <CheckCircle className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied!' : 'Copy to Clipboard'}
              </button>
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-orange-600 text-white hover:bg-orange-700 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download .rsc
              </button>
            </div>
          </div>

          {/* Script Output */}
          <div className="relative">
            <textarea
              ref={scriptRef}
              readOnly
              value={generatedScript}
              className={`w-full font-mono text-[11px] leading-relaxed p-5 rounded-2xl border resize-none ${
                darkMode ? 'bg-slate-950 border-slate-700 text-emerald-400' : 'bg-slate-950 border-slate-300 text-emerald-400'
              }`}
              style={{ height: '600px' }}
              spellCheck={false}
            />
            <div className="absolute top-3 right-3 flex gap-1">
              <span className="w-3 h-3 bg-red-500 rounded-full"></span>
              <span className="w-3 h-3 bg-amber-500 rounded-full"></span>
              <span className="w-3 h-3 bg-emerald-500 rounded-full"></span>
            </div>
          </div>

          {/* Warning */}
          <div className={`p-4 rounded-2xl border flex items-start gap-3 ${darkMode ? 'bg-amber-950/30 border-amber-800/50' : 'bg-amber-50 border-amber-200'}`}>
            <AlertTriangle className={`w-5 h-5 shrink-0 mt-0.5 ${darkMode ? 'text-amber-400' : 'text-amber-600'}`} />
            <div>
              <h4 className={`font-bold text-xs ${darkMode ? 'text-amber-300' : 'text-amber-800'}`}>Important Before Running</h4>
              <ul className={`text-[11px] mt-1 space-y-0.5 list-disc list-inside ${darkMode ? 'text-amber-300/80' : 'text-amber-700'}`}>
                <li>Back up your current configuration first: <code className="font-mono bg-amber-100 text-amber-900 px-1 rounded text-[10px]">/system backup save name=backup-before-ultrafaiba</code></li>
                <li>Connect your PC to ether3 or ether4 before running (not ether2)</li>
                <li>WAN uplink cable goes into ether1 — hotspot clients connect via ether2</li>
                <li>Change the admin password immediately after initial setup</li>
                <li>Paste the entire script into Winbox Terminal or SSH session</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ═══ GUIDE TAB ═══ */}
      {activeSection === 'guide' && (
        <div className="space-y-6">
          {/* Port Diagram */}
          <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
            <h3 className={`font-bold text-sm mb-4 ${darkMode ? 'text-white' : 'text-slate-900'}`}>RB941-2nD Port Layout</h3>
            <div className="flex items-center justify-center gap-1 py-6">
              {[
                { port: 'ether1', label: 'WAN', sublabel: 'ISP Uplink', color: 'from-blue-500 to-cyan-500', active: true },
                { port: 'ether2', label: 'HOTSPOT', sublabel: 'Client Access', color: 'from-orange-500 to-red-500', active: true },
                { port: 'ether3', label: 'MGMT', sublabel: 'Management', color: 'from-slate-500 to-slate-600', active: false },
                { port: 'ether4', label: 'SPARE', sublabel: 'Available', color: 'from-slate-500 to-slate-600', active: false },
              ].map((p, i) => (
                <div key={i} className="flex flex-col items-center gap-2">
                  <div className={`w-16 h-20 rounded-xl bg-gradient-to-b ${p.color} flex flex-col items-center justify-center text-white shadow-md ${p.active ? 'ring-2 ring-offset-2 ring-offset-slate-950' : 'opacity-50'} ${p.port === 'ether2' ? 'ring-orange-400 scale-110' : p.port === 'ether1' ? 'ring-blue-400' : ''}`}>
                    <span className="text-[9px] font-mono opacity-80">{p.port}</span>
                    <span className="text-xs font-black">{p.label}</span>
                  </div>
                  <span className={`text-[10px] font-medium ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{p.sublabel}</span>
                </div>
              ))}
            </div>
            <div className={`mt-2 text-center text-[11px] ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>
              <span className="font-mono">MikroTik RB941-2nD (hAP lite) — 4 x Fast Ethernet Ports</span>
            </div>
          </div>

          {/* Step-by-Step Guide */}
          <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
            <h3 className={`font-bold text-sm mb-4 ${darkMode ? 'text-white' : 'text-slate-900'}`}>Step-by-Step Setup Guide</h3>
            <div className="space-y-4">
              {[
                { step: 1, title: 'Physical Connection', desc: 'Connect your ISP fiber/cable to ether1 (WAN). Connect your WiFi access point or switch to ether2 (Hotspot). Connect your management laptop to ether3 or ether4.' },
                { step: 2, title: 'Access the Router', desc: 'Download Winbox from mikrotik.com. Open Winbox and connect to the router via MAC address or IP. Default login: admin (no password on fresh reset).' },
                { step: 3, title: 'Configure Parameters', desc: 'Go to the "Configure Parameters" tab above. Adjust IP addresses, DNS servers, and hotspot settings to match your network. The defaults work for most setups.' },
                { step: 4, title: 'Generate & Copy Script', desc: 'Switch to the "Script Preview" tab. Click "Copy to Clipboard" or "Download .rsc" to get the complete configuration script.' },
                { step: 5, title: 'Run the Script', desc: 'In Winbox, open Terminal (New Terminal). Paste the entire script. Wait for all commands to execute. You will see output for each section.' },
                { step: 6, title: 'Test Hotspot', desc: 'Connect a phone or laptop to ether2 (or the AP connected to ether2). You should be redirected to the Ultrafaiba login page. Use one of the sample voucher codes to test.' },
                { step: 7, title: 'Upload Login Page', desc: 'Customize the hotspot login page. In Winbox go to Files → hotspot directory. Upload your branded login.html, logo, and CSS files.' },
                { step: 8, title: 'Production Vouchers', desc: 'For production, use MikroTik User Manager or an external RADIUS server (like FreeRADIUS) to generate and manage voucher codes at scale.' },
                { step: 9, title: 'Backup Configuration', desc: 'Once everything is working, create a backup: /system backup save name=ultrafaiba-production. Store this file safely.' },
                { step: 10, title: 'Monitor & Maintain', desc: 'Use the Ultrafaiba ISP Panel to monitor active sessions. Regularly check for RouterOS updates. Review firewall logs for security events.' },
              ].map(item => (
                <div key={item.step} className={`flex gap-4 p-3 rounded-xl ${darkMode ? 'bg-slate-900 border border-slate-700' : 'bg-slate-50 border border-slate-200'}`}>
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center text-white font-black text-sm shrink-0">
                    {item.step}
                  </div>
                  <div>
                    <h4 className={`font-bold text-xs ${darkMode ? 'text-white' : 'text-slate-900'}`}>{item.title}</h4>
                    <p className={`text-[11px] mt-0.5 leading-relaxed ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Commands Reference */}
          <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
            <h3 className={`font-bold text-sm mb-4 ${darkMode ? 'text-white' : 'text-slate-900'}`}>Useful RouterOS Commands</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[
                { cmd: '/ip hotspot active print', desc: 'View active hotspot sessions' },
                { cmd: '/ip hotspot user print', desc: 'List all voucher codes' },
                { cmd: '/ip hotspot user add name=CODE password=CODE profile=ultra-lite limit-uptime=02:00:00', desc: 'Add new voucher manually' },
                { cmd: '/ip hotspot user remove [find name=CODE]', desc: 'Delete a voucher code' },
                { cmd: '/queue simple print', desc: 'View bandwidth queues' },
                { cmd: '/ip firewall filter print', desc: 'View firewall rules' },
                { cmd: '/system resource print', desc: 'Check CPU/RAM usage' },
                { cmd: '/system backup save name=backup', desc: 'Create configuration backup' },
                { cmd: '/system reboot', desc: 'Reboot the router' },
                { cmd: '/ip hotspot cookie print', desc: 'View stored login cookies' },
              ].map((item, i) => (
                <div key={i} className={`p-2.5 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                  <code className={`text-[10px] font-mono block ${darkMode ? 'text-orange-400' : 'text-orange-600'}`}>{item.cmd}</code>
                  <span className={`text-[10px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{item.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

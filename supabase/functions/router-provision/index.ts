import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const vm = url.searchParams.get("vm") || "7";
    const arch = url.searchParams.get("arch") || "x86_64";

    if (!token) {
      return new Response("Error: Missing provisioning token", { status: 400 });
    }

    // Initialize Supabase Client
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch Router Configuration from Supabase
    const { data: router, error } = await supabase
      .from("routers")
      .select("*")
      .eq("provision_token", token)
      .single();

    if (error || !router) {
      return new Response("Error: Invalid provisioning token", { status: 401 });
    }

    // Provisioning Variables
    const radiusIp = router.radius_ip || "10.0.0.1";
    const radiusSecret = router.radius_secret || "ispflow_radius_secret";
    const heartbeatUrl = `${supabaseUrl}/functions/v1/router-provision/ping`;
    const hotspotPageUrl = router.hotspot_html_url || `${supabaseUrl}/storage/v1/object/public/hotspot-templates/login.html`;

    // WireGuard & VPN Tunnel Configurations
    const wgServerIp = router.wg_server_ip || "10.250.0.1";
    const wgServerPort = router.wg_server_port || 51820;
    const wgServerPublicKey = router.wg_server_public_key || "WG_SERVER_PUBLIC_KEY_PLACEHOLDER";
    const wgClientIp = router.wg_client_ip || "10.250.0.2/32";

    // Fallback VPN Credentials
    const sstpServerIp = router.sstp_server_ip || "vpn.ispflow.net";
    const vpnUser = router.vpn_user || `router_${router.id}`;
    const vpnPass = router.vpn_password || "ispflow_vpn_pass";

    // Walled Garden Domains
    const walledGardenDomains = [
      "*.supabase.co",
      "*.payhero.co.ke",
      "*.safaricom.co.ke",
      "*.mpesa.co.ke",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "cdn.jsdelivr.net"
    ];

    // Build Walled Garden commands safely
    const walledGardenCmds = walledGardenDomains.map(
      (domain) =>
        `:if ([:len [/ip hotspot walled-garden find dst-host="${domain}"]] = 0) do={ /ip hotspot walled-garden add dst-host="${domain}" action=allow comment="ISPFlow Auto Bypass" }`
    ).join("\n");

    // Production-Ready RouterOS Script
    const routerScript = `# =============================================================================
# ISPFlow Complete RouterOS v${vm} (${arch}) Auto-Provisioning Script
# Router ID: ${router.id}
# =============================================================================

:put "Starting ISPFlow full router provisioning...";

# -----------------------------------------------------------------------------
# 1. MANAGEMENT SERVICES & API ACCESS
# -----------------------------------------------------------------------------
:onerror err in={} do={ /ip service set [find name="api"] disabled=no port=8728 }
:onerror err in={} do={ /ip service set [find name="api-ssl"] disabled=no port=8729 }
:onerror err in={} do={ /ip service set [find name="www-ssl"] disabled=no port=8080 }
:onerror err in={} do={ /ip service set [find name="ssh"] disabled=no port=22 }

# -----------------------------------------------------------------------------
# 2. DNS CONFIGURATION
# -----------------------------------------------------------------------------
/ip dns set allow-remote-requests=yes servers=8.8.8.8,1.1.1.1

# -----------------------------------------------------------------------------
# 3. WIREGUARD VPN TUNNEL SETUP
# -----------------------------------------------------------------------------
:if ([:len [/interface wireguard find name="ispflow-wg"]] = 0) do={
  /interface wireguard add name="ispflow-wg" listen-port=51820 comment="ISPFlow Secure Management Tunnel"
}

:if ([:len [/ip address find comment="ISPFlow WireGuard IP"]] = 0) do={
  /ip address add address=${wgClientIp} interface=ispflow-wg comment="ISPFlow WireGuard IP"
}

:if ([:len [/interface wireguard peers find comment="ISPFlow Server Peer"]] = 0) do={
  /interface wireguard peers add interface=ispflow-wg public-key="${wgServerPublicKey}" endpoint-address="${wgServerIp}" endpoint-port=${wgServerPort} allowed-address=0.0.0.0/0 persistent-keepalive=25s comment="ISPFlow Server Peer"
}

# -----------------------------------------------------------------------------
# 4. SSTP VPN BACKUP TUNNEL
# -----------------------------------------------------------------------------
:if ([:len [/interface sstp-client find name="ispflow-sstp-backup"]] = 0) do={
  /interface sstp-client add name="ispflow-sstp-backup" connect-to="${sstpServerIp}" user="${vpnUser}" password="${vpnPass}" profile=default-encryption disabled=no comment="ISPFlow SSTP Backup Tunnel"
}

# -----------------------------------------------------------------------------
# 5. RADIUS AAA CONFIGURATION
# -----------------------------------------------------------------------------
:if ([:len [/radius find address="${radiusIp}"]] = 0) do={
  /radius add service=hotspot,ppp address=${radiusIp} secret="${radiusSecret}" timeout=3000ms src-address=0.0.0.0 comment="ISPFlow RADIUS Server"
}

/ppp aaa set use-radius=yes accounting=yes interim-update=00:05:00
:onerror err in={} do={ /ip hotspot user profile set [find name="default"] use-radius=yes }

# -----------------------------------------------------------------------------
# 6. PPPOE POOL, PROFILE & SERVER SETUP
# -----------------------------------------------------------------------------
:if ([:len [/ip pool find name="ispflow-pppoe-pool"]] = 0) do={
  /ip pool add name="ispflow-pppoe-pool" ranges=10.10.0.2-10.10.255.254
}

:if ([:len [/ppp profile find name="ispflow-pppoe-profile"]] = 0) do={
  /ppp profile add name="ispflow-pppoe-profile" local-address=10.10.0.1 remote-address=ispflow-pppoe-pool dns-server=8.8.8.8,1.1.1.1 use-ipv6=no use-mpls=no comment="ISPFlow PPPoE Profile"
}

# Safely Enable PPPoE Server across interfaces
:foreach i in=[/interface ethernet find] do={
  :local ifName [/interface ethernet get $i name];
  :if ([:len [/interface pppoe-server server find interface=$ifName]] = 0) do={
    :onerror err in={} do={
      /interface pppoe-server server add interface=$ifName service-name=("pppoe-" . $ifName) default-profile=ispflow-pppoe-profile authentication=chap,pap disabled=no
    }
  }
}

# -----------------------------------------------------------------------------
# 7. HOTSPOT POOL, PROFILE & HTML FILE FETCH
# -----------------------------------------------------------------------------
:if ([:len [/ip pool find name="ispflow-hotspot-pool"]] = 0) do={
  /ip pool add name="ispflow-hotspot-pool" ranges=10.20.0.2-10.20.255.254
}

:if ([:len [/ip hotspot profile find name="ispflow-hs-profile"]] = 0) do={
  /ip hotspot profile add name="ispflow-hs-profile" hotspot-address=10.20.0.1 dns-name="login.ispflow.net" html-directory=hotspot login-by=http-chap,http-pap,cookie use-radius=yes radius-accounting=yes radius-interim-update=00:05:00 comment="ISPFlow Hotspot Profile"
}

# Fetch Custom Hotspot Page Safely
:onerror err in={
  :put "ISPFlow: HotSpot HTML download skipped or unneeded.";
} do={
  /tool fetch url="${hotspotPageUrl}" mode=https check-certificate=no dst-path="hotspot/login.html"
}

# -----------------------------------------------------------------------------
# 8. WALLED GARDEN RULES
# -----------------------------------------------------------------------------
${walledGardenCmds}

# -----------------------------------------------------------------------------
# 9. FIREWALL & NAT MASQUERADE
# -----------------------------------------------------------------------------
:if ([:len [/ip firewall nat find comment="ISPFlow Masquerade"]] = 0) do={
  /ip firewall nat add chain=srcnat action=masquerade comment="ISPFlow Masquerade"
}

:if ([:len [/ip firewall filter find comment="Allow WireGuard Input"]] = 0) do={
  /ip firewall filter add chain=input protocol=udp dst-port=51820 action=accept comment="Allow WireGuard Input" place-before=0
}

# -----------------------------------------------------------------------------
# 10. HEARTBEAT SCHEDULER & MONITORING
# -----------------------------------------------------------------------------
:if ([:len [/system script find name="ispflow-heartbeat"]] = 0) do={
  /system script add name="ispflow-heartbeat" owner="admin" policy=read,write,test,policy source={
    :onerror err in={} do={
      /tool fetch url="${heartbeatUrl}?token=${token}" method=POST check-certificate=no output=none
    }
  }
}

:if ([:len [/system scheduler find name="ispflow-ping-scheduler"]] = 0) do={
  /system scheduler add name="ispflow-ping-scheduler" interval=1m on-event="ispflow-heartbeat" start-time=startup
}

:put "ISPFlow provisioning completed successfully!";
`;

    // Update Router Status in DB
    await supabase
      .from("routers")
      .update({ status: "provisioned", last_seen: new Date().toISOString() })
      .eq("id", router.id);

    return new Response(routerScript, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  } catch (err) {
    return new Response(`Server Error: ${err.message}`, {
      status: 500,
      headers: corsHeaders,
    });
  }
});



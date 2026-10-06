# ISPFlow-BOOTSTRAP-GENERATOR-528C90
# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR
# NETISP access - session NETISP:abcd1234
# Enables management access. Additive and idempotent; deletes nothing.

# --- RouterOS API on 8728. Present on every RouterOS including 6.x. ---
:local ispFlowApi [/ip service find name="api"]
:if ([:len $ispFlowApi] = 0) do={
    /ip service add name="api" port=8728
}

# --- API over TLS on 8729. ---
:local ispFlowApiSsl [/ip service find name="api-ssl"]
:if ([:len $ispFlowApiSsl] = 0) do={
    /ip service add name="api-ssl" port=8729
}

# --- HTTPS REST on 8080. RouterOS 7.1 and later only. ---
:local ispFlowRest [/ip service find name="www-ssl"]
:if ([:len $ispFlowRest] = 0) do={
    /ip service add name="www-ssl" port=8080
}

# --- Report what this router is, from the router itself ---
:local ispFlowIdentity [/system identity get name]
:local ispFlowVersion [/system resource get version]
:local ispFlowBoard [/system resource get board-name]
:put ("ISPFlow: this router is " . $ispFlowIdentity . ", RouterOS " . $ispFlowVersion .  " on " . $ispFlowBoard . ".")
:put "NETISP:abcd1234: management access configured."

:local ispFlowClaimName [/system identity get name]
:local ispFlowClaimVer [/system resource get version]
:local ispFlowClaimBoard [/system resource get board-name]
:put ("ISPFlow: registered as " . $ispFlowClaimName);
:put ("ISPFlow: RouterOS " . $ispFlowClaimVer . " on " . $ispFlowClaimBoard);
:put "ISPFlow: HTTPS management is available on port 8080.";
{
# ISPFlow-BOOTSTRAP-GENERATOR-528C90
# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR
# =============================================================================
# ISPFlow router discovery - session abcd1234
# =============================================================================
# READ ONLY. This script reads what is already configured and reports it,
# so ISPFlow can configure safely. Every block is guarded: one menu this
# firmware does not have costs one line of output, never the whole run.

:local token "dddddddddddddddddddddddddddddddddddddddddddddddd";
:local tag "abcd1234";
:local baseUrl "https://demo.supabase.co/functions/v1/router-provision/report";
:put "Starting ISPFlow router discovery...";
:put "";

# --- identity ---
:do {
  :local r [:toarray ""]
  :local v0 [/system identity get name]
  :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
  :local v1 [/system resource get version]
  :if ([:typeof $v1] != "array") do={ :set ($r->"version") $v1 }
  :local jsonPayload [:serialize to=json value=$r]
  /tool fetch mode=https url=($baseUrl . "?survey=identity&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: identity skipped/failed"
};

# --- resource ---
:do {
  :local r [:toarray ""]
  :local v0 [/system resource get board-name]
  :if ([:typeof $v0] != "array") do={ :set ($r->"board_name") $v0 }
  :local v1 [/system resource get platform]
  :if ([:typeof $v1] != "array") do={ :set ($r->"platform") $v1 }
  :local v2 [/system resource get architecture-name]
  :if ([:typeof $v2] != "array") do={ :set ($r->"architecture") $v2 }
  :local v3 [/system resource get cpu]
  :if ([:typeof $v3] != "array") do={ :set ($r->"cpu") $v3 }
  :local v4 [/system resource get cpu-count]
  :if ([:typeof $v4] != "array") do={ :set ($r->"cpu_count") $v4 }
  :local v5 [/system resource get cpu-load]
  :if ([:typeof $v5] != "array") do={ :set ($r->"cpu_load") $v5 }
  :local v6 [/system resource get free-memory]
  :if ([:typeof $v6] != "array") do={ :set ($r->"free_memory") $v6 }
  :local v7 [/system resource get total-memory]
  :if ([:typeof $v7] != "array") do={ :set ($r->"total_memory") $v7 }
  :local v8 [/system resource get free-hdd-space]
  :if ([:typeof $v8] != "array") do={ :set ($r->"free_hdd") $v8 }
  :local v9 [/system resource get total-hdd-space]
  :if ([:typeof $v9] != "array") do={ :set ($r->"total_hdd") $v9 }
  :local v10 [/system resource get uptime]
  :if ([:typeof $v10] != "array") do={ :set ($r->"uptime") $v10 }
  :local jsonPayload [:serialize to=json value=$r]
  /tool fetch mode=https url=($baseUrl . "?survey=resource&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: resource skipped/failed"
};

# --- board (skipped: not applicable to this firmware) ---
:do {
  :put "ISPFlow: board skipped - CHR/x86_64 does not expose a RouterBOARD menu";
  :local r [:toarray ""]
  :set ($r->"unsupported") "CHR/x86_64 does not expose a RouterBOARD menu"
  :local jsonPayload [:serialize to=json value=$r]
  /tool fetch mode=https url=($baseUrl . "?survey=board&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: board skipped/failed"
};

# --- packages ---
:do {
  :local rows ""
  :foreach i in=[/system package find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"version")
    :if ([:typeof $v1] != "array") do={ :set ($r->"version") $v1 }
    :local v2 ($i->"installed")
    :if ([:typeof $v2] != "array") do={ :set ($r->"installed") $v2 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=packages&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: packages skipped/failed"
};

# --- interfaces ---
:do {
  :local rows ""
  :foreach i in=[/interface find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"type")
    :if ([:typeof $v1] != "array") do={ :set ($r->"type") $v1 }
    :local v2 ($i->"running")
    :if ([:typeof $v2] != "array") do={ :set ($r->"running") $v2 }
    :local v3 ($i->"disabled")
    :if ([:typeof $v3] != "array") do={ :set ($r->"disabled") $v3 }
    :local v4 ($i->"comment")
    :if ([:typeof $v4] != "array") do={ :set ($r->"comment") $v4 }
    :local v5 ($i->"mtu")
    :if ([:typeof $v5] != "array") do={ :set ($r->"mtu") $v5 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=interfaces&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: interfaces skipped/failed"
};

# --- bridge ---
:do {
  :local rows ""
  :foreach i in=[/interface bridge find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"comment")
    :if ([:typeof $v1] != "array") do={ :set ($r->"comment") $v1 }
    :local v2 ($i->"vlan-filtering")
    :if ([:typeof $v2] != "array") do={ :set ($r->"vlan_filtering") $v2 }
    :local v3 ($i->"pvid")
    :if ([:typeof $v3] != "array") do={ :set ($r->"pvid") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=bridge&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: bridge skipped/failed"
};

# --- bridge_ports ---
:do {
  :local rows ""
  :foreach i in=[/interface bridge port find] do={
    :local r [:toarray ""]
    :local v0 ($i->"bridge")
    :if ([:typeof $v0] != "array") do={ :set ($r->"bridge") $v0 }
    :local v1 ($i->"interface")
    :if ([:typeof $v1] != "array") do={ :set ($r->"interface") $v1 }
    :local v2 ($i->"comment")
    :if ([:typeof $v2] != "array") do={ :set ($r->"comment") $v2 }
    :local v3 ($i->"disabled")
    :if ([:typeof $v3] != "array") do={ :set ($r->"disabled") $v3 }
    :local v4 ($i->"edge")
    :if ([:typeof $v4] != "array") do={ :set ($r->"edge") $v4 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=bridge_ports&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: bridge_ports skipped/failed"
};

# --- vlans ---
:do {
  :local rows ""
  :foreach i in=[/interface vlan find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"interface")
    :if ([:typeof $v1] != "array") do={ :set ($r->"interface") $v1 }
    :local v2 ($i->"vlan-id")
    :if ([:typeof $v2] != "array") do={ :set ($r->"vlan_id") $v2 }
    :local v3 ($i->"comment")
    :if ([:typeof $v3] != "array") do={ :set ($r->"comment") $v3 }
    :local v4 ($i->"disabled")
    :if ([:typeof $v4] != "array") do={ :set ($r->"disabled") $v4 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=vlans&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: vlans skipped/failed"
};

# --- ip_addresses ---
:do {
  :local rows ""
  :foreach i in=[/ip address find] do={
    :local r [:toarray ""]
    :local v0 ($i->"address")
    :if ([:typeof $v0] != "array") do={ :set ($r->"address") $v0 }
    :local v1 ($i->"network")
    :if ([:typeof $v1] != "array") do={ :set ($r->"network") $v1 }
    :local v2 ($i->"interface")
    :if ([:typeof $v2] != "array") do={ :set ($r->"interface") $v2 }
    :local v3 ($i->"disabled")
    :if ([:typeof $v3] != "array") do={ :set ($r->"disabled") $v3 }
    :local v4 ($i->"comment")
    :if ([:typeof $v4] != "array") do={ :set ($r->"comment") $v4 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=ip_addresses&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: ip_addresses skipped/failed"
};

# --- dhcp ---
:do {
  :local rows ""
  :foreach i in=[/ip dhcp-server find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"interface")
    :if ([:typeof $v1] != "array") do={ :set ($r->"interface") $v1 }
    :local v2 ($i->"address-pool")
    :if ([:typeof $v2] != "array") do={ :set ($r->"address_pool") $v2 }
    :local v3 ($i->"disabled")
    :if ([:typeof $v3] != "array") do={ :set ($r->"disabled") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=dhcp&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: dhcp skipped/failed"
};

# --- ip_pools ---
:do {
  :local rows ""
  :foreach i in=[/ip pool find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"ranges")
    :if ([:typeof $v1] != "array") do={ :set ($r->"ranges") $v1 }
    :local v2 ($i->"next-pool")
    :if ([:typeof $v2] != "array") do={ :set ($r->"next_pool") $v2 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=ip_pools&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: ip_pools skipped/failed"
};

# --- hotspot ---
:do {
  :local rows ""
  :foreach i in=[/ip hotspot find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"interface")
    :if ([:typeof $v1] != "array") do={ :set ($r->"interface") $v1 }
    :local v2 ($i->"address-pool")
    :if ([:typeof $v2] != "array") do={ :set ($r->"address_pool") $v2 }
    :local v3 ($i->"profile")
    :if ([:typeof $v3] != "array") do={ :set ($r->"profile") $v3 }
    :local v4 ($i->"disabled")
    :if ([:typeof $v4] != "array") do={ :set ($r->"disabled") $v4 }
    :local v5 ($i->"comment")
    :if ([:typeof $v5] != "array") do={ :set ($r->"comment") $v5 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=hotspot&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: hotspot skipped/failed"
};

# --- hotspot ---
:do {
  :local rows ""
  :foreach i in=[/ip hotspot user find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"profile")
    :if ([:typeof $v1] != "array") do={ :set ($r->"profile") $v1 }
    :local v2 ($i->"server")
    :if ([:typeof $v2] != "array") do={ :set ($r->"server") $v2 }
    :local v3 ($i->"comment")
    :if ([:typeof $v3] != "array") do={ :set ($r->"comment") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=hotspot&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: hotspot skipped/failed"
};

# --- pppoe ---
:do {
  :local rows ""
  :foreach i in=[/ppp secret find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"service")
    :if ([:typeof $v1] != "array") do={ :set ($r->"service") $v1 }
    :local v2 ($i->"profile")
    :if ([:typeof $v2] != "array") do={ :set ($r->"profile") $v2 }
    :local v3 ($i->"remote-address")
    :if ([:typeof $v3] != "array") do={ :set ($r->"remote_address") $v3 }
    :local v4 ($i->"comment")
    :if ([:typeof $v4] != "array") do={ :set ($r->"comment") $v4 }
    :local v5 ($i->"disabled")
    :if ([:typeof $v5] != "array") do={ :set ($r->"disabled") $v5 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=pppoe&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: pppoe skipped/failed"
};

# --- pppoe-servers ---
:do {
  :local rows ""
  :foreach i in=[/interface pppoe-server server find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"service-name")
    :if ([:typeof $v1] != "array") do={ :set ($r->"service_name") $v1 }
    :local v2 ($i->"max-mtu")
    :if ([:typeof $v2] != "array") do={ :set ($r->"max_mtu") $v2 }
    :local v3 ($i->"authentication")
    :if ([:typeof $v3] != "array") do={ :set ($r->"authentication") $v3 }
    :local v4 ($i->"one-session-per-host")
    :if ([:typeof $v4] != "array") do={ :set ($r->"one_session_per_host") $v4 }
    :local v5 ($i->"keepalive-timeout")
    :if ([:typeof $v5] != "array") do={ :set ($r->"keepalive_timeout") $v5 }
    :local v6 ($i->"comment")
    :if ([:typeof $v6] != "array") do={ :set ($r->"comment") $v6 }
    :local v7 ($i->"disabled")
    :if ([:typeof $v7] != "array") do={ :set ($r->"disabled") $v7 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=pppoe-servers&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: pppoe-servers skipped/failed"
};

# --- pppoe-profiles ---
:do {
  :local rows ""
  :foreach i in=[/ppp profile find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"comment")
    :if ([:typeof $v1] != "array") do={ :set ($r->"comment") $v1 }
    :local v2 ($i->"local-address")
    :if ([:typeof $v2] != "array") do={ :set ($r->"local_address") $v2 }
    :local v3 ($i->"remote-address")
    :if ([:typeof $v3] != "array") do={ :set ($r->"remote_address") $v3 }
    :local v4 ($i->"use-compression")
    :if ([:typeof $v4] != "array") do={ :set ($r->"use_compression") $v4 }
    :local v5 ($i->"use-encryption")
    :if ([:typeof $v5] != "array") do={ :set ($r->"use_encryption") $v5 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=pppoe-profiles&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: pppoe-profiles skipped/failed"
};

# --- radius ---
:do {
  :local rows ""
  :foreach i in=[/radius find] do={
    :local r [:toarray ""]
    :local v0 ($i->"address")
    :if ([:typeof $v0] != "array") do={ :set ($r->"address") $v0 }
    :local v1 ($i->"port")
    :if ([:typeof $v1] != "array") do={ :set ($r->"port") $v1 }
    :local v2 ($i->"timeout")
    :if ([:typeof $v2] != "array") do={ :set ($r->"timeout") $v2 }
    :local v3 ($i->"src-address")
    :if ([:typeof $v3] != "array") do={ :set ($r->"src_address") $v3 }
    :local v4 ($i->"comment")
    :if ([:typeof $v4] != "array") do={ :set ($r->"comment") $v4 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=radius&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: radius skipped/failed"
};

# --- radius-aaa ---
:do {
  :local rows ""
  :foreach i in=[/ppp aaa find] do={
    :local r [:toarray ""]
    :local v0 ($i->"use-radius")
    :if ([:typeof $v0] != "array") do={ :set ($r->"use-radius") $v0 }
    :local v1 ($i->"radius-interim-update")
    :if ([:typeof $v1] != "array") do={ :set ($r->"radius-interim-update") $v1 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=radius-aaa&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: radius-aaa skipped/failed"
};

# --- firewall ---
:do {
  :local rows ""
  :foreach i in=[/ip firewall filter find] do={
    :local r [:toarray ""]
    :local v0 ($i->"chain")
    :if ([:typeof $v0] != "array") do={ :set ($r->"chain") $v0 }
    :local v1 ($i->"action")
    :if ([:typeof $v1] != "array") do={ :set ($r->"action") $v1 }
    :local v2 ($i->"comment")
    :if ([:typeof $v2] != "array") do={ :set ($r->"comment") $v2 }
    :local v3 ($i->"disabled")
    :if ([:typeof $v3] != "array") do={ :set ($r->"disabled") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=firewall&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: firewall skipped/failed"
};

# --- nat ---
:do {
  :local rows ""
  :foreach i in=[/ip firewall nat find] do={
    :local r [:toarray ""]
    :local v0 ($i->"chain")
    :if ([:typeof $v0] != "array") do={ :set ($r->"chain") $v0 }
    :local v1 ($i->"action")
    :if ([:typeof $v1] != "array") do={ :set ($r->"action") $v1 }
    :local v2 ($i->"comment")
    :if ([:typeof $v2] != "array") do={ :set ($r->"comment") $v2 }
    :local v3 ($i->"disabled")
    :if ([:typeof $v3] != "array") do={ :set ($r->"disabled") $v3 }
    :local v4 ($i->"to-addresses")
    :if ([:typeof $v4] != "array") do={ :set ($r->"to_addresses") $v4 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=nat&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: nat skipped/failed"
};

# --- routes ---
:do {
  :local rows ""
  :foreach i in=[/ip route find] do={
    :local r [:toarray ""]
    :local v0 ($i->"dst-address")
    :if ([:typeof $v0] != "array") do={ :set ($r->"dst_address") $v0 }
    :local v1 ($i->"gateway")
    :if ([:typeof $v1] != "array") do={ :set ($r->"gateway") $v1 }
    :local v2 ($i->"distance")
    :if ([:typeof $v2] != "array") do={ :set ($r->"distance") $v2 }
    :local v3 ($i->"comment")
    :if ([:typeof $v3] != "array") do={ :set ($r->"comment") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=routes&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: routes skipped/failed"
};

# --- dns ---
:do {
  :local rows ""
  :foreach i in=[/ip dns find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"servers")
    :if ([:typeof $v1] != "array") do={ :set ($r->"servers") $v1 }
    :local v2 ($i->"dynamic-servers")
    :if ([:typeof $v2] != "array") do={ :set ($r->"dynamic_servers") $v2 }
    :local v3 ($i->"allow-remote-requests")
    :if ([:typeof $v3] != "array") do={ :set ($r->"allow_remote_requests") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=dns&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: dns skipped/failed"
};

# --- wireguard ---
:do {
  :local rows ""
  :foreach i in=[/interface wireguard find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"listen-port")
    :if ([:typeof $v1] != "array") do={ :set ($r->"listen_port") $v1 }
    :local v2 ($i->"disabled")
    :if ([:typeof $v2] != "array") do={ :set ($r->"disabled") $v2 }
    :local v3 ($i->"comment")
    :if ([:typeof $v3] != "array") do={ :set ($r->"comment") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=wireguard&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: wireguard skipped/failed"
};

# --- services ---
:do {
  :local rows ""
  :foreach i in=[/ip service find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"port")
    :if ([:typeof $v1] != "array") do={ :set ($r->"port") $v1 }
    :local v2 ($i->"disabled")
    :if ([:typeof $v2] != "array") do={ :set ($r->"disabled") $v2 }
    :local v3 ($i->"address")
    :if ([:typeof $v3] != "array") do={ :set ($r->"address") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=services&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: services skipped/failed"
};

# --- certificates ---
:do {
  :local rows ""
  :foreach i in=[/certificate find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"common-name")
    :if ([:typeof $v1] != "array") do={ :set ($r->"common_name") $v1 }
    :local v2 ($i->"invalid-after")
    :if ([:typeof $v2] != "array") do={ :set ($r->"invalid_after") $v2 }
    :local v3 ($i->"expired")
    :if ([:typeof $v3] != "array") do={ :set ($r->"expired") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=certificates&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: certificates skipped/failed"
};

# --- wireless ---
:do {
  :local rows ""
  :foreach i in=[/interface wireless find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"ssid")
    :if ([:typeof $v1] != "array") do={ :set ($r->"ssid") $v1 }
    :local v2 ($i->"mode")
    :if ([:typeof $v2] != "array") do={ :set ($r->"mode") $v2 }
    :local v3 ($i->"disabled")
    :if ([:typeof $v3] != "array") do={ :set ($r->"disabled") $v3 }
    :local v4 ($i->"comment")
    :if ([:typeof $v4] != "array") do={ :set ($r->"comment") $v4 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=wireless&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: wireless skipped/failed"
};

# --- capsman ---
:do {
  :local rows ""
  :foreach i in=[/caps-man manager find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"enabled")
    :if ([:typeof $v1] != "array") do={ :set ($r->"enabled") $v1 }
    :local v2 ($i->"certificate")
    :if ([:typeof $v2] != "array") do={ :set ($r->"certificate") $v2 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=capsman&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: capsman skipped/failed"
};

# --- ispflow ---
:do {
  :local rows ""
  :foreach i in=[/ip firewall filter find] do={
    :local r [:toarray ""]
    :local v0 ($i->"chain")
    :if ([:typeof $v0] != "array") do={ :set ($r->"chain") $v0 }
    :local v1 ($i->"action")
    :if ([:typeof $v1] != "array") do={ :set ($r->"action") $v1 }
    :local v2 ($i->"comment")
    :if ([:typeof $v2] != "array") do={ :set ($r->"comment") $v2 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=ispflow&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: ispflow skipped/failed"
};

# --- scheduler ---
:do {
  :local rows ""
  :foreach i in=[/system scheduler find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"interval")
    :if ([:typeof $v1] != "array") do={ :set ($r->"interval") $v1 }
    :local v2 ($i->"disabled")
    :if ([:typeof $v2] != "array") do={ :set ($r->"disabled") $v2 }
    :local v3 ($i->"comment")
    :if ([:typeof $v3] != "array") do={ :set ($r->"comment") $v3 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=scheduler&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: scheduler skipped/failed"
};

# --- backup ---
:do {
  :local rows ""
  :foreach i in=[/system script find] do={
    :local r [:toarray ""]
    :local v0 ($i->"name")
    :if ([:typeof $v0] != "array") do={ :set ($r->"name") $v0 }
    :local v1 ($i->"comment")
    :if ([:typeof $v1] != "array") do={ :set ($r->"comment") $v1 }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=backup&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: backup skipped/failed"
};

:put "";
:put "ISPFlow discovery finished. Return to your ISPFlow dashboard.";
}

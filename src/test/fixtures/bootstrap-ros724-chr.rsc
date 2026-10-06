# ISPFlow-BOOTSTRAP-GENERATOR-528C90
# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR
# NETISP access - session NETISP:abcd1234
# Enables management access. Additive and idempotent; deletes nothing.

# --- RouterOS API on 8728. Present on every RouterOS including 6.x. ---
:local ispFlowApi [/ip/service/find name="api"]
:if ([:len $ispFlowApi] = 0) do={
    /ip/service/add name="api" port=8728
}

# --- API over TLS on 8729. ---
:local ispFlowApiSsl [/ip/service/find name="api-ssl"]
:if ([:len $ispFlowApiSsl] = 0) do={
    /ip/service/add name="api-ssl" port=8729
}

# --- HTTPS REST on 8080. RouterOS 7.1 and later only. ---
:local ispFlowRest [/ip/service/find name="www-ssl"]
:if ([:len $ispFlowRest] = 0) do={
    /ip/service/add name="www-ssl" port=8080
}

# --- Report what this router is, from the router itself ---
:local ispFlowIdentity [/system/identity/get name]
:local ispFlowVersion [/system/resource/get version]
:local ispFlowBoard [/system/resource/get board-name]
:put ("ISPFlow: this router is " . $ispFlowIdentity . ", RouterOS " . $ispFlowVersion .  " on " . $ispFlowBoard . ".")
:put "NETISP:abcd1234: management access configured."

:local ispFlowClaimName [/system/identity/get name]
:local ispFlowClaimVer [/system/resource/get version]
:local ispFlowClaimBoard [/system/resource/get board-name]
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
  :local v [/system identity/get name]
  :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
  :local v [/system resource/get version]
  :if ([:typeof $v] != "array") do={ :set ($r->"version") $v }
  :local jsonPayload [:serialize to=json value=$r]
  /tool fetch mode=https url=($baseUrl . "?survey=identity&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: identity skipped/failed"
};

# --- resource ---
:do {
  :local r [:toarray ""]
  :local v [/system resource/get board-name]
  :if ([:typeof $v] != "array") do={ :set ($r->"board_name") $v }
  :local v [/system resource/get platform]
  :if ([:typeof $v] != "array") do={ :set ($r->"platform") $v }
  :local v [/system resource/get architecture-name]
  :if ([:typeof $v] != "array") do={ :set ($r->"architecture") $v }
  :local v [/system resource/get cpu]
  :if ([:typeof $v] != "array") do={ :set ($r->"cpu") $v }
  :local v [/system resource/get cpu-count]
  :if ([:typeof $v] != "array") do={ :set ($r->"cpu_count") $v }
  :local v [/system resource/get cpu-load]
  :if ([:typeof $v] != "array") do={ :set ($r->"cpu_load") $v }
  :local v [/system resource/get free-memory]
  :if ([:typeof $v] != "array") do={ :set ($r->"free_memory") $v }
  :local v [/system resource/get total-memory]
  :if ([:typeof $v] != "array") do={ :set ($r->"total_memory") $v }
  :local v [/system resource/get free-hdd-space]
  :if ([:typeof $v] != "array") do={ :set ($r->"free_hdd") $v }
  :local v [/system resource/get total-hdd-space]
  :if ([:typeof $v] != "array") do={ :set ($r->"total_hdd") $v }
  :local v [/system resource/get uptime]
  :if ([:typeof $v] != "array") do={ :set ($r->"uptime") $v }
  :local jsonPayload [:serialize to=json value=$r]
  /tool fetch mode=https url=($baseUrl . "?survey=resource&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: resource skipped/failed"
};

# --- board ---
:do {
  :local r [:toarray ""]
  :local v [/system routerboard/get serial-number]
  :if ([:typeof $v] != "array") do={ :set ($r->"serial_number") $v }
  :local v [/system routerboard/get model]
  :if ([:typeof $v] != "array") do={ :set ($r->"model") $v }
  :local v [/system routerboard/get firmware-type]
  :if ([:typeof $v] != "array") do={ :set ($r->"firmware_type") $v }
  :local jsonPayload [:serialize to=json value=$r]
  /tool fetch mode=https url=($baseUrl . "?survey=board&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: board skipped/failed"
};

# --- packages ---
:do {
  :local rows ""
  :foreach i in=[/system package/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"version")
    :if ([:typeof $v] != "array") do={ :set ($r->"version") $v }
    :local v ($i->"installed")
    :if ([:typeof $v] != "array") do={ :set ($r->"installed") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=packages&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: packages skipped/failed"
};

# --- interfaces ---
:do {
  :local rows ""
  :foreach i in=[/interface/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"type")
    :if ([:typeof $v] != "array") do={ :set ($r->"type") $v }
    :local v ($i->"running")
    :if ([:typeof $v] != "array") do={ :set ($r->"running") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"mtu")
    :if ([:typeof $v] != "array") do={ :set ($r->"mtu") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=interfaces&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: interfaces skipped/failed"
};

# --- bridge ---
:do {
  :local rows ""
  :foreach i in=[/interface bridge/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"vlan-filtering")
    :if ([:typeof $v] != "array") do={ :set ($r->"vlan_filtering") $v }
    :local v ($i->"pvid")
    :if ([:typeof $v] != "array") do={ :set ($r->"pvid") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=bridge&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: bridge skipped/failed"
};

# --- bridge_ports ---
:do {
  :local rows ""
  :foreach i in=[/interface bridge port/find] do={
    :local r [:toarray ""]
    :local v ($i->"bridge")
    :if ([:typeof $v] != "array") do={ :set ($r->"bridge") $v }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set ($r->"interface") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"edge")
    :if ([:typeof $v] != "array") do={ :set ($r->"edge") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=bridge_ports&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: bridge_ports skipped/failed"
};

# --- vlans ---
:do {
  :local rows ""
  :foreach i in=[/interface vlan/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set ($r->"interface") $v }
    :local v ($i->"vlan-id")
    :if ([:typeof $v] != "array") do={ :set ($r->"vlan_id") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=vlans&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: vlans skipped/failed"
};

# --- ip_addresses ---
:do {
  :local rows ""
  :foreach i in=[/ip address/find] do={
    :local r [:toarray ""]
    :local v ($i->"address")
    :if ([:typeof $v] != "array") do={ :set ($r->"address") $v }
    :local v ($i->"network")
    :if ([:typeof $v] != "array") do={ :set ($r->"network") $v }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set ($r->"interface") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=ip_addresses&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: ip_addresses skipped/failed"
};

# --- dhcp ---
:do {
  :local rows ""
  :foreach i in=[/ip dhcp-server/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set ($r->"interface") $v }
    :local v ($i->"address-pool")
    :if ([:typeof $v] != "array") do={ :set ($r->"address_pool") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=dhcp&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: dhcp skipped/failed"
};

# --- ip_pools ---
:do {
  :local rows ""
  :foreach i in=[/ip pool/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"ranges")
    :if ([:typeof $v] != "array") do={ :set ($r->"ranges") $v }
    :local v ($i->"next-pool")
    :if ([:typeof $v] != "array") do={ :set ($r->"next_pool") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=ip_pools&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: ip_pools skipped/failed"
};

# --- hotspot ---
:do {
  :local rows ""
  :foreach i in=[/ip hotspot/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set ($r->"interface") $v }
    :local v ($i->"address-pool")
    :if ([:typeof $v] != "array") do={ :set ($r->"address_pool") $v }
    :local v ($i->"profile")
    :if ([:typeof $v] != "array") do={ :set ($r->"profile") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=hotspot&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: hotspot skipped/failed"
};

# --- hotspot ---
:do {
  :local rows ""
  :foreach i in=[/ip hotspot user/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"profile")
    :if ([:typeof $v] != "array") do={ :set ($r->"profile") $v }
    :local v ($i->"server")
    :if ([:typeof $v] != "array") do={ :set ($r->"server") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=hotspot&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: hotspot skipped/failed"
};

# --- pppoe ---
:do {
  :local rows ""
  :foreach i in=[/ppp secret/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"service")
    :if ([:typeof $v] != "array") do={ :set ($r->"service") $v }
    :local v ($i->"profile")
    :if ([:typeof $v] != "array") do={ :set ($r->"profile") $v }
    :local v ($i->"remote-address")
    :if ([:typeof $v] != "array") do={ :set ($r->"remote_address") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=pppoe&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: pppoe skipped/failed"
};

# --- pppoe-servers ---
:do {
  :local rows ""
  :foreach i in=[/interface pppoe-server server/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"service-name")
    :if ([:typeof $v] != "array") do={ :set ($r->"service_name") $v }
    :local v ($i->"max-mtu")
    :if ([:typeof $v] != "array") do={ :set ($r->"max_mtu") $v }
    :local v ($i->"authentication")
    :if ([:typeof $v] != "array") do={ :set ($r->"authentication") $v }
    :local v ($i->"one-session-per-host")
    :if ([:typeof $v] != "array") do={ :set ($r->"one_session_per_host") $v }
    :local v ($i->"keepalive-timeout")
    :if ([:typeof $v] != "array") do={ :set ($r->"keepalive_timeout") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=pppoe-servers&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: pppoe-servers skipped/failed"
};

# --- pppoe-profiles ---
:do {
  :local rows ""
  :foreach i in=[/ppp profile/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"local-address")
    :if ([:typeof $v] != "array") do={ :set ($r->"local_address") $v }
    :local v ($i->"remote-address")
    :if ([:typeof $v] != "array") do={ :set ($r->"remote_address") $v }
    :local v ($i->"use-compression")
    :if ([:typeof $v] != "array") do={ :set ($r->"use_compression") $v }
    :local v ($i->"use-encryption")
    :if ([:typeof $v] != "array") do={ :set ($r->"use_encryption") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=pppoe-profiles&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: pppoe-profiles skipped/failed"
};

# --- radius ---
:do {
  :local rows ""
  :foreach i in=[/radius/find] do={
    :local r [:toarray ""]
    :local v ($i->"address")
    :if ([:typeof $v] != "array") do={ :set ($r->"address") $v }
    :local v ($i->"port")
    :if ([:typeof $v] != "array") do={ :set ($r->"port") $v }
    :local v ($i->"timeout")
    :if ([:typeof $v] != "array") do={ :set ($r->"timeout") $v }
    :local v ($i->"src-address")
    :if ([:typeof $v] != "array") do={ :set ($r->"src_address") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=radius&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: radius skipped/failed"
};

# --- radius-aaa ---
:do {
  :local rows ""
  :foreach i in=[/ppp aaa/find] do={
    :local r [:toarray ""]
    :local v ($i->"use-radius")
    :if ([:typeof $v] != "array") do={ :set ($r->"use-radius") $v }
    :local v ($i->"radius-interim-update")
    :if ([:typeof $v] != "array") do={ :set ($r->"radius-interim-update") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=radius-aaa&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: radius-aaa skipped/failed"
};

# --- firewall ---
:do {
  :local rows ""
  :foreach i in=[/ip firewall filter/find] do={
    :local r [:toarray ""]
    :local v ($i->"chain")
    :if ([:typeof $v] != "array") do={ :set ($r->"chain") $v }
    :local v ($i->"action")
    :if ([:typeof $v] != "array") do={ :set ($r->"action") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=firewall&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: firewall skipped/failed"
};

# --- nat ---
:do {
  :local rows ""
  :foreach i in=[/ip firewall nat/find] do={
    :local r [:toarray ""]
    :local v ($i->"chain")
    :if ([:typeof $v] != "array") do={ :set ($r->"chain") $v }
    :local v ($i->"action")
    :if ([:typeof $v] != "array") do={ :set ($r->"action") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"to-addresses")
    :if ([:typeof $v] != "array") do={ :set ($r->"to_addresses") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=nat&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: nat skipped/failed"
};

# --- routes ---
:do {
  :local rows ""
  :foreach i in=[/ip route/find] do={
    :local r [:toarray ""]
    :local v ($i->"dst-address")
    :if ([:typeof $v] != "array") do={ :set ($r->"dst_address") $v }
    :local v ($i->"gateway")
    :if ([:typeof $v] != "array") do={ :set ($r->"gateway") $v }
    :local v ($i->"distance")
    :if ([:typeof $v] != "array") do={ :set ($r->"distance") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=routes&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: routes skipped/failed"
};

# --- dns ---
:do {
  :local rows ""
  :foreach i in=[/ip dns/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"servers")
    :if ([:typeof $v] != "array") do={ :set ($r->"servers") $v }
    :local v ($i->"dynamic-servers")
    :if ([:typeof $v] != "array") do={ :set ($r->"dynamic_servers") $v }
    :local v ($i->"allow-remote-requests")
    :if ([:typeof $v] != "array") do={ :set ($r->"allow_remote_requests") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=dns&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: dns skipped/failed"
};

# --- wireguard ---
:do {
  :local rows ""
  :foreach i in=[/interface wireguard/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"listen-port")
    :if ([:typeof $v] != "array") do={ :set ($r->"listen_port") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=wireguard&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: wireguard skipped/failed"
};

# --- services ---
:do {
  :local rows ""
  :foreach i in=[/ip service/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"port")
    :if ([:typeof $v] != "array") do={ :set ($r->"port") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"address")
    :if ([:typeof $v] != "array") do={ :set ($r->"address") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=services&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: services skipped/failed"
};

# --- certificates ---
:do {
  :local rows ""
  :foreach i in=[/certificate/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"common-name")
    :if ([:typeof $v] != "array") do={ :set ($r->"common_name") $v }
    :local v ($i->"invalid-after")
    :if ([:typeof $v] != "array") do={ :set ($r->"invalid_after") $v }
    :local v ($i->"expired")
    :if ([:typeof $v] != "array") do={ :set ($r->"expired") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=certificates&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: certificates skipped/failed"
};

# --- wireless ---
:do {
  :local rows ""
  :foreach i in=[/interface wireless/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"ssid")
    :if ([:typeof $v] != "array") do={ :set ($r->"ssid") $v }
    :local v ($i->"mode")
    :if ([:typeof $v] != "array") do={ :set ($r->"mode") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=wireless&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: wireless skipped/failed"
};

# --- capsman ---
:do {
  :local rows ""
  :foreach i in=[/caps-man manager/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"enabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"enabled") $v }
    :local v ($i->"certificate")
    :if ([:typeof $v] != "array") do={ :set ($r->"certificate") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=capsman&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: capsman skipped/failed"
};

# --- ispflow ---
:do {
  :local rows ""
  :foreach i in=[/ip firewall filter/find] do={
    :local r [:toarray ""]
    :local v ($i->"chain")
    :if ([:typeof $v] != "array") do={ :set ($r->"chain") $v }
    :local v ($i->"action")
    :if ([:typeof $v] != "array") do={ :set ($r->"action") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=ispflow&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: ispflow skipped/failed"
};

# --- scheduler ---
:do {
  :local rows ""
  :foreach i in=[/system scheduler/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"interval")
    :if ([:typeof $v] != "array") do={ :set ($r->"interval") $v }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set ($r->"disabled") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=scheduler&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: scheduler skipped/failed"
};

# --- backup ---
:do {
  :local rows ""
  :foreach i in=[/system script/find] do={
    :local r [:toarray ""]
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set ($r->"name") $v }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set ($r->"comment") $v }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  :local jsonPayload ("[" . $rows . "]")
  /tool fetch mode=https url=($baseUrl . "?survey=backup&token=" . $token . "&tag=" . $tag) method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: backup skipped/failed"
};

:put "";
:put "ISPFlow discovery finished. Return to your ISPFlow dashboard.";
}

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
  :local v_name [/system identity get name]
  :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
  :local v_version [/system resource get version]
  :if ([:typeof $v_version] != "array") do={ :set ($r->"version") $v_version }
  :local jsonPayload [:serialize to=json value=$r]
  /tool fetch mode=https url=($baseUrl . "?survey=identity&token=" . $token . "&tag=" . $tag) http-method=post check-certificate=yes http-header-field="Content-Type:application/json" output=none http-data=$jsonPayload;
} on-error={
  :put "ISPFlow: identity skipped/failed"
};

# --- resource ---
:do {
  :local r [:toarray ""]
  :local v_board_name [/system resource get board-name]
  :if ([:typeof $v_board_name] != "array") do={ :set ($r->"board_name") $v_board_name }
  :local v_platform [/system resource get platform]
  :if ([:typeof $v_platform] != "array") do={ :set ($r->"platform") $v_platform }
  :local v_architecture [/system resource get architecture-name]
  :if ([:typeof $v_architecture] != "array") do={ :set ($r->"architecture") $v_architecture }
  :local v_cpu [/system resource get cpu]
  :if ([:typeof $v_cpu] != "array") do={ :set ($r->"cpu") $v_cpu }
  :local v_cpu_count [/system resource get cpu-count]
  :if ([:typeof $v_cpu_count] != "array") do={ :set ($r->"cpu_count") $v_cpu_count }
  :local v_cpu_load [/system resource get cpu-load]
  :if ([:typeof $v_cpu_load] != "array") do={ :set ($r->"cpu_load") $v_cpu_load }
  :local v_free_memory [/system resource get free-memory]
  :if ([:typeof $v_free_memory] != "array") do={ :set ($r->"free_memory") $v_free_memory }
  :local v_total_memory [/system resource get total-memory]
  :if ([:typeof $v_total_memory] != "array") do={ :set ($r->"total_memory") $v_total_memory }
  :local v_free_hdd [/system resource get free-hdd-space]
  :if ([:typeof $v_free_hdd] != "array") do={ :set ($r->"free_hdd") $v_free_hdd }
  :local v_total_hdd [/system resource get total-hdd-space]
  :if ([:typeof $v_total_hdd] != "array") do={ :set ($r->"total_hdd") $v_total_hdd }
  :local v_uptime [/system resource get uptime]
  :if ([:typeof $v_uptime] != "array") do={ :set ($r->"uptime") $v_uptime }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_version ($i->"version")
    :if ([:typeof $v_version] != "array") do={ :set ($r->"version") $v_version }
    :local v_installed ($i->"installed")
    :if ([:typeof $v_installed] != "array") do={ :set ($r->"installed") $v_installed }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_type ($i->"type")
    :if ([:typeof $v_type] != "array") do={ :set ($r->"type") $v_type }
    :local v_running ($i->"running")
    :if ([:typeof $v_running] != "array") do={ :set ($r->"running") $v_running }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_mtu ($i->"mtu")
    :if ([:typeof $v_mtu] != "array") do={ :set ($r->"mtu") $v_mtu }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_vlan_filtering ($i->"vlan-filtering")
    :if ([:typeof $v_vlan_filtering] != "array") do={ :set ($r->"vlan_filtering") $v_vlan_filtering }
    :local v_pvid ($i->"pvid")
    :if ([:typeof $v_pvid] != "array") do={ :set ($r->"pvid") $v_pvid }
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
    :local v_bridge ($i->"bridge")
    :if ([:typeof $v_bridge] != "array") do={ :set ($r->"bridge") $v_bridge }
    :local v_interface ($i->"interface")
    :if ([:typeof $v_interface] != "array") do={ :set ($r->"interface") $v_interface }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_edge ($i->"edge")
    :if ([:typeof $v_edge] != "array") do={ :set ($r->"edge") $v_edge }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_interface ($i->"interface")
    :if ([:typeof $v_interface] != "array") do={ :set ($r->"interface") $v_interface }
    :local v_vlan_id ($i->"vlan-id")
    :if ([:typeof $v_vlan_id] != "array") do={ :set ($r->"vlan_id") $v_vlan_id }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
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
    :local v_address ($i->"address")
    :if ([:typeof $v_address] != "array") do={ :set ($r->"address") $v_address }
    :local v_network ($i->"network")
    :if ([:typeof $v_network] != "array") do={ :set ($r->"network") $v_network }
    :local v_interface ($i->"interface")
    :if ([:typeof $v_interface] != "array") do={ :set ($r->"interface") $v_interface }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_interface ($i->"interface")
    :if ([:typeof $v_interface] != "array") do={ :set ($r->"interface") $v_interface }
    :local v_address_pool ($i->"address-pool")
    :if ([:typeof $v_address_pool] != "array") do={ :set ($r->"address_pool") $v_address_pool }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_ranges ($i->"ranges")
    :if ([:typeof $v_ranges] != "array") do={ :set ($r->"ranges") $v_ranges }
    :local v_next_pool ($i->"next-pool")
    :if ([:typeof $v_next_pool] != "array") do={ :set ($r->"next_pool") $v_next_pool }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_interface ($i->"interface")
    :if ([:typeof $v_interface] != "array") do={ :set ($r->"interface") $v_interface }
    :local v_address_pool ($i->"address-pool")
    :if ([:typeof $v_address_pool] != "array") do={ :set ($r->"address_pool") $v_address_pool }
    :local v_profile ($i->"profile")
    :if ([:typeof $v_profile] != "array") do={ :set ($r->"profile") $v_profile }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_profile ($i->"profile")
    :if ([:typeof $v_profile] != "array") do={ :set ($r->"profile") $v_profile }
    :local v_server ($i->"server")
    :if ([:typeof $v_server] != "array") do={ :set ($r->"server") $v_server }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_service ($i->"service")
    :if ([:typeof $v_service] != "array") do={ :set ($r->"service") $v_service }
    :local v_profile ($i->"profile")
    :if ([:typeof $v_profile] != "array") do={ :set ($r->"profile") $v_profile }
    :local v_remote_address ($i->"remote-address")
    :if ([:typeof $v_remote_address] != "array") do={ :set ($r->"remote_address") $v_remote_address }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_service_name ($i->"service-name")
    :if ([:typeof $v_service_name] != "array") do={ :set ($r->"service_name") $v_service_name }
    :local v_max_mtu ($i->"max-mtu")
    :if ([:typeof $v_max_mtu] != "array") do={ :set ($r->"max_mtu") $v_max_mtu }
    :local v_authentication ($i->"authentication")
    :if ([:typeof $v_authentication] != "array") do={ :set ($r->"authentication") $v_authentication }
    :local v_one_session_per_host ($i->"one-session-per-host")
    :if ([:typeof $v_one_session_per_host] != "array") do={ :set ($r->"one_session_per_host") $v_one_session_per_host }
    :local v_keepalive_timeout ($i->"keepalive-timeout")
    :if ([:typeof $v_keepalive_timeout] != "array") do={ :set ($r->"keepalive_timeout") $v_keepalive_timeout }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_local_address ($i->"local-address")
    :if ([:typeof $v_local_address] != "array") do={ :set ($r->"local_address") $v_local_address }
    :local v_remote_address ($i->"remote-address")
    :if ([:typeof $v_remote_address] != "array") do={ :set ($r->"remote_address") $v_remote_address }
    :local v_use_compression ($i->"use-compression")
    :if ([:typeof $v_use_compression] != "array") do={ :set ($r->"use_compression") $v_use_compression }
    :local v_use_encryption ($i->"use-encryption")
    :if ([:typeof $v_use_encryption] != "array") do={ :set ($r->"use_encryption") $v_use_encryption }
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
    :local v_address ($i->"address")
    :if ([:typeof $v_address] != "array") do={ :set ($r->"address") $v_address }
    :local v_port ($i->"port")
    :if ([:typeof $v_port] != "array") do={ :set ($r->"port") $v_port }
    :local v_timeout ($i->"timeout")
    :if ([:typeof $v_timeout] != "array") do={ :set ($r->"timeout") $v_timeout }
    :local v_src_address ($i->"src-address")
    :if ([:typeof $v_src_address] != "array") do={ :set ($r->"src_address") $v_src_address }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_use_radius ($i->"use-radius")
    :if ([:typeof $v_use_radius] != "array") do={ :set ($r->"use-radius") $v_use_radius }
    :local v_radius_interim_update ($i->"radius-interim-update")
    :if ([:typeof $v_radius_interim_update] != "array") do={ :set ($r->"radius-interim-update") $v_radius_interim_update }
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
    :local v_chain ($i->"chain")
    :if ([:typeof $v_chain] != "array") do={ :set ($r->"chain") $v_chain }
    :local v_action ($i->"action")
    :if ([:typeof $v_action] != "array") do={ :set ($r->"action") $v_action }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
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
    :local v_chain ($i->"chain")
    :if ([:typeof $v_chain] != "array") do={ :set ($r->"chain") $v_chain }
    :local v_action ($i->"action")
    :if ([:typeof $v_action] != "array") do={ :set ($r->"action") $v_action }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_to_addresses ($i->"to-addresses")
    :if ([:typeof $v_to_addresses] != "array") do={ :set ($r->"to_addresses") $v_to_addresses }
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
    :local v_dst_address ($i->"dst-address")
    :if ([:typeof $v_dst_address] != "array") do={ :set ($r->"dst_address") $v_dst_address }
    :local v_gateway ($i->"gateway")
    :if ([:typeof $v_gateway] != "array") do={ :set ($r->"gateway") $v_gateway }
    :local v_distance ($i->"distance")
    :if ([:typeof $v_distance] != "array") do={ :set ($r->"distance") $v_distance }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_servers ($i->"servers")
    :if ([:typeof $v_servers] != "array") do={ :set ($r->"servers") $v_servers }
    :local v_dynamic_servers ($i->"dynamic-servers")
    :if ([:typeof $v_dynamic_servers] != "array") do={ :set ($r->"dynamic_servers") $v_dynamic_servers }
    :local v_allow_remote_requests ($i->"allow-remote-requests")
    :if ([:typeof $v_allow_remote_requests] != "array") do={ :set ($r->"allow_remote_requests") $v_allow_remote_requests }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_listen_port ($i->"listen-port")
    :if ([:typeof $v_listen_port] != "array") do={ :set ($r->"listen_port") $v_listen_port }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_port ($i->"port")
    :if ([:typeof $v_port] != "array") do={ :set ($r->"port") $v_port }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_address ($i->"address")
    :if ([:typeof $v_address] != "array") do={ :set ($r->"address") $v_address }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_common_name ($i->"common-name")
    :if ([:typeof $v_common_name] != "array") do={ :set ($r->"common_name") $v_common_name }
    :local v_invalid_after ($i->"invalid-after")
    :if ([:typeof $v_invalid_after] != "array") do={ :set ($r->"invalid_after") $v_invalid_after }
    :local v_expired ($i->"expired")
    :if ([:typeof $v_expired] != "array") do={ :set ($r->"expired") $v_expired }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_ssid ($i->"ssid")
    :if ([:typeof $v_ssid] != "array") do={ :set ($r->"ssid") $v_ssid }
    :local v_mode ($i->"mode")
    :if ([:typeof $v_mode] != "array") do={ :set ($r->"mode") $v_mode }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_enabled ($i->"enabled")
    :if ([:typeof $v_enabled] != "array") do={ :set ($r->"enabled") $v_enabled }
    :local v_certificate ($i->"certificate")
    :if ([:typeof $v_certificate] != "array") do={ :set ($r->"certificate") $v_certificate }
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
    :local v_chain ($i->"chain")
    :if ([:typeof $v_chain] != "array") do={ :set ($r->"chain") $v_chain }
    :local v_action ($i->"action")
    :if ([:typeof $v_action] != "array") do={ :set ($r->"action") $v_action }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_interval ($i->"interval")
    :if ([:typeof $v_interval] != "array") do={ :set ($r->"interval") $v_interval }
    :local v_disabled ($i->"disabled")
    :if ([:typeof $v_disabled] != "array") do={ :set ($r->"disabled") $v_disabled }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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
    :local v_name ($i->"name")
    :if ([:typeof $v_name] != "array") do={ :set ($r->"name") $v_name }
    :local v_comment ($i->"comment")
    :if ([:typeof $v_comment] != "array") do={ :set ($r->"comment") $v_comment }
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

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
# ISPFlow-BOOTSTRAP-GENERATOR-528C90
# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR
# =============================================================================
# ISPFlow router discovery - session abcd1234
# =============================================================================
# READ ONLY. This script changes nothing on your router. It reads what is
# already configured and reports it, so ISPFlow can configure safely.

:put "Starting ISPFlow router discovery...";
:put "";

# --- identity ---
:onerror e in={
  :put ("ISPFlow: identity not reported: " . $e)
} do={
  :local r {}
  :local v [/system identity/get name]
  :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
  :local v [/system resource/get version]
  :if ([:typeof $v] != "array") do={ :set r ($r . "version"=$v) }
  :local j [:serialize to=json value=$r]
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=identity&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=($j)
}

# --- resource ---
:onerror e in={
  :put ("ISPFlow: resource not reported: " . $e)
} do={
  :local r {}
  :local v [/system resource/get board-name]
  :if ([:typeof $v] != "array") do={ :set r ($r . "board_name"=$v) }
  :local v [/system resource/get platform]
  :if ([:typeof $v] != "array") do={ :set r ($r . "platform"=$v) }
  :local v [/system resource/get architecture-name]
  :if ([:typeof $v] != "array") do={ :set r ($r . "architecture"=$v) }
  :local v [/system resource/get cpu]
  :if ([:typeof $v] != "array") do={ :set r ($r . "cpu"=$v) }
  :local v [/system resource/get cpu-count]
  :if ([:typeof $v] != "array") do={ :set r ($r . "cpu_count"=$v) }
  :local v [/system resource/get cpu-load]
  :if ([:typeof $v] != "array") do={ :set r ($r . "cpu_load"=$v) }
  :local v [/system resource/get free-memory]
  :if ([:typeof $v] != "array") do={ :set r ($r . "free_memory"=$v) }
  :local v [/system resource/get total-memory]
  :if ([:typeof $v] != "array") do={ :set r ($r . "total_memory"=$v) }
  :local v [/system resource/get free-hdd-space]
  :if ([:typeof $v] != "array") do={ :set r ($r . "free_hdd"=$v) }
  :local v [/system resource/get total-hdd-space]
  :if ([:typeof $v] != "array") do={ :set r ($r . "total_hdd"=$v) }
  :local v [/system resource/get uptime]
  :if ([:typeof $v] != "array") do={ :set r ($r . "uptime"=$v) }
  :local j [:serialize to=json value=$r]
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=resource&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=($j)
}

# --- board ---
:onerror e in={
  :put ("ISPFlow: board not reported: " . $e)
} do={
  :local r {}
  :local v [/system routerboard/get serial-number]
  :if ([:typeof $v] != "array") do={ :set r ($r . "serial_number"=$v) }
  :local v [/system routerboard/get model]
  :if ([:typeof $v] != "array") do={ :set r ($r . "model"=$v) }
  :local v [/system routerboard/get firmware-type]
  :if ([:typeof $v] != "array") do={ :set r ($r . "firmware_type"=$v) }
  :local j [:serialize to=json value=$r]
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=board&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=($j)
}

# --- packages ---
:onerror e in={
  :put ("ISPFlow: packages not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/system package/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"version")
    :if ([:typeof $v] != "array") do={ :set r ($r . "version"=$v) }
    :local v ($i->"installed")
    :if ([:typeof $v] != "array") do={ :set r ($r . "installed"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=packages&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- interfaces ---
:onerror e in={
  :put ("ISPFlow: interfaces not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/interface/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"type")
    :if ([:typeof $v] != "array") do={ :set r ($r . "type"=$v) }
    :local v ($i->"running")
    :if ([:typeof $v] != "array") do={ :set r ($r . "running"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local v ($i->"mtu")
    :if ([:typeof $v] != "array") do={ :set r ($r . "mtu"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=interfaces&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- bridges ---
:onerror e in={
  :put ("ISPFlow: bridges not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/interface bridge/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local v ($i->"vlan-filtering")
    :if ([:typeof $v] != "array") do={ :set r ($r . "vlan_filtering"=$v) }
    :local v ($i->"pvid")
    :if ([:typeof $v] != "array") do={ :set r ($r . "pvid"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=bridges&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- vlans ---
:onerror e in={
  :put ("ISPFlow: vlans not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/interface vlan/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set r ($r . "interface"=$v) }
    :local v ($i->"vlan-id")
    :if ([:typeof $v] != "array") do={ :set r ($r . "vlan_id"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=vlans&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- addresses ---
:onerror e in={
  :put ("ISPFlow: addresses not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip address/find] do={
    :local r {}
    :local v ($i->"address")
    :if ([:typeof $v] != "array") do={ :set r ($r . "address"=$v) }
    :local v ($i->"network")
    :if ([:typeof $v] != "array") do={ :set r ($r . "network"=$v) }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set r ($r . "interface"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=addresses&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- dhcp ---
:onerror e in={
  :put ("ISPFlow: dhcp not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip dhcp-server/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set r ($r . "interface"=$v) }
    :local v ($i->"address-pool")
    :if ([:typeof $v] != "array") do={ :set r ($r . "address_pool"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=dhcp&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- pools ---
:onerror e in={
  :put ("ISPFlow: pools not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip pool/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"ranges")
    :if ([:typeof $v] != "array") do={ :set r ($r . "ranges"=$v) }
    :local v ($i->"next-pool")
    :if ([:typeof $v] != "array") do={ :set r ($r . "next_pool"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pools&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- hotspot ---
:onerror e in={
  :put ("ISPFlow: hotspot not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip hotspot/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"interface")
    :if ([:typeof $v] != "array") do={ :set r ($r . "interface"=$v) }
    :local v ($i->"address-pool")
    :if ([:typeof $v] != "array") do={ :set r ($r . "address_pool"=$v) }
    :local v ($i->"profile")
    :if ([:typeof $v] != "array") do={ :set r ($r . "profile"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=hotspot&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- hotspot ---
:onerror e in={
  :put ("ISPFlow: hotspot not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip hotspot user/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"profile")
    :if ([:typeof $v] != "array") do={ :set r ($r . "profile"=$v) }
    :local v ($i->"server")
    :if ([:typeof $v] != "array") do={ :set r ($r . "server"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=hotspot&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- pppoe ---
:onerror e in={
  :put ("ISPFlow: pppoe not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ppp secret/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"service")
    :if ([:typeof $v] != "array") do={ :set r ($r . "service"=$v) }
    :local v ($i->"profile")
    :if ([:typeof $v] != "array") do={ :set r ($r . "profile"=$v) }
    :local v ($i->"remote-address")
    :if ([:typeof $v] != "array") do={ :set r ($r . "remote_address"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pppoe&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- pppoe-servers ---
:onerror e in={
  :put ("ISPFlow: pppoe-servers not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/interface pppoe-server server/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"service-name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "service_name"=$v) }
    :local v ($i->"max-mtu")
    :if ([:typeof $v] != "array") do={ :set r ($r . "max_mtu"=$v) }
    :local v ($i->"authentication")
    :if ([:typeof $v] != "array") do={ :set r ($r . "authentication"=$v) }
    :local v ($i->"one-session-per-host")
    :if ([:typeof $v] != "array") do={ :set r ($r . "one_session_per_host"=$v) }
    :local v ($i->"keepalive-timeout")
    :if ([:typeof $v] != "array") do={ :set r ($r . "keepalive_timeout"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pppoe-servers&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- pppoe-profiles ---
:onerror e in={
  :put ("ISPFlow: pppoe-profiles not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ppp profile/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local v ($i->"local-address")
    :if ([:typeof $v] != "array") do={ :set r ($r . "local_address"=$v) }
    :local v ($i->"remote-address")
    :if ([:typeof $v] != "array") do={ :set r ($r . "remote_address"=$v) }
    :local v ($i->"use-compression")
    :if ([:typeof $v] != "array") do={ :set r ($r . "use_compression"=$v) }
    :local v ($i->"use-encryption")
    :if ([:typeof $v] != "array") do={ :set r ($r . "use_encryption"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pppoe-profiles&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- radius ---
:onerror e in={
  :put ("ISPFlow: radius not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/radius/find] do={
    :local r {}
    :local v ($i->"address")
    :if ([:typeof $v] != "array") do={ :set r ($r . "address"=$v) }
    :local v ($i->"port")
    :if ([:typeof $v] != "array") do={ :set r ($r . "port"=$v) }
    :local v ($i->"timeout")
    :if ([:typeof $v] != "array") do={ :set r ($r . "timeout"=$v) }
    :local v ($i->"src-address")
    :if ([:typeof $v] != "array") do={ :set r ($r . "src_address"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=radius&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- radius-aaa ---
:onerror e in={
  :put ("ISPFlow: radius-aaa not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ppp aaa/find] do={
    :local r {}
    :local v ($i->"use-radius")
    :if ([:typeof $v] != "array") do={ :set r ($r . "use-radius"=$v) }
    :local v ($i->"radius-interim-update")
    :if ([:typeof $v] != "array") do={ :set r ($r . "radius-interim-update"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=radius-aaa&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- firewall ---
:onerror e in={
  :put ("ISPFlow: firewall not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip firewall filter/find] do={
    :local r {}
    :local v ($i->"chain")
    :if ([:typeof $v] != "array") do={ :set r ($r . "chain"=$v) }
    :local v ($i->"action")
    :if ([:typeof $v] != "array") do={ :set r ($r . "action"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=firewall&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- nat ---
:onerror e in={
  :put ("ISPFlow: nat not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip firewall nat/find] do={
    :local r {}
    :local v ($i->"chain")
    :if ([:typeof $v] != "array") do={ :set r ($r . "chain"=$v) }
    :local v ($i->"action")
    :if ([:typeof $v] != "array") do={ :set r ($r . "action"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local v ($i->"to-addresses")
    :if ([:typeof $v] != "array") do={ :set r ($r . "to_addresses"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=nat&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- routes ---
:onerror e in={
  :put ("ISPFlow: routes not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip route/find] do={
    :local r {}
    :local v ($i->"dst-address")
    :if ([:typeof $v] != "array") do={ :set r ($r . "dst_address"=$v) }
    :local v ($i->"gateway")
    :if ([:typeof $v] != "array") do={ :set r ($r . "gateway"=$v) }
    :local v ($i->"distance")
    :if ([:typeof $v] != "array") do={ :set r ($r . "distance"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=routes&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- dns ---
:onerror e in={
  :put ("ISPFlow: dns not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip dns/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"servers")
    :if ([:typeof $v] != "array") do={ :set r ($r . "servers"=$v) }
    :local v ($i->"dynamic-servers")
    :if ([:typeof $v] != "array") do={ :set r ($r . "dynamic_servers"=$v) }
    :local v ($i->"allow-remote-requests")
    :if ([:typeof $v] != "array") do={ :set r ($r . "allow_remote_requests"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=dns&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- wireguard ---
:onerror e in={
  :put ("ISPFlow: wireguard not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/interface wireguard/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"listen-port")
    :if ([:typeof $v] != "array") do={ :set r ($r . "listen_port"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=wireguard&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- services ---
:onerror e in={
  :put ("ISPFlow: services not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip service/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"port")
    :if ([:typeof $v] != "array") do={ :set r ($r . "port"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local v ($i->"address")
    :if ([:typeof $v] != "array") do={ :set r ($r . "address"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=services&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- certificates ---
:onerror e in={
  :put ("ISPFlow: certificates not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/certificate/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"common-name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "common_name"=$v) }
    :local v ($i->"invalid-after")
    :if ([:typeof $v] != "array") do={ :set r ($r . "invalid_after"=$v) }
    :local v ($i->"expired")
    :if ([:typeof $v] != "array") do={ :set r ($r . "expired"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=certificates&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- wireless ---
:onerror e in={
  :put ("ISPFlow: wireless not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/interface wireless/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"ssid")
    :if ([:typeof $v] != "array") do={ :set r ($r . "ssid"=$v) }
    :local v ($i->"mode")
    :if ([:typeof $v] != "array") do={ :set r ($r . "mode"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=wireless&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- capsman ---
:onerror e in={
  :put ("ISPFlow: capsman not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/caps-man manager/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"enabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "enabled"=$v) }
    :local v ($i->"certificate")
    :if ([:typeof $v] != "array") do={ :set r ($r . "certificate"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=capsman&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- ispflow ---
:onerror e in={
  :put ("ISPFlow: ispflow not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/ip firewall filter/find] do={
    :local r {}
    :local v ($i->"chain")
    :if ([:typeof $v] != "array") do={ :set r ($r . "chain"=$v) }
    :local v ($i->"action")
    :if ([:typeof $v] != "array") do={ :set r ($r . "action"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=ispflow&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- scheduler ---
:onerror e in={
  :put ("ISPFlow: scheduler not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/system scheduler/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"interval")
    :if ([:typeof $v] != "array") do={ :set r ($r . "interval"=$v) }
    :local v ($i->"disabled")
    :if ([:typeof $v] != "array") do={ :set r ($r . "disabled"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=scheduler&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

# --- backup ---
:onerror e in={
  :put ("ISPFlow: backup not reported: " . $e)
} do={
  :local rows ""
  :foreach i in=[/system script/find] do={
    :local r {}
    :local v ($i->"name")
    :if ([:typeof $v] != "array") do={ :set r ($r . "name"=$v) }
    :local v ($i->"comment")
    :if ([:typeof $v] != "array") do={ :set r ($r . "comment"=$v) }
    :local j [:serialize to=json value=$r]
    :if ([:len $rows] > 0) do={ :set rows ($rows . ",") }
    :set rows ($rows . $j)
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=backup&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes http-header-field="Content-Type:application/json" output=user as-value http-data=("[" . $rows . "]")
}

:put "";
:put "ISPFlow discovery finished. Return to your ISPFlow dashboard.";

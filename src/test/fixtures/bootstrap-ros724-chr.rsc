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
# =============================================================================
# ISPFlow router discovery - session abcd1234
# =============================================================================
# READ ONLY. This script changes nothing on your router. It reads what is
# already configured and reports it, so ISPFlow can configure safely.

:put "Starting ISPFlow router discovery...";
:put "";

# --- identity ---
:onerror e do={ :put ("ISPFlow: identity not reported: " . $e) }
{
  :local o "";
  :local j ""
  :local p [/system identity/get name]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"name\":\"" . $j . "\"")
  }
  :local p [/system resource/get version]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"version\":\"" . $j . "\"")
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=identity&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("{" . $o . "}") keep-result=no
}

# --- resource ---
:onerror e do={ :put ("ISPFlow: resource not reported: " . $e) }
{
  :local o "";
  :local j ""
  :local p [/system resource/get board-name]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"board_name\":\"" . $j . "\"")
  }
  :local p [/system resource/get platform]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"platform\":\"" . $j . "\"")
  }
  :local p [/system resource/get architecture-name]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"architecture\":\"" . $j . "\"")
  }
  :local p [/system resource/get cpu]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"cpu\":\"" . $j . "\"")
  }
  :local p [/system resource/get cpu-count]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"cpu_count\":\"" . $j . "\"")
  }
  :local p [/system resource/get cpu-load]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"cpu_load\":\"" . $j . "\"")
  }
  :local p [/system resource/get free-memory]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"free_memory\":\"" . $j . "\"")
  }
  :local p [/system resource/get total-memory]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"total_memory\":\"" . $j . "\"")
  }
  :local p [/system resource/get free-hdd-space]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"free_hdd\":\"" . $j . "\"")
  }
  :local p [/system resource/get total-hdd-space]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"total_hdd\":\"" . $j . "\"")
  }
  :local p [/system resource/get uptime]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"uptime\":\"" . $j . "\"")
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=resource&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("{" . $o . "}") keep-result=no
}

# --- board ---
:onerror e do={ :put ("ISPFlow: board not reported: " . $e) }
{
  :local o "";
  :local j ""
  :local p [/system routerboard/get serial-number]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"serial_number\":\"" . $j . "\"")
  }
  :local p [/system routerboard/get model]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"model\":\"" . $j . "\"")
  }
  :local p [/system routerboard/get firmware-type]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set j [:replace $p "\\" "\\\\"]
    :set j [:replace $j "\"" "\\\""]
    :set o ($o . $s . "\"firmware_type\":\"" . $j . "\"")
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=board&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("{" . $o . "}") keep-result=no
}

# --- packages ---
:onerror e do={ :put ("ISPFlow: packages not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/system package/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"version")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"version\":\"" . $j . "\"")
    }
    :local p ($i->"installed")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"installed\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=packages&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- interfaces ---
:onerror e do={ :put ("ISPFlow: interfaces not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/interface/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"type")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"type\":\"" . $j . "\"")
    }
    :local p ($i->"running")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"running\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :local p ($i->"mtu")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"mtu\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=interfaces&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- bridges ---
:onerror e do={ :put ("ISPFlow: bridges not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/interface bridge/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :local p ($i->"vlan-filtering")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"vlan_filtering\":\"" . $j . "\"")
    }
    :local p ($i->"pvid")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"pvid\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=bridges&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- vlans ---
:onerror e do={ :put ("ISPFlow: vlans not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/interface vlan/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"interface")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interface\":\"" . $j . "\"")
    }
    :local p ($i->"vlan-id")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"vlan_id\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=vlans&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- addresses ---
:onerror e do={ :put ("ISPFlow: addresses not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip address/find] do={
    :local o "";
    :local j ""
    :local p ($i->"address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address\":\"" . $j . "\"")
    }
    :local p ($i->"network")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"network\":\"" . $j . "\"")
    }
    :local p ($i->"interface")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interface\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=addresses&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- dhcp ---
:onerror e do={ :put ("ISPFlow: dhcp not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip dhcp-server/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"interface")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interface\":\"" . $j . "\"")
    }
    :local p ($i->"address-pool")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address_pool\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=dhcp&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- pools ---
:onerror e do={ :put ("ISPFlow: pools not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip pool/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"ranges")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"ranges\":\"" . $j . "\"")
    }
    :local p ($i->"next-pool")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"next_pool\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pools&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- hotspot ---
:onerror e do={ :put ("ISPFlow: hotspot not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip hotspot/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"interface")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interface\":\"" . $j . "\"")
    }
    :local p ($i->"address-pool")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address_pool\":\"" . $j . "\"")
    }
    :local p ($i->"profile")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"profile\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=hotspot&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- hotspot ---
:onerror e do={ :put ("ISPFlow: hotspot not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip hotspot user/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"profile")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"profile\":\"" . $j . "\"")
    }
    :local p ($i->"server")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"server\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=hotspot&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- pppoe ---
:onerror e do={ :put ("ISPFlow: pppoe not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ppp secret/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"service")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"service\":\"" . $j . "\"")
    }
    :local p ($i->"profile")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"profile\":\"" . $j . "\"")
    }
    :local p ($i->"remote-address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"remote_address\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pppoe&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- pppoe-servers ---
:onerror e do={ :put ("ISPFlow: pppoe-servers not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/interface pppoe-server server/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"service-name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"service_name\":\"" . $j . "\"")
    }
    :local p ($i->"max-mtu")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"max_mtu\":\"" . $j . "\"")
    }
    :local p ($i->"authentication")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"authentication\":\"" . $j . "\"")
    }
    :local p ($i->"one-session-per-host")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"one_session_per_host\":\"" . $j . "\"")
    }
    :local p ($i->"keepalive-timeout")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"keepalive_timeout\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pppoe-servers&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- pppoe-profiles ---
:onerror e do={ :put ("ISPFlow: pppoe-profiles not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ppp profile/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :local p ($i->"local-address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"local_address\":\"" . $j . "\"")
    }
    :local p ($i->"remote-address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"remote_address\":\"" . $j . "\"")
    }
    :local p ($i->"use-compression")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"use_compression\":\"" . $j . "\"")
    }
    :local p ($i->"use-encryption")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"use_encryption\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pppoe-profiles&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- radius ---
:onerror e do={ :put ("ISPFlow: radius not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/radius/find] do={
    :local o "";
    :local j ""
    :local p ($i->"address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address\":\"" . $j . "\"")
    }
    :local p ($i->"port")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"port\":\"" . $j . "\"")
    }
    :local p ($i->"timeout")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"timeout\":\"" . $j . "\"")
    }
    :local p ($i->"src-address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"src_address\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=radius&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- radius-aaa ---
:onerror e do={ :put ("ISPFlow: radius-aaa not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ppp aaa/find] do={
    :local o "";
    :local j ""
    :local p ($i->"use-radius")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"use-radius\":\"" . $j . "\"")
    }
    :local p ($i->"radius-interim-update")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"radius-interim-update\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=radius-aaa&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- firewall ---
:onerror e do={ :put ("ISPFlow: firewall not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip firewall filter/find] do={
    :local o "";
    :local j ""
    :local p ($i->"chain")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"chain\":\"" . $j . "\"")
    }
    :local p ($i->"action")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"action\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=firewall&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- nat ---
:onerror e do={ :put ("ISPFlow: nat not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip firewall nat/find] do={
    :local o "";
    :local j ""
    :local p ($i->"chain")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"chain\":\"" . $j . "\"")
    }
    :local p ($i->"action")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"action\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :local p ($i->"to-addresses")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"to_addresses\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=nat&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- routes ---
:onerror e do={ :put ("ISPFlow: routes not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip route/find] do={
    :local o "";
    :local j ""
    :local p ($i->"dst-address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"dst_address\":\"" . $j . "\"")
    }
    :local p ($i->"gateway")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"gateway\":\"" . $j . "\"")
    }
    :local p ($i->"distance")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"distance\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=routes&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- dns ---
:onerror e do={ :put ("ISPFlow: dns not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip dns/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"servers")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"servers\":\"" . $j . "\"")
    }
    :local p ($i->"dynamic-servers")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"dynamic_servers\":\"" . $j . "\"")
    }
    :local p ($i->"allow-remote-requests")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"allow_remote_requests\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=dns&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- wireguard ---
:onerror e do={ :put ("ISPFlow: wireguard not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/interface wireguard/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"listen-port")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"listen_port\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=wireguard&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- services ---
:onerror e do={ :put ("ISPFlow: services not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip service/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"port")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"port\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :local p ($i->"address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=services&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- certificates ---
:onerror e do={ :put ("ISPFlow: certificates not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/certificate/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"common-name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"common_name\":\"" . $j . "\"")
    }
    :local p ($i->"invalid-after")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"invalid_after\":\"" . $j . "\"")
    }
    :local p ($i->"expired")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"expired\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=certificates&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- wireless ---
:onerror e do={ :put ("ISPFlow: wireless not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/interface wireless/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"ssid")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"ssid\":\"" . $j . "\"")
    }
    :local p ($i->"mode")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"mode\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=wireless&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- capsman ---
:onerror e do={ :put ("ISPFlow: capsman not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/caps-man manager/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"enabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"enabled\":\"" . $j . "\"")
    }
    :local p ($i->"certificate")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"certificate\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=capsman&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- ispflow ---
:onerror e do={ :put ("ISPFlow: ispflow not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip firewall filter/find] do={
    :local o "";
    :local j ""
    :local p ($i->"chain")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"chain\":\"" . $j . "\"")
    }
    :local p ($i->"action")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"action\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=ispflow&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- scheduler ---
:onerror e do={ :put ("ISPFlow: scheduler not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/system scheduler/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"interval")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interval\":\"" . $j . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=scheduler&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- backup ---
:onerror e do={ :put ("ISPFlow: backup not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/system script/find] do={
    :local o "";
    :local j ""
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . $j . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :set j [:replace $p "\\" "\\\\"]
      :set j [:replace $j "\"" "\\\""]
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . $j . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=backup&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

:put "";
:put "ISPFlow discovery finished. Return to your ISPFlow dashboard.";

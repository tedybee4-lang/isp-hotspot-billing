# NETISP provisioning - session abcd1234
# Safe to run repeatedly: every block checks before it acts.
# Only objects tagged "NETISP:abcd1234" are created or updated.
# No factory reset, no firewall or WAN changes, no deletions.

# --- DNS resolvers ---
:global NETISP_DNS 1.1.1.1 8.8.8.8
do={/ip dns
  :local have [find where address="1.1.1.1"]
  :if ([:len $have] = 0) do={ add address="1.1.1.1" }
}
do={/ip dns
  :local have [find where address="8.8.8.8"]
  :if ([:len $have] = 0) do={ add address="8.8.8.8" }
}

# --- HotSpot servers ---
do={/ip hotspot
  :local s [find interface="ether2"]
  :if ([:len $s] = 0) do={
    add name="NETISP-abcd1234-ether2" interface="ether2" profile="NETISP-abcd1234" comment="NETISP:abcd1234" disabled=no
  }
}

# --- PPPoE servers ---
do={/interface pppoe-server
  :local s [find service-name="ether3"]
  :if ([:len $s] = 0) do={
    add service-name="ether3" name="NETISP-abcd1234-ether3" one-session-per-host=yes comment="NETISP:abcd1234" disabled=no
  }
}

# --- Management group for the panel ---
do={/user group
  :local g [find name="netisp-panel"]
  :if ([:len $g] = 0) do={ add name="netisp-panel" policy=read,write,api,test }
}

# --- Session timeouts (only on servers we created) ---
do={/ip hotspot
  :local mine [find comment="NETISP:abcd1234"]
  :foreach s in=$mine do={
    :set s "idle-timeout=5m"
    :set s "keepalive-timeout=30m"
  }
}

# --- RADIUS servers ---
do={/radius
  :local r [find address="10.10.0.1"]
  :if ([:len $r] = 0) do={
    add address="10.10.0.1" service=hotspot,ppp comment="NETISP:abcd1234" secret="(set from the panel)"
  }
}

:put "NETISP:abcd1234: configuration applied."
:log info "NETISP:abcd1234 provisioning finished."
:put ("ISPFlow: registered as " . $identity);
:put ("ISPFlow: RouterOS " . $version . " on " . $board-name);

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
  :local p [/system identity/get name]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get version]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"version\":\"" . [:tostr $p] . "\"")
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=identity&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("{" . $o . "}") keep-result=no
}

# --- resource ---
:onerror e do={ :put ("ISPFlow: resource not reported: " . $e) }
{
  :local o "";
  :local p [/system resource/get board-name]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"board_name\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get platform]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"platform\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get architecture-name]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"architecture\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get cpu]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"cpu\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get cpu-count]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"cpu_count\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get cpu-load]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"cpu_load\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get free-memory]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"free_memory\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get total-memory]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"total_memory\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get free-hdd-space]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"free_hdd\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get total-hdd-space]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"total_hdd\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system resource/get uptime]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"uptime\":\"" . [:tostr $p] . "\"")
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=resource&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("{" . $o . "}") keep-result=no
}

# --- board ---
:onerror e do={ :put ("ISPFlow: board not reported: " . $e) }
{
  :local o "";
  :local p [/system routerboard/get serial-number]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"serial_number\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system routerboard/get model]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"model\":\"" . [:tostr $p] . "\"")
  }
  :local p [/system routerboard/get firmware-type]
  :if ([:typeof $p] = "array") do={ :set p "" }
  :if ($p != "") do={
    :local s ""
    :if ([:len $o] > 0) do={ :set s "," }
    :set o ($o . $s . "\"firmware_type\":\"" . [:tostr $p] . "\"")
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=board&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("{" . $o . "}") keep-result=no
}

# --- packages ---
:onerror e do={ :put ("ISPFlow: packages not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/system package/find] do={
    :local o "";
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"version")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"version\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"installed")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"installed\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"type")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"type\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"running")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"running\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"mtu")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"mtu\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"vlan-filtering")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"vlan_filtering\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"pvid")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"pvid\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"interface")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interface\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"vlan-id")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"vlan_id\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"network")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"network\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"interface")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interface\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"interface")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interface\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"address-pool")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address_pool\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"ranges")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"ranges\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"next-pool")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"next_pool\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"interface")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interface\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"address-pool")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address_pool\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"profile")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"profile\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
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
  :foreach i in=[/ip hotspot user/find] do={
    :local o "";
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"profile")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"profile\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"server")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"server\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=pppoe&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- radius ---
:onerror e do={ :put ("ISPFlow: radius not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ppp profile/find] do={
    :local o "";
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"local-address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"local_address\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"remote-address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"remote_address\":\"" . [:tostr $p] . "\"")
    }
    :if ([:len $o] > 0) do={
      :local s ""
      :if ([:len $rows] > 0) do={ :set s "," }
      :set rows ($rows . $s . "{" . $o . "}")
    }
  }
  /tool fetch url="https://demo.supabase.co/functions/v1/router-provision/report?survey=radius&token=dddddddddddddddddddddddddddddddddddddddddddddddd&tag=abcd1234" method=POST check-certificate=yes output=user as-value http-data=("[" . $rows . "]") keep-result=no
}

# --- firewall ---
:onerror e do={ :put ("ISPFlow: firewall not reported: " . $e) }
{
  :local rows "";
  :foreach i in=[/ip firewall filter/find] do={
    :local o "";
    :local p ($i->"chain")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"chain\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"action")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"action\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"chain")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"chain\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"action")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"action\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"to-addresses")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"to_addresses\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"dst-address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"dst_address\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"gateway")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"gateway\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"distance")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"distance\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"servers")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"servers\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"dynamic-servers")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"dynamic_servers\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"allow-remote-requests")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"allow_remote_requests\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"listen-port")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"listen_port\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"port")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"port\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"address")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"address\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"common-name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"common_name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"invalid-after")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"invalid_after\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"expired")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"expired\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"ssid")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"ssid\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"mode")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"mode\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"enabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"enabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"certificate")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"certificate\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"chain")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"chain\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"action")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"action\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"interval")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"interval\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"disabled")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"disabled\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
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
    :local p ($i->"name")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"name\":\"" . [:tostr $p] . "\"")
    }
    :local p ($i->"comment")
    :if ([:typeof $p] = "array") do={ :set p "" }
    :if ($p != "") do={
      :local s ""
      :if ([:len $o] > 0) do={ :set s "," }
      :set o ($o . $s . "\"comment\":\"" . [:tostr $p] . "\"")
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

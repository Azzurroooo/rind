import assert from "node:assert/strict"
import test from "node:test"
import { localAddresses, outboundAddress } from "../src/main/gateway/network.ts"

const ipv4 = (address, internal = false) => ({ address, family: "IPv4", internal })
test("Wi-Fi wins over Hyper-V and VPN adapters even if a VPN owns the default route", () => {
  const interfaces = {
    "vEthernet (WLAN)": [ipv4("172.25.160.1")],
    "vEthernet (Default Switch)": [ipv4("192.168.176.1")],
    Tailscale: [ipv4("100.81.25.85")],
    WLAN: [ipv4("192.168.1.44")],
    Ethernet: [ipv4("169.254.22.5")],
    Loopback: [ipv4("127.0.0.1", true)],
  }
  const result = localAddresses(interfaces, "100.81.25.85").map((row) => row.address)
  assert.equal(result[0], "192.168.1.44")
  assert.equal(result[1], "100.81.25.85")
  assert.equal(result.length, 4)
})
test("route selection breaks ties between real adapters and duplicate IPs are collapsed", () => {
  const result = localAddresses({ Ethernet: [ipv4("192.168.2.2")], WLAN: [ipv4("192.168.1.44")], Duplicate: [ipv4("192.168.1.44")] }, "192.168.1.44")
  assert.deepEqual(result.map((row) => row.address), ["192.168.1.44", "192.168.2.2"])
  assert.deepEqual(localAddresses({ offline: [], unknown: undefined, v6: [{ address: "fe80::1" }] }), [])
})
test("route lookup completes without sending data", { timeout: 2000 }, async () => {
  assert.equal(typeof await outboundAddress(), "string")
})

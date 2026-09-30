import { createSocket } from "node:dgram"
import { isIPv4 } from "node:net"
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os"

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>
const virtual = /vethernet|hyper-v|vmware|virtualbox|vbox|docker|wsl|vet[h0-9]|bridge|loopback|\btun\b|\btap\b/i
const vpn = /tailscale|zerotier|wireguard|vpn|utun/i

/** Ask the routing table for the outbound interface; UDP connect sends no data. */
export function outboundAddress(): Promise<string> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4")
    let settled = false
    const finish = (address = "") => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* No socket was bound if route lookup failed. */ }
      resolve(address)
    }
    const timer = setTimeout(() => finish(), 500)
    socket.once("error", () => finish())
    socket.connect(9, "192.0.2.1", () => finish(socket.address().address))
  })
}

/** Prefer a physical LAN over host-only adapters and VPNs; never hide fallbacks. */
export function localAddresses(interfaces: Interfaces = networkInterfaces(), preferred = "") {
  const rows = Object.entries(interfaces).flatMap(([name, entries]) => (entries || []).flatMap((entry) => {
    const address = entry.address
    if (entry.internal || !isIPv4(address) || /^(?:0\.|127\.|169\.254\.)/.test(address)) return []
    const privateLan = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address)
    const isVpn = vpn.test(name) || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)
    const isVirtual = virtual.test(name) || /^198\.(?:18|19)\./.test(address)
    const rank = (isVirtual ? 60 : isVpn ? 40 : privateLan ? 0 : 20) + (address === preferred ? 0 : 1)
    return [{ name, address, rank }]
  }))
  return [...new Map(rows.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map((row) => [row.address, row])).values()]
}

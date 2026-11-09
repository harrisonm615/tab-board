// What the Mac is doing right now: CPU, GPU, memory, network and free disk space.
// Small system tools only, with no permission prompts, and only while the panel is showing. No battery: it's in the menu bar right above.
const { execFile } = require('child_process')
const os = require('os')

const SLOW_EVERY = 3 // disks and the Wi-Fi link change slowly, so they're read every third look
const STALE_MS = 20_000 // a gap longer than this means the panel was hidden: an average over the gap isn't "now"
const SMALL_DISK_GB = 8 // a recorder or a mounted installer isn't worth a place on the line

const run = (command, args, timeout = 5_000) =>
  new Promise(resolve => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : stdout))
  })

function cpuTimes(cores = os.cpus()) {
  let idle = 0
  let total = 0
  for (const { times } of cores) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

function cpuPercent(before, now) {
  const total = now.total - before.total
  return total > 0 ? Math.min(Math.max(100 * (1 - (now.idle - before.idle) / total), 0), 100) : undefined
}

// The same sum as Activity Monitor's Memory Used. A full-looking Mac is normal, so the warning comes from macOS's own pressure level, not this number.
function memoryFrom(vmStat, totalBytes, pressureLevel) {
  if (!vmStat) return undefined
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1])
  const pages = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(vmStat)?.[1])
  const used = (pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page
  if (!Number.isFinite(used)) return undefined
  const pressure = { 2: 'warning', 4: 'critical' }[Number(pressureLevel)] || 'normal'
  return { percent: Math.min(100 * used / totalBytes, 100), usedGB: used / 2 ** 30, totalGB: totalBytes / 2 ** 30, pressure }
}

// All the Mac's network ports together, so it's right on Wi-Fi or a cable, and VPNs aren't counted twice.
function netBytes(netstat) {
  if (!netstat) return undefined
  let down = 0
  let up = 0
  let seen = false
  for (const line of netstat.split('\n')) {
    if (!/^en\d+\*?\s+\d+\s+<Link#/.test(line)) continue
    const cols = line.trim().split(/\s+/)
    down += Number(cols[cols.length - 5])
    up += Number(cols[cols.length - 2])
    seen = true
  }
  return seen ? { down, up } : undefined
}

function netRates(before, now, seconds) {
  if (!before || !now || seconds <= 0) return undefined
  const mbps = (a, b) => Math.max(b - a, 0) * 8 / 1e6 / seconds
  return { down: mbps(before.down, now.down), up: mbps(before.up, now.up) }
}

function gpuPercent(ioreg) {
  const found = /"Device Utilization %"\s*=\s*(\d+)/.exec(ioreg || '')
  return found ? Number(found[1]) : undefined
}

// Sizes in GB the way Finder counts them. Local drives only (df -l), so a network drive that's gone can't hang it.
function disksFrom(df) {
  const out = []
  for (const line of (df || '').split('\n')) {
    const cols = /^.+?\s+(\d+)\s+\d+\s+(\d+)\s+\d+%\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)
    if (!cols) continue
    const [, blocks, avail, mount] = cols
    const isMac = mount === '/System/Volumes/Data'
    const name = isMac ? 'Mac' : /^\/Volumes\/([^/.][^/]*)$/.exec(mount)?.[1]
    const totalGB = Number(blocks) * 1024 / 1e9
    if (!name || totalGB < SMALL_DISK_GB) continue
    const freeGB = Number(avail) * 1024 / 1e9
    const share = freeGB / totalGB
    // The Mac's own disk matters more: renders write to it, and macOS itself struggles when it's nearly full.
    const tone = share < 0.03 || (isMac && freeGB < 20) ? 'bad' : share < (isMac ? 0.15 : 0.1) ? 'warn' : ''
    out.push({ name, freeGB, totalGB, tone })
  }
  return out.sort((a, b) => (b.name === 'Mac') - (a.name === 'Mac') || a.name.localeCompare(b.name))
}

// CoreWLAN through JavaScript for Automation. Rate, signal and band need no Location permission (only the network's name would, and it isn't read).
const WIFI_READ = "ObjC.import('CoreWLAN');var i=$.CWWiFiClient.sharedWiFiClient.interface;JSON.stringify({device:ObjC.unwrap(i.interfaceName),rate:i.transmitRate,rssi:i.rssiValue,band:i.wlanChannel.channelBand})"
const BANDS = { 1: '2.4 GHz', 2: '5 GHz', 3: '6 GHz' }

function wifiFrom(text) {
  try {
    const { device, rate, rssi, band } = JSON.parse(text)
    return { device, rate: Number(rate), rssi: Number(rssi), band: BANDS[Number(band)] }
  } catch {
    return undefined
  }
}

// Wi-Fi only when that's the way out to the internet.
function linkFrom(route, wifi) {
  const device = /interface:\s*(\S+)/.exec(route || '')?.[1]
  if (!device) return { kind: 'Offline' }
  if (wifi && wifi.device === device && wifi.rate > 0) return { kind: 'Wi-Fi', ...wifi }
  return { kind: device.startsWith('en') ? 'Wired' : 'Network' }
}

class Gauges {
  constructor() {
    this.looks = 0
  }

  async read() {
    const now = Date.now()
    const cpuNow = cpuTimes()
    const [vm, pressure, netstat, ioreg] = await Promise.all([
      run('/usr/bin/vm_stat', []),
      run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
      run('/usr/sbin/netstat', ['-ibn']),
      run('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']),
    ])
    const netNow = netBytes(netstat)
    const seconds = this.before ? (now - this.before.at) / 1000 : 0
    const fresh = this.before && now - this.before.at <= STALE_MS
    const out = {
      at: now,
      load: Math.round(os.loadavg()[0]),
      cpu: fresh ? cpuPercent(this.before.cpu, cpuNow) : undefined,
      gpu: gpuPercent(ioreg),
      memory: memoryFrom(vm, os.totalmem(), pressure),
      net: fresh ? netRates(this.before.net, netNow, seconds) : undefined,
    }
    this.before = { at: now, cpu: cpuNow, net: netNow }
    if (this.looks % SLOW_EVERY === 0) await this.readSlow()
    this.looks += 1
    return { ...out, disks: this.disks, link: this.link }
  }

  async readSlow() {
    const [df, route, wifi] = await Promise.all([
      run('/bin/df', ['-kl']),
      run('/sbin/route', ['-n', 'get', 'default']),
      run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WIFI_READ]),
    ])
    if (df) this.disks = disksFrom(df)
    this.link = linkFrom(route, wifiFrom(wifi))
  }
}

// macOS's own speed test. It pushes the line as hard as it can for about 45 seconds, so it only ever runs on a press.
async function speedTest() {
  const out = await run('/usr/bin/networkQuality', ['-s', '-c'], 120_000)
  try {
    const { dl_throughput: down, ul_throughput: up } = JSON.parse(out)
    return down > 0 && up > 0 ? { down: down / 1e6, up: up / 1e6, at: Date.now() } : undefined
  } catch {
    return undefined
  }
}

module.exports = { Gauges, speedTest, cpuPercent, cpuTimes, memoryFrom, netBytes, netRates, gpuPercent, disksFrom, wifiFrom, linkFrom }

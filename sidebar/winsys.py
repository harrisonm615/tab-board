#!/usr/bin/env python3
"""Windows' side of the meters and lists the Mac gets from its own small tools. Windows has no ps, netstat or ioreg, so this asks
Windows' system libraries directly, through ctypes: nothing to install, and nothing that asks for a permission.
  winsys.py meters   for the side bar's meters. Answers each line it's sent with one line of JSON: the network's byte counts, the way
                     out to the internet, and how busy the GPU is. It ends by itself once nothing has asked for a minute, or when the
                     side bar that started it goes away, so it can never be left running.
collect.py imports it for the rest: the process list (what a reload would stop), Open apps with their × buttons, and notices.
Windows only. Nothing here sends anything anywhere: the Wi-Fi signal is read from the PC's own adapter, with no scan."""
import base64
import ctypes
import json
import os
import re
import subprocess
import sys
import threading
import time
from ctypes import wintypes

IDLE_S = float(os.environ.get("BAR_METER_IDLE_S") or 60)   # the meters helper ends after this long with no one asking
NO_WINDOW = 0x08000000                                      # CREATE_NO_WINDOW: no console flashing up

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")
HANDLE = wintypes.HANDLE
DWORD = wintypes.DWORD


class FILETIME(ctypes.Structure):
    _fields_ = [("low", DWORD), ("high", DWORD)]

    @property
    def value(self):
        return (self.high << 32) | self.low


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", DWORD), ("cntUsage", DWORD), ("th32ProcessID", DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", DWORD), ("cntThreads", DWORD), ("th32ParentProcessID", DWORD), ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", DWORD), ("szExeFile", ctypes.c_wchar * 260)]


class MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [("cb", DWORD), ("PageFaultCount", DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]


class UNICODE_STRING(ctypes.Structure):
    _fields_ = [("Length", ctypes.c_ushort), ("MaximumLength", ctypes.c_ushort), ("Buffer", ctypes.c_void_p)]


kernel32.CreateToolhelp32Snapshot.restype = HANDLE
kernel32.CreateToolhelp32Snapshot.argtypes = [DWORD, DWORD]
kernel32.Process32FirstW.argtypes = [HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.argtypes = [HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.OpenProcess.restype = HANDLE
kernel32.OpenProcess.argtypes = [DWORD, wintypes.BOOL, DWORD]
kernel32.CloseHandle.argtypes = [HANDLE]
kernel32.GetProcessTimes.argtypes = [HANDLE] + [ctypes.POINTER(FILETIME)] * 4
kernel32.GetSystemTimeAsFileTime.argtypes = [ctypes.POINTER(FILETIME)]
kernel32.QueryFullProcessImageNameW.argtypes = [HANDLE, DWORD, wintypes.LPWSTR, ctypes.POINTER(DWORD)]
kernel32.K32GetProcessMemoryInfo.argtypes = [HANDLE, ctypes.POINTER(MEMORY_COUNTERS), DWORD]
ntdll.NtQueryInformationProcess.restype = ctypes.c_long
ntdll.NtQueryInformationProcess.argtypes = [HANDLE, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]

QUERY_LIMITED = 0x1000          # PROCESS_QUERY_LIMITED_INFORMATION: allowed for any of the person's own processes, with no prompt
COMMAND_LINE_CLASS = 60         # ProcessCommandLineInformation, Windows 8.1 and later
TOO_SMALL = {0xC0000004, 0xC0000023, 0x80000005}


def now_100ns():
    ft = FILETIME()
    kernel32.GetSystemTimeAsFileTime(ctypes.byref(ft))
    return ft.value


def command_line(handle):
    size = ctypes.c_ulong(0)
    buf = ctypes.create_string_buffer(2048)
    status = ntdll.NtQueryInformationProcess(handle, COMMAND_LINE_CLASS, buf, len(buf), ctypes.byref(size)) & 0xFFFFFFFF
    if status in TOO_SMALL and size.value:
        buf = ctypes.create_string_buffer(size.value)
        status = ntdll.NtQueryInformationProcess(handle, COMMAND_LINE_CLASS, buf, len(buf), ctypes.byref(size)) & 0xFFFFFFFF
    if status != 0:
        return ""
    text = UNICODE_STRING.from_buffer(buf)
    return ctypes.wstring_at(text.Buffer, text.Length // 2) if text.Buffer and text.Length else ""


def stem(name):
    return re.sub(r"\.exe$", "", name, flags=re.I)


def short_command(name, line):
    """The program's own name, then what it was given: `node -e ...`, not `"C:\\Program Files\\nodejs\\node.exe" -e ...`,
    so the words read the same as ps's do on a Mac."""
    line = line.strip()
    if line.startswith('"'):
        end = line.find('"', 1)
        rest = line[end + 1:] if end > 0 else ""
    else:
        rest = line.split(None, 1)[1] if len(line.split(None, 1)) > 1 else ""
    return f"{stem(name)} {rest.strip()}".strip()


def processes(lines=True):
    """Every process: {pid: {parent, name, path, cmd, secs, cpu, busy, kb}}. cpu is its average share of one core since it started, as a
    percent, like ps's %CPU; busy is its total CPU time, for working out how busy it is now. Processes this user can't look into
    (the system's own) still appear, with only their name and parent."""
    snap = kernel32.CreateToolhelp32Snapshot(0x2, 0)    # TH32CS_SNAPPROCESS
    if not snap or snap == HANDLE(-1).value:
        return None
    found = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        more = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while more:
            found[entry.th32ProcessID] = {"parent": entry.th32ParentProcessID, "name": entry.szExeFile}
            more = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    now = now_100ns()
    path_buf = ctypes.create_unicode_buffer(1024)
    for pid, proc in found.items():
        proc.update(path="", cmd=stem(proc["name"]), secs=0, cpu=0.0, busy=0, kb=0, born=0)
        handle = kernel32.OpenProcess(QUERY_LIMITED, False, pid) if pid else None
        if not handle:
            continue
        try:
            made, ended, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
            if kernel32.GetProcessTimes(handle, ctypes.byref(made), ctypes.byref(ended), ctypes.byref(kernel), ctypes.byref(user)):
                lived = max(now - made.value, 1)
                proc.update(born=made.value, secs=lived // 10_000_000, busy=kernel.value + user.value, cpu=100 * (kernel.value + user.value) / lived)
            size = DWORD(len(path_buf))
            if kernel32.QueryFullProcessImageNameW(handle, 0, path_buf, ctypes.byref(size)):
                proc["path"] = path_buf.value
            memory = MEMORY_COUNTERS()
            memory.cb = ctypes.sizeof(MEMORY_COUNTERS)
            if kernel32.K32GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
                proc["kb"] = memory.WorkingSetSize // 1024
            if lines:
                proc["cmd"] = short_command(proc["name"], command_line(handle)) or proc["cmd"]
        finally:
            kernel32.CloseHandle(handle)
    # Windows reuses a finished process's number. A "parent" that started after its child is someone else, not the parent.
    for proc in found.values():
        parent = found.get(proc["parent"])
        if parent is None or (parent["born"] and proc["born"] and parent["born"] > proc["born"]) or proc["parent"] == 0:
            proc["parent"] = -1
    return found


# ---------- Open apps: what has a window in Alt+Tab, with its helpers' CPU and memory ----------
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.GetWindow.restype = wintypes.HWND
user32.GetWindow.argtypes = [wintypes.HWND, ctypes.c_uint]
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(DWORD)]
user32.PostMessageW.argtypes = [wintypes.HWND, ctypes.c_uint, wintypes.WPARAM, wintypes.LPARAM]

# This window, and Windows' own desktop and taskbar, get no ×: closing VS Code would stop every chat. A UWP app's window belongs to
# Windows' frame host rather than the app, so those (Settings, Calculator) are left out rather than named wrong.
NEVER_CLOSE = re.compile(r"\\Microsoft VS Code( Insiders)?\\|\\(explorer|ApplicationFrameHost|TextInputHost|SearchHost|StartMenuExperienceHost|ShellExperienceHost|LockApp)\.exe$", re.I)


def app_windows():
    """[(window, pid)] for the windows Alt+Tab shows: visible, not hidden away by Windows, not a tool palette, and not a dialog of another window."""
    out = []
    try:
        dwm = ctypes.WinDLL("dwmapi")
        dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, DWORD, ctypes.c_void_p, DWORD]
    except OSError:
        dwm = None

    def look(hwnd, _):
        if not user32.IsWindowVisible(hwnd) or user32.GetWindowTextLengthW(hwnd) == 0:
            return True
        ex = user32.GetWindowLongW(hwnd, -20) & 0xFFFFFFFF   # GWL_EXSTYLE
        is_app = bool(ex & 0x40000)                         # WS_EX_APPWINDOW
        if (ex & 0x80 and not is_app) or (user32.GetWindow(hwnd, 4) and not is_app):   # WS_EX_TOOLWINDOW, GW_OWNER
            return True
        if dwm:
            cloaked = ctypes.c_int(0)
            if dwm.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), 4) == 0 and cloaked.value:   # DWMWA_CLOAKED
                return True
        pid = DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        out.append((hwnd, pid.value))
        return True

    user32.EnumWindows(WNDENUMPROC(look), 0)
    return out


def file_description(path):
    """The name an app gives itself, as Task Manager shows it: "Google Chrome", not "chrome"."""
    try:
        version = ctypes.WinDLL("version")
        size = version.GetFileVersionInfoSizeW(path, None)
        if not size:
            return ""
        data = ctypes.create_string_buffer(size)
        if not version.GetFileVersionInfoW(path, 0, size, data):
            return ""
        pointer, length = ctypes.c_void_p(), ctypes.c_uint(0)
        if not version.VerQueryValueW(data, "\\VarFileInfo\\Translation", ctypes.byref(pointer), ctypes.byref(length)) or length.value < 4:
            pairs = [(0x0409, 0x04B0)]
        else:
            words = (ctypes.c_ushort * (length.value // 2)).from_address(pointer.value)
            pairs = [(words[i], words[i + 1]) for i in range(0, len(words) - 1, 2)] + [(0x0409, 0x04B0)]
        for language, page in pairs:
            for field in ("FileDescription", "ProductName"):
                if version.VerQueryValueW(data, f"\\StringFileInfo\\{language:04x}{page:04x}\\{field}", ctypes.byref(pointer), ctypes.byref(length)) and length.value > 1:
                    text = ctypes.wstring_at(pointer.value, length.value - 1).strip()
                    if text:
                        return text
    except (OSError, ValueError):
        pass
    return ""


def usage_text(share, kb):
    return f"{'<1' if share < 1 else round(share)}% · {kb / 1048576:.1f} GB", f"{'<1' if share < 1 else round(share)}% CPU · {kb / 1048576:.1f} GB"


def open_apps(before=None, now=None):
    """{"rows": [{id, name, text, tip, cpu, kb}]}, busiest first, and this look's CPU times for next time. One row per program, by its
    path, with every process under it counted, since Chrome or Teams runs as dozens. CPU is measured since the last look when there was
    one in the last two minutes, or else averaged since the app started."""
    procs = processes(lines=False)
    if procs is None:
        return None, None
    now = now or time.time()
    kids = {}
    for pid, proc in procs.items():
        kids.setdefault(proc["parent"], []).append(pid)
    by_app = {}
    for hwnd, pid in app_windows():
        proc = procs.get(pid)
        if not proc or not proc["path"] or NEVER_CLOSE.search(proc["path"]):
            continue
        by_app.setdefault(proc["path"].lower(), {"path": proc["path"], "pids": set()})["pids"].add(pid)
    cores = os.cpu_count() or 1
    earlier = before if isinstance(before, dict) and now - (before.get("at") or 0) < 120 else None
    seen = {}
    rows = []
    for app_id, app in by_app.items():
        family, todo = set(), list(app["pids"])
        while todo:
            pid = todo.pop()
            if pid not in family:
                family.add(pid)
                todo += kids.get(pid, [])
        kb = sum(procs[pid]["kb"] for pid in family)
        lifetime = sum(procs[pid]["cpu"] for pid in family)
        busy = 0.0
        for pid in family:
            key = f"{pid}:{procs[pid]['born']}"
            seen[key] = procs[pid]["busy"]
            if earlier:
                busy += max(procs[pid]["busy"] - (earlier["busy"].get(key) or procs[pid]["busy"]), 0)
        share = 100 * busy / 1e7 / (now - earlier["at"]) / cores if earlier else lifetime / cores
        name = file_description(app["path"]) or stem(os.path.basename(app["path"]))
        text, tip = usage_text(share, kb)
        rows.append({"id": app_id, "name": name, "cpu": round(share, 2), "kb": kb, "text": text, "tip": tip})
    rows.sort(key=lambda a: (-a["cpu"], -a["kb"]))
    return {"rows": rows}, {"at": now, "busy": seen}


def quit_apps(ids):
    """Closes each of its windows, the same as clicking its X, so an app with unsaved work asks first. Never ends a process.
    Only what the list offers right now, so a stale click or a made-up id can never close this window."""
    procs = processes(lines=False) or {}
    wanted = {i.lower() for i in ids}
    closed = 0
    for hwnd, pid in app_windows():
        path = (procs.get(pid) or {}).get("path") or ""
        if path and path.lower() in wanted and not NEVER_CLOSE.search(path):
            closed += bool(user32.PostMessageW(hwnd, 0x0010, 0, 0))   # WM_CLOSE
    return closed


# ---------- Notices: a Windows notification that opens the chat when clicked ----------
# The same words as the tab-board plugin's copy in hooks/register.tsx, which the Windows test checks. {XML} is base64, so nothing in a
# chat's title can end a quote; {TAG} is a chat's id and {APP} one of the two names below.
TOAST_PS = """$ErrorActionPreference = 'Stop'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{XML}')))
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = '{TAG}'
$toast.Group = 'tab-board'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{APP}').Show($toast)"""
VS_CODE_APP = "Microsoft.VisualStudioCode"   # shown as Visual Studio Code, with its icon, when its Start menu entry is there
POWERSHELL_APP = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"   # always there


def notice_app():
    for root in (os.environ.get("APPDATA"), os.environ.get("ProgramData")):
        if root and os.path.exists(os.path.join(root, "Microsoft", "Windows", "Start Menu", "Programs", "Visual Studio Code", "Visual Studio Code.lnk")):
            return VS_CODE_APP
    return POWERSHELL_APP


def xml_text(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def toast_script(title, heading, body, url, tag, app):
    xml = (f'<toast activationType="protocol" launch="{xml_text(url)}"><visual><binding template="ToastGeneric">'
           f"<text>{xml_text(title)}</text><text>{xml_text(heading)}</text><text>{xml_text(body)}</text>"
           '</binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')
    encoded = base64.b64encode(xml.encode("utf-8")).decode()
    return TOAST_PS.replace("{XML}", encoded).replace("{TAG}", re.sub(r"[^\w-]", "", tag)[:64]).replace("{APP}", app)


def powershell():
    return os.path.join(os.environ.get("SystemRoot") or "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")


def notice(title, heading, body, url, tag):
    """True if Windows took it. Windows PowerShell, which every Windows has, is what can reach Windows' notifications without anything installed."""
    script = toast_script(title, heading, body, url, tag, notice_app())
    try:
        done = subprocess.run([powershell(), "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.b64encode(script.encode("utf-16-le")).decode()],
                              capture_output=True, timeout=20, creationflags=NO_WINDOW)
        return done.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ---------- The meters: network, the way out, and the GPU ----------
class MIB_IF_ROW2(ctypes.Structure):
    _fields_ = [("InterfaceLuid", ctypes.c_uint64), ("InterfaceIndex", ctypes.c_uint32), ("InterfaceGuid", ctypes.c_ubyte * 16),
                ("Alias", ctypes.c_uint16 * 257), ("Description", ctypes.c_uint16 * 257), ("PhysicalAddressLength", ctypes.c_uint32),
                ("PhysicalAddress", ctypes.c_ubyte * 32), ("PermanentPhysicalAddress", ctypes.c_ubyte * 32), ("Mtu", ctypes.c_uint32),
                ("Type", ctypes.c_uint32), ("TunnelType", ctypes.c_uint32), ("MediaType", ctypes.c_uint32), ("PhysicalMediumType", ctypes.c_uint32),
                ("AccessType", ctypes.c_uint32), ("DirectionType", ctypes.c_uint32), ("Flags", ctypes.c_uint8), ("OperStatus", ctypes.c_uint32),
                ("AdminStatus", ctypes.c_uint32), ("MediaConnectState", ctypes.c_uint32), ("NetworkGuid", ctypes.c_ubyte * 16),
                ("ConnectionType", ctypes.c_uint32), ("TransmitLinkSpeed", ctypes.c_uint64), ("ReceiveLinkSpeed", ctypes.c_uint64),
                ("InOctets", ctypes.c_uint64), ("InUcastPkts", ctypes.c_uint64), ("InNUcastPkts", ctypes.c_uint64), ("InDiscards", ctypes.c_uint64),
                ("InErrors", ctypes.c_uint64), ("InUnknownProtos", ctypes.c_uint64), ("InUcastOctets", ctypes.c_uint64),
                ("InMulticastOctets", ctypes.c_uint64), ("InBroadcastOctets", ctypes.c_uint64), ("OutOctets", ctypes.c_uint64),
                ("OutUcastPkts", ctypes.c_uint64), ("OutNUcastPkts", ctypes.c_uint64), ("OutDiscards", ctypes.c_uint64),
                ("OutErrors", ctypes.c_uint64), ("OutUcastOctets", ctypes.c_uint64), ("OutMulticastOctets", ctypes.c_uint64),
                ("OutBroadcastOctets", ctypes.c_uint64), ("OutQLen", ctypes.c_uint64)]


HARDWARE, FILTER = 0x1, 0x2
WIFI_TYPE, ETHERNET_TYPE, LOOPBACK_TYPE = 71, 6, 24
WIFI_MEDIUM = 9                 # NdisPhysicalMediumNative802_11


class Network:
    """Byte counts over the PC's own network adapters together, so it's right on Wi-Fi or a cable and a VPN isn't counted twice,
    the way the Mac adds up its en ports. And which adapter the internet goes out through, without sending anything."""

    def __init__(self):
        self.iphlp = ctypes.WinDLL("iphlpapi")
        self.iphlp.GetIfTable2.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        self.iphlp.FreeMibTable.argtypes = [ctypes.c_void_p]
        self.iphlp.GetBestInterface.argtypes = [DWORD, ctypes.POINTER(DWORD)]
        self.wifi = Wifi()

    def rows(self):
        table = ctypes.c_void_p()
        if self.iphlp.GetIfTable2(ctypes.byref(table)) != 0 or not table.value:
            return []
        try:
            count = ctypes.c_uint32.from_address(table.value).value
            return [MIB_IF_ROW2.from_buffer_copy(row) for row in (MIB_IF_ROW2 * count).from_address(table.value + 8)]   # copied before the table is freed
        finally:
            self.iphlp.FreeMibTable(table)

    def read(self):
        rows = self.rows()
        own = [r for r in rows if r.Flags & HARDWARE and not r.Flags & FILTER and r.OperStatus == 1 and r.Type != LOOPBACK_TYPE]
        net = {"down": sum(r.InOctets for r in own), "up": sum(r.OutOctets for r in own)} if own else None
        best = DWORD(0)
        if self.iphlp.GetBestInterface(0x08080808, ctypes.byref(best)) != 0:   # the route to a public address: none means offline
            return net, {"kind": "Offline"}
        out = next((r for r in rows if r.InterfaceIndex == best.value), None)
        if out is None:
            return net, {"kind": "Network"}
        if out.Type == WIFI_TYPE or out.PhysicalMediumType == WIFI_MEDIUM:
            link = {"kind": "Wi-Fi"}
            rssi = self.wifi.rssi(bytes(out.InterfaceGuid))
            if rssi is not None and out.TransmitLinkSpeed:
                link.update(rate=round(out.TransmitLinkSpeed / 1e6), rssi=rssi)
            return net, link
        return net, {"kind": "Wired" if out.Type == ETHERNET_TYPE and out.Flags & HARDWARE else "Network"}


class GUID(ctypes.Structure):
    _fields_ = [("bytes", ctypes.c_ubyte * 16)]


class WLAN_INTERFACE_INFO(ctypes.Structure):
    _fields_ = [("InterfaceGuid", GUID), ("strInterfaceDescription", ctypes.c_uint16 * 256), ("isState", DWORD)]


class Wifi:
    """Only the signal strength. Asking for the network's name or nearby networks is what Windows 11 puts behind the Location
    permission (and a one-time prompt), and neither is read here. If Windows ever refuses even this, it stops asking."""
    RSSI = 0x10000102       # wlan_intf_opcode_rssi

    def __init__(self):
        self.handle = None
        self.refused = False
        try:
            self.api = ctypes.WinDLL("wlanapi")
        except OSError:
            self.api = None     # a PC with no Wi-Fi software, such as a server

    def rssi(self, guid_bytes):
        if not self.api or self.refused:
            return None
        if self.handle is None:
            version, handle = DWORD(0), HANDLE()
            if self.api.WlanOpenHandle(2, None, ctypes.byref(version), ctypes.byref(handle)) != 0:
                self.api = None
                return None
            self.handle = handle
        guid = GUID.from_buffer_copy(guid_bytes)
        size, data, kind = DWORD(0), ctypes.c_void_p(), DWORD(0)
        error = self.api.WlanQueryInterface(self.handle, ctypes.byref(guid), self.RSSI, None, ctypes.byref(size), ctypes.byref(data), ctypes.byref(kind))
        if error == 5:          # ERROR_ACCESS_DENIED
            self.refused = True
            return None
        if error != 0 or not data.value:
            return None
        try:
            value = ctypes.c_long.from_address(data.value).value
        finally:
            self.api.WlanFreeMemory(data)
        return value if -110 < value < 0 else None


class FMT_VALUE(ctypes.Structure):
    _fields_ = [("CStatus", DWORD), ("doubleValue", ctypes.c_double)]


class FMT_ITEM(ctypes.Structure):
    _fields_ = [("szName", ctypes.c_wchar_p), ("FmtValue", FMT_VALUE)]


ENGINE = re.compile(r"luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)", re.I)


class Gpu:
    """How busy the GPU is, the way Task Manager counts it: each of its engines (3D, video encode, copy...) is added up over every
    process using it, and the GPU is as busy as its busiest engine. Windows' own performance counters, the same ones Task Manager reads."""
    MORE_DATA = 0x800007D2

    def __init__(self):
        self.pdh = ctypes.WinDLL("pdh")
        self.query, self.counter = HANDLE(), HANDLE()
        if self.pdh.PdhOpenQueryW(None, 0, ctypes.byref(self.query)) != 0:
            raise OSError("no performance counters")
        if self.pdh.PdhAddEnglishCounterW(self.query, "\\GPU Engine(*)\\Utilization Percentage", 0, ctypes.byref(self.counter)) != 0:
            raise OSError("no GPU counters")
        self.pdh.PdhCollectQueryData(self.query)

    def read(self):
        if self.pdh.PdhCollectQueryData(self.query) != 0:
            return None
        size, count = DWORD(0), DWORD(0)
        flags = 0x200 | 0x8000      # PDH_FMT_DOUBLE | PDH_FMT_NOCAP100
        status = self.pdh.PdhGetFormattedCounterArrayW(self.counter, flags, ctypes.byref(size), ctypes.byref(count), None) & 0xFFFFFFFF
        if status != self.MORE_DATA or not size.value:
            return None
        buf = ctypes.create_string_buffer(size.value)
        if self.pdh.PdhGetFormattedCounterArrayW(self.counter, flags, ctypes.byref(size), ctypes.byref(count), buf) != 0:
            return None
        items = ctypes.cast(buf, ctypes.POINTER(FMT_ITEM))
        engines = {}
        for i in range(count.value):
            item = items[i]
            found = ENGINE.search(item.szName or "")
            if found and item.FmtValue.CStatus in (0, 1):     # valid or new data
                key = found.groups()
                engines[key] = engines.get(key, 0.0) + max(item.FmtValue.doubleValue, 0.0)
        return round(min(max(engines.values()), 100)) if engines else None


def serve():
    """One line in, one line of JSON out, until stdin closes or nobody has asked for IDLE_S."""
    last = [time.time()]

    def watchdog():
        while True:
            time.sleep(min(IDLE_S, 5))
            if time.time() - last[0] > IDLE_S:
                os._exit(0)

    threading.Thread(target=watchdog, daemon=True).start()
    try:
        network = Network()
    except OSError:
        network = None
    try:
        gpu = Gpu()
    except OSError:
        gpu = None
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        last[0] = time.time()
        out = {}
        try:
            if network:
                out["net"], out["link"] = network.read()
        except Exception:      # a reading that fails this once mustn't end the helper
            pass
        try:
            out["gpu"] = gpu.read() if gpu else None
        except Exception:
            out["gpu"] = None
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if sys.argv[1:2] == ["meters"]:
        serve()

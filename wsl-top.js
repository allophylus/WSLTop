#!/usr/bin/env node

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ANSI = {
  home: '\x1b[H',
  clearToEnd: '\x1b[0J',
  clearLine: '\x1b[K',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  altScreen: '\x1b[?1049h',
  mainScreen: '\x1b[?1049l',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

// Color theme system: every data series is colored by a semantic "hue" name
// (green/blue/cyan/magenta/yellow/red) rather than a hardcoded ANSI code, so
// switching COLOR_THEMES[colorThemeIndex] re-colors the whole UI on the next
// frame. 'bright' reproduces the original fixed ANSI colors; the others trade
// hue for brightness/weight so widgets stay visually distinct without color.
const COLOR_THEMES = ['bright', 'green', 'mono', 'greyscale'];
const COLOR_THEME_LABELS = {
  bright: 'Bright',
  green: 'Green',
  mono: 'Black & White',
  greyscale: 'Greyscale',
};
const HUE_PALETTES = {
  bright: { green: '\x1b[32m', blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m', yellow: '\x1b[33m', red: '\x1b[31m' },
  green: { green: '\x1b[38;5;46m', blue: '\x1b[38;5;34m', cyan: '\x1b[38;5;83m', magenta: '\x1b[38;5;22m', yellow: '\x1b[38;5;118m', red: '\x1b[38;5;28m' },
  mono: { green: '', blue: '', cyan: '', magenta: '', yellow: '', red: '' },
  greyscale: { green: '\x1b[38;5;252m', blue: '\x1b[38;5;245m', cyan: '\x1b[38;5;255m', magenta: '\x1b[38;5;240m', yellow: '\x1b[38;5;248m', red: '\x1b[38;5;238m' },
};
let colorThemeIndex = 0;

function hue(name) {
  const theme = COLOR_THEMES[colorThemeIndex];
  return HUE_PALETTES[theme][name] ?? '';
}

const PROC_DIR = '/proc';
const SECTOR_SIZE = 512;
const DEFAULT_INTERVAL_MS = 1000;
const WINDOWS_HOST_REFRESH_MS = 10000;
const WINDOWS_HOST_TIMEOUT_MS = 9000;
const WINDOWS_HOST_GPU_TIMEOUT_MS = 30000;
const HISTORY_LENGTH = 72;
const CLK_TCK = readClockTicks();
const BOTTOM_VIEW_MODES = ['cpu', 'memory', 'network', 'gpu', 'ports'];
const BOTTOM_VIEW_TITLES = {
  cpu: 'Top processes — by CPU%',
  memory: 'Top processes — by memory (RSS)',
  network: 'Top processes — by open sockets (approx. network activity)',
  gpu: 'Top processes — by GPU engine usage (Windows host)',
  ports: 'Listening ports (localhost, via ss)',
};
const INTERVAL_STEPS_MS = [1000, 5000, 15000, 30000, 60000];
// Hostname/IP don't change while the process is running, so resolve them
// once rather than re-scanning network interfaces every frame.
const WSL_IDENTITY = readWslIdentity();
// Rough per-sensor-type unit suffixes for the raw "all sensors" list view;
// LibreHardwareMonitor sensor types not listed here just show a bare number.
const SENSOR_UNITS = {
  Temperature: '°C',
  Load: '%',
  Clock: ' MHz',
  Power: ' W',
  Voltage: ' V',
  Fan: ' RPM',
  Flow: ' L/h',
  Control: '%',
  Level: '%',
  Factor: 'x',
  Data: ' GB',
  SmallData: ' MB',
  Throughput: ' B/s',
  Energy: ' mWh',
  Noise: ' dBA',
  Current: ' A',
};

let windowsHostInfo;
let windowsHostRequestInFlight = false;
let lastWindowsHostRequest = 0;
let bottomViewMode = 'cpu';
let showAllSensors = false;
const history = {
  cpu: [],
  mem: [],
  hostCpu: [],
  hostMem: [],
  netRx: [],
  netTx: [],
  diskRead: [],
  diskWrite: [],
  temp: [],
  gpu: [],
  gpuPower: [],
  battery: [],
};

function readClockTicks() {
  try {
    const output = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000 }).trim();
    const parsed = Number(output);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  } catch {
    return 100;
  }
}

function parseArgs(argv) {
  const options = {
    intervalMs: DEFAULT_INTERVAL_MS,
    includeWindowsHost: true,
    once: !process.stdout.isTTY,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--no-host') {
      options.includeWindowsHost = false;
      continue;
    }
    if (arg === '--once') {
      options.once = true;
      continue;
    }
    if (arg === '--interval' || arg === '-i') {
      const next = argv[i + 1];
      if (!next) throw new Error('Missing value for --interval');
      const seconds = Number(next);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--interval must be a positive number of seconds');
      }
      options.intervalMs = Math.max(250, seconds * 1000);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`WSL Top

Usage:
  node wsl-top.js [options]
  npm start -- [options]

Options:
  -i, --interval <seconds>  Refresh interval (default: 1)
      --no-host            Skip optional Windows host metrics
      --once               Render one sample and exit
  -h, --help               Show this help

Controls:
  q / Ctrl+C               Quit
  v / Tab                  Cycle the bottom panel: CPU -> Memory -> Network -> GPU -> Ports
  c                        Cycle color theme: Bright -> Green -> Black & White -> Greyscale
  i                        Cycle refresh interval: 1s -> 5s -> 15s -> 30s -> 60s
  s                        Toggle raw "all sensors" view (every LibreHardwareMonitor sensor and value)
`);
}

function readCpuSnapshot() {
  const lines = fs.readFileSync(path.join(PROC_DIR, 'stat'), 'utf8').split('\n');
  const cpuLines = lines.filter(line => /^cpu\d*\s/.test(line));
  const snapshots = cpuLines.map(line => {
    const [name, ...values] = line.trim().split(/\s+/);
    const numbers = values.map(value => Number(value));
    const idle = (numbers[3] || 0) + (numbers[4] || 0);
    const total = numbers.reduce((sum, value) => sum + value, 0);
    return { name, idle, total };
  });

  return {
    total: snapshots[0],
    cores: snapshots.slice(1),
  };
}

function calculateCpuUsage(previous, current) {
  return [current.total, ...current.cores].map((currentCore, index) => {
    const previousCore = index === 0 ? previous.total : previous.cores[index - 1];
    const totalDelta = currentCore.total - previousCore.total;
    const idleDelta = currentCore.idle - previousCore.idle;
    const usage = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
    return { name: currentCore.name, usage: clamp(usage, 0, 100) };
  });
}

function readMemInfo() {
  const fields = new Map();
  fs.readFileSync(path.join(PROC_DIR, 'meminfo'), 'utf8')
    .split('\n')
    .forEach(line => {
      const match = line.match(/^([^:]+):\s+(\d+)/);
      if (match) fields.set(match[1], Number(match[2]) * 1024);
    });

  const total = fields.get('MemTotal') || 0;
  const available = fields.get('MemAvailable') || fields.get('MemFree') || 0;
  const swapTotal = fields.get('SwapTotal') || 0;
  const swapFree = fields.get('SwapFree') || 0;
  return {
    total,
    available,
    used: Math.max(0, total - available),
    swapTotal,
    swapFree,
  };
}

function readNetSnapshot() {
  let rxBytes = 0;
  let txBytes = 0;
  const lines = fs.readFileSync(path.join(PROC_DIR, 'net', 'dev'), 'utf8').split('\n').slice(2);
  for (const line of lines) {
    const [rawName, rawStats] = line.split(':');
    if (!rawName || !rawStats) continue;
    const name = rawName.trim();
    if (name === 'lo') continue;
    const stats = rawStats.trim().split(/\s+/).map(Number);
    rxBytes += stats[0] || 0;
    txBytes += stats[8] || 0;
  }
  return { rxBytes, txBytes };
}

function readDiskSnapshot() {
  let readSectors = 0;
  let writeSectors = 0;
  const lines = fs.readFileSync(path.join(PROC_DIR, 'diskstats'), 'utf8').split('\n');
  for (const line of lines) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 14) continue;
    const name = columns[2];
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(name)) continue;
    readSectors += Number(columns[5]) || 0;
    writeSectors += Number(columns[9]) || 0;
  }
  return { readSectors, writeSectors };
}

function readLoadAverage() {
  return fs.readFileSync(path.join(PROC_DIR, 'loadavg'), 'utf8').trim().split(/\s+/).slice(0, 3).join(' ');
}

let cachedListeningPorts = [];
let lastListeningPortsRefresh = 0;
const LISTENING_PORTS_REFRESH_MS = 2000;

function readListeningPorts() {
  const now = Date.now();
  if (now - lastListeningPortsRefresh < LISTENING_PORTS_REFRESH_MS) {
    return cachedListeningPorts;
  }
  lastListeningPortsRefresh = now;
  try {
    const output = execFileSync('ss', ['-H', '-tulnp'], { encoding: 'utf8', timeout: 1000 });
    cachedListeningPorts = parseListeningPorts(output);
  } catch {
    cachedListeningPorts = cachedListeningPorts.length > 0 ? cachedListeningPorts : [];
  }
  return cachedListeningPorts;
}

function parseListeningPorts(output) {
  const ports = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    const [proto, state, , , localAddress] = fields;
    if (state !== 'LISTEN' && state !== 'UNCONN') continue;
    const separatorIndex = localAddress.lastIndexOf(':');
    if (separatorIndex === -1) continue;
    const address = localAddress.slice(0, separatorIndex).replace(/^\[|\]$/g, '');
    const port = Number(localAddress.slice(separatorIndex + 1));
    if (!Number.isFinite(port)) continue;
    const processMatch = line.match(/\("([^"]+)",pid=(\d+)/);
    ports.push({
      proto,
      address,
      port,
      process: processMatch ? `${processMatch[1]}(${processMatch[2]})` : '-',
    });
  }
  ports.sort((a, b) => a.port - b.port);
  const seen = new Set();
  return ports.filter(entry => {
    const key = `${entry.proto}:${entry.address}:${entry.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readUptime() {
  const value = fs.readFileSync(path.join(PROC_DIR, 'uptime'), 'utf8').trim().split(/\s+/)[0];
  return Number(value) || 0;
}

function readSensors() {
  const lhm = windowsHostInfo?.lhm;
  const temperatures = readTemperatures();
  if (temperatures.length === 0 && Number.isFinite(lhm?.temperatureC)) {
    temperatures.push({ label: 'LHM', celsius: lhm.temperatureC });
  }

  const gpu = readGpuInfo() || lhm?.gpu;
  return {
    temperatures,
    powerWatts: readPowerWatts(),
    batteries: readBatteries(),
    gpu,
  };
}

function readTemperatures() {
  const sensors = [];
  for (const basePath of listDirectories('/sys/class/hwmon')) {
    const chipName = readOptionalFile(path.join(basePath, 'name')) || path.basename(basePath);
    for (const inputPath of listFiles(basePath, /^temp\d+_input$/)) {
      const sensorId = path.basename(inputPath).match(/^temp(\d+)_input$/)?.[1];
      const raw = Number(readOptionalFile(inputPath));
      if (!Number.isFinite(raw)) continue;
      const label = readOptionalFile(path.join(basePath, `temp${sensorId}_label`)) || chipName;
      sensors.push({ label, celsius: raw / 1000 });
    }
  }
  return sensors.sort((a, b) => b.celsius - a.celsius).slice(0, 4);
}

function readPowerWatts() {
  const readings = [];
  for (const basePath of listDirectories('/sys/class/hwmon')) {
    const chipName = readOptionalFile(path.join(basePath, 'name')) || path.basename(basePath);
    for (const inputPath of listFiles(basePath, /^power\d+_input$/)) {
      const sensorId = path.basename(inputPath).match(/^power(\d+)_input$/)?.[1];
      const raw = Number(readOptionalFile(inputPath));
      if (!Number.isFinite(raw)) continue;
      const label = readOptionalFile(path.join(basePath, `power${sensorId}_label`)) || chipName;
      readings.push({ label, watts: raw / 1000000 });
    }
  }
  return readings.sort((a, b) => b.watts - a.watts).slice(0, 4);
}

function readBatteries() {
  const batteries = [];
  for (const basePath of listDirectories('/sys/class/power_supply')) {
    if (readOptionalFile(path.join(basePath, 'type')) !== 'Battery') continue;
    const label = path.basename(basePath);
    const capacity = Number(readOptionalFile(path.join(basePath, 'capacity')));
    const status = readOptionalFile(path.join(basePath, 'status'));
    const present = readOptionalFile(path.join(basePath, 'present'));
    const powerNow = Number(readOptionalFile(path.join(basePath, 'power_now')));
    const energyNow = Number(readOptionalFile(path.join(basePath, 'energy_now')));
    const energyFull = Number(readOptionalFile(path.join(basePath, 'energy_full')));
    const chargeNow = Number(readOptionalFile(path.join(basePath, 'charge_now')));
    const chargeFull = Number(readOptionalFile(path.join(basePath, 'charge_full')));
    const calculatedCapacity = Number.isFinite(energyNow) && Number.isFinite(energyFull) && energyFull > 0
      ? (energyNow / energyFull) * 100
      : Number.isFinite(chargeNow) && Number.isFinite(chargeFull) && chargeFull > 0
        ? (chargeNow / chargeFull) * 100
        : undefined;
    batteries.push({
      label,
      capacity: Number.isFinite(capacity) ? capacity : calculatedCapacity,
      status,
      present: present !== '0',
      watts: Number.isFinite(powerNow) ? powerNow / 1000000 : undefined,
    });
  }
  return batteries.filter(battery => battery.present).slice(0, 4);
}

function readGpuInfo() {
  const nvidia = readNvidiaGpuInfo();
  if (nvidia) return nvidia;

  const drmCards = listDirectories('/sys/class/drm')
    .filter(cardPath => /^card\d+$/.test(path.basename(cardPath)));
  if (drmCards.length === 0) return undefined;

  return {
    label: drmCards.map(cardPath => path.basename(cardPath)).join(', '),
  };
}

function readNvidiaGpuInfo() {
  try {
    const output = execFileSync(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
        '--format=csv,noheader,nounits',
      ],
      { encoding: 'utf8', timeout: 1500 },
    ).trim();
    const line = output.split('\n').find(Boolean);
    if (!line) return undefined;
    const [name, utilization, memoryUsed, memoryTotal, temperature, powerDraw] = line.split(',').map(value => value.trim());
    return {
      label: name,
      utilization: Number(utilization),
      memoryUsed: Number(memoryUsed) * 1024 * 1024,
      memoryTotal: Number(memoryTotal) * 1024 * 1024,
      temperature: Number(temperature),
      powerWatts: Number(powerDraw),
    };
  } catch {
    return undefined;
  }
}

function listDirectories(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function listFiles(directory, pattern) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && pattern.test(entry.name))
      .map(entry => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function readOptionalFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function readProcesses() {
  const processes = new Map();
  for (const entry of fs.readdirSync(PROC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const procPath = path.join(PROC_DIR, entry.name);
    try {
      const stat = fs.readFileSync(path.join(procPath, 'stat'), 'utf8');
      const parsed = parseProcessStat(pid, stat);
      const status = fs.readFileSync(path.join(procPath, 'status'), 'utf8');
      const rssBytes = parseStatusKb(status, 'VmRSS') * 1024;
      const command = readProcessCommand(procPath, parsed.name);
      const sockets = countProcessSockets(procPath);
      processes.set(pid, { ...parsed, command, rssBytes, sockets });
    } catch {
      // Processes can exit while being sampled.
    }
  }
  return processes;
}

function countProcessSockets(procPath) {
  let count = 0;
  try {
    for (const name of fs.readdirSync(path.join(procPath, 'fd'))) {
      try {
        if (fs.readlinkSync(path.join(procPath, 'fd', name)).startsWith('socket:')) count += 1;
      } catch {
        // fd may disappear or be unreadable without permission; skip it.
      }
    }
  } catch {
    // /proc/<pid>/fd is only readable for processes we own; leave count at 0.
  }
  return count;
}

function parseProcessStat(pid, stat) {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open === -1 || close === -1 || close <= open) {
    throw new Error(`Unable to parse /proc/${pid}/stat`);
  }
  const name = stat.slice(open + 1, close);
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  const state = rest[0] || '?';
  const utime = Number(rest[11]) || 0;
  const stime = Number(rest[12]) || 0;
  return {
    pid,
    name,
    state,
    ticks: utime + stime,
  };
}

function parseStatusKb(status, field) {
  const match = status.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm'));
  return match ? Number(match[1]) : 0;
}

function readProcessCommand(procPath, fallback) {
  try {
    const raw = fs.readFileSync(path.join(procPath, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
    return raw || fallback;
  } catch {
    return fallback;
  }
}

function calculateProcessUsage(previous, current, elapsedSeconds) {
  const processes = [];
  for (const [pid, snapshot] of current) {
    const previousSnapshot = previous.get(pid);
    const tickDelta = previousSnapshot ? Math.max(0, snapshot.ticks - previousSnapshot.ticks) : 0;
    const cpu = elapsedSeconds > 0 ? (tickDelta / CLK_TCK / elapsedSeconds) * 100 : 0;
    processes.push({ ...snapshot, cpu });
  }
  // Caller sorts/truncates per the active bottom-panel view (CPU, memory, or
  // network/socket count), so keep the full list here.
  return processes;
}

function refreshWindowsHostInfo(includeWindowsHost, includeGpuProcesses) {
  if (!includeWindowsHost || windowsHostRequestInFlight) return;
  if (Date.now() - lastWindowsHostRequest < WINDOWS_HOST_REFRESH_MS) return;

  lastWindowsHostRequest = Date.now();
  windowsHostRequestInFlight = true;
  const command = [
    '$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;',
    '$os=Get-CimInstance Win32_OperatingSystem;',
    '$temps=@(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | ForEach-Object { [math]::Round(($_.CurrentTemperature / 10) - 273.15, 1) } | Where-Object { $_ -gt 0 -and $_ -lt 150 });',
    '$temp=if ($temps.Count -gt 0) { [math]::Round(($temps | Measure-Object -Average).Average, 1) } else { $null };',
    '$lhm=$null;',
    '$lhmDll=Join-Path $env:LOCALAPPDATA "Programs\\LibreHardwareMonitor\\LibreHardwareMonitorLib.dll";',
    'if (Test-Path $lhmDll) {',
    'try {',
    'Add-Type -Path $lhmDll -ErrorAction SilentlyContinue;',
    '$computer=[LibreHardwareMonitor.Hardware.Computer]::new();',
    '$computer.IsCpuEnabled=$true; $computer.IsGpuEnabled=$true; $computer.IsMemoryEnabled=$true; $computer.IsMotherboardEnabled=$true; $computer.IsStorageEnabled=$true; $computer.IsBatteryEnabled=$true; $computer.IsControllerEnabled=$true;',
    '$computer.Open();',
    'function ReadLhmHardware($hardware) {',
    '$hardware.Update();',
    'foreach ($sub in $hardware.SubHardware) { ReadLhmHardware $sub }',
    'foreach ($sensor in $hardware.Sensors) { if ($null -ne $sensor.Value) { [pscustomobject]@{ Hardware=[string]$hardware.Name; HardwareType=[string]$hardware.HardwareType; Sensor=[string]$sensor.Name; SensorType=[string]$sensor.SensorType; Value=[double]$sensor.Value } } }',
    '}',
    '$lhmSensors=@(foreach ($hardware in $computer.Hardware) { ReadLhmHardware $hardware });',
    '$computer.Close();',
    '$lhmTemps=@($lhmSensors | Where-Object { $_.SensorType -eq "Temperature" -and $_.Value -gt 0 -and $_.Value -lt 150 });',
    '$lhmTemp=if ($lhmTemps.Count -gt 0) { [math]::Round(($lhmTemps | Sort-Object Value -Descending | Select-Object -First 1).Value, 1) } else { $null };',
    '$gpuSensors=@($lhmSensors | Where-Object { $_.HardwareType -like "Gpu*" });',
    '$gpuLoads=@($gpuSensors | Where-Object { $_.SensorType -eq "Load" -and $_.Value -ge 0 });',
    '$gpuLoad=if ($gpuLoads.Count -gt 0) { [math]::Round(($gpuLoads | Sort-Object Value -Descending | Select-Object -First 1).Value, 1) } else { $null };',
    '$gpuName=if ($gpuSensors.Count -gt 0) { ($gpuSensors | Select-Object -First 1).Hardware } else { $null };',
    '$gpuMemoryTotal=($gpuSensors | Where-Object { $_.SensorType -eq "SmallData" -and $_.Sensor -match "Memory Total" } | Select-Object -First 1).Value;',
    '$gpuMemoryUsed=($gpuSensors | Where-Object { $_.SensorType -eq "SmallData" -and $_.Sensor -match "Memory Used" } | Select-Object -First 1).Value;',
    '$gpuTemp=($gpuSensors | Where-Object { $_.SensorType -eq "Temperature" -and $_.Value -gt 0 } | Sort-Object Value -Descending | Select-Object -First 1).Value;',
    '$gpuPower=($gpuSensors | Where-Object { $_.SensorType -eq "Power" -and $_.Value -gt 0 } | Sort-Object Value -Descending | Select-Object -First 1).Value;',
    '$lhm=[pscustomobject]@{ available=$true; sensorCount=$lhmSensors.Count; temperatureC=$lhmTemp; gpu=[pscustomobject]@{ label=$gpuName; utilization=$gpuLoad; memoryUsedMb=$gpuMemoryUsed; memoryTotalMb=$gpuMemoryTotal; temperature=$gpuTemp; powerWatts=$gpuPower }; sensors=$lhmSensors };',
    '} catch { $lhm=[pscustomobject]@{ available=$false; error=$_.Exception.Message } }',
    '}',
    '$gpuProcs=$null;',
    ...(includeGpuProcesses ? [
      // Same "GPU Engine" perf counters Task Manager's per-process GPU column
      // uses: each counter instance encodes a PID, so usage across all of a
      // process' engines (3D, copy, video decode, ...) is summed per PID.
      'try {',
      '$gpuSamples=@((Get-Counter "\\GPU Engine(*)\\Utilization Percentage" -ErrorAction Stop).CounterSamples | Where-Object { $_.CookedValue -gt 0 });',
      '$gpuProcs=@($gpuSamples | ForEach-Object { if ($_.Path -match "pid_(\\d+)_") { [pscustomobject]@{ ProcId=[int]$Matches[1]; Usage=$_.CookedValue } } } | Group-Object ProcId | ForEach-Object { $procId=[int]$_.Name; $usage=($_.Group | Measure-Object Usage -Sum).Sum; $procName=try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "unknown" }; [pscustomobject]@{ pid=$procId; usage=[math]::Round($usage,1); name=$procName } } | Sort-Object usage -Descending | Select-Object -First 10);',
      '} catch { $gpuProcs=@() }',
    ] : []),
    '[pscustomobject]@{',
    'cpu=[math]::Round([double]$cpu,1);',
    'totalGb=[math]::Round($os.TotalVisibleMemorySize/1MB,1);',
    'freeGb=[math]::Round($os.FreePhysicalMemory/1MB,1);',
    'temperatureC=$temp;',
    'lhm=$lhm;',
    `gpuProcessesSupported=$${includeGpuProcesses ? 'true' : 'false'};`,
    'gpuProcesses=$gpuProcs',
    '} | ConvertTo-Json -Compress -Depth 6',
  ].join(' ');

  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    // The GPU-per-process query (Get-Counter) adds real time on top of the
    // LibreHardwareMonitor read, so it gets a longer budget than the normal
    // (much faster) CPU/memory/LHM-only refresh.
    { encoding: 'utf8', timeout: includeGpuProcesses ? WINDOWS_HOST_GPU_TIMEOUT_MS : WINDOWS_HOST_TIMEOUT_MS, windowsHide: true },
    (error, stdout) => {
      windowsHostRequestInFlight = false;
      if (error) {
        if (process.env.WSLTOP_DEBUG_HOST) console.error('[wsltop debug] host refresh error:', error);
        windowsHostInfo = {
          cpu: 0,
          totalGb: 0,
          freeGb: 0,
          updatedAt: Date.now(),
          error: 'Windows host metrics unavailable',
        };
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        windowsHostInfo = { ...parsed, updatedAt: Date.now() };
      } catch {
        windowsHostInfo = {
          cpu: 0,
          totalGb: 0,
          freeGb: 0,
          updatedAt: Date.now(),
          error: 'Windows host metrics parse failed',
        };
      }
    },
  );
}

function renderFrame(cpuUsage, memInfo, loadAverage, uptimeSeconds, netRate, diskRate, sensors, processUsage, listeningPorts, options) {
  const width = Math.max(80, Number(process.env.COLUMNS) || process.stdout.columns || 100);
  const height = Math.max(20, Number(process.env.LINES) || process.stdout.rows || 35);
  const totalCpu = cpuUsage[0]?.usage || 0;
  const memUsage = percent(memInfo.used, memInfo.total);
  const hostMemUsage = windowsHostInfo && Number.isFinite(windowsHostInfo.totalGb) && windowsHostInfo.totalGb > 0
    ? percent(windowsHostInfo.totalGb - windowsHostInfo.freeGb, windowsHostInfo.totalGb)
    : undefined;
  const batteryCapacity = sensors.batteries[0]?.capacity;
  updateHistory(history.cpu, totalCpu);
  updateHistory(history.mem, memUsage);
  updateHistory(history.hostCpu, windowsHostInfo?.cpu);
  updateHistory(history.hostMem, hostMemUsage);
  updateHistory(history.netRx, netRate.rxBytes);
  updateHistory(history.netTx, netRate.txBytes);
  updateHistory(history.diskRead, diskRate.readSectors * SECTOR_SIZE);
  updateHistory(history.diskWrite, diskRate.writeSectors * SECTOR_SIZE);
  updateHistory(history.temp, sensors.temperatures[0]?.celsius);
  updateHistory(history.gpu, sensors.gpu?.utilization);
  updateHistory(history.gpuPower, sensors.gpu?.powerWatts);
  updateHistory(history.battery, batteryCapacity);

  if (showAllSensors) {
    return renderSensorListView(width, height, options);
  }

  // Everything not shown as a chart is collected here so the chart grid can
  // claim all leftover vertical space without guessing at a fixed row count.
  const preLines = [];
  preLines.push(...headerLines(options, 's shows all sensors', width));
  preLines.push(rule(width));
  preLines.push(`${label('System')} Load ${loadAverage}   Up ${formatDuration(uptimeSeconds)}   Swap ${formatBytes(memInfo.swapTotal - memInfo.swapFree)}/${formatBytes(memInfo.swapTotal)}`);
  preLines.push(`${label('Detail')} ${formatDetailSummary(sensors)}`);
  preLines.push('');

  const postLines = [];
  postLines.push('');

  const bottomRows = clamp(Math.floor(height * 0.34), 5, 16);
  postLines.push('');
  postLines.push(...renderBottomPanel(bottomViewMode, processUsage, listeningPorts, width, bottomRows));

  const chartRows = Math.max(10, height - preLines.length - postLines.length);
  const cells = buildChartCells(totalCpu, memUsage, hostMemUsage, memInfo, batteryCapacity, netRate, diskRate, sensors);
  const chartLines = renderChartGrid(cells, width, chartRows);

  return [...preLines, ...chartLines, ...postLines].slice(0, height).join('\n');
}

// Shared banner for both the normal dashboard and the raw sensor list view,
// so the identity/hints stay visible everywhere. Split across two lines -
// title/identity on the left and date/time right-aligned on the first line,
// key hints on the second - so neither line grows so long it wraps
// awkwardly in a narrow terminal.
function headerLines(options, extraHint, width) {
  const intervalSeconds = Math.round(options.intervalMs / 1000 * 10) / 10;
  const hints = [
    'q quits',
    'v cycles bottom panel',
    `c cycles color theme (${COLOR_THEME_LABELS[COLOR_THEMES[colorThemeIndex]]})`,
    `i cycles interval (${intervalSeconds}s)`,
    extraHint,
  ].filter(Boolean);
  const identity = `${WSL_IDENTITY.hostname} (${WSL_IDENTITY.ip})`;
  const now = new Date();
  const left = `${ANSI.bold}${ANSI.cyan}WSL Top${ANSI.reset} ${ANSI.dim}${identity}${ANSI.reset}`;
  const right = `${ANSI.dim}${now.toLocaleDateString()} ${now.toLocaleTimeString()}${ANSI.reset}`;
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return [
    `${left}${' '.repeat(gap)}${right}`,
    `${ANSI.dim}${hints.join(' | ')}${ANSI.reset}`,
  ];
}

// "All sensors" view: replaces the normal dashboard entirely with a flat,
// scrollable list of every sensor LibreHardwareMonitor reports (51+ on a
// typical machine) - useful for finding a specific sensor name/value that
// isn't surfaced by any of the summarized widgets.
function renderSensorListView(width, height, options) {
  const lines = [];
  lines.push(...headerLines(options, 's returns to the dashboard', width));
  lines.push(rule(width));
  lines.push('');

  const lhm = windowsHostInfo?.lhm;
  const sensorList = lhm?.sensors;
  if (!windowsHostInfo || !lhm || lhm.available === false) {
    lines.push(`${ANSI.bold}All sensors${ANSI.reset} ${ANSI.dim}(LibreHardwareMonitor not available; install it and enable Windows host metrics)${ANSI.reset}`);
    lines.push(`${ANSI.dim}-${ANSI.reset}`);
    return lines.slice(0, height).join('\n');
  }
  if (!Array.isArray(sensorList) || sensorList.length === 0) {
    lines.push(`${ANSI.bold}All sensors${ANSI.reset} ${ANSI.dim}(no sensors reported yet - waiting for the next Windows host refresh)${ANSI.reset}`);
    return lines.slice(0, height).join('\n');
  }

  lines.push(`${ANSI.bold}All sensors${ANSI.reset} ${ANSI.dim}(${sensorList.length} from LibreHardwareMonitor)${ANSI.reset}`);
  lines.push(`${'HARDWARE'.padEnd(26)} ${'TYPE'.padEnd(9)} ${'SENSOR'.padEnd(28)} ${'KIND'.padEnd(11)} VALUE`);
  const sorted = [...sensorList].sort((a, b) =>
    (a.Hardware || '').localeCompare(b.Hardware || '')
    || (a.SensorType || '').localeCompare(b.SensorType || '')
    || (a.Sensor || '').localeCompare(b.Sensor || ''));

  const rowBudget = Math.max(1, height - lines.length);
  const visibleCount = sorted.length > rowBudget ? Math.max(1, rowBudget - 1) : Math.min(rowBudget, sorted.length);
  for (const sensor of sorted.slice(0, visibleCount)) {
    lines.push(`${truncate(sensor.Hardware || '-', 26).padEnd(26)} ${truncate(sensor.HardwareType || '-', 9).padEnd(9)} ${truncate(sensor.Sensor || '-', 28).padEnd(28)} ${truncate(sensor.SensorType || '-', 11).padEnd(11)} ${formatSensorValue(sensor)}`);
  }
  if (sorted.length > visibleCount) {
    lines.push(`${ANSI.dim}... and ${sorted.length - visibleCount} more (enlarge the window to see them)${ANSI.reset}`);
  }
  return lines.slice(0, height).join('\n');
}

function formatSensorValue(sensor) {
  const value = Number(sensor.Value);
  if (!Number.isFinite(value)) return '-';
  const unit = SENSOR_UNITS[sensor.SensorType] || '';
  return `${value.toFixed(2)}${unit}`;
}

function renderBottomPanel(mode, processUsage, listeningPorts, width, maxRows) {
  const lines = [`${ANSI.bold}${BOTTOM_VIEW_TITLES[mode]}${ANSI.reset} ${ANSI.dim}(press v to cycle: CPU → Memory → Network → GPU → Ports)${ANSI.reset}`];

  if (mode === 'gpu') {
    const gpuProcesses = windowsHostInfo?.gpuProcesses;
    if (!windowsHostInfo || !windowsHostInfo.gpuProcessesSupported) {
      lines.push(`${ANSI.dim}GPU-per-process usage needs Windows host metrics enabled (omit --no-host).${ANSI.reset}`);
    } else if (!Array.isArray(gpuProcesses) || gpuProcesses.length === 0) {
      lines.push(`${ANSI.dim}-${ANSI.reset}`);
    } else {
      lines.push(`${'PID'.padStart(7)}  ${'GPU%'.padStart(6)}  PROCESS`);
      const rowBudget = Math.max(1, maxRows - lines.length);
      for (const process of gpuProcesses.slice(0, rowBudget)) {
        lines.push(`${String(process.pid).padStart(7)}  ${process.usage.toFixed(1).padStart(6)}  ${truncate(process.name, Math.max(10, width - 20))}`);
      }
    }
    return lines;
  }

  if (mode === 'ports') {
    lines.push(`${'PROTO'.padEnd(5)} ${'ADDRESS:PORT'.padEnd(24)} PROCESS`);
    const rowBudget = Math.max(1, maxRows - lines.length);
    if (listeningPorts.length === 0) {
      lines.push(`${ANSI.dim}-${ANSI.reset}`);
    } else {
      const visibleCount = listeningPorts.length > rowBudget ? Math.max(1, rowBudget - 1) : Math.min(rowBudget, listeningPorts.length);
      for (const entry of listeningPorts.slice(0, visibleCount)) {
        const addrPort = `${entry.address}:${entry.port}`;
        lines.push(`${entry.proto.toUpperCase().padEnd(5)} ${truncate(addrPort, 24).padEnd(24)} ${entry.process}`);
      }
      if (listeningPorts.length > visibleCount) {
        lines.push(`${ANSI.dim}... and ${listeningPorts.length - visibleCount} more${ANSI.reset}`);
      }
    }
    return lines;
  }

  const sorted = [...processUsage].sort((a, b) => {
    if (mode === 'memory') return b.rssBytes - a.rssBytes;
    if (mode === 'network') return b.sockets - a.sockets || b.cpu - a.cpu;
    return b.cpu - a.cpu || b.rssBytes - a.rssBytes;
  });

  const commandWidth = Math.max(20, width - (mode === 'network' ? 40 : 32));
  if (mode === 'network') {
    lines.push(`${'PID'.padStart(7)}  ${'SOCK'.padStart(5)}  ${'CPU%'.padStart(6)}  ${'RSS'.padStart(8)}  S  COMMAND`);
  } else {
    lines.push(`${'PID'.padStart(7)}  ${'CPU%'.padStart(6)}  ${'RSS'.padStart(8)}  S  COMMAND`);
  }
  const rowBudget = Math.max(1, maxRows - lines.length);
  for (const process of sorted.slice(0, rowBudget)) {
    if (mode === 'network') {
      lines.push(`${String(process.pid).padStart(7)}  ${String(process.sockets).padStart(5)}  ${process.cpu.toFixed(1).padStart(6)}  ${formatBytes(process.rssBytes).padStart(8)}  ${process.state.padEnd(1)}  ${truncate(process.command, commandWidth)}`);
    } else {
      lines.push(`${String(process.pid).padStart(7)}  ${process.cpu.toFixed(1).padStart(6)}  ${formatBytes(process.rssBytes).padStart(8)}  ${process.state.padEnd(1)}  ${truncate(process.command, commandWidth)}`);
    }
  }
  return lines;
}

function buildChartCells(totalCpu, memUsage, hostMemUsage, memInfo, batteryCapacity, netRate, diskRate, sensors) {
  const hostCpu = windowsHostInfo?.cpu;
  const gpuUtil = sensors.gpu?.utilization;
  const cpuWsl = { title: 'W', type: 'meter', value: formatPercent(totalCpu), percent: totalCpu, values: history.cpu, min: 0, max: 100, color: hue('green') };
  const cpuHost = { title: 'H', type: 'meter', value: formatMaybePercent(hostCpu), percent: hostCpu, values: history.hostCpu, min: 0, max: 100, color: hue('blue') };
  const hostMemTotalBytes = windowsHostInfo && Number.isFinite(windowsHostInfo.totalGb) ? windowsHostInfo.totalGb * 1024 ** 3 : undefined;
  const hostMemUsedBytes = windowsHostInfo && Number.isFinite(windowsHostInfo.totalGb) && Number.isFinite(windowsHostInfo.freeGb)
    ? (windowsHostInfo.totalGb - windowsHostInfo.freeGb) * 1024 ** 3
    : undefined;
  const ramWsl = { title: 'W', type: 'meter', value: formatPercent(memUsage), percent: memUsage, amountLabel: formatBytesPair(memInfo.used, memInfo.total), values: history.mem, min: 0, max: 100, color: hue('cyan') };
  const ramHost = { title: 'H', type: 'meter', value: formatMaybePercent(hostMemUsage), percent: hostMemUsage, amountLabel: Number.isFinite(hostMemUsedBytes) && Number.isFinite(hostMemTotalBytes) ? formatBytesPair(hostMemUsedBytes, hostMemTotalBytes) : undefined, values: history.hostMem, min: 0, max: 100, color: hue('blue') };
  const gpu = { title: 'GPU', type: 'meter', value: formatMaybePercent(gpuUtil), percent: gpuUtil, values: history.gpu, min: 0, max: 100, color: hue('magenta') };
  const gpuPowerWatts = sensors.gpu?.powerWatts;
  const gpuPower = { title: 'GPU PWR', type: 'meter', value: formatMaybeWatts(gpuPowerWatts), rateLabel: Number.isFinite(gpuPowerWatts) ? formatWatts(gpuPowerWatts) : undefined, percent: Number.isFinite(gpuPowerWatts) ? rateGaugePercent(history.gpuPower, gpuPowerWatts) : undefined, values: history.gpuPower, color: hue('magenta') };
  const battery = { title: 'BATTERY', type: 'meter', value: formatMaybePercent(batteryCapacity), percent: batteryCapacity, values: history.battery, min: 0, max: 100, color: hue('yellow') };
  const netDownRate = netRate.rxBytes;
  const netUpRate = netRate.txBytes;
  const diskReadRate = diskRate.readSectors * SECTOR_SIZE;
  const diskWriteRate = diskRate.writeSectors * SECTOR_SIZE;
  const netDown = { title: '↓', type: 'meter', value: `${formatBytes(netDownRate)}/s`, rateLabel: `${formatBytes(netDownRate)}/s`, percent: rateGaugePercent(history.netRx, netDownRate), values: history.netRx, color: hue('green') };
  const netUp = { title: '↑', type: 'meter', value: `${formatBytes(netUpRate)}/s`, rateLabel: `${formatBytes(netUpRate)}/s`, percent: rateGaugePercent(history.netTx, netUpRate), values: history.netTx, color: hue('yellow') };
  const diskRead = { title: 'R', type: 'meter', value: `${formatBytes(diskReadRate)}/s`, rateLabel: `${formatBytes(diskReadRate)}/s`, percent: rateGaugePercent(history.diskRead, diskReadRate), values: history.diskRead, color: hue('green') };
  const diskWrite = { title: 'W', type: 'meter', value: `${formatBytes(diskWriteRate)}/s`, rateLabel: `${formatBytes(diskWriteRate)}/s`, percent: rateGaugePercent(history.diskWrite, diskWriteRate), values: history.diskWrite, color: hue('yellow') };
  const temp = { title: 'TEMP', value: formatTemperature(sensors.temperatures[0]?.celsius), values: history.temp, color: hue('red') };

  // CPU/RAM ('meterPair') and NET/DSK ('stack') are all rendered the same
  // way: one box titled like GPU/BATTERY, with each series embedded as its
  // own tagged gauge-bar row (e.g. "WSL"/"HOST" or "NET ↓"/"NET ↑") instead
  // of a separate label line - this keeps every pair box uniform and
  // readable down to the smallest supported window, with no split/degenerate
  // cases needed. Kept as a separate 'stack' kind (vs 'meterPair') only so
  // NET/DSK can carry their own box title distinct from their series titles.
  return [
    { kind: 'meterPair', title: 'CPU', metrics: [cpuWsl, cpuHost] },
    { kind: 'meterPair', title: 'RAM', metrics: [ramWsl, ramHost] },
    { kind: 'single', metric: gpu },
    { kind: 'single', metric: gpuPower },
    { kind: 'single', metric: battery },
    { kind: 'stack', title: 'NETWORK', metrics: [netDown, netUp] },
    { kind: 'stack', title: 'DISK', metrics: [diskRead, diskWrite] },
    { kind: 'single', metric: temp },
  ];
}

function chunkArray(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

function cellLineCount(cell) {
  return 2;
}

// WSL and Host values are always shown as two distinct bars (never averaged
// or overlaid into one) so each stays individually readable, even when the
// terminal is small. Terminal font size can't be controlled from inside the
// app (that's a terminal-emulator setting), so instead the layout adapts:
// boxed charts are used when there's room, and a denser, borderless
// sparkline layout is used when there isn't - so every widget stays visible
// rather than being dropped.
function renderChartGrid(cells, width, totalRows) {
  const budget = Math.max(1, totalRows);

  const columns = Math.min(cells.length, width >= 150 ? 5 : width >= 110 ? 3 : 2);
  const groups = chunkArray(cells, columns);
  let chartHeight = Math.floor(budget / groups.length) - 2;
  // meterPair and stack cells (CPU/RAM, NET/DSK) always need 2 rows - one
  // bar per embedded tag - so they're never allowed to shrink below that,
  // even if the naturally computed shared height would be smaller.
  if (cells.some(cell => cell.kind === 'meterPair' || cell.kind === 'stack')) chartHeight = Math.max(chartHeight, 2);
  if (chartHeight >= 1) {
    const output = [];
    // panelWidth is derived from the grid's column count (not each row's own
    // cell count) so every box is the same width, including a shorter final
    // row that has fewer cells than a full row.
    const panelWidth = Math.max(12, Math.floor((width - ((columns - 1) * 2)) / columns));
    for (const group of groups) {
      const charts = group.map(cell => boxedCellChart(cell, panelWidth, chartHeight));
      for (let row = 0; row < chartHeight + 2; row += 1) {
        output.push(charts.map(chart => chart[row]).join('  '));
      }
    }
    return output;
  }

  // Not enough vertical room for boxed charts (2-row minimum body + border):
  // fall back to a compact borderless layout (2 lines per single widget, 4
  // lines per stacked pair) so every widget can still be shown instead of
  // being dropped entirely.
  return renderCompactChartGrid(cells, width, budget);
}

function renderCompactChartGrid(cells, width, budget) {
  const panelMinWidth = 22;
  const columns = Math.max(1, Math.min(cells.length, Math.floor(width / panelMinWidth)));
  let visible = cells;
  let groups = chunkArray(visible, columns);
  const groupsHeight = groupList => groupList.reduce((sum, group) => sum + Math.max(...group.map(cellLineCount)), 0);
  // If space is so tight even the compact layout can't fit every widget,
  // drop from the end one widget at a time (never a whole box, since there
  // is no box to break) until what remains fits within the budget.
  while (groupsHeight(groups) > budget && visible.length > 1) {
    visible = visible.slice(0, -1);
    groups = chunkArray(visible, columns);
  }

  // Same reasoning as the boxed layout: derive panelWidth from the grid's
  // column count so every widget is the same width, even on a shorter final
  // row.
  const panelWidth = Math.max(panelMinWidth, Math.floor((width - ((columns - 1) * 2)) / columns));
  const output = [];
  for (const group of groups) {
    const cellLines = group.map(cell => compactCellLines(cell, panelWidth));
    const rowHeight = Math.max(...cellLines.map(lines => lines.length));
    const blank = ' '.repeat(panelWidth);
    const padded = cellLines.map(lines => {
      const copy = lines.slice();
      while (copy.length < rowHeight) copy.push(blank);
      return copy;
    });
    for (let row = 0; row < rowHeight; row += 1) {
      output.push(padded.map(lines => lines[row]).join('  '));
    }
  }
  if (visible.length < cells.length) {
    output.push(`${ANSI.dim}... ${cells.length - visible.length} more widget(s) hidden (enlarge the window to see them)${ANSI.reset}`);
  }
  return output;
}

function compactCellLines(cell, width) {
  if (cell.kind === 'stack' || cell.kind === 'meterPair') {
    const innerWidth = Math.max(10, width);
    const tagWidth = Math.max(...cell.metrics.map(metric => metric.title.length));
    return cell.metrics.map(metric => meterTagLine(metric, innerWidth, tagWidth));
  }
  return compactChartLines(cell.metric, width);
}

function compactChartLines(metric, width) {
  const innerWidth = Math.max(10, width);
  const title = `${metric.title} ${metric.value}`;
  const label = truncateVisible(title, innerWidth).padEnd(innerWidth);
  const spark = metric.type === 'meter' ? meterBarLine(metric, innerWidth) : verticalChart(metric, innerWidth, 1)[0];
  return [label, spark];
}

function boxedCellChart(cell, width, chartHeight) {
  if (cell.kind === 'stack' || cell.kind === 'meterPair') return boxedMeterPairChart(cell.title, cell.metrics, width, chartHeight);
  return boxedVerticalChart(cell.metric, width, chartHeight);
}

function boxedVerticalChart(metric, width, chartHeight) {
  const innerWidth = Math.max(8, width - 2);
  const title = `${metric.title} ${metric.value}`;
  const header = `┌${truncateVisible(title, innerWidth).padEnd(innerWidth, '─')}┐`;
  const body = metric.type === 'meter'
    ? meterBarRows(metric, innerWidth, chartHeight)
    : verticalChart(metric, innerWidth, chartHeight);
  const rows = body.map(row => `│${row}│`);
  return [header, ...rows, `└${'─'.repeat(innerWidth)}┘`];
}

// Renders a WSL/Host metric pair (CPU, RAM) in a single box titled just like
// a plain single-metric widget (e.g. "GPU"), with each series' "WSL"/"HOST"
// tag embedded directly into its own bar row instead of a separate label
// line above it - keeps both bars always visible in exactly 2 body rows
// regardless of box height.
function boxedMeterPairChart(title, pair, width, chartHeight) {
  const innerWidth = Math.max(8, width - 2);
  const header = `┌${truncateVisible(title, innerWidth).padEnd(innerWidth, '─')}┐`;
  const rows = meterPairRows(pair, innerWidth, chartHeight).map(row => `│${row}│`);
  return [header, ...rows, `└${'─'.repeat(innerWidth)}┘`];
}

// Splits the box's full height between the two series so each one's gauge
// scales up (gets thicker) as the box is expanded, instead of staying a
// single thin line surrounded by growing empty space. Both tags share a
// single width - the longer of the two - so their bars line up flush
// regardless of which series ("W"/"H" vs. "↓"/"↑" vs. "R"/"W") is wider. The
// value text is only stamped on the vertically-centered row of each series'
// span (see meterGaugeRows), so it appears exactly once even when thick.
function meterPairRows(pair, width, height) {
  const [a, b] = pair;
  const heightA = Math.ceil(height / 2);
  const heightB = height - heightA;
  const tagWidth = Math.max(a.title.length, b.title.length);
  return [...meterGaugeRows(a, width, heightA, a.title, tagWidth), ...meterGaugeRows(b, width, heightB, b.title, tagWidth)];
}

// A single WSL/Host bar row: "TAG  [bar] value%", all in one line so the
// series is identifiable without a dedicated label row.
function meterTagLine(metric, width, tagWidth = metric.title.length) {
  const prefix = `${metric.title.padEnd(tagWidth)} `;
  const barWidth = Math.max(6, width - prefix.length);
  return `${prefix}${meterBarLine(metric, barWidth)}`.padEnd(width);
}

// Percentage widgets (CPU/RAM/GPU/Battery) show the current value as an
// htop-style fill bar rather than a historical trend - the user only cares
// about "how full is it right now", not a sparkline. Unlike a plain single
// line, the bar is drawn as a solid vertical gauge that fills the entire
// available height, so it visibly scales up (gets thicker) when the box is
// expanded instead of staying a thin line lost in empty space. An optional
// tag ("WSL"/"HOST") can be embedded as a prefix, shown once on the
// vertically-centered row.
function meterBarRows(metric, width, height) {
  return meterGaugeRows(metric, width, height, null);
}

function meterGaugeRows(metric, width, height, tag, tagWidth = 5) {
  const rowsCount = Math.max(1, height);
  const prefix = tag ? `${tag.padEnd(tagWidth)} ` : '';
  const prefixWidth = prefix.length;
  const barAreaWidth = Math.max(6, width - prefixWidth);
  const innerWidth = Math.max(4, barAreaWidth - 2);
  // The value text is only stamped onto the vertically-centered row - other
  // rows just show the plain fill, so a multi-row-tall gauge reads as one
  // thick bar with a single label, not the same reading repeated on every row.
  const barRowWithText = `[${meterBarInterior(metric, innerWidth, true)}]`;
  const barRowPlain = `[${meterBarInterior(metric, innerWidth, false)}]`;
  const blankPrefix = ' '.repeat(prefixWidth);
  const middle = Math.floor((rowsCount - 1) / 2);
  const rows = [];
  for (let row = 0; row < rowsCount; row += 1) {
    const rowPrefix = row === middle ? prefix : blankPrefix;
    const barRow = row === middle ? barRowWithText : barRowPlain;
    rows.push(`${rowPrefix}${barRow}`.padEnd(width));
  }
  return rows;
}

// Value text stamped directly onto the bar (percentage, optional RAM amount,
// or NET/DSK throughput rate) rather than printed after it - the reading
// sits on top of the gauge itself so no extra column width is spent on it,
// left-aligned (with a small margin) so it reads naturally like a label
// rather than floating in the middle of the bar. Text over the filled
// portion is drawn in reverse video (bar's hue becomes the background,
// default terminal color becomes the readable foreground), so it always
// contrasts with the bar underneath it instead of blending in; text over the
// unfilled portion uses the plain foreground. The unfilled track itself is
// left blank (no dotted shading) so it just shows the terminal's own
// background instead of a mismatched grey texture.
function meterValueText(metric) {
  if (!Number.isFinite(metric.percent)) return '';
  if (metric.rateLabel) return metric.rateLabel;
  const percentText = `${clamp(metric.percent, 0, 100).toFixed(1)}%`;
  return metric.amountLabel ? `${percentText} (${metric.amountLabel})` : percentText;
}

// Picks the fullest value text that still fits inside the bar with at least
// a 1-character margin on each side, falling back to the bare percentage (no
// amount detail), then to nothing at all for very narrow bars.
function meterValueTextForWidth(metric, innerWidth) {
  const full = meterValueText(metric);
  if (!full) return '';
  if (full.length + 2 <= innerWidth) return full;
  if (metric.amountLabel && !metric.rateLabel) {
    const percentOnly = `${clamp(metric.percent, 0, 100).toFixed(1)}%`;
    return percentOnly.length <= innerWidth ? percentOnly : '';
  }
  return full.length <= innerWidth ? full : '';
}

function meterBarInterior(metric, innerWidth, includeText = true) {
  const width = Math.max(4, innerWidth);
  const color = metric.color || hue('green');
  const percent = metric.percent;
  const hasPercent = Number.isFinite(percent);
  if (!hasPercent) return `${ANSI.dim}${'-'.repeat(width)}${ANSI.reset}`;
  const filled = clamp(Math.round((clamp(percent, 0, 100) / 100) * width), 0, width);
  const text = includeText ? meterValueTextForWidth(metric, width) : '';
  const chars = new Array(width).fill(' ');
  if (text) {
    const start = Math.min(1, Math.max(0, width - text.length));
    for (let i = 0; i < text.length && start + i < width; i += 1) chars[start + i] = text[i];
  }
  const filledPart = chars.slice(0, filled).join('');
  const restPart = chars.slice(filled).join('');
  return `${color}${ANSI.reverse}${filledPart}${ANSI.reset}${restPart}`;
}

function meterBarLine(metric, width) {
  const bracketWidth = Math.max(4, width - 2);
  return `[${meterBarInterior(metric, bracketWidth)}]`.padEnd(width);
}

const BLOCK_GLYPHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function verticalChart(metric, width, height) {
  const values = metric.values.slice(-width);
  const numeric = values.filter(Number.isFinite);
  const padded = Array(Math.max(0, width - values.length)).fill(undefined).concat(values);
  if (numeric.length === 0) {
    return Array(height).fill('·'.repeat(width));
  }

  const min = Number.isFinite(metric.min) ? metric.min : Math.min(0, Math.min(...numeric));
  const max = Number.isFinite(metric.max) ? metric.max : Math.max(...numeric);
  const range = max - min || 1;
  const color = metric.color || hue('green');
  // Track fill in eighths-of-a-row so magnitude is still visible even when a
  // widget only has one row of vertical space (otherwise any non-zero value
  // rounds up to a fully filled row and every bar looks identical).
  const eighths = padded.map(value => {
    if (!Number.isFinite(value)) return undefined;
    return clamp((value - min) / range, 0, 1) * height * 8;
  });

  const rows = [];
  for (let row = height; row >= 1; row -= 1) {
    const rowFloor = (row - 1) * 8;
    rows.push(eighths.map(filledEighths => {
      if (!Number.isFinite(filledEighths)) return '·';
      const glyphIndex = clamp(Math.round(filledEighths - rowFloor), 0, 8);
      return glyphIndex <= 0 ? '·' : `${color}${BLOCK_GLYPHS[glyphIndex]}${ANSI.reset}`;
    }).join(''));
  }
  return rows;
}

// Resolves the WSL distro's hostname and primary (non-internal) IPv4 address
// so both are visible at a glance - useful when connecting to this WSL
// instance from another machine or another WSL distro on the same host.
function readWslIdentity() {
  const hostname = os.hostname();
  const interfaces = os.networkInterfaces();
  let ip;
  for (const name of Object.keys(interfaces)) {
    const addr = (interfaces[name] || []).find(entry => entry.family === 'IPv4' && !entry.internal);
    if (addr) {
      ip = addr.address;
      break;
    }
  }
  return { hostname, ip: ip || '-' };
}

function formatDetailSummary(sensors) {  const parts = [];
  if (sensors.gpu?.label) {
    const memText = Number.isFinite(sensors.gpu.memoryUsed) && Number.isFinite(sensors.gpu.memoryTotal)
      ? ` ${formatBytes(sensors.gpu.memoryUsed)}/${formatBytes(sensors.gpu.memoryTotal)}`
      : Number.isFinite(sensors.gpu.memoryUsedMb) && Number.isFinite(sensors.gpu.memoryTotalMb)
        ? ` ${formatBytes(sensors.gpu.memoryUsedMb * 1024 * 1024)}/${formatBytes(sensors.gpu.memoryTotalMb * 1024 * 1024)}`
        : '';
    parts.push(`GPU ${sensors.gpu.label}${memText}`);
  }
  const battery = sensors.batteries[0];
  if (battery) {
    const bits = [battery.label];
    if (battery.status) bits.push(battery.status);
    if (Number.isFinite(battery.watts)) bits.push(`${battery.watts.toFixed(1)}W`);
    parts.push(bits.join(' '));
  } else if (sensors.powerWatts.length > 0) {
    parts.push(sensors.powerWatts.map(sensor => `${sensor.label} ${sensor.watts.toFixed(1)}W`).join('  '));
  }
  if (sensors.temperatures.length > 0) {
    parts.push(`Temp source ${sensors.temperatures.map(sensor => sensor.label).join(', ')}`);
  }
  if (windowsHostInfo?.lhm?.available) {
    parts.push(`LHM ${windowsHostInfo.lhm.sensorCount || 0} sensors`);
  } else if (windowsHostInfo?.error) {
    parts.push(windowsHostInfo.error);
  }
  return parts.length > 0 ? parts.join('   ') : '-';
}

function label(value) {
  return `${ANSI.bold}${value.padEnd(8)}${ANSI.reset}`;
}

function rule(width) {
  return `${ANSI.dim}${'─'.repeat(width)}${ANSI.reset}`;
}

function percent(value, total) {
  return total > 0 ? (value / total) * 100 : 0;
}

function formatPercent(value) {
  return `${clamp(value, 0, 100).toFixed(1)}%`;
}

function formatMaybePercent(value) {
  return Number.isFinite(value) ? formatPercent(value) : '-';
}

function formatWatts(value) {
  return `${value.toFixed(1)}W`;
}

function formatMaybeWatts(value) {
  return Number.isFinite(value) ? formatWatts(value) : '-';
}

function formatTemperature(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}°C` : '-';
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`;
}

// Compact "used/total" byte pair sharing a single unit suffix (e.g.
// "2.6/7.8GB" instead of "2.6GB/7.8GB") - used for the RAM box's amount
// detail, where every character counts toward fitting inside the box.
function formatBytesPair(usedBytes, totalBytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let used = Math.max(0, usedBytes);
  let total = Math.max(0, totalBytes);
  let index = 0;
  while (total >= 1024 && index < units.length - 1) {
    used /= 1024;
    total /= 1024;
    index += 1;
  }
  const digits = (value) => (value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1));
  return `${digits(used)}/${digits(total)}${units[index]}`;
}

function formatDuration(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
}

function truncate(value, width) {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
}

function truncateVisible(value, width) {
  const plain = value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (plain.length <= width) return value;
  return truncate(value, width);
}

function visibleLength(value) {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateHistory(values, value) {
  values.push(Number.isFinite(value) ? value : undefined);
  while (values.length > HISTORY_LENGTH) values.shift();
}

// Throughput metrics (NET/DSK) have no natural 0-100% ceiling like CPU/RAM,
// so their gauge bar is scaled relative to the highest rate seen recently
// (including the current sample) - this keeps the bar visually meaningful
// (an idle rate shows an empty/near-empty bar, a rate near the recent peak
// shows a nearly full bar) while still rendering as a solid gauge like the
// percentage widgets, instead of a historical sparkline trend.
function rateGaugePercent(values, current) {
  const numeric = values.filter(Number.isFinite);
  const historyMax = numeric.length ? Math.max(...numeric) : 0;
  const scale = Math.max(historyMax, current, 1);
  return clamp((current / scale) * 100, 0, 100);
}

let wakeSleep = null;

// Sleeps for ms, but can be interrupted early (see wake()) so a key press
// that changes the refresh interval takes effect immediately instead of
// waiting out whatever interval was in effect when the key was pressed.
async function sleep(ms) {
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}

function wake() {
  if (wakeSleep) wakeSleep();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(PROC_DIR, 'stat')) || !fs.existsSync(path.join(PROC_DIR, 'meminfo'))) {
    throw new Error('This monitor reads Linux /proc metrics. Run it from inside WSL, or use --help to see available options.');
  }

  let previousCpu = readCpuSnapshot();
  let previousNet = readNetSnapshot();
  let previousDisk = readDiskSnapshot();
  let previousProcesses = readProcesses();
  let previousTime = Date.now();

  if (!options.once && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', data => {
      const key = data.toString();
      if (key === 'q' || key === '\u0003') cleanupAndExit();
      else if (key === 'v' || key === 'V' || key === '\t') {
        const currentIndex = BOTTOM_VIEW_MODES.indexOf(bottomViewMode);
        bottomViewMode = BOTTOM_VIEW_MODES[(currentIndex + 1) % BOTTOM_VIEW_MODES.length];
        wake();
      } else if (key === 'c' || key === 'C') {
        colorThemeIndex = (colorThemeIndex + 1) % COLOR_THEMES.length;
        wake();
      } else if (key === 'i' || key === 'I') {
        const currentIndex = INTERVAL_STEPS_MS.indexOf(options.intervalMs);
        options.intervalMs = INTERVAL_STEPS_MS[(currentIndex + 1) % INTERVAL_STEPS_MS.length];
        wake();
      } else if (key === 's' || key === 'S') {
        showAllSensors = !showAllSensors;
        wake();
      }
    });
    process.stdout.write(ANSI.altScreen + ANSI.hideCursor);
    process.on('SIGINT', cleanupAndExit);
    process.on('SIGTERM', cleanupAndExit);
  }

  do {
    await sleep(options.once ? Math.min(options.intervalMs, 1000) : options.intervalMs);
    refreshWindowsHostInfo(options.includeWindowsHost, bottomViewMode === 'gpu');

    const now = Date.now();
    const elapsedSeconds = Math.max(0.001, (now - previousTime) / 1000);
    const currentCpu = readCpuSnapshot();
    const currentNet = readNetSnapshot();
    const currentDisk = readDiskSnapshot();
    const currentProcesses = readProcesses();
    const sensors = readSensors();
    const listeningPorts = readListeningPorts();
    const cpuUsage = calculateCpuUsage(previousCpu, currentCpu);
    const memInfo = readMemInfo();
    const netRate = {
      rxBytes: (currentNet.rxBytes - previousNet.rxBytes) / elapsedSeconds,
      txBytes: (currentNet.txBytes - previousNet.txBytes) / elapsedSeconds,
    };
    const diskRate = {
      readSectors: (currentDisk.readSectors - previousDisk.readSectors) / elapsedSeconds,
      writeSectors: (currentDisk.writeSectors - previousDisk.writeSectors) / elapsedSeconds,
    };
    const processUsage = calculateProcessUsage(previousProcesses, currentProcesses, elapsedSeconds);
    const frame = renderFrame(
      cpuUsage,
      memInfo,
      readLoadAverage(),
      readUptime(),
      netRate,
      diskRate,
      sensors,
      processUsage,
      listeningPorts,
      options,
    );

    // Move the cursor home and overwrite in place rather than a full
    // erase-then-redraw (\x1b[2J) - the full clear blanks the whole screen
    // for a frame before the new content lands, which reads as flicker at a
    // 1s refresh rate. Erasing to end-of-line on every row (\x1b[K) cleans up
    // any leftover text from a previous, wider frame (e.g. after the window
    // is resized narrower) that would otherwise poke out past the new,
    // shorter line content; erasing to end-of-screen once at the end handles
    // the vertical case (a previous, taller frame, e.g. fewer processes now).
    const liveFrame = frame.split('\n').join(`${ANSI.clearLine}\n`) + ANSI.clearLine;
    process.stdout.write(options.once ? `${frame}\n` : `${ANSI.home}${liveFrame}${ANSI.clearToEnd}`);

    previousCpu = currentCpu;
    previousNet = currentNet;
    previousDisk = currentDisk;
    previousProcesses = currentProcesses;
    previousTime = now;
  } while (!options.once);

  if (!options.once) cleanupAndExit();
}

function cleanupAndExit() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdout.write(ANSI.reset + ANSI.showCursor + ANSI.mainScreen);
  process.exit(0);
}

main().catch(error => {
  process.stdout.write(ANSI.reset + ANSI.showCursor + ANSI.mainScreen);
  console.error(`Failed to start WSL Top: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

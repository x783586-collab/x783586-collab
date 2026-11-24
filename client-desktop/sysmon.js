"use strict";
/* 系统监控采样：CPU 使用率 + 上下行网速。
 * Linux 精确读 /proc/net/dev；其他平台网速显示 "--"（接口限制）。
 */
const os = require("os");
const fs = require("fs");

function cpuSnapshot() {
  let idle = 0, total = 0;
  const cpus = os.cpus();
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function readNetLinux() {
  try {
    const txt = fs.readFileSync("/proc/net/dev", "utf8");
    let rx = 0, tx = 0;
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (!m) continue;
      const iface = m[1];
      if (iface === "lo" || /^(veth|docker|br-|virbr)/.test(iface)) continue;
      rx += Number(m[2]);
      tx += Number(m[3]);
    }
    return { rx, tx };
  } catch (e) { return null; }
}

function readNet() {
  return process.platform === "linux" ? readNetLinux() : null;
}

function fmtSpeed(bps) {
  if (bps < 1024) return Math.round(bps) + "B";
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + "K";
  return (bps / 1024 / 1024).toFixed(1) + "M";
}

let lastCpu = cpuSnapshot();
let lastNet = readNet();
let lastTs = Date.now();

function sample() {
  const now = Date.now();
  const cur = cpuSnapshot();
  const dIdle = cur.idle - lastCpu.idle;
  const dTotal = cur.total - lastCpu.total;
  const cpu = dTotal > 0
    ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)))
    : 0;
  lastCpu = cur;

  let down = "--", up = "--";
  const net = readNet();
  const dt = (now - lastTs) / 1000;
  if (net && lastNet && dt > 0) {
    down = fmtSpeed(Math.max(0, (net.rx - lastNet.rx) / dt));
    up = fmtSpeed(Math.max(0, (net.tx - lastNet.tx) / dt));
  }
  if (net) lastNet = net;
  lastTs = now;

  return { cpu, down, up };
}

module.exports = { sample };

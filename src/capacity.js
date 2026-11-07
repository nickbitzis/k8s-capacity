// Kubernetes capacity planner for one synthetic cluster.
// One config drives six models:
//   1. Workloads: about 60 deployments across 8 teams, with requests, limits,
//      replicas, PodDisruptionBudgets, anti-affinity, zone spread, and a week of
//      usage at 5 minute resolution (diurnal load, weekends, spikes, nightly batch).
//   2. Node pools: an illustrative instance catalog and allocatable after the
//      kubelet, OS, eviction threshold, and DaemonSets take their share.
//   3. Bin packing: first fit decreasing, MostAllocated, and LeastAllocated scoring,
//      with anti-affinity and zone spread, plus a search for the cheapest mix.
//   4. Rightsizing: VPA-style requests from usage percentiles, then a repack.
//   5. Autoscaling: HPA with stabilization windows and a cluster autoscaler with a
//      provisioning delay and scale-down cooldown, minute by minute for a week.
//   6. Spot and cost allocation: interruptions against PDBs, cost per team by
//      requests and by usage, with system overhead and idle shown separately.
// CPU is in millicores, memory in MiB, time in minutes from Monday 00:00. No DOM code.

// ---------------------------------------------------------------------------
// Randomness and statistics

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent but reproducible seed for stream `i` of base seed `seed`. */
export function subSeed(seed, i) {
  let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** Linear interpolation quantile on a copy of xs (q in [0, 1]). */
export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = Float64Array.from(xs).sort();
  const pos = (s.length - 1) * q, i = Math.floor(pos), f = pos - i;
  return i + 1 < s.length ? s[i] + f * (s[i + 1] - s[i]) : s[i];
}

const mean = (xs) => { let s = 0; for (const x of xs) s += x; return xs.length ? s / xs.length : 0; };
const maxOf = (xs) => { let m = -Infinity; for (const x of xs) if (x > m) m = x; return m; };

// ---------------------------------------------------------------------------
// Time

export const WEEK_MIN = 7 * 24 * 60;
export const STEP_MIN = 5; // usage resolution
export const STEPS = WEEK_MIN / STEP_MIN; // 2016
export const HOURS_PER_MONTH = 730;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------------------------------------------------------------------------
// Node catalog. Illustrative prices with realistic ratios, not a quote.
// On-demand price = vCPU x $0.031 + GiB x $0.0042 per hour, times a family factor.

export const ZONES = ["zone-a", "zone-b", "zone-c"];

const FAMILIES = {
  gp: { label: "General purpose", ratio: 4, factor: 1.0, spot: 0.35 },
  cpu: { label: "Compute optimized", ratio: 2, factor: 0.92, spot: 0.32 },
  mem: { label: "Memory optimized", ratio: 8, factor: 1.04, spot: 0.38 },
  gpu: { label: "GPU", ratio: 8, factor: 1.0, spot: 0.45 },
};

function makeType(family, vcpu, gpu = 0) {
  const f = FAMILIES[family];
  const memGiB = vcpu * f.ratio;
  const od = (vcpu * 0.031 + memGiB * 0.0042) * f.factor + gpu * 0.85;
  return {
    id: `${family}-${vcpu}`, family, vcpu, memGiB, gpu,
    od: Math.round(od * 10000) / 10000,
    spot: Math.round(od * f.spot * 10000) / 10000,
  };
}

export const CATALOG = [
  makeType("gp", 2), makeType("gp", 4), makeType("gp", 8), makeType("gp", 16), makeType("gp", 32),
  makeType("cpu", 4), makeType("cpu", 8), makeType("cpu", 16), makeType("cpu", 32),
  makeType("mem", 2), makeType("mem", 4), makeType("mem", 8), makeType("mem", 16),
  makeType("gpu", 8, 1),
];
export const TYPE = Object.fromEntries(CATALOG.map((t) => [t.id, t]));
export const familyLabel = (f) => FAMILIES[f].label;

// DaemonSets on every node: log shipper, metrics agent, CNI plus kube-proxy.
export const DAEMONSETS = [
  { name: "log-shipper", cpu: 100, mem: 200 },
  { name: "metrics-agent", cpu: 100, mem: 150 },
  { name: "cni-and-proxy", cpu: 150, mem: 150 },
];
export const MAX_PODS = 110;
export const EVICTION_MIB = 100;

/** Tiered reservation: rate applies to the slice of `x` between successive limits. */
function tiered(x, tiers) {
  let left = x, prev = 0, out = 0;
  for (const [limit, rate] of tiers) {
    const slice = Math.max(0, Math.min(left, limit - prev));
    out += slice * rate;
    left -= slice;
    prev = limit;
    if (left <= 0) break;
  }
  return out;
}

/**
 * Allocatable for pods on a node, after kube-reserved CPU and memory (the common
 * managed-Kubernetes tiers), the hard eviction threshold, and DaemonSet requests.
 */
export function allocatable(type, daemonsets = DAEMONSETS) {
  const cpuCap = type.vcpu * 1000, memCap = type.memGiB * 1024;
  const kubeCpu = tiered(cpuCap, [[1000, 0.06], [2000, 0.01], [4000, 0.005], [Infinity, 0.0025]]);
  const kubeMem = tiered(memCap, [[4096, 0.25], [8192, 0.2], [16384, 0.1], [131072, 0.06], [Infinity, 0.02]]);
  const dsCpu = daemonsets.reduce((s, d) => s + d.cpu, 0);
  const dsMem = daemonsets.reduce((s, d) => s + d.mem, 0);
  return {
    cpuCap, memCap, kubeCpu, kubeMem, evictMem: EVICTION_MIB, dsCpu, dsMem,
    cpu: Math.floor(cpuCap - kubeCpu - dsCpu),
    mem: Math.floor(memCap - kubeMem - EVICTION_MIB - dsMem),
    gpu: type.gpu,
    pods: MAX_PODS - daemonsets.length,
  };
}

const ALLOC_CACHE = new Map();
function alloc(type) {
  if (type.alloc) return type.alloc; // tests can pass an explicit allocatable
  if (!ALLOC_CACHE.has(type.id)) ALLOC_CACHE.set(type.id, allocatable(type));
  return ALLOC_CACHE.get(type.id);
}

// ---------------------------------------------------------------------------
// Teams, workload kinds, presets

export const TEAMS = ["storefront", "checkout", "search", "payments", "catalog", "data", "ml", "platform"];

// How far each team's typical usage sits below its requests (1 = requests match peak use).
const TEAM_FIT = { storefront: 0.75, checkout: 0.9, search: 0.7, payments: 0.95, catalog: 0.32, data: 0.8, ml: 0.85, platform: 0.45 };

const KINDS = {
  web: { teams: ["storefront", "checkout", "search", "payments", "catalog"], stateless: true, hpa: true },
  worker: { teams: ["checkout", "payments", "catalog", "search", "platform"], stateless: true, hpa: true },
  batch: { teams: ["data", "catalog", "search", "ml"], stateless: true, hpa: true },
  data: { teams: ["data", "search", "payments", "storefront"], stateless: false, hpa: false },
  gpu: { teams: ["ml"], stateless: false, hpa: false },
  platform: { teams: ["platform"], stateless: true, hpa: false },
};

const NOUNS = {
  web: ["api", "web", "gateway", "bff", "graphql", "pricing", "cart", "profile", "reviews", "recs", "auth", "media", "promo", "orders", "wishlist", "session", "inventory", "store", "menu", "ratings", "checkout-ui", "tax", "shipping", "quotes", "content", "banner", "seo", "geo", "locale", "feed"],
  worker: ["mailer", "indexer", "webhook", "settler", "ledger-sync", "thumbnailer", "notifier", "exporter", "importer", "reconciler", "scheduler", "fraud-score", "refunds", "invoicer"],
  batch: ["etl", "nightly-report", "feature-build", "reindex", "backfill", "rollup", "sitemap", "model-eval", "dedupe", "compaction", "churn-score", "snapshot", "archiver", "audit-export", "price-sync", "embeddings"],
  data: ["postgres", "redis", "kafka", "elastic", "clickhouse", "cassandra", "memcache", "zookeeper", "minio", "timescale", "vector-db", "rabbitmq", "etcd-app", "neo4j", "druid", "pinot", "solr", "mongo", "nats", "valkey"],
  gpu: ["inference", "reranker", "vision"],
  platform: ["ingress", "cert-manager", "external-dns", "prometheus", "grafana", "loki", "argo-cd", "keda", "otel-collector", "policy-agent"],
};

export const PRESETS = {
  steady: {
    label: "Steady web",
    note: "Mostly request-driven web services with a smooth daily curve, a few workers, and a small data tier. The question is how much headroom the requests carry.",
    counts: { web: 30, worker: 9, batch: 4, data: 6, gpu: 2, platform: 9 },
    amp: 0.55, spikeRate: 0.15, spikeMul: 1.6, batchPeak: 2.5,
  },
  spiky: {
    label: "Spiky batch and web",
    note: "Web traffic with flash sales, queue workers that burst, and nightly batch that runs four times hotter than the day. Autoscaling carries most of the load.",
    counts: { web: 20, worker: 12, batch: 14, data: 4, gpu: 2, platform: 8 },
    amp: 0.75, spikeRate: 0.7, spikeMul: 2.6, batchPeak: 4,
  },
  memory: {
    label: "Memory-heavy data",
    note: "Caches, search clusters, and stream brokers with large memory requests next to a modest web tier. CPU is cheap here and memory sets the node count.",
    counts: { web: 16, worker: 8, batch: 4, data: 22, gpu: 2, platform: 8 },
    amp: 0.45, spikeRate: 0.2, spikeMul: 1.5, batchPeak: 2.5,
  },
};

export const STRATEGIES = {
  ffd: { label: "First fit decreasing", short: "First fit" },
  most: { label: "Best fit (MostAllocated)", short: "Most allocated" },
  least: { label: "Spread (LeastAllocated)", short: "Least allocated" },
};

// ---------------------------------------------------------------------------
// Config

const BASE = {
  strategy: "most", mix: "auto",
  cpuPct: 95, cpuMargin: 10, memHeadroom: 20,
  hpaTarget: 70, upWin: 0, downWin: 5, provisionMin: 3, podStartMin: 1, scaleDownUtil: 50, scaleDownMin: 10, maxNodes: 80,
  spotPct: 50, spotRatePct: 5, notice: 2, pdbAware: 1,
  seed: 7,
};

const LIMITS = {
  cpuPct: [50, 100], cpuMargin: [0, 100], memHeadroom: [0, 100],
  hpaTarget: [30, 95], upWin: [0, 30], downWin: [0, 60], provisionMin: [0, 30], podStartMin: [0, 10],
  scaleDownUtil: [10, 90], scaleDownMin: [1, 60], maxNodes: [5, 300],
  spotPct: [0, 100], spotRatePct: [0, 100], notice: [0, 10], pdbAware: [0, 1],
  seed: [0, 1e9],
};

export const HPA_TARGETS = [50, 70, 85];

export function presetValues(id) {
  return { preset: id, ...BASE };
}

export const DEFAULTS = presetValues("steady");

export function mixIds() {
  return candidateMixes(CATALOG).map((m) => m.id);
}

export function clamp(cfg) {
  const preset = PRESETS[cfg?.preset] ? cfg.preset : DEFAULTS.preset;
  const base = presetValues(preset);
  const c = { ...base, ...cfg, preset };
  if (!STRATEGIES[c.strategy]) c.strategy = base.strategy;
  if (c.mix !== "auto" && !mixIds().includes(c.mix)) c.mix = "auto";
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    let v = Number(c[k]);
    if (!Number.isFinite(v)) v = base[k];
    c[k] = Math.round(Math.min(hi, Math.max(lo, v)));
  }
  return c;
}

export const makeConfig = (over = {}) => clamp(over);

/** Only the preset and values that differ from it go in the URL, so links stay short. */
export function encodeConfig(cfg) {
  const base = presetValues(cfg.preset);
  const p = new URLSearchParams();
  p.set("preset", cfg.preset);
  for (const k of Object.keys(base)) if (k !== "preset" && cfg[k] !== base[k]) p.set(k, String(cfg[k]));
  return p.toString();
}

export function decodeConfig(hash) {
  const p = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const over = { preset: p.get("preset") ?? DEFAULTS.preset };
  for (const k of Object.keys(DEFAULTS)) if (k !== "preset" && p.has(k)) over[k] = p.get(k);
  return makeConfig(over);
}

// ---------------------------------------------------------------------------
// Workloads

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const between = (r, a, b) => a + r() * (b - a);
const roundTo = (x, step) => Math.max(step, Math.round(x / step) * step);

/** Daily shape in [0, 1]: low at 04:00, peak around 19:00, with a lunch bump. */
export function diurnal(minuteOfDay) {
  const h = minuteOfDay / 60;
  const evening = Math.exp(-((h - 19.5) ** 2) / 12);
  const lunch = 0.55 * Math.exp(-((h - 12.5) ** 2) / 4);
  const night = Math.exp(-((h - 4) ** 2) / 6);
  return Math.max(0, Math.min(1, 0.15 + 0.85 * Math.max(evening, lunch) - 0.15 * night));
}

/**
 * Build the deployments for a preset. Each one has requests, limits, replicas,
 * a PDB, scheduling constraints, and per-pod CPU and memory usage for the week.
 */
export function generateWorkloads(presetId, seed = 7) {
  const P = PRESETS[presetId] ?? PRESETS.steady;
  const r = mulberry32(subSeed(seed, 101));
  const used = new Set();
  const deps = [];
  for (const [kind, n] of Object.entries(P.counts)) {
    const K = KINDS[kind];
    for (let i = 0; i < n; i++) {
      const team = kind === "web" || kind === "worker" || kind === "data" || kind === "batch" ? K.teams[i % K.teams.length] : pick(r, K.teams);
      let name = `${team}-${NOUNS[kind][i % NOUNS[kind].length]}`;
      for (let k = 2; used.has(name); k++) name = `${team}-${NOUNS[kind][i % NOUNS[kind].length]}-${k}`;
      used.add(name);
      deps.push(makeDeployment(kind, team, name, r, P));
    }
  }
  deps.forEach((d, i) => { d.id = i; });
  for (const d of deps) d.usage = usageSeries(d, P, mulberry32(subSeed(seed, 1000 + d.id)));
  return deps;
}

function makeDeployment(kind, team, name, r, P) {
  let d;
  if (kind === "web") {
    const replicas = Math.round(between(r, 3, 12));
    d = { replicas, cpu: roundTo(between(r, 250, 1000), 50), mem: roundTo(between(r, 384, 1536), 128), anti: r() < 0.5, spread: true, hpaMin: 3 };
  } else if (kind === "worker") {
    const replicas = Math.round(between(r, 2, 8));
    d = { replicas, cpu: roundTo(between(r, 500, 2000), 100), mem: roundTo(between(r, 512, 2048), 128), anti: false, spread: r() < 0.5, hpaMin: 2 };
  } else if (kind === "batch") {
    const replicas = Math.round(between(r, 2, 6));
    d = { replicas, cpu: roundTo(between(r, 1000, 3000), 250), mem: roundTo(between(r, 1024, 4096), 256), anti: false, spread: false, hpaMin: 1 };
  } else if (kind === "data") {
    const big = r() < 0.6;
    d = { replicas: 3, cpu: roundTo(between(r, 500, 2000), 250), mem: roundTo(big ? between(r, 8192, 26000) : between(r, 2048, 6144), 512), anti: true, spread: true, hpaMin: 3 };
  } else if (kind === "gpu") {
    d = { replicas: Math.round(between(r, 1, 3)), cpu: 3000, mem: 16384, gpu: 1, anti: true, spread: false, hpaMin: 1 };
  } else {
    d = { replicas: 2, cpu: roundTo(between(r, 100, 800), 50), mem: roundTo(between(r, 256, name.includes("prometheus") ? 6144 : 1536), 128), anti: true, spread: true, hpaMin: 2 };
  }
  const K = KINDS[kind];
  // PDB: data keeps a quorum, everything else tolerates one pod down at a time.
  const minAvailable = kind === "data" ? 2 : Math.max(0, d.replicas - 1);
  const fit = TEAM_FIT[team] * between(r, 0.8, 1.15);
  return {
    name, team, kind, gpu: 0, ...d,
    cpuLimit: kind === "data" || kind === "gpu" ? d.cpu : d.cpu * 2,
    memLimit: d.mem,
    stateless: K.stateless, hpa: K.hpa, minAvailable,
    hpaMax: Math.max(d.replicas * 4, 6),
    // Shape parameters for the usage series.
    base: fit * (kind === "batch" ? 0.25 : kind === "data" ? 0.35 : 0.45),
    amp: kind === "data" ? P.amp * 0.4 : kind === "platform" ? 0.2 : P.amp,
    memFrac: Math.min(0.95, fit * between(r, 0.55, 0.85)),
    phase: between(r, -45, 45),
  };
}

/**
 * Per-pod usage at the base replica count, 5 minute steps. CPU follows the daily
 * curve (lighter on weekends) with noise and spikes. Batch runs hot overnight.
 * Memory grows slowly through the week with small noise.
 */
function usageSeries(d, P, r) {
  const cpu = new Float32Array(STEPS), mem = new Float32Array(STEPS);
  const spikes = [];
  if (d.kind === "web" || d.kind === "worker") {
    const n = Math.floor(P.spikeRate * 7 * (0.5 + r()));
    for (let i = 0; i < n; i++) spikes.push({ at: Math.floor(r() * STEPS), len: 3 + Math.floor(r() * 10), mul: 1 + (P.spikeMul - 1) * (0.5 + r()) });
  }
  const batchStart = 60 + Math.floor(r() * 90); // 01:00 to 02:30
  const batchLen = 120 + Math.floor(r() * 120);
  let noise = 0;
  for (let s = 0; s < STEPS; s++) {
    const t = s * STEP_MIN, day = Math.floor(t / 1440), mod = (t % 1440 + 1440 + d.phase) % 1440;
    const weekend = day >= 5 ? (d.team === "storefront" || d.team === "search" ? 1.1 : 0.7) : 1;
    noise = 0.8 * noise + 0.2 * (r() - 0.5);
    let u;
    if (d.kind === "batch") {
      const m = t % 1440;
      const on = m >= batchStart && m < batchStart + batchLen;
      u = d.base * (on ? P.batchPeak : 0.35) * (1 + noise * 0.6);
    } else {
      u = d.base * (1 - d.amp + 2 * d.amp * diurnal(mod)) * weekend * (1 + noise);
    }
    for (const sp of spikes) if (s >= sp.at && s < sp.at + sp.len) u *= sp.mul;
    cpu[s] = Math.max(5, u * d.cpu);
    mem[s] = d.mem * d.memFrac * (0.92 + 0.08 * (s / STEPS) + 0.03 * (r() - 0.5)) * (d.kind === "batch" ? (u > d.base ? 1.05 : 0.85) : 1);
  }
  return { cpu, mem };
}

/** One pod per replica. Requests can be overridden (rightsizing). */
export function podsOf(deps, req = null) {
  const pods = [];
  for (const d of deps) {
    const q = req?.[d.id] ?? d;
    for (let i = 0; i < d.replicas; i++) {
      pods.push({ id: `${d.name}-${i}`, dep: d.id, team: d.team, cpu: q.cpu, mem: q.mem, gpu: d.gpu, anti: d.anti, spread: d.spread });
    }
  }
  return pods;
}

// ---------------------------------------------------------------------------
// Bin packing

function newNode(type, zone, pool, spot = false) {
  const a = alloc(type);
  return { type: type.id, typeObj: type, zone, pool, spot, a, cpu: 0, mem: 0, gpu: 0, pods: [], deps: new Map() };
}

export function fits(node, pod, cap = null) {
  const a = node.a;
  if (node.cpu + pod.cpu > a.cpu || node.mem + pod.mem > a.mem || node.gpu + (pod.gpu || 0) > a.gpu) return false;
  if (node.pods.length + 1 > a.pods) return false;
  const have = node.deps.get(pod.dep) ?? 0;
  if (pod.anti && have > 0) return false;
  if (cap && cap[pod.dep] != null && have + 1 > cap[pod.dep]) return false;
  return true;
}

function place(node, pod) {
  node.cpu += pod.cpu;
  node.mem += pod.mem;
  node.gpu += pod.gpu || 0;
  node.pods.push(pod);
  node.deps.set(pod.dep, (node.deps.get(pod.dep) ?? 0) + 1);
}

function unplace(node, pod) {
  node.cpu -= pod.cpu;
  node.mem -= pod.mem;
  node.gpu -= pod.gpu || 0;
  node.pods.splice(node.pods.indexOf(pod), 1);
  const n = (node.deps.get(pod.dep) ?? 1) - 1;
  if (n) node.deps.set(pod.dep, n); else node.deps.delete(pod.dep);
}

/** Scheduler scores in [0, 1] after placing the pod. Higher wins. */
export function score(node, pod, strategy) {
  const c = (node.cpu + pod.cpu) / node.a.cpu, m = (node.mem + pod.mem) / node.a.mem;
  if (strategy === "least") return ((1 - c) + (1 - m)) / 2;
  if (strategy === "most") return (c + m) / 2;
  return 0;
}

/** Zones a pod may use under maxSkew 1 across all zones (DoNotSchedule). */
function allowedZones(counts, zones) {
  const lo = Math.min(...zones.map((z) => counts?.[z] ?? 0));
  return new Set(zones.filter((z) => (counts?.[z] ?? 0) + 1 - lo <= 1));
}

/**
 * Pack pods onto nodes of one instance type. Pods go in decreasing order of their
 * dominant share of the node. Each pod goes to the best existing node by the
 * strategy; when none fits, a new node opens (the cluster autoscaler's job).
 * Returns { nodes, unschedulable }.
 */
export function packPool(pods, type, { strategy = "most", zones = ZONES, pool = type.id, spot = false, cap = null, nodes = [] } = {}) {
  const a = alloc(type);
  // Most constrained first: anti-affinity pods need distinct nodes, so they go in
  // before the nodes fill up. Then decreasing dominant share.
  const order = [...pods].sort((p, q) => (q.anti ? 1 : 0) - (p.anti ? 1 : 0)
    || Math.max(q.cpu / a.cpu, q.mem / a.mem) - Math.max(p.cpu / a.cpu, p.mem / a.mem) || (p.id < q.id ? -1 : 1));
  const zoneCount = {};
  const spreadCount = {};
  for (const z of zones) zoneCount[z] = 0;
  for (const n of nodes) zoneCount[n.zone] = (zoneCount[n.zone] ?? 0) + 1;
  const unschedulable = [];
  for (const pod of order) {
    if (pod.cpu > a.cpu || pod.mem > a.mem || (pod.gpu || 0) > a.gpu) { unschedulable.push(pod); continue; }
    const zs = pod.spread ? allowedZones(spreadCount[pod.dep], zones) : null;
    let best = null, bestScore = -Infinity;
    for (const n of nodes) {
      if (zs && !zs.has(n.zone)) continue;
      if (!fits(n, pod, cap)) continue;
      if (strategy === "ffd") { best = n; break; }
      const s = score(n, pod, strategy);
      if (s > bestScore + 1e-12) { best = n; bestScore = s; }
    }
    if (!best) {
      const choices = zs ? zones.filter((z) => zs.has(z)) : zones;
      const zone = choices.reduce((b, z) => (zoneCount[z] < zoneCount[b] ? z : b), choices[0]);
      best = newNode(type, zone, pool, spot);
      zoneCount[zone]++;
      nodes.push(best);
    }
    place(best, pod);
    if (pod.spread) {
      spreadCount[pod.dep] ??= {};
      spreadCount[pod.dep][best.zone] = (spreadCount[pod.dep][best.zone] ?? 0) + 1;
    }
  }
  return { nodes, unschedulable };
}

/** Cost of a pod's dominant share of a node. Used to route pods between pools. */
const shareCost = (pod, type) => {
  const a = alloc(type);
  return type.od * Math.max(pod.cpu / a.cpu, pod.mem / a.mem);
};

const podFits = (pod, type) => {
  const a = alloc(type);
  return pod.cpu <= a.cpu && pod.mem <= a.mem && (pod.gpu || 0) <= a.gpu && (!(pod.gpu > 0) || type.gpu > 0);
};

/**
 * Route each pod to the pool in the mix where its dominant resource is cheapest.
 * GPU pods only go to GPU pools, and GPU pools only take GPU pods.
 */
export function routePods(pods, types) {
  const byType = new Map(types.map((t) => [t.id, []]));
  const none = [];
  for (const p of pods) {
    const ok = types.filter((t) => podFits(p, t) && (p.gpu > 0) === (t.gpu > 0));
    if (!ok.length) { none.push(p); continue; }
    const t = ok.reduce((b, x) => (shareCost(p, x) < shareCost(p, b) - 1e-12 ? x : b), ok[0]);
    byType.get(t.id).push(p);
  }
  return { byType, none };
}

/** Pack a set of pods onto a mix of instance types, one node pool per type. */
export function packMix(pods, types, opts = {}) {
  const { byType, none } = routePods(pods, types);
  const nodes = [];
  const unschedulable = [...none];
  for (const t of types) {
    const ps = byType.get(t.id);
    if (!ps.length) continue;
    const r = packPool(ps, t, { ...opts, nodes: [] });
    nodes.push(...r.nodes);
    unschedulable.push(...r.unschedulable);
  }
  return summarize(nodes, unschedulable, opts.usage);
}

/**
 * Node count, allocation against allocatable, actual use, and stranded capacity.
 * A node's free CPU is stranded when less than 10% of its memory is free, and its
 * free memory is stranded when less than 10% of its CPU is free: no typical pod can use it.
 */
export function summarize(nodes, unschedulable = [], usage = null) {
  let cpuA = 0, memA = 0, cpuR = 0, memR = 0, cpuU = 0, memU = 0, strandedCpu = 0, strandedMem = 0, cost = 0;
  for (const n of nodes) {
    cpuA += n.a.cpu; memA += n.a.mem; cpuR += n.cpu; memR += n.mem;
    cost += n.spot ? n.typeObj.spot : n.typeObj.od;
    const freeC = n.a.cpu - n.cpu, freeM = n.a.mem - n.mem;
    if (freeM < 0.1 * n.a.mem) strandedCpu += freeC;
    if (freeC < 0.1 * n.a.cpu) strandedMem += freeM;
    if (usage) for (const p of n.pods) { cpuU += usage[p.dep].cpu; memU += usage[p.dep].mem; }
  }
  const counts = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  return {
    nodes, unschedulable, feasible: unschedulable.length === 0, count: nodes.length, counts,
    cpuAlloc: cpuA, memAlloc: memA, cpuReq: cpuR, memReq: memR, cpuUsed: cpuU, memUsed: memU,
    cpuReqPct: cpuA ? cpuR / cpuA : 0, memReqPct: memA ? memR / memA : 0,
    cpuUsedPct: cpuA ? cpuU / cpuA : 0, memUsedPct: memA ? memU / memA : 0,
    strandedCpu, strandedMem, costHr: cost, costMonth: cost * HOURS_PER_MONTH,
  };
}

/**
 * Candidate mixes: every non-GPU type alone, and every general purpose or compute
 * type paired with a memory optimized type. The GPU type is added when needed.
 */
export function candidateMixes(catalog = CATALOG, needGpu = true) {
  const gpu = catalog.filter((t) => t.gpu > 0);
  const plain = catalog.filter((t) => t.gpu === 0);
  const mixes = plain.map((t) => [t]);
  for (const a of plain.filter((t) => t.family !== "mem")) for (const b of plain.filter((t) => t.family === "mem")) mixes.push([a, b]);
  return mixes.map((ts) => {
    const types = needGpu && gpu.length ? [...ts, gpu[0]] : ts;
    return { id: ts.map((t) => t.id).join("+"), types };
  });
}

/** Pack every candidate mix with every strategy. Returns rows sorted by cost and the cheapest feasible one. */
export function searchMixes(pods, { catalog = CATALOG, strategies = Object.keys(STRATEGIES), usage = null } = {}) {
  const needGpu = pods.some((p) => p.gpu > 0);
  const rows = candidateMixes(catalog, needGpu).map((m) => {
    const by = {};
    for (const s of strategies) by[s] = packMix(pods, m.types, { strategy: s, usage });
    return { ...m, by };
  });
  let best = null;
  const bestBy = {};
  for (const row of rows) for (const s of strategies) {
    const r = row.by[s];
    if (!r.feasible) continue;
    if (!best || r.costHr < best.r.costHr - 1e-9) best = { mix: row.id, strategy: s, r };
    if (!bestBy[s] || r.costHr < bestBy[s].r.costHr - 1e-9) bestBy[s] = { mix: row.id, strategy: s, r };
  }
  return { rows, best, bestBy };
}

// ---------------------------------------------------------------------------
// Rightsizing

/**
 * VPA-style recommendation: CPU at the chosen percentile of per-pod use plus a
 * margin, memory at the week's maximum plus headroom (memory cannot be throttled,
 * so a low request risks OOM kills and evictions). Rounded up to 10m and 16 MiB.
 */
export function recommend(usage, { cpuPct = 95, cpuMargin = 10, memHeadroom = 20 } = {}) {
  const cpuQ = quantile(usage.cpu, cpuPct / 100);
  const memMax = maxOf(usage.mem);
  return {
    cpuQ, memMax,
    cpu: Math.max(25, Math.ceil((cpuQ * (1 + cpuMargin / 100)) / 10) * 10),
    mem: Math.max(64, Math.ceil((memMax * (1 + memHeadroom / 100)) / 16) * 16),
  };
}

export function rightsize(deps, cfg) {
  const rec = {};
  for (const d of deps) rec[d.id] = recommend(d.usage, cfg);
  return rec;
}

/** Per-team totals: requested, used at the percentile, and the recommendation. */
export function teamRightsizing(deps, rec) {
  const out = {};
  for (const t of TEAMS) out[t] = { team: t, deps: 0, cpuReq: 0, cpuQ: 0, cpuRec: 0, memReq: 0, memMax: 0, memRec: 0, cpuMean: 0 };
  for (const d of deps) {
    const o = out[d.team], n = d.replicas, r = rec[d.id];
    o.deps++;
    o.cpuReq += d.cpu * n; o.cpuQ += r.cpuQ * n; o.cpuRec += r.cpu * n; o.cpuMean += mean(d.usage.cpu) * n;
    o.memReq += d.mem * n; o.memMax += r.memMax * n; o.memRec += r.mem * n;
  }
  return TEAMS.map((t) => out[t]).filter((o) => o.deps).map((o) => ({ ...o, cpuRatio: o.cpuReq / Math.max(1, o.cpuQ), memRatio: o.memReq / Math.max(1, o.memMax) }));
}

// ---------------------------------------------------------------------------
// HPA

/** desired = ceil(current * utilization / target), unchanged inside the tolerance band. */
export function hpaDesired(current, util, target, tolerance = 0.1) {
  if (current <= 0) return current;
  const ratio = util / target;
  if (Math.abs(ratio - 1) <= tolerance) return current;
  return Math.ceil(current * ratio - 1e-9);
}

/**
 * Stabilization as in the HPA controller: scale up to the lowest recommendation in
 * the up window, scale down only to the highest recommendation in the down window.
 * `history` holds { t, desired } entries, newest last.
 */
export function stabilize(history, t, current, desired, upWin, downWin) {
  let up = desired, down = desired;
  for (const h of history) {
    if (t - h.t <= upWin && h.t <= t) up = Math.min(up, h.desired);
    if (t - h.t <= downWin && h.t <= t) down = Math.max(down, h.desired);
  }
  let rec = current;
  if (rec < up) rec = up;
  if (rec > down) rec = down;
  return rec;
}

/** Per-pod CPU demand at minute t, from the 5 minute usage series (linear interpolation). */
function demandAt(d, t) {
  const x = t / STEP_MIN, i = Math.floor(x) % STEPS, j = (i + 1) % STEPS, f = x - Math.floor(x);
  return d.usage.cpu[i] * (1 - f) + d.usage.cpu[j] * f;
}

/** Where each pod on `n` would go if the node were removed (MostAllocated), or null if one has nowhere to go. */
function planMoves(n, nodes, a) {
  const others = nodes.filter((m) => m !== n);
  const shadow = new Map(others.map((m) => [m, { cpu: m.cpu, mem: m.mem, deps: new Map(m.deps), pods: m.pods.length }]));
  const moves = [];
  for (const p of [...n.pods].sort((x, y) => y.cpu - x.cpu)) {
    let dest = null, bs = -Infinity;
    for (const m of others) {
      const sh = shadow.get(m);
      if (sh.cpu + p.cpu > a.cpu || sh.mem + p.mem > a.mem || sh.pods + 1 > a.pods) continue;
      if (p.anti && (sh.deps.get(p.dep) ?? 0) > 0) continue;
      const sc = (sh.cpu + p.cpu) / a.cpu + (sh.mem + p.mem) / a.mem;
      if (sc > bs) { bs = sc; dest = m; }
    }
    if (!dest) return null;
    const sh = shadow.get(dest);
    sh.cpu += p.cpu; sh.mem += p.mem; sh.pods++; sh.deps.set(p.dep, (sh.deps.get(p.dep) ?? 0) + 1);
    moves.push([p, dest]);
  }
  return moves;
}

// ---------------------------------------------------------------------------
// Autoscaling simulation (HPA plus cluster autoscaler), one minute steps

/**
 * Simulate a week for the deployments on one node pool.
 * Pods that cannot be placed on ready nodes are nominated to provisioning nodes or
 * trigger a new node, which is ready after `provisionMin`. A pod runs `podStartMin`
 * after it lands on a ready node. Every 5 minutes the autoscaler marks nodes whose
 * requested CPU and memory are both under `scaleDownUtil` as unneeded and removes
 * one after `scaleDownMin`, if its pods fit on the other nodes.
 */
export function simulateAutoscaling(deps, type, cfg, { target = cfg.hpaTarget, minutes = WEEK_MIN, staticCostHr = 0, sample = 15 } = {}) {
  const a = alloc(type);
  const T = target / 100;
  const st = deps.map((d) => ({ d, spec: d.replicas, pods: [], hist: [] }));
  const nodes = [];
  let nodeSeq = 0, podSeq = 0;
  const mkNode = (t, ready) => {
    const n = newNode(type, ZONES[nodeSeq % ZONES.length], type.id);
    Object.assign(n, { id: nodeSeq++, launched: t, readyAt: ready, unneededSince: null });
    nodes.push(n);
    return n;
  };
  const mkPod = (s) => ({ id: podSeq++, dep: s.d.id, cpu: s.d.cpu, mem: s.d.mem, gpu: 0, anti: s.d.anti, node: null, runAt: Infinity, s });

  // Start at the replicas the HPA wants at Monday 00:00, packed with no delay.
  for (const s of st) {
    if (s.d.hpa) {
      const util = demandAt(s.d, 0) * s.d.replicas / (s.d.replicas * s.d.cpu);
      s.spec = Math.min(s.d.hpaMax, Math.max(s.d.hpaMin, hpaDesired(s.d.replicas, util, T)));
    }
    for (let i = 0; i < s.spec; i++) s.pods.push(mkPod(s));
  }
  const all = st.flatMap((s) => s.pods);
  const init = packPool(all.map((p) => ({ ...p, id: String(p.id).padStart(6, "0"), ref: p })), type, { strategy: "most" });
  for (const n0 of init.nodes) {
    const n = mkNode(0, 0);
    for (const q of n0.pods) { place(n, q.ref); q.ref.node = n; q.ref.runAt = 0; }
  }

  let lastAdd = -Infinity;
  let pendingPodMin = 0, sloRiskMin = 0, nodeMin = 0, maxNodesSeen = 0, scaleUps = 0, scaleDowns = 0, podStarts = 0;
  const series = [];
  let bucket = { replicas: 0, nodes: 0, provisioning: 0, pending: 0, n: 0 };

  const bindPending = (t) => {
    const pending = [];
    for (const s of st) for (const p of s.pods) if (!p.node) pending.push(p);
    if (!pending.length) return;
    pending.sort((p, q) => q.cpu - p.cpu || p.id - q.id);
    for (const p of pending) {
      let best = null, bs = -Infinity;
      // Ready nodes first (MostAllocated), then nodes still provisioning.
      for (const n of nodes) {
        if (n.readyAt > t || !fits(n, p)) continue;
        const sc = score(n, p, "most");
        if (sc > bs) { bs = sc; best = n; }
      }
      if (!best) for (const n of nodes) if (n.readyAt > t && fits(n, p)) { best = n; break; }
      if (!best && nodes.length < cfg.maxNodes && p.cpu <= a.cpu && p.mem <= a.mem) {
        best = mkNode(t, t + cfg.provisionMin);
        lastAdd = t;
        scaleUps++;
      }
      if (!best) continue;
      place(best, p);
      p.node = best;
      p.runAt = Math.max(t, best.readyAt) + cfg.podStartMin;
      podStarts++;
    }
  };

  const removePod = (s, p) => {
    if (p.node) unplace(p.node, p);
    s.pods.splice(s.pods.indexOf(p), 1);
  };

  for (let t = 0; t < minutes; t++) {
    // HPA, every minute.
    for (const s of st) {
      if (!s.d.hpa) continue;
      let running = 0;
      for (const p of s.pods) if (p.runAt <= t) running++;
      if (running > 0) {
        const util = (demandAt(s.d, t) * s.d.replicas) / (running * s.d.cpu);
        const raw = Math.min(s.d.hpaMax, Math.max(s.d.hpaMin, hpaDesired(running, util, T)));
        s.hist.push({ t, desired: raw });
        while (s.hist.length && t - s.hist[0].t > Math.max(cfg.upWin, cfg.downWin)) s.hist.shift();
        s.spec = Math.min(s.d.hpaMax, Math.max(s.d.hpaMin, stabilize(s.hist, t, s.spec, raw, cfg.upWin, cfg.downWin)));
      }
      while (s.pods.length < s.spec) s.pods.push(mkPod(s));
      if (s.pods.length > s.spec) {
        // Remove unscheduled pods first, then not yet running, then the ones on the emptiest nodes.
        const fill = (p) => (p.node ? p.node.cpu / a.cpu + p.node.mem / a.mem : -1);
        const late = (p) => (p.runAt === Infinity ? 1e9 : p.runAt);
        const order = [...s.pods].sort((p, q) => (p.node ? 1 : 0) - (q.node ? 1 : 0) || late(q) - late(p) || fill(p) - fill(q));
        for (const p of order.slice(0, s.pods.length - s.spec)) removePod(s, p);
      }
    }

    bindPending(t);

    // Cluster autoscaler scale down, every 5 minutes. A node is unneeded while its
    // requests are under the threshold and its pods fit on the other ready nodes.
    if (t % 5 === 0) {
      const ready = nodes.filter((n) => n.readyAt <= t);
      for (const n of ready) {
        const u = Math.max(n.cpu / a.cpu, n.mem / a.mem);
        const low = u < cfg.scaleDownUtil / 100 && ready.length > 1;
        // Marked nodes are checked again when they come up for removal.
        if (!low) n.unneededSince = null;
        else if (n.unneededSince == null && planMoves(n, ready, a)) n.unneededSince = t;
      }
      const cand = ready.filter((n) => n.unneededSince != null && t - n.unneededSince >= cfg.scaleDownMin && t - lastAdd >= 10)
        .sort((x, y) => x.pods.length - y.pods.length || x.cpu - y.cpu);
      let removedBusy = false;
      for (const n of cand) {
        if (nodes.length <= 1) break;
        if (n.pods.length && removedBusy) continue;
        const moves = planMoves(n, nodes.filter((m) => m.readyAt <= t), a);
        if (!moves) { n.unneededSince = null; continue; }
        for (const [p, dest] of moves) {
          unplace(n, p);
          place(dest, p);
          p.node = dest;
          p.runAt = t + cfg.podStartMin; // evicted and restarted elsewhere
        }
        nodes.splice(nodes.indexOf(n), 1);
        scaleDowns++;
        if (moves.length) removedBusy = true;
      }
    }

    // Metrics for this minute.
    let pending = 0, replicas = 0;
    for (const s of st) {
      let running = 0;
      for (const p of s.pods) if (p.runAt <= t) running++; else pending++;
      if (s.d.hpa) replicas += s.pods.length;
      const demand = demandAt(s.d, t) * s.d.replicas;
      if (running === 0 ? demand > 0 : demand / running > s.d.cpu) sloRiskMin++;
    }
    pendingPodMin += pending;
    nodeMin += nodes.length;
    maxNodesSeen = Math.max(maxNodesSeen, nodes.length);
    const prov = nodes.filter((n) => n.readyAt > t).length;
    bucket.replicas += replicas; bucket.nodes += nodes.length - prov; bucket.provisioning = Math.max(bucket.provisioning, prov);
    bucket.pending = Math.max(bucket.pending, pending); bucket.n++;
    if (bucket.n === sample) {
      series.push({ t: t - sample + 1, replicas: bucket.replicas / sample, nodes: bucket.nodes / sample, provisioning: bucket.provisioning, pending: bucket.pending });
      bucket = { replicas: 0, nodes: 0, provisioning: 0, pending: 0, n: 0 };
    }
  }
  const nodeHours = nodeMin / 60;
  const hours = minutes / 60;
  const costWeek = nodeHours * type.od + staticCostHr * hours;
  return {
    target, type: type.id, series, pendingPodMin, sloRiskMin, nodeHours, maxNodes: maxNodesSeen, scaleUps, scaleDowns, podStarts,
    costWeek, costMonth: (costWeek / hours) * HOURS_PER_MONTH, avgNodes: nodeHours / hours,
  };
}

// ---------------------------------------------------------------------------
// Spot

/** Disruptions a deployment's PDB allows at once. */
export const allowedDisruptions = (d) => Math.max(0, d.replicas - d.minAvailable);

/**
 * Split pods between on-demand and spot. Stateless, non-GPU deployments whose PDB
 * allows a disruption put `spotPct` of their replicas (rounded down) on spot. With
 * `pdbAware`, a spot node holds at most the PDB's allowed disruptions per deployment,
 * so losing one node never breaks a budget.
 */
export function spotPlan(deps, pods, types, mainType, { spotPct = 50, pdbAware = 1, strategy = "most" } = {}) {
  const spotCount = {};
  for (const d of deps) {
    const ok = d.stateless && !d.gpu && allowedDisruptions(d) > 0 && pods.some((p) => p.dep === d.id && routePods([p], types).byType.get(mainType.id)?.length);
    spotCount[d.id] = ok ? Math.floor((d.replicas * spotPct) / 100) : 0;
  }
  const taken = {};
  const od = [], sp = [];
  for (const p of pods) {
    taken[p.dep] = (taken[p.dep] ?? 0) + 1;
    (taken[p.dep] <= spotCount[p.dep] ? sp : od).push(p);
  }
  const cap = pdbAware ? Object.fromEntries(deps.map((d) => [d.id, Math.max(1, allowedDisruptions(d))])) : null;
  const odPack = packMix(od, types, { strategy });
  const spPack = packPool(sp, mainType, { strategy, spot: true, cap, pool: `${mainType.id}-spot` });
  return { od: odPack, spot: summarize(spPack.nodes, spPack.unschedulable), spotPods: sp.length, spotCount };
}

/** Interruption times for each spot node: a Poisson process at `ratePerDay`. */
export function drawInterruptions(nodeCount, ratePerDay, seed, minutes = WEEK_MIN) {
  const events = [];
  const lam = ratePerDay / 1440;
  for (let i = 0; i < nodeCount; i++) {
    if (lam <= 0) continue;
    const r = mulberry32(subSeed(seed, 5000 + i));
    for (let t = -Math.log(1 - r()) / lam; t < minutes; t += -Math.log(1 - r()) / lam) events.push({ node: i, t: Math.floor(t) });
  }
  return events.sort((x, y) => x.t - y.t || x.node - y.node);
}

/**
 * Replay interruptions against the spot nodes. On a notice the node is cordoned
 * and a replacement launches. The drain evicts a pod only if its PDB allows it
 * right now; pods the PDB blocks are killed when the node terminates at the end of
 * the notice. Each pod is back `provisionMin + podStartMin` after the notice.
 * Breach minutes count minutes a deployment has fewer than minAvailable pods up.
 */
export function simulateSpot(deps, spotNodes, events, { notice = 2, provisionMin = 3, podStartMin = 1, minutes = WEEK_MIN } = {}) {
  const byId = Object.fromEntries(deps.map((d) => [d.id, d]));
  const down = deps.map(() => []); // intervals [from, to)
  let evicted = 0, blocked = 0, podDownMin = 0;
  const backAt = (t) => t + Math.max(notice, provisionMin) + podStartMin;
  const downAt = (dep, t) => down[dep].filter(([a, b]) => a <= t && t < b).length;
  for (const e of events) {
    const n = spotNodes[e.node];
    if (!n) continue;
    const per = {};
    for (const p of n.pods) per[p.dep] = (per[p.dep] ?? 0) + 1;
    for (const [dep, k] of Object.entries(per)) {
      const d = byId[dep];
      const allowed = Math.max(0, d.replicas - downAt(dep, e.t) - d.minAvailable);
      const ev = Math.min(k, allowed);
      evicted += ev;
      blocked += k - ev;
      for (let i = 0; i < ev; i++) down[dep].push([e.t, backAt(e.t)]);
      for (let i = 0; i < k - ev; i++) down[dep].push([e.t + notice, backAt(e.t)]);
    }
  }
  let breachMin = 0;
  const breachByDep = {};
  for (const d of deps) {
    if (!down[d.id].length) continue;
    const diff = new Int16Array(minutes + 1);
    for (const [a, b] of down[d.id]) { diff[Math.min(minutes, a)]++; diff[Math.min(minutes, b)]--; podDownMin += Math.min(minutes, b) - Math.min(minutes, a); }
    let cur = 0, m = 0;
    for (let t = 0; t < minutes; t++) { cur += diff[t]; if (d.replicas - cur < d.minAvailable) m++; }
    if (m) breachByDep[d.id] = m;
    breachMin += m;
  }
  return { interruptions: events.length, evicted, blocked, podDownMin, breachMin, breachByDep };
}

/** Spot plan, interruptions, and savings against the all on-demand packing. */
export function spotAnalysis(deps, pods, types, mainType, cfg, baseline, { spotPct = cfg.spotPct, pdbAware = cfg.pdbAware } = {}) {
  const plan = spotPlan(deps, pods, types, mainType, { spotPct, pdbAware, strategy: cfg.strategy });
  const events = drawInterruptions(plan.spot.count, cfg.spotRatePct / 100, cfg.seed);
  const sim = simulateSpot(deps, plan.spot.nodes, events, cfg);
  // Replacement nodes run alongside the old one during the notice.
  const overlapHr = (events.length * Math.min(cfg.notice, cfg.provisionMin)) / 60;
  const weekHr = WEEK_MIN / 60;
  const costHr = plan.od.costHr + plan.spot.costHr + (overlapHr * mainType.spot) / weekHr;
  return {
    spotPct, pdbAware, plan, events, ...sim,
    costHr, costMonth: costHr * HOURS_PER_MONTH,
    savingsMonth: (baseline.costHr - costHr) * HOURS_PER_MONTH,
    savingsPct: baseline.costHr ? 1 - costHr / baseline.costHr : 0,
  };
}

// ---------------------------------------------------------------------------
// Cost allocation

// One vCPU is priced like 7.5 GiB of memory, and one GPU like 200 GiB, when a node's
// price is split between the resources (close to list price ratios).
export const CPU_GIB_RATIO = 7.5;
export const GPU_GIB_RATIO = 200;

const units = (cpu, mem, gpu = 0) => (cpu / 1000) * CPU_GIB_RATIO + mem / 1024 + gpu * GPU_GIB_RATIO;

/**
 * Split each node's hourly price into: pods by request (or by mean use), system
 * overhead (kubelet, OS, eviction threshold, DaemonSets), and idle allocatable.
 * The parts sum to the cluster total.
 */
export function costAllocation(nodes, deps, by = "requests") {
  const byTeam = Object.fromEntries(TEAMS.map((t) => [t, 0]));
  let system = 0, idle = 0, total = 0;
  const useOf = deps.map((d) => ({ cpu: mean(d.usage.cpu), mem: mean(d.usage.mem) }));
  for (const n of nodes) {
    const price = n.spot ? n.typeObj.spot : n.typeObj.od;
    const cap = units(n.a.cpuCap, n.a.memCap, n.typeObj.gpu);
    const u = price / cap;
    const sys = u * units(n.a.kubeCpu + n.a.dsCpu, n.a.kubeMem + n.a.evictMem + n.a.dsMem);
    let pods = 0;
    for (const p of n.pods) {
      const q = by === "usage" ? { cpu: Math.min(useOf[p.dep].cpu, n.a.cpu), mem: useOf[p.dep].mem } : p;
      const c = u * units(q.cpu, q.mem, p.gpu || 0);
      byTeam[p.team ?? deps[p.dep].team] += c;
      pods += c;
    }
    system += sys;
    idle += price - sys - pods;
    total += price;
  }
  return { byTeam, system, idle, total };
}

// ---------------------------------------------------------------------------
// Everything for one config

// Results are cached by the inputs each stage depends on, so a slider only reruns its own stage.
const CACHE = new Map();
function memo(key, fn) {
  if (CACHE.has(key)) return CACHE.get(key);
  const v = fn();
  CACHE.set(key, v);
  if (CACHE.size > 120) CACHE.delete(CACHE.keys().next().value);
  return v;
}
const keyOf = (cfg, ks) => ks.map((k) => `${k}=${cfg[k]}`).join("&");

export function evaluate(cfg, opts = {}) {
  const k0 = keyOf(cfg, ["preset", "seed"]);
  const base = memo(`base|${k0}`, () => {
    const deps = generateWorkloads(cfg.preset, cfg.seed);
    const usage = deps.map((d) => ({ cpu: mean(d.usage.cpu), mem: mean(d.usage.mem) }));
    const pods = podsOf(deps);
    return { deps, usage, pods, search: searchMixes(pods, { usage }) };
  });
  const { deps, usage, pods, search } = base;
  const mixId = cfg.mix === "auto" ? search.bestBy[cfg.strategy].mix : cfg.mix;
  const row = search.rows.find((r) => r.id === mixId);
  const current = row.by[cfg.strategy];
  const types = row.types;
  // The main pool is the non-GPU type with the most nodes.
  const plain = types.filter((t) => t.gpu === 0);
  const mainType = plain.reduce((b, t) => ((current.counts[t.id] ?? 0) > (current.counts[b.id] ?? 0) ? t : b), plain[0]);
  const k1 = `${k0}|${mixId}|${cfg.strategy}`;

  // Rightsizing.
  const rs = memo(`rs|${k1}|${keyOf(cfg, ["cpuPct", "cpuMargin", "memHeadroom"])}`, () => {
    const rec = rightsize(deps, cfg);
    const rsPods = podsOf(deps, rec);
    return {
      rec,
      rsPack: packMix(rsPods, types, { strategy: cfg.strategy, usage }),
      rsSearch: searchMixes(rsPods, { usage, strategies: [cfg.strategy] }),
      teams: teamRightsizing(deps, rec),
    };
  });

  // Autoscaling: deployments routed to the main pool, other pools at a fixed cost.
  const { byType } = routePods(pods, types);
  const simDeps = deps.filter((d) => byType.get(mainType.id).some((p) => p.dep === d.id));
  const staticCostHr = current.nodes.filter((n) => n.type !== mainType.id).reduce((s, n) => s + n.typeObj.od, 0);
  const targets = HPA_TARGETS.includes(cfg.hpaTarget) ? HPA_TARGETS : [...HPA_TARGETS, cfg.hpaTarget].sort((x, y) => x - y);
  const kh = `${k1}|${keyOf(cfg, ["upWin", "downWin", "provisionMin", "podStartMin", "scaleDownUtil", "scaleDownMin", "maxNodes"])}`;
  const hpa = opts.skipAutoscale ? [] : targets.map((tg) => memo(`hpa|${kh}|${tg}`, () => simulateAutoscaling(simDeps, mainType, cfg, { target: tg, staticCostHr })));

  // Spot.
  const ks = `${k1}|${keyOf(cfg, ["spotRatePct", "notice", "provisionMin", "podStartMin"])}`;
  const spotAt = (f, aware) => memo(`spot|${ks}|${f}|${aware}`, () => spotAnalysis(deps, pods, types, mainType, cfg, current, { spotPct: f, pdbAware: aware }));
  const spot = spotAt(cfg.spotPct, cfg.pdbAware);
  const spotTable = opts.skipSpotTable ? [] : [0, 25, 50, 75, 100].map((f) => ({ f, aware: spotAt(f, 1), naive: spotAt(f, 0) }));

  const allocReq = costAllocation(current.nodes, deps, "requests");
  const allocUse = costAllocation(current.nodes, deps, "usage");
  const rsAlloc = costAllocation(rs.rsPack.nodes, deps, "requests");

  return { cfg, deps, usage, pods, search, mixId, row, current, types, mainType, ...rs, simDeps, staticCostHr, hpa, spot, spotTable, allocReq, allocUse, rsAlloc };
}

// ---------------------------------------------------------------------------
// Formatting

export const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "n/a");
export const fmtMoney = (n) => (Number.isFinite(n) ? `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}` : "n/a");
export const fmtMoney2 = (n) => `$${n.toFixed(2)}`;
export const pct = (x, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
export const cores = (m) => (m >= 10000 ? `${fmtInt(m / 1000)}` : (m / 1000).toFixed(1));
export const gib = (mib) => (mib >= 10240 ? fmtInt(mib / 1024) : (mib / 1024).toFixed(1));
export function fmtMin(m) {
  if (!Number.isFinite(m)) return "n/a";
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 10 ? `${h.toFixed(1)} h` : `${fmtInt(h)} h`;
}
export function fmtWeekTime(t) {
  const d = Math.floor(t / 1440) % 7, m = t % 1440;
  return `${DAYS[d]} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
export const mixLabel = (id) => id.split("+").join(" + ");

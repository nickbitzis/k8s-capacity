import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CATALOG, DAEMONSETS, DEFAULTS, HOURS_PER_MONTH, PRESETS, STEPS, TEAMS, TYPE, WEEK_MIN, allocatable, allowedDisruptions,
  candidateMixes, costAllocation, decodeConfig, diurnal, drawInterruptions, encodeConfig, evaluate, fits, generateWorkloads,
  hpaDesired, makeConfig, mulberry32, packMix, packPool, podsOf, quantile, recommend, routePods, searchMixes, simulateAutoscaling,
  simulateSpot, spotPlan, stabilize, summarize, teamRightsizing,
} from "../src/capacity.js";

const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// A node type with explicit allocatable and no system overhead, for hand-checked cases.
const plainType = (id, cpu, mem, od, gpu = 0) => ({ id, family: "gp", vcpu: cpu / 1000, memGiB: mem / 1024, gpu, od, spot: od * 0.3, alloc: { cpu, mem, gpu, pods: 110, cpuCap: cpu, memCap: mem, kubeCpu: 0, kubeMem: 0, evictMem: 0, dsCpu: 0, dsMem: 0 } });
const pod = (id, dep, cpu, mem, extra = {}) => ({ id, dep, team: "storefront", cpu, mem, gpu: 0, anti: false, spread: false, ...extra });

// A tiny deployment for the simulators: per-pod usage is a constant or a function of the 5 minute step.
function dep(id, over = {}) {
  const d = { id, name: `d${id}`, team: "storefront", kind: "web", replicas: 2, cpu: 500, mem: 512, gpu: 0, anti: false, spread: false, stateless: true, hpa: true, hpaMin: 1, hpaMax: 20, minAvailable: 1, ...over };
  const f = typeof over.load === "function" ? over.load : () => over.load ?? 250;
  const cpu = new Float32Array(STEPS), mem = new Float32Array(STEPS);
  for (let s = 0; s < STEPS; s++) { cpu[s] = f(s); mem[s] = d.mem * 0.5; }
  d.usage = { cpu, mem };
  return d;
}
const simCfg = (over = {}) => ({ hpaTarget: 50, upWin: 0, downWin: 5, provisionMin: 3, podStartMin: 1, scaleDownUtil: 50, scaleDownMin: 10, maxNodes: 50, ...over });

// --- Randomness and statistics -----------------------------------------------

test("mulberry32 is deterministic and seed dependent", () => {
  const a = mulberry32(3), b = mulberry32(3), c = mulberry32(4);
  const xs = Array.from({ length: 8 }, a);
  assert.deepEqual(xs, Array.from({ length: 8 }, b));
  assert.notDeepEqual(xs, Array.from({ length: 8 }, c));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test("quantile interpolates and hits the ends", () => {
  assert.equal(quantile([5, 1, 4, 2, 3], 0.5), 3);
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([7, 1, 9], 1), 9);
  assert.equal(quantile([7, 1, 9], 0), 1);
  const xs = Array.from({ length: 101 }, (_, i) => i);
  assert.equal(quantile(xs, 0.95), 95);
});

// --- Allocatable --------------------------------------------------------------

test("allocatable on a 4 vCPU, 16 GiB node follows the reservation tiers", () => {
  const a = allocatable(TYPE["gp-4"]);
  // CPU: 6% of the first core, 1% of the second, 0.5% of cores 3 and 4 = 60 + 10 + 10.
  close(a.kubeCpu, 80, 1e-9);
  // Memory: 25% of 4 GiB, 20% of the next 4, 10% of the next 8 = 1024 + 819.2 + 819.2.
  close(a.kubeMem, 2662.4, 1e-9);
  assert.equal(a.dsCpu, 350);
  assert.equal(a.dsMem, 500);
  assert.equal(a.cpu, 4000 - 80 - 350);
  assert.equal(a.mem, Math.floor(16384 - 2662.4 - 100 - 500));
  assert.equal(a.pods, 110 - DAEMONSETS.length);
});

test("larger nodes keep a larger share of their capacity, and memory tiers flatten above 16 GiB", () => {
  const share = (id) => { const a = allocatable(TYPE[id]); return a.cpu / a.cpuCap; };
  assert.ok(share("gp-2") < share("gp-4") && share("gp-4") < share("gp-16") && share("gp-16") < share("gp-32"));
  const m = allocatable(TYPE["mem-16"]); // 128 GiB: 1024 + 819.2 + 819.2 + 6% of 112 GiB
  close(m.kubeMem, 1024 + 819.2 + 819.2 + 0.06 * 112 * 1024, 1e-6);
  for (const t of CATALOG) { const a = allocatable(t); assert.ok(a.cpu > 0 && a.mem > 0 && a.cpu < a.cpuCap && a.mem < a.memCap); }
});

test("catalog prices are illustrative but ordered: spot is cheaper, memory nodes cost more per vCPU", () => {
  for (const t of CATALOG) assert.ok(t.spot < t.od * 0.5);
  assert.ok(TYPE["mem-8"].od > TYPE["gp-8"].od && TYPE["gp-8"].od > TYPE["cpu-8"].od);
  close(TYPE["gp-16"].od, 2 * TYPE["gp-8"].od, 1e-3);
  assert.ok(TYPE["gpu-8"].gpu === 1 && TYPE["gpu-8"].od > TYPE["mem-8"].od);
});

// --- Workloads ----------------------------------------------------------------

test("workloads are about 60 deployments over 8 teams, reproducible from the seed", () => {
  for (const id of Object.keys(PRESETS)) {
    const a = generateWorkloads(id, 7), b = generateWorkloads(id, 7);
    assert.equal(a.length, 60);
    assert.deepEqual(a.map((d) => [d.name, d.cpu, d.mem, d.replicas]), b.map((d) => [d.name, d.cpu, d.mem, d.replicas]));
    assert.deepEqual([...a[0].usage.cpu.slice(0, 50)], [...b[0].usage.cpu.slice(0, 50)]);
    assert.equal(new Set(a.map((d) => d.name)).size, a.length);
    for (const d of a) { assert.ok(TEAMS.includes(d.team)); assert.equal(d.usage.cpu.length, STEPS); assert.ok(d.minAvailable <= d.replicas); }
  }
  assert.notDeepEqual(generateWorkloads("steady", 7).map((d) => d.cpu), generateWorkloads("steady", 8).map((d) => d.cpu));
});

test("usage has a daily cycle, and the memory preset asks for far more memory", () => {
  assert.ok(diurnal(19.5 * 60) > 0.9 && diurnal(4 * 60) < 0.2);
  const web = generateWorkloads("steady", 7).find((d) => d.kind === "web");
  const at = (h) => web.usage.cpu[(h * 60) / 5];
  assert.ok(at(19) > at(4) * 1.5, "evening peak above the night trough");
  const mem = (id) => podsOf(generateWorkloads(id, 7)).reduce((s, p) => s + p.mem, 0);
  assert.ok(mem("memory") > 1.5 * mem("steady"));
  assert.ok(generateWorkloads("steady", 7).some((d) => d.gpu > 0));
});

// --- Bin packing ----------------------------------------------------------------

test("packing never exceeds a node's allocatable CPU, memory, GPU, or pod count", () => {
  const deps = generateWorkloads("spiky", 3);
  const pods = podsOf(deps);
  for (const s of ["ffd", "most", "least"]) {
    const r = packMix(pods, [TYPE["gp-8"], TYPE["mem-8"], TYPE["gpu-8"]], { strategy: s });
    assert.ok(r.feasible);
    assert.equal(r.nodes.reduce((n, x) => n + x.pods.length, 0), pods.length);
    for (const n of r.nodes) {
      assert.ok(n.cpu <= n.a.cpu && n.mem <= n.a.mem && n.gpu <= n.a.gpu && n.pods.length <= n.a.pods);
      close(n.cpu, n.pods.reduce((s2, p) => s2 + p.cpu, 0), 1e-9);
    }
  }
});

test("required anti-affinity puts each replica on its own node", () => {
  const t = plainType("big", 16000, 65536, 1);
  const pods = Array.from({ length: 5 }, (_, i) => pod(`a${i}`, 1, 100, 100, { anti: true }));
  const r = packPool(pods, t, { strategy: "most" });
  assert.equal(r.nodes.length, 5);
  for (const n of r.nodes) assert.equal(n.pods.length, 1);
  // Without anti-affinity they share one node.
  assert.equal(packPool(pods.map((p) => ({ ...p, anti: false })), t).nodes.length, 1);
});

test("zone spread keeps a deployment within one pod of even across zones", () => {
  const t = plainType("n", 4000, 8192, 1);
  const pods = Array.from({ length: 7 }, (_, i) => pod(`s${i}`, 2, 500, 512, { spread: true }));
  const r = packPool(pods, t, { strategy: "most" });
  const per = {};
  for (const n of r.nodes) for (const p of n.pods) per[n.zone] = (per[n.zone] ?? 0) + 1;
  const counts = Object.values(per);
  assert.equal(counts.length, 3);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
});

test("MostAllocated packs onto the fuller node and LeastAllocated onto the emptier one", () => {
  const t = plainType("n", 4000, 4000, 1);
  // Two existing nodes: one 60% used, one 20% used.
  const mk = () => {
    const a = packPool([pod("a", 1, 2400, 2400)], t).nodes;
    a.push(...packPool([pod("b", 2, 800, 800)], t).nodes);
    return a;
  };
  const most = packPool([pod("c", 3, 400, 400)], t, { strategy: "most", nodes: mk() }).nodes;
  const least = packPool([pod("c", 3, 400, 400)], t, { strategy: "least", nodes: mk() }).nodes;
  const where = (nodes) => nodes.findIndex((n) => n.pods.some((p) => p.id === "c"));
  assert.equal(where(most), 0, "MostAllocated picks the fuller node");
  assert.equal(where(least), 1, "LeastAllocated picks the emptier node");
});

test("stranded capacity: free CPU on a memory-full node is stranded, and free memory on a CPU-full node", () => {
  const t = plainType("n", 4000, 8000, 1);
  // Memory-heavy pods fill memory and leave 3 cores free.
  const memFull = packPool([pod("m1", 1, 500, 4000), pod("m2", 2, 500, 3900)], t).nodes;
  let s = summarize(memFull);
  assert.equal(s.strandedCpu, 3000);
  assert.equal(s.strandedMem, 0);
  // CPU-heavy pods fill CPU and leave 6 GB free.
  const cpuFull = packPool([pod("c1", 3, 2000, 1000), pod("c2", 4, 1800, 1000)], t).nodes;
  s = summarize(cpuFull);
  assert.equal(s.strandedMem, 6000);
  assert.equal(s.strandedCpu, 0);
  // A balanced half-full node strands nothing.
  assert.equal(summarize(packPool([pod("b", 5, 2000, 4000)], t).nodes).strandedCpu, 0);
});

test("pods that fit no node type are reported as unschedulable", () => {
  const r = packMix([pod("huge", 1, 500, 40 * 1024)], [TYPE["gp-4"]]);
  assert.equal(r.feasible, false);
  assert.equal(r.unschedulable.length, 1);
  assert.equal(packMix([pod("huge", 1, 500, 40 * 1024)], [TYPE["mem-8"]]).feasible, true);
});

test("routing sends each pod to the pool where its dominant resource is cheapest, and GPU pods to GPU nodes", () => {
  const types = [TYPE["cpu-8"], TYPE["mem-8"], TYPE["gpu-8"]];
  const { byType } = routePods([pod("c", 1, 2000, 1024), pod("m", 2, 250, 8192), pod("g", 3, 3000, 16384, { gpu: 1 })], types);
  assert.deepEqual(byType.get("cpu-8").map((p) => p.id), ["c"]);
  assert.deepEqual(byType.get("mem-8").map((p) => p.id), ["m"]);
  assert.deepEqual(byType.get("gpu-8").map((p) => p.id), ["g"]);
});

test("cheapest mix search finds the known optimum on a small case", () => {
  // Four pods of 3 cores and 2 GiB. A holds 1 per node (4 x $0.20 = $0.80),
  // B holds 2 (2 x $0.38 = $0.76), C holds 5 but costs $0.90. B is optimal.
  const A = plainType("A", 4000, 8192, 0.2), B = plainType("B", 8000, 16384, 0.38), C = plainType("C", 16000, 32768, 0.9);
  const pods = Array.from({ length: 4 }, (_, i) => pod(`p${i}`, i, 3000, 2048));
  const mixes = candidateMixes([A, B, C], false);
  assert.equal(mixes.length, 3);
  const { best, rows } = searchMixes(pods, { catalog: [A, B, C] });
  assert.equal(best.mix, "B");
  close(best.r.costHr, 0.76, 1e-9);
  close(rows.find((r) => r.id === "A").by.ffd.costHr, 0.8, 1e-9);
  close(rows.find((r) => r.id === "C").by.ffd.costHr, 0.9, 1e-9);
});

test("candidate mixes cover every single type and general or compute plus memory pairs", () => {
  const ms = candidateMixes();
  const plain = CATALOG.filter((t) => !t.gpu);
  const gpOrCpu = plain.filter((t) => t.family !== "mem").length, mem = plain.filter((t) => t.family === "mem").length;
  assert.equal(ms.length, plain.length + gpOrCpu * mem);
  for (const m of ms) assert.ok(m.types.some((t) => t.gpu > 0), "GPU pool is always available");
});

// --- Rightsizing ----------------------------------------------------------------

test("rightsizing uses the CPU percentile plus margin and the memory maximum plus headroom", () => {
  const cpu = Float32Array.from({ length: 100 }, (_, i) => (i + 1) * 10); // 10..1000
  const mem = Float32Array.from({ length: 100 }, (_, i) => 500 + i); // max 599
  const r = recommend({ cpu, mem }, { cpuPct: 95, cpuMargin: 10, memHeadroom: 20 });
  close(r.cpuQ, quantile(cpu, 0.95), 1e-9);
  assert.equal(r.cpu, Math.ceil((r.cpuQ * 1.1) / 10) * 10);
  assert.equal(r.memMax, 599);
  assert.equal(r.mem, Math.ceil((599 * 1.2) / 16) * 16);
  // A higher percentile never lowers the recommendation; floors apply to idle pods.
  assert.ok(recommend({ cpu, mem }, { cpuPct: 99 }).cpu >= r.cpu);
  const idle = recommend({ cpu: new Float32Array(10).fill(1), mem: new Float32Array(10).fill(1) });
  assert.deepEqual([idle.cpu, idle.mem], [25, 64]);
});

test("rightsizing lowers node count and cost, and flags the most over-requested team", () => {
  const R = evaluate(makeConfig({ preset: "steady" }), { skipAutoscale: true, skipSpotTable: true });
  assert.ok(R.rsPack.count < R.current.count);
  assert.ok(R.rsPack.costHr < R.current.costHr);
  const worst = [...R.teams].sort((a, b) => b.cpuRatio - a.cpuRatio)[0];
  assert.equal(worst.team, "catalog");
  assert.ok(worst.cpuRatio > 3);
  const tr = teamRightsizing(R.deps, R.rec);
  assert.equal(tr.reduce((s, t) => s + t.cpuReq, 0), R.pods.reduce((s, p) => s + p.cpu, 0));
});

// --- HPA ------------------------------------------------------------------------

test("HPA desired replicas = ceil(current * utilization / target)", () => {
  assert.equal(hpaDesired(4, 0.9, 0.5), 8); // 4 * 1.8 = 7.2 -> 8
  assert.equal(hpaDesired(10, 0.35, 0.7), 5);
  assert.equal(hpaDesired(3, 0.71, 0.7), 3); // inside the 10% tolerance
  assert.equal(hpaDesired(3, 0.78, 0.7), 4); // 1.11 ratio is outside it
  assert.equal(hpaDesired(5, 0.5, 0.5), 5);
  assert.equal(hpaDesired(0, 1, 0.5), 0);
});

test("stabilization: scale up at once, scale down only to the highest recent recommendation", () => {
  const hist = [{ t: 0, desired: 10 }, { t: 2, desired: 6 }, { t: 4, desired: 4 }];
  // Down window 5: the max over the window is 10, so no scale down yet.
  assert.equal(stabilize(hist, 4, 10, 4, 0, 5), 10);
  // Once the 10 falls out of the window, it can drop to 6.
  assert.equal(stabilize(hist, 6, 10, 4, 0, 5), 6);
  // With no down window, it follows the recommendation.
  assert.equal(stabilize(hist, 4, 10, 4, 0, 0), 4);
  // Scale up with a zero up window is immediate.
  assert.equal(stabilize(hist.slice(0, 2), 4, 4, 12, 0, 5), 12);
  // An up window takes the lowest recent recommendation.
  assert.equal(stabilize([{ t: 3, desired: 7 }], 4, 4, 12, 3, 5), 7);
});

test("HPA in the simulation scales out for a load step and back in after the down window", () => {
  // Per-pod usage 250m at 2 replicas until 10:00 Monday, then 4 times as much.
  const step = (s) => (s * 5 >= 600 && s * 5 < 900 ? 1000 : 250);
  const d = dep(0, { load: step, hpaMax: 40 });
  const r = simulateAutoscaling([d], TYPE["gp-8"], simCfg({ downWin: 30 }), { target: 50, minutes: 1440, sample: 1 });
  const at = (t) => r.series[t].replicas;
  assert.equal(at(500), 2); // 500m total at 50% of 500m per pod = 2
  assert.ok(at(620) >= 8, `scaled out to ${at(620)}`); // 2000m / 250m target per pod = 8
  assert.ok(at(910) >= 8, "still out inside the down window");
  assert.equal(at(1000), 2);
});

// --- Cluster autoscaler ---------------------------------------------------------

test("cluster autoscaler: pending pods wait for the provisioning delay, then run", () => {
  // One pod per node (anti-affinity), 2 replicas, then a jump that needs 6.
  const d = dep(0, { anti: true, load: (s) => (s * 5 >= 100 ? 750 : 250), hpaMax: 10 });
  const r = simulateAutoscaling([d], TYPE["gp-4"], simCfg({ provisionMin: 4, podStartMin: 1 }), { target: 50, minutes: 200, sample: 1 });
  const t0 = r.series.findIndex((x) => x.pending > 0);
  assert.ok(t0 > 80 && t0 <= 100, `scale out starts at ${t0}`);
  assert.equal(r.series[t0 - 1].nodes, 2);
  assert.ok(r.series[t0].provisioning >= 1, "nodes launched at once");
  assert.equal(r.series[t0 + 3].nodes, 2, "not ready before the delay");
  assert.ok(r.series[t0 + 4].nodes > 2, "ready after 4 minutes");
  assert.equal(r.series[150].nodes, 6);
  assert.equal(r.series[150].pending, 0);
  assert.ok(r.pendingPodMin >= 4 * 5, "each new pod waits at least the delay plus start");
});

test("cluster autoscaler removes underutilized nodes only after the cooldown", () => {
  // Small anti-affinity pods: every node is under 50% but none can be emptied while 6 replicas need 6 nodes.
  const d = dep(0, { anti: true, load: (s) => (s * 5 < 60 ? 750 : 250), hpaMax: 10, hpaMin: 2 });
  const r = simulateAutoscaling([d], TYPE["gp-4"], simCfg({ downWin: 0, scaleDownMin: 20 }), { target: 50, minutes: 240, sample: 1 });
  assert.equal(r.series[30].nodes, 6);
  const drop = r.series.findIndex((x) => x.replicas === 2);
  assert.ok(drop > 50 && drop <= 60, `replicas drop at ${drop}`);
  assert.equal(r.series[drop + 15].nodes, 6, "still there inside the cooldown");
  assert.equal(r.series[drop + 35].nodes, 2, "removed once the cooldown passes");
  assert.equal(r.scaleDowns, 4);
});

test("a higher HPA target uses fewer node hours and carries more SLO risk", () => {
  const cfg = makeConfig({ preset: "spiky" });
  const R = evaluate(cfg, { skipSpotTable: true });
  const [h50, h70, h85] = R.hpa;
  assert.deepEqual(R.hpa.map((h) => h.target), [50, 70, 85]);
  assert.ok(h50.nodeHours > h70.nodeHours && h70.nodeHours > h85.nodeHours);
  assert.ok(h50.sloRiskMin < h85.sloRiskMin);
  assert.ok(h50.costMonth > h85.costMonth);
});

// --- Spot -----------------------------------------------------------------------

test("PDB-aware spot placement keeps each node within the allowed disruptions", () => {
  const deps = generateWorkloads("steady", 7);
  const pods = podsOf(deps);
  const types = [TYPE["cpu-16"], TYPE["mem-8"], TYPE["gpu-8"]];
  const plan = spotPlan(deps, pods, types, TYPE["cpu-16"], { spotPct: 100, pdbAware: 1 });
  assert.ok(plan.spotPods > 50);
  for (const n of plan.spot.nodes) for (const [id, k] of n.deps) assert.ok(k <= Math.max(1, allowedDisruptions(deps[id])));
  for (const d of deps) if (!d.stateless || d.gpu) assert.equal(plan.spotCount[d.id], 0);
  assert.equal(plan.od.nodes.reduce((s, n) => s + n.pods.length, 0) + plan.spotPods, pods.length);
});

test("a spot interruption respects PDBs: allowed pods are evicted, blocked ones count as forced", () => {
  // 4 replicas, minAvailable 3: one disruption allowed.
  const d = dep(0, { replicas: 4, minAvailable: 3 });
  const t = plainType("n", 8000, 16384, 1);
  const pods = Array.from({ length: 4 }, (_, i) => pod(`p${i}`, 0, 500, 512));
  const aware = packPool(pods, t, { spot: true, cap: { 0: 1 } }).nodes;
  assert.equal(aware.length, 4);
  let r = simulateSpot([d], aware, [{ node: 0, t: 100 }], { notice: 2, provisionMin: 3, podStartMin: 1, minutes: 300 });
  assert.equal(r.evicted, 1);
  assert.equal(r.blocked, 0);
  assert.equal(r.breachMin, 0);
  assert.equal(r.podDownMin, 4); // back at 100 + max(2, 3) + 1
  // All four on one node: the PDB blocks three evictions and the budget is broken.
  const naive = packPool(pods, t, { spot: true }).nodes;
  assert.equal(naive.length, 1);
  r = simulateSpot([d], naive, [{ node: 0, t: 100 }], { notice: 2, provisionMin: 3, podStartMin: 1, minutes: 300 });
  assert.equal(r.evicted, 1);
  assert.equal(r.blocked, 3);
  assert.equal(r.breachMin, 2); // three pods killed at 102, all back at 104
});

test("overlapping interruptions on two nodes can still break a PDB, separate ones cannot", () => {
  const d = dep(0, { replicas: 4, minAvailable: 3 });
  const t = plainType("n", 8000, 16384, 1);
  const nodes = packPool(Array.from({ length: 4 }, (_, i) => pod(`p${i}`, 0, 500, 512)), t, { spot: true, cap: { 0: 1 } }).nodes;
  const opts = { notice: 2, provisionMin: 3, podStartMin: 1, minutes: 300 };
  assert.equal(simulateSpot([d], nodes, [{ node: 0, t: 100 }, { node: 1, t: 200 }], opts).breachMin, 0);
  const r = simulateSpot([d], nodes, [{ node: 0, t: 100 }, { node: 1, t: 101 }], opts);
  assert.equal(r.blocked, 1);
  assert.ok(r.breachMin > 0);
});

test("interruptions are a seeded Poisson process at the given rate", () => {
  const a = drawInterruptions(200, 0.05, 7), b = drawInterruptions(200, 0.05, 7);
  assert.deepEqual(a, b);
  // 200 nodes x 7 days x 5% = 70 expected.
  assert.ok(a.length > 45 && a.length < 95, `${a.length} events`);
  for (const e of a) assert.ok(e.t >= 0 && e.t < WEEK_MIN);
  assert.equal(drawInterruptions(10, 0, 7).length, 0);
});

test("more spot saves more, and PDB-aware placement avoids breaches the naive one has", () => {
  const R = evaluate(makeConfig({ preset: "steady" }), { skipAutoscale: true });
  const s = R.spotTable;
  assert.equal(s[0].aware.savingsMonth, 0);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].aware.savingsMonth > s[i - 1].aware.savingsMonth);
  for (const row of s) assert.equal(row.aware.breachMin, 0);
  assert.ok(s.at(-1).naive.breachMin > 0);
});

// --- Cost allocation --------------------------------------------------------------

test("cost allocation by requests and by usage both sum to the cluster total", () => {
  const R = evaluate(makeConfig({ preset: "memory" }), { skipAutoscale: true, skipSpotTable: true });
  for (const a of [R.allocReq, R.allocUse]) {
    const teams = Object.values(a.byTeam).reduce((s, x) => s + x, 0);
    close(teams + a.system + a.idle, a.total, 1e-6);
    close(a.total, R.current.costHr, 1e-6);
    assert.ok(a.idle >= 0 && a.system > 0);
  }
  // Usage is below requests, so idle by usage is larger.
  assert.ok(R.allocUse.idle > R.allocReq.idle);
});

test("cost allocation on one hand-checked node", () => {
  // 4 vCPU and 8 GiB at $0.62/h: 4 x 7.5 + 8 = 38 units, so $0.01632 per unit.
  const t = plainType("n", 4000, 8192, 0.38);
  const nodes = packPool([pod("a", 0, 2000, 4096)], t).nodes;
  const deps = [{ team: "storefront", usage: { cpu: new Float32Array([1000]), mem: new Float32Array([2048]) } }];
  const byReq = costAllocation(nodes, deps, "requests");
  close(byReq.byTeam.storefront, (0.38 * (2 * 7.5 + 4)) / 38, 1e-9);
  close(byReq.idle, 0.38 / 2, 1e-9);
  const byUse = costAllocation(nodes, deps, "usage");
  close(byUse.byTeam.storefront, (0.38 * (7.5 + 2)) / 38, 1e-9);
  assert.equal(byReq.system, 0);
});

// --- Whole run, config, and docs ----------------------------------------------------

test("evaluate is deterministic and the auto mix is the cheapest feasible for the strategy", () => {
  const cfg = makeConfig({ preset: "spiky" });
  const a = evaluate(cfg, { skipAutoscale: true, skipSpotTable: true });
  const cheapest = Math.min(...a.search.rows.filter((r) => r.by[cfg.strategy].feasible).map((r) => r.by[cfg.strategy].costHr));
  close(a.current.costHr, cheapest, 1e-9);
  close(a.current.costMonth, a.current.costHr * HOURS_PER_MONTH, 1e-9);
  const b = evaluate(makeConfig({ preset: "spiky" }), { skipAutoscale: true, skipSpotTable: true });
  assert.equal(a.current.count, b.current.count);
});

test("config clamps bad values and round-trips through the URL hash", () => {
  const cfg = makeConfig({ preset: "memory", hpaTarget: 85, spotPct: 140, strategy: "nope", mix: "gp-8+mem-8" });
  assert.equal(cfg.spotPct, 100);
  assert.equal(cfg.strategy, DEFAULTS.strategy);
  const hash = encodeConfig(cfg);
  assert.ok(hash.startsWith("preset=memory"));
  assert.deepEqual(decodeConfig(`#${hash}`), cfg);
  assert.equal(encodeConfig(makeConfig({ preset: "steady" })), "preset=steady");
  assert.equal(makeConfig({ mix: "bogus" }).mix, "auto");
  assert.equal(decodeConfig("#preset=zzz").preset, "steady");
});

test("fits respects a per-deployment cap", () => {
  const t = plainType("n", 8000, 8000, 1);
  const n = packPool([pod("a", 1, 100, 100)], t).nodes[0];
  assert.ok(fits(n, pod("b", 1, 100, 100)));
  assert.ok(!fits(n, pod("b", 1, 100, 100), { 1: 1 }));
  assert.ok(!fits(n, pod("c", 2, 8000, 100)));
});

test("the Karpenter example lists the recommended instance types and matches the simulator's delays", () => {
  const yaml = readFileSync(new URL("../docs/karpenter-nodepool-example.yaml", import.meta.url), "utf8");
  const R = evaluate(makeConfig({ preset: "steady" }), { skipAutoscale: true, skipSpotTable: true });
  for (const t of R.types) assert.ok(yaml.includes(t.id), `${t.id} in the NodePool`);
  assert.ok(yaml.includes(`consolidateAfter: ${DEFAULTS.scaleDownMin}m`));
  assert.ok(yaml.includes("karpenter.sh/capacity-type"));
});

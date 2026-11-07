import {
  DAYS, HOURS_PER_MONTH, HPA_TARGETS, PRESETS, STRATEGIES, TEAMS, WEEK_MIN, clamp, cores, decodeConfig, encodeConfig,
  evaluate, fmtInt, fmtMin, fmtMoney, fmtWeekTime, gib, mixIds, mixLabel, pct, presetValues,
} from "./capacity.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const SVG_NS = "http://www.w3.org/2000/svg";

let cfg = decodeConfig(location.hash);
let R = null; // evaluate() result, without the autoscaling runs
let HPA = null; // autoscaling runs from the worker
let packView = "current";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const money = (hr) => fmtMoney(hr * HOURS_PER_MONTH);
const teamSwatch = (t) => el("i", { class: `swatch t-${t}` });

// ---------------------------------------------------------------------------
// Form

const F = (name, label, title, step = 1, extra = {}) => ({ name, label, title, step, ...extra });
const mixOptions = () => ({ auto: "Cheapest that fits", ...Object.fromEntries(mixIds().map((id) => [id, mixLabel(id)])) });

const GROUPS = [
  { legend: "Packing", fields: [
    { name: "strategy", label: "Scheduler scoring", type: "select", options: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v.label])), title: "How each pod picks among nodes it fits on" },
    { name: "mix", label: "Instance mix", type: "select", options: mixOptions(), title: "Node pools. A GPU pool is added for GPU pods" },
  ] },
  { legend: "Rightsizing", fields: [
    F("cpuPct", "CPU percentile", "Per-pod CPU use at this percentile of the week sets the request"),
    F("cpuMargin", "CPU margin (%)", "Added on top of the percentile"),
    F("memHeadroom", "Memory headroom (%)", "Added on top of the week's maximum memory. Memory cannot be throttled"),
  ] },
  { legend: "Autoscaling", fields: [
    F("hpaTarget", "HPA CPU target (%)", "Target average utilization against requests. The table always compares 50, 70, and 85"),
    F("downWin", "Scale-down window (min)", "HPA scales down only to the highest recommendation in this window. Kubernetes default is 5"),
    F("upWin", "Scale-up window (min)", "HPA scales up to the lowest recommendation in this window. Default 0"),
    F("provisionMin", "Node provisioning (min)", "From launch to Ready"),
    F("podStartMin", "Pod start (min)", "Image pull and readiness after a pod lands on a ready node"),
    F("scaleDownUtil", "Scale-down threshold (%)", "Nodes with requested CPU and memory both under this are candidates"),
    F("scaleDownMin", "Scale-down cooldown (min)", "How long a node must be unneeded before it is removed"),
    F("maxNodes", "Max nodes in pool", "Cluster autoscaler upper bound"),
  ] },
  { legend: "Spot", fields: [
    F("spotPct", "Stateless replicas on spot (%)", "Per deployment, rounded down. Stateful and GPU workloads stay on-demand"),
    F("spotRatePct", "Interruptions per node per day (%)", "Chance a spot node is reclaimed on a given day"),
    F("notice", "Interruption notice (min)", "Time between the notice and termination"),
    { name: "pdbAware", label: "PDB-aware spot placement", type: "check", title: "A spot node holds at most the PDB's allowed disruptions per deployment" },
  ] },
  { legend: "Simulation", fields: [F("seed", "Random seed", "Workloads, usage, and interruptions all come from this seed")] },
];

function field(f) {
  if (f.type === "check") {
    return el("label", { class: "check", title: f.title || null }, [el("input", { type: "checkbox", name: f.name }), el("span", { text: f.label })]);
  }
  if (f.type === "select") {
    return el("label", { title: f.title || null }, [f.label, el("select", { name: f.name }, Object.entries(f.options).map(([v, t]) => el("option", { value: v, text: t })))]);
  }
  return el("label", { title: f.title || null }, [f.label, el("input", { type: "number", name: f.name, step: f.step, min: 0, inputmode: "decimal" })]);
}

function buildForm() {
  form.replaceChildren(...GROUPS.map((g) => {
    const checks = g.fields.filter((f) => f.type === "check");
    const selects = g.fields.filter((f) => f.type === "select");
    const rest = g.fields.filter((f) => f.type !== "check" && f.type !== "select");
    return el("fieldset", {}, [el("legend", { text: g.legend }), ...selects.map(field), el("div", { class: "grid2" }, rest.map(field)), ...checks.map(field)]);
  }));
  fillForm();
}

function fillForm() {
  for (const f of form.elements) {
    if (!f.name || !(f.name in cfg)) continue;
    if (f.type === "checkbox") f.checked = cfg[f.name] === 1;
    else f.value = cfg[f.name];
  }
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (!f.name) return;
  let v;
  if (f.type === "checkbox") v = f.checked ? 1 : 0;
  else if (f.tagName === "SELECT") v = f.value;
  else {
    v = Number(f.value);
    if (f.value === "" || !Number.isFinite(v) || v < 0) return;
  }
  cfg = clamp({ ...cfg, [f.name]: v });
  schedule();
});
form.addEventListener("change", () => fillForm());

function drawPresets() {
  $("presets").replaceChildren(...Object.entries(PRESETS).map(([id, p]) => el("button", {
    type: "button", class: "preset", "data-preset": id, "aria-pressed": String(cfg.preset === id),
  }, [el("span", { text: p.label }), el("small", { text: Object.entries(p.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") })])));
  $("preset-note").textContent = PRESETS[cfg.preset].note;
}

$("presets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-preset]");
  if (!b) return;
  cfg = clamp(presetValues(b.dataset.preset));
  drawPresets();
  buildForm();
  update();
});

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(update, 250);
}

// ---------------------------------------------------------------------------
// Autoscaling runs happen in a worker so the page stays responsive.

let worker = null, jobId = 0;
try {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    if (e.data.id !== jobId) return;
    HPA = e.data.hpa;
    drawAutoscale();
    drawPlan();
  };
  worker.onerror = () => { worker = null; runAutoscale(); };
} catch {
  worker = null;
}

function runAutoscale() {
  HPA = null;
  jobId++;
  $("as-status").textContent = "Simulating 10,080 minutes...";
  const id = jobId;
  const local = () => { if (id !== jobId || HPA) return; HPA = evaluate(cfg, { skipSpotTable: true }).hpa; drawAutoscale(); drawPlan(); };
  if (worker) {
    worker.postMessage({ id, cfg });
    setTimeout(local, 8000); // fallback if the worker never answers
  } else setTimeout(local, 0);
}

// ---------------------------------------------------------------------------
// Results

function update() {
  R = evaluate(cfg, { skipAutoscale: true });
  drawPlan();
  drawCards();
  drawLegend();
  drawNodes();
  drawMixes();
  drawRightsizing();
  drawSpot();
  drawAlloc();
  runAutoscale();
  drawAutoscale();
  history.replaceState(null, "", `#${encodeConfig(cfg)}`);
}

const countsText = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(", ");

function drawPlan() {
  const { current: c, rsPack, rsSearch, spot, search } = R;
  const best = search.best;
  const strat = STRATEGIES[cfg.strategy].short;
  const sel = HPA?.find((h) => h.target === cfg.hpaTarget);
  const parts = [
    `${cfg.mix === "auto" ? "Cheapest mix that fits" : "Selected mix"}: ${countsText(c.counts)} nodes with ${strat.toLowerCase()} scoring, ${fmtMoney(c.costMonth)} a month on-demand.`,
    `Pods request ${pct(c.cpuReqPct)} of allocatable CPU but use ${pct(c.cpuUsedPct)} on average.`,
    `Rightsizing requests to p${cfg.cpuPct} CPU and peak memory cuts it to ${rsPack.count} nodes and ${fmtMoney(rsPack.costMonth)} (${fmtMoney(rsSearch.bestBy[cfg.strategy].r.costMonth)} on the best mix after, ${mixLabel(rsSearch.bestBy[cfg.strategy].mix)}).`,
  ];
  if (sel) parts.push(`With the HPA at ${cfg.hpaTarget}% and the cluster autoscaler, the week costs ${fmtMoney(sel.costMonth)} a month equivalent, with ${fmtInt(sel.sloRiskMin)} SLO risk minutes.`);
  parts.push(`Spot for ${cfg.spotPct}% of stateless replicas saves ${fmtMoney(spot.savingsMonth)} a month${spot.breachMin ? `, with ${fmtInt(spot.breachMin)} minutes below a PDB` : " without breaking a PDB"}.`);
  if (best.mix !== R.mixId || best.strategy !== cfg.strategy) {
    parts.push(`Across all strategies the cheapest is ${mixLabel(best.mix)} with ${STRATEGIES[best.strategy].short.toLowerCase()} at ${fmtMoney(best.r.costMonth)}.`);
  }
  $("rec").textContent = parts.join(" ");
}

function card(label, value, sub, title, cls = "") {
  return el("div", { class: "card", title }, [el("span", { class: "card-label", text: label }), el("span", { class: `card-total ${cls}`, text: value }), el("span", { class: "card-sub", text: sub })]);
}

function drawCards() {
  const { current: c, allocReq } = R;
  $("cards").replaceChildren(
    card("Nodes", fmtInt(c.count), countsText(c.counts), "Nodes in the static plan"),
    card("Monthly cost", fmtMoney(c.costMonth), `${fmtMoney(c.costHr * 24)} a day on-demand`, "Sum of node prices times 730 hours"),
    card("CPU requested / used", `${pct(c.cpuReqPct)} / ${pct(c.cpuUsedPct)}`, `${cores(c.cpuReq)} of ${cores(c.cpuAlloc)} cores allocatable`, "Requests and mean use against allocatable CPU"),
    card("Memory requested / used", `${pct(c.memReqPct)} / ${pct(c.memUsedPct)}`, `${gib(c.memReq)} of ${gib(c.memAlloc)} GiB allocatable`, "Requests and mean use against allocatable memory"),
    card("Stranded", `${cores(c.strandedCpu)} cores`, `${gib(c.strandedMem)} GiB memory`, "Free CPU on memory-full nodes, and free memory on CPU-full nodes", c.strandedCpu > 0.1 * c.cpuAlloc ? "bad" : ""),
    card("Idle and system", pct((allocReq.idle + allocReq.system) / allocReq.total), `${money(allocReq.idle)} idle, ${money(allocReq.system)} system a month`, "Node cost no request pays for"),
  );
}

function drawLegend() {
  const present = new Set(R.deps.map((d) => d.team));
  $("team-legend").replaceChildren(...TEAMS.filter((t) => present.has(t)).map((t) => el("li", {}, [teamSwatch(t), t])));
}

// ---------------------------------------------------------------------------
// Node packing view

function drawNodes() {
  const pack = packView === "rightsized" ? R.rsPack : R.current;
  for (const b of $("pack-tabs").children) b.setAttribute("aria-selected", String(b.dataset.view === packView));
  const order = [...pack.nodes].sort((a, b) => (a.type === b.type ? 0 : a.typeObj.gpu - b.typeObj.gpu || a.typeObj.family.localeCompare(b.typeObj.family) || a.type.localeCompare(b.type)));
  const box = $("nodes");
  box.replaceChildren(...order.map((n, i) => {
    const byTeam = {};
    for (const p of n.pods) {
      const t = p.team;
      byTeam[t] ??= { cpu: 0, mem: 0 };
      byTeam[t].cpu += p.cpu;
      byTeam[t].mem += p.mem;
    }
    const stranded = n.a.mem - n.mem < 0.1 * n.a.mem && n.a.cpu - n.cpu > 0.25 * n.a.cpu || n.a.cpu - n.cpu < 0.1 * n.a.cpu && n.a.mem - n.mem > 0.25 * n.a.mem;
    const bar = (key, cap) => el("div", { class: "rbar" }, TEAMS.filter((t) => byTeam[t]).map((t) => el("i", { class: `t-${t}`, style: `width:${(100 * byTeam[t][key]) / cap}%` })));
    const pods = [...n.pods].sort((a, b) => TEAMS.indexOf(a.team) - TEAMS.indexOf(b.team) || b.cpu - a.cpu);
    return el("div", { class: `node${stranded ? " stranded" : ""}`, "data-i": pack.nodes.indexOf(n), tabindex: "0" }, [
      el("div", { class: "node-head" }, [el("b", { text: n.type }), el("span", { text: n.zone.replace("zone-", "") })]),
      el("div", { class: "pods" }, pods.map((p) => el("i", { class: `t-${p.team}${p.gpu ? " gpu" : ""}` }))),
      el("div", { class: "rrow" }, [el("span", { text: "CPU" }), bar("cpu", n.a.cpu)]),
      el("div", { class: "rrow" }, [el("span", { text: "Mem" }), bar("mem", n.a.mem)]),
    ]);
  }));
  const c = pack;
  $("pack-sub").textContent = `${packView === "rightsized" ? "Rightsized requests" : "Current requests"} on ${mixLabel(R.mixId)}: ${c.count} nodes, ${fmtMoney(c.costMonth)} a month. `
    + `CPU ${pct(c.cpuReqPct)} requested and ${pct(c.cpuUsedPct)} used, memory ${pct(c.memReqPct)} and ${pct(c.memUsedPct)}.`;
}

$("pack-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b) return;
  packView = b.dataset.view;
  drawNodes();
});

const tipRow = (a, b) => el("div", { class: "tip-row" }, [el("span", { text: a }), el("b", { text: b })]);

function placeTip(tip, box, e) {
  tip.hidden = false;
  const left = e.clientX - box.left;
  const w = tip.offsetWidth;
  let x = left > box.width / 2 ? left - w - 12 : left + 12;
  x = Math.max(0, Math.min(box.width - w, x));
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.max(0, e.clientY - box.top + 14)}px`;
}

{
  const box = $("nodes"), tip = box.nextElementSibling;
  const show = (e, nodeEl) => {
    const pack = packView === "rightsized" ? R.rsPack : R.current;
    const n = pack.nodes[Number(nodeEl.dataset.i)];
    const teams = {};
    for (const p of n.pods) teams[p.team] = (teams[p.team] ?? 0) + 1;
    tip.replaceChildren(
      el("strong", { text: `${n.type}, ${n.zone}` }),
      tipRow("Price", `$${n.typeObj.od.toFixed(3)} an hour`),
      tipRow("CPU requested", `${cores(n.cpu)} of ${cores(n.a.cpu)} cores (${pct(n.cpu / n.a.cpu)})`),
      tipRow("Memory requested", `${gib(n.mem)} of ${gib(n.a.mem)} GiB (${pct(n.mem / n.a.mem)})`),
      tipRow("Pods", `${n.pods.length}`),
      ...Object.entries(teams).sort((a, b) => b[1] - a[1]).map(([t, k]) => tipRow(t, `${k} pod${k > 1 ? "s" : ""}`)),
      el("div", { class: "tip-ev", text: `System takes ${cores(n.a.kubeCpu + n.a.dsCpu)} cores and ${gib(n.a.kubeMem + n.a.evictMem + n.a.dsMem)} GiB of ${n.typeObj.vcpu} vCPU and ${n.typeObj.memGiB} GiB.` }),
    );
    placeTip(tip, box.parentElement.getBoundingClientRect(), e);
  };
  box.addEventListener("pointermove", (e) => {
    const nodeEl = e.target.closest(".node");
    if (!nodeEl) { tip.hidden = true; return; }
    show(e, nodeEl);
  });
  box.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---------------------------------------------------------------------------
// Mix table

function drawMixes() {
  const s = cfg.strategy;
  const rows = R.search.rows.filter((r) => r.by[s].feasible).sort((a, b) => a.by[s].costHr - b.by[s].costHr);
  const infeasible = R.search.rows.length - rows.length;
  const shown = rows.slice(0, 10);
  const sel = rows.find((r) => r.id === R.mixId);
  if (sel && !shown.includes(sel)) shown.push(sel);
  const minBy = Object.fromEntries(Object.keys(STRATEGIES).map((k) => [k, Math.min(...R.search.rows.filter((r) => r.by[k].feasible).map((r) => r.by[k].costHr))]));
  $("mix-rows").replaceChildren(...shown.map((r) => {
    const x = r.by[s];
    return el("tr", { class: r.id === R.mixId ? "selected" : null, "data-mix": r.id, title: "Click to use this mix" }, [
      el("td", { class: "name", text: mixLabel(r.id) }),
      el("td", { class: "num", text: fmtInt(x.count) }),
      el("td", { class: "num", text: `${pct(x.cpuReqPct)} / ${pct(x.memReqPct)}` }),
      el("td", { class: "num", text: `${cores(x.strandedCpu)} c, ${gib(x.strandedMem)} GiB` }),
      ...Object.keys(STRATEGIES).map((k) => el("td", { class: `num${Math.abs(r.by[k].costHr - minBy[k]) < 1e-9 ? " good" : ""}${k === s ? " sel-col" : ""}`, text: r.by[k].feasible ? fmtMoney(r.by[k].costMonth) : "does not fit" })),
    ]);
  }));
  const st = R.row.by;
  const spread = Math.max(...Object.values(st).map((x) => x.count)) - Math.min(...Object.values(st).map((x) => x.count));
  $("mix-sub").textContent = `${R.search.rows.length} mixes, each packed with all three strategies. Each pod goes to the pool where its dominant resource is cheapest. The ten cheapest for ${STRATEGIES[s].short.toLowerCase()} are shown; green is the cheapest in each column.`;
  $("mix-note").textContent = `On ${mixLabel(R.mixId)}, first fit needs ${st.ffd.count} nodes, most allocated ${st.most.count}, and least allocated ${st.least.count}${spread ? "" : ": the same count, because anti-affinity and zone spread force most of the layout"}. `
    + `${infeasible} mixes cannot place every pod, usually because a data pod asks for more memory than a small node has. Packing goes most constrained first: anti-affinity pods, then decreasing size.`;
}

$("mix-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("[data-mix]");
  if (!tr) return;
  cfg = clamp({ ...cfg, mix: tr.dataset.mix });
  fillForm();
  update();
});

// ---------------------------------------------------------------------------
// Rightsizing

function stat(label, value, cls, sub) {
  return el("div", {}, [el("span", { text: label }), el("b", { class: cls, text: value }), ...(sub ? [el("small", { text: sub })] : [])]);
}

function drawRightsizing() {
  const { current: c, rsPack: r, rsSearch, teams, allocReq, rsAlloc } = R;
  const bestAfter = rsSearch.bestBy[cfg.strategy];
  $("rs-stats").replaceChildren(
    stat("Nodes", `${c.count} to ${r.count}`, r.count < c.count ? "good" : "", `same mix, ${mixLabel(R.mixId)}`),
    stat("Monthly cost", `${fmtMoney(c.costMonth)} to ${fmtMoney(r.costMonth)}`, "good", `saves ${fmtMoney(c.costMonth - r.costMonth)}`),
    stat("Best mix after", fmtMoney(bestAfter.r.costMonth), "", mixLabel(bestAfter.mix)),
    stat("CPU requested", `${cores(c.cpuReq)} to ${cores(r.cpuReq)} cores`, "", `memory ${gib(c.memReq)} to ${gib(r.memReq)} GiB`),
  );
  $("rs-cpu-head").textContent = `CPU p${cfg.cpuPct} used`;
  $("rs-rows").replaceChildren(...[...teams].sort((a, b) => b.cpuRatio - a.cpuRatio).map((t) => el("tr", { class: t.cpuRatio >= 3 ? "flag" : null, title: `Recommended: ${cores(t.cpuRec)} cores, ${gib(t.memRec)} GiB` }, [
    el("td", { class: "name" }, [teamSwatch(t.team), ` ${t.team}`]),
    el("td", { class: "num", text: cores(t.cpuReq) }),
    el("td", { class: "num", text: cores(t.cpuQ) }),
    el("td", { class: `num${t.cpuRatio >= 3 ? " bad" : ""}`, text: `${t.cpuRatio.toFixed(1)}x` }),
    el("td", { class: "num", text: gib(t.memReq) }),
    el("td", { class: "num", text: gib(t.memMax) }),
    el("td", { class: `num${t.memRatio >= 3 ? " bad" : ""}`, text: `${t.memRatio.toFixed(1)}x` }),
    el("td", { class: "num", text: `${money(allocReq.byTeam[t.team])} to ${money(rsAlloc.byTeam[t.team])}` }),
  ])));
  const worst = [...teams].sort((a, b) => b.cpuRatio - a.cpuRatio)[0];
  $("rs-note").textContent = `Recommendation per deployment, VPA style: CPU request at p${cfg.cpuPct} of per-pod use plus ${cfg.cpuMargin}%, memory at the week's maximum plus ${cfg.memHeadroom}%. `
    + `${worst.team} requests ${worst.cpuRatio.toFixed(1)} times the CPU it uses at p${cfg.cpuPct}. Ratios of 3x or more are marked. Hover a row for the recommended totals. Monthly cost here is each team's share of node cost by requests, before and after.`;
}

// ---------------------------------------------------------------------------
// Autoscaling

const narrow = () => matchMedia("(max-width: 600px)").matches;
let CW = 800;
const CH = 128, CP = { l: 40, r: 10, t: 10, b: 20 };
const charts = {};

function niceStep(span, n) {
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function drawAutoscale() {
  const rowsEl = $("as-rows");
  const base = R.current.costMonth;
  if (!HPA) {
    rowsEl.replaceChildren(el("tr", {}, [el("td", { colspan: "7", class: "muted", text: "Running the week..." })]));
    for (const id of ["c-rep", "c-nodes", "c-pend"]) $(id).replaceChildren();
    $("as-sub").textContent = "";
    return;
  }
  $("as-status").textContent = "";
  const best = (k, dir = 1) => Math.min(...HPA.map((h) => dir * h[k])) * dir;
  rowsEl.replaceChildren(...HPA.map((h) => el("tr", { class: h.target === cfg.hpaTarget ? "selected" : null, "data-target": h.target, title: "Click to chart this target" }, [
    el("td", { class: "name", text: `${h.target}%${HPA_TARGETS.includes(h.target) ? "" : " (custom)"}` }),
    el("td", { class: `num${h.pendingPodMin === best("pendingPodMin") ? " good" : ""}`, text: fmtInt(h.pendingPodMin) }),
    el("td", { class: `num${h.sloRiskMin === best("sloRiskMin") ? " good" : ""}`, text: fmtInt(h.sloRiskMin) }),
    el("td", { class: `num${h.nodeHours === best("nodeHours") ? " good" : ""}`, text: fmtInt(h.nodeHours) }),
    el("td", { class: "num", text: fmtInt(h.maxNodes) }),
    el("td", { class: "num", text: `${fmtInt(h.scaleUps)} / ${fmtInt(h.scaleDowns)}` }),
    el("td", { class: `num${h.costMonth === best("costMonth") ? " good" : ""}`, text: fmtMoney(h.costMonth) }),
  ])));
  const sel = HPA.find((h) => h.target === cfg.hpaTarget) ?? HPA[0];
  const staticN = R.current.counts[R.mainType.id] ?? 0;
  $("as-sub").textContent = `${R.simDeps.length} deployments on the ${R.mainType.id} pool, minute by minute for a week. HPA syncs every minute with a 10% tolerance. `
    + `Static plan: ${staticN} ${R.mainType.id} nodes and ${fmtMoney(base)} a month. At ${sel.target}% the pool averages ${sel.avgNodes.toFixed(1)} nodes, ${fmtMoney(base - sel.costMonth)} a month less.`;
  CW = narrow() ? 440 : 800;
  const s = sel.series;
  drawSeries("c-rep", s, [{ key: "replicas", cls: "l-rep", area: true }], "Replicas");
  drawSeries("c-nodes", s, [{ key: "total", cls: "a-prov", area: true, get: (p) => p.nodes + p.provisioning }, { key: "nodes", cls: "a-ready", area: true }], "Nodes", staticN);
  drawSeries("c-pend", s, [{ key: "pending", cls: "l-pend", area: true }], "Pods");
  $("as-note").textContent = `A lower target keeps more spare CPU per pod, so fewer minutes run above requests, but it adds nodes and churn: every scale-up waits ${cfg.provisionMin} min for a node plus ${cfg.podStartMin} min to start. `
    + `Nodes leave after ${cfg.scaleDownMin} min under ${cfg.scaleDownUtil}% requested, if their pods fit elsewhere. Other pools (memory, GPU) stay at their static size.`;
}

function drawSeries(id, s, layers, yTitle, refLine = null) {
  const chart = $(id);
  chart.setAttribute("viewBox", `0 0 ${CW} ${CH}`);
  const X = (t) => CP.l + (t / WEEK_MIN) * (CW - CP.l - CP.r);
  const val = (L, p) => (L.get ? L.get(p) : p[L.key]);
  const top = Math.max(1, refLine ?? 0, ...s.map((p) => Math.max(...layers.map((L) => val(L, p))))) * 1.08;
  const yStep = niceStep(top, 3), yMax = Math.ceil(top / yStep) * yStep;
  const Y = (v) => CP.t + (1 - v / yMax) * (CH - CP.t - CP.b);
  const nodes = [];
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    nodes.push(svg("line", { x1: CP.l, x2: CW - CP.r, y1: Y(v), y2: Y(v), class: "grid" }));
    nodes.push(svg("text", { x: CP.l - 6, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, fmtInt(v)));
  }
  for (let d = 0; d < 7; d++) {
    if (d) nodes.push(svg("line", { x1: X(d * 1440), x2: X(d * 1440), y1: CP.t, y2: CH - CP.b, class: "grid" }));
    nodes.push(svg("text", { x: X(d * 1440 + 720), y: CH - 5, class: "tick", "text-anchor": "middle" }, DAYS[d]));
  }
  for (const L of layers) {
    const pts = s.map((p) => `${X(p.t).toFixed(1)},${Y(val(L, p)).toFixed(1)}`);
    if (L.area) nodes.push(svg("path", { d: `M${X(s[0].t)},${Y(0)} L${pts.join(" L")} L${X(s.at(-1).t)},${Y(0)} Z`, class: L.cls }));
    if (L.cls.startsWith("l-")) nodes.push(svg("polyline", { points: pts.join(" "), class: `${L.cls}-line` }));
  }
  if (refLine != null) nodes.push(svg("line", { x1: CP.l, x2: CW - CP.r, y1: Y(refLine), y2: Y(refLine), class: "threshold" }));
  nodes.push(svg("line", { class: "crosshair", x1: 0, x2: 0, y1: CP.t, y2: CH - CP.b, visibility: "hidden" }));
  chart.replaceChildren(...nodes);
  charts[id] = { X, s, yTitle };
}

{
  const ids = ["c-rep", "c-nodes", "c-pend"];
  for (const id of ids) {
    const chart = $(id), tip = chart.nextElementSibling;
    chart.addEventListener("pointermove", (e) => {
      const g = charts[id];
      if (!g || !HPA) return;
      const box = chart.getBoundingClientRect();
      const sx = ((e.clientX - box.left) / box.width) * CW;
      const t = ((sx - CP.l) / (CW - CP.l - CP.r)) * WEEK_MIN;
      const i = Math.max(0, Math.min(g.s.length - 1, Math.floor(t / (g.s[1].t - g.s[0].t))));
      const p = g.s[i];
      for (const other of ids) {
        const ch = $(other).querySelector(".crosshair");
        if (!ch) continue;
        ch.setAttribute("x1", g.X(p.t)); ch.setAttribute("x2", g.X(p.t)); ch.setAttribute("visibility", "visible");
      }
      tip.replaceChildren(
        el("strong", { text: `${fmtWeekTime(p.t)} to ${fmtWeekTime(p.t + 15).slice(4)}` }),
        tipRow("HPA replicas", p.replicas.toFixed(0)),
        tipRow("Ready nodes", p.nodes.toFixed(1)),
        tipRow("Provisioning, peak", fmtInt(p.provisioning)),
        tipRow("Pending pods, peak", fmtInt(p.pending)),
      );
      placeTip(tip, box, e);
    });
    chart.addEventListener("pointerleave", () => {
      tip.hidden = true;
      for (const other of ids) $(other).querySelector(".crosshair")?.setAttribute("visibility", "hidden");
    });
  }
}

$("as-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("[data-target]");
  if (!tr) return;
  cfg = clamp({ ...cfg, hpaTarget: Number(tr.dataset.target) });
  fillForm();
  history.replaceState(null, "", `#${encodeConfig(cfg)}`);
  drawAutoscale();
  drawPlan();
});

// ---------------------------------------------------------------------------
// Spot

function drawSpot() {
  const s = R.spot;
  $("spot-stats").replaceChildren(
    stat("Saving per month", fmtMoney(s.savingsMonth), s.savingsMonth > 0 ? "good" : "", `${pct(s.savingsPct)} of the on-demand bill`),
    stat("On spot", `${fmtInt(s.plan.spotPods)} pods`, "", `${s.plan.spot.count} ${R.mainType.id} spot nodes`),
    stat("Interruptions", fmtInt(s.interruptions), "", `${fmtInt(s.evicted)} pods evicted, ${fmtInt(s.blocked)} blocked by a PDB`),
    stat("PDB breach", fmtMin(s.breachMin), s.breachMin ? "bad" : "good", `${fmtInt(s.podDownMin)} pod minutes down`),
  );
  $("spot-rows").replaceChildren(...R.spotTable.map((r) => el("tr", { class: r.f === cfg.spotPct ? "selected" : null, "data-f": r.f, title: "Click to use this share" }, [
    el("td", { class: "name", text: `${r.f}%` }),
    el("td", { class: "num", text: fmtInt(r.aware.plan.spotPods) }),
    el("td", { class: "num", text: fmtInt(r.aware.plan.spot.count) }),
    el("td", { class: "num", text: fmtMoney(r.aware.savingsMonth) }),
    el("td", { class: "num", text: fmtInt(r.aware.interruptions) }),
    el("td", { class: `num${r.aware.breachMin ? " bad" : ""}`, text: fmtInt(r.aware.breachMin) }),
    el("td", { class: `num${r.naive.breachMin ? " bad" : ""}`, text: `${fmtInt(r.naive.breachMin)} (${fmtMoney(r.naive.savingsMonth)})` }),
  ])));
  const spotPrice = R.mainType.spot / R.mainType.od;
  $("spot-note").textContent = `Spot ${R.mainType.id} is priced at ${pct(spotPrice)} of on-demand. Interruptions are a Poisson process per node at ${cfg.spotRatePct}% a day. `
    + `On a notice the node is drained: a pod is evicted only if its PDB allows it, and the rest are killed when the node terminates ${cfg.notice} min later. A replacement is ready ${Math.max(cfg.notice, cfg.provisionMin)} min after the notice. `
    + `PDB-aware placement caps each deployment at its allowed disruptions per spot node, which costs a few more nodes than naive packing (saving in brackets) but keeps one interruption from breaking a budget.`;
}

$("spot-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("[data-f]");
  if (!tr) return;
  cfg = clamp({ ...cfg, spotPct: Number(tr.dataset.f) });
  fillForm();
  update();
});

// ---------------------------------------------------------------------------
// Cost allocation

function drawAlloc() {
  const a = R.allocReq, u = R.allocUse;
  const max = Math.max(...Object.values(a.byTeam), ...Object.values(u.byTeam), a.idle, u.idle);
  const barCell = (v, cls) => el("td", { class: "bar-col" }, [el("i", { class: `hbar ${cls}`, style: `width:${(100 * v) / max}%` })]);
  const row = (label, sw, ra, ru, cls) => el("tr", { class: cls }, [
    el("td", { class: "name" }, sw ? [sw, ` ${label}`] : [label]),
    el("td", { class: "num", text: `${money(ra)} (${pct(ra / a.total)})` }),
    barCell(ra, sw ? sw.className.replace("swatch ", "") : cls),
    el("td", { class: "num", text: `${money(ru)} (${pct(ru / u.total)})` }),
    barCell(ru, sw ? sw.className.replace("swatch ", "") : cls),
  ]);
  const teams = TEAMS.filter((t) => a.byTeam[t] > 0).sort((x, y) => a.byTeam[y] - a.byTeam[x]);
  $("alloc-rows").replaceChildren(
    ...teams.map((t) => row(t, teamSwatch(t), a.byTeam[t], u.byTeam[t])),
    row("System: kubelet, OS, DaemonSets", null, a.system, u.system, "sys"),
    row("Idle: allocatable nobody uses", null, a.idle, u.idle, "idle"),
  );
  $("alloc-total").textContent = money(a.total);
  $("alloc-total2").textContent = money(u.total);
  $("alloc-note").textContent = `Each node's price is split by resource, with one vCPU priced like 7.5 GiB of memory and one GPU like 200 GiB. `
    + `By requests, idle is allocatable no pod asked for: ${pct(a.idle / a.total)} of the bill. By usage, teams pay only for mean use and idle grows to ${pct(u.idle / u.total)}. Showing idle separately keeps teams from paying for the cluster's packing.`;
}

// ---------------------------------------------------------------------------

$("reset").addEventListener("click", () => {
  cfg = clamp(presetValues(cfg.preset));
  drawPresets();
  buildForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

window.addEventListener("hashchange", () => {
  if (location.hash.slice(1) === encodeConfig(cfg)) return;
  cfg = decodeConfig(location.hash);
  drawPresets();
  buildForm();
  update();
});

let wasNarrow = narrow();
window.addEventListener("resize", () => {
  if (narrow() === wasNarrow || !R) return;
  wasNarrow = narrow();
  drawAutoscale();
});

drawPresets();
buildForm();
update();

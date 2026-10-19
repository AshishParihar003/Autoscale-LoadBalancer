import { useCallback, useEffect, useState } from "react";
import {
  Activity, Check, ChevronRight, Cloud, Cpu, ExternalLink, Gauge, Globe,
  HardDrive, LoaderCircle, Minus, Plus, RefreshCw, Server, ShieldCheck,
  SlidersHorizontal, TriangleAlert, Wifi, X
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip,
  XAxis, YAxis
} from "recharts";
import { API_BASE_URL } from "./api";

type Section = "overview" | "health";
type Target = "azure-vms" | "docker-containers";
type Tone = "green" | "amber" | "red" | "blue";

type HistoryPoint = {
  time: string;
  requests: number;
  cpu: number;
  memory: number;
  instances: number;
};

type Instance = {
  id: string;
  name: string;
  status: string;
  publicIp?: string;
  cpuPercent?: number;
  memoryPercent?: number;
};

type ControllerState = {
  application: {
    name: string;
    url?: string;
    status: string;
    health?: string;
  };
  metrics: {
    requestsPerMinute: number;
    cpuPercent: number;
    memoryPercent: number;
    healthyInstances: number;
    desiredInstances: number;
    activeInstances: number;
    timestamp?: string;
  };
  infrastructure: {
    target: Target;
    instances: Instance[];
  };
  history: HistoryPoint[];
};

type ScalingPlan = {
  planId: string;
  targetTraffic: number;
  currentInstances: number;
  requiredInstances: number;
  action?: string;
  estimatedCpuPercent?: number;
  warnings?: string[];
  message?: string;
};

type Operation = {
  operationId: string;
  status: string;
  message?: string;
};

const POLL_INTERVAL_MS = 5000;
const MAX_TRAFFIC = 1_000_000;
const API_ROOT = (API_BASE_URL || "").replace(/\/$/, "");

const fallbackState: ControllerState = {
  application: {
    name: "Sample Web Application",
    status: "unknown",
    health: "Waiting for backend"
  },
  metrics: {
    requestsPerMinute: 0,
    cpuPercent: 0,
    memoryPercent: 0,
    healthyInstances: 0,
    desiredInstances: 0,
    activeInstances: 0
  },
  infrastructure: { target: "azure-vms", instances: [] },
  history: []
};

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof payload?.message === "string"
        ? payload.message
        : `API request failed (${response.status})`
    );
  }
  return payload as T;
}

function isRunning(status: string) {
  return ["running", "healthy", "active", "succeeded", "success"].includes(
    status.toLowerCase()
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(Number.isFinite(value) ? value : 0);
}

function percent(value: number) {
  return `${Math.round(Math.max(0, Math.min(100, value || 0)))}%`;
}

function App() {
  const [section, setSection] = useState<Section>("overview");
  const [state, setState] = useState<ControllerState>(fallbackState);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [target, setTarget] = useState<Target>("azure-vms");
  const [trafficInput, setTrafficInput] = useState("1000");
  const [vmOverride, setVmOverride] = useState<number | null>(null);
  const [plan, setPlan] = useState<ScalingPlan | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [generatingTraffic, setGeneratingTraffic] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: Tone } | null>(null);
  const [showApproval, setShowApproval] = useState(false);

  const loadState = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const next = await apiRequest<ControllerState>("/api/controller/state");
      setState({
        ...fallbackState,
        ...next,
        application: { ...fallbackState.application, ...next.application },
        metrics: { ...fallbackState.metrics, ...next.metrics },
        infrastructure: {
          ...fallbackState.infrastructure,
          ...next.infrastructure
        },
        history: Array.isArray(next.history) ? next.history : []
      });
      setTarget(next.infrastructure?.target || "azure-vms");
      setConnected(true);
      setNotice((current) =>
        current?.tone === "red" && current.text.startsWith("Backend unavailable")
          ? null
          : current
      );
    } catch (error) {
      setConnected(false);
      if (!quiet) {
        setNotice({
          tone: "red",
          text: `Backend unavailable: ${error instanceof Error ? error.message : "Could not load live state"}. Configure the API and start the controller service.`
        });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => void loadState(true), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadState]);

  const currentInstances = state.metrics.activeInstances ?? state.infrastructure.instances.length;
  const requests = state.metrics.requestsPerMinute || 0;
  const cpu = state.metrics.cpuPercent || 0;
  const memory = state.metrics.memoryPercent || 0;
  const appHealthy = isRunning(state.application.health || state.application.status);
  const desiredInstances = vmOverride ?? state.metrics.desiredInstances ?? currentInstances;
  const numericTraffic = Math.max(0, Math.min(MAX_TRAFFIC, Number(trafficInput) || 0));

  async function generateTraffic() {
    if (!connected) {
      setNotice({ tone: "red", text: "Connect the backend before generating real traffic." });
      return;
    }
    setGeneratingTraffic(true);
    setNotice(null);
    try {
      const result = await apiRequest<{ message?: string; requestsPerMinute?: number }>(
        "/api/controller/traffic",
        {
          method: "POST",
          body: JSON.stringify({ requestsPerMinute: numericTraffic })
        }
      );
      setNotice({
        tone: "green",
        text: result.message || `Traffic target submitted: ${formatNumber(numericTraffic)} requests/min.`
      });
      await loadState(true);
    } catch (error) {
      setNotice({
        tone: "red",
        text: error instanceof Error ? error.message : "Could not set traffic target."
      });
    } finally {
      setGeneratingTraffic(false);
    }
  }

  async function createPlan() {
    if (!connected) {
      setNotice({ tone: "red", text: "The controller API is not connected. No plan can be calculated or applied yet." });
      return;
    }
    setPlanning(true);
    setNotice(null);
    setPlan(null);
    try {
      const result = await apiRequest<ScalingPlan>("/api/controller/plan", {
        method: "POST",
        body: JSON.stringify({
          target,
          targetTraffic: numericTraffic,
          desiredInstances: vmOverride,
          approvalRequired: true
        })
      });
      setPlan(result);
      setShowApproval(true);
    } catch (error) {
      setNotice({
        tone: "red",
        text: error instanceof Error ? error.message : "Unable to calculate a scaling plan."
      });
    } finally {
      setPlanning(false);
    }
  }

  async function executePlan() {
    if (!plan || !connected) return;
    setExecuting(true);
    setNotice(null);
    try {
      const result = await apiRequest<Operation>("/api/controller/execute", {
        method: "POST",
        body: JSON.stringify({ planId: plan.planId })
      });
      setOperation(result);
      setShowApproval(false);
      setVmOverride(null);
      setNotice({
        tone: "blue",
        text: result.message || `Provisioning operation ${result.operationId} accepted. The controller will refresh live metrics.`
      });
      await loadState(true);
    } catch (error) {
      setNotice({
        tone: "red",
        text: error instanceof Error ? error.message : "Provisioning request failed."
      });
    } finally {
      setExecuting(false);
    }
  }

  async function changeTarget(nextTarget: Target) {
    setTarget(nextTarget);
    setPlan(null);
    if (!connected) return;
    try {
      await apiRequest("/api/controller/config", {
        method: "PATCH",
        body: JSON.stringify({ target: nextTarget })
      });
      await loadState(true);
    } catch (error) {
      setNotice({
        tone: "red",
        text: error instanceof Error ? error.message : "Could not update infrastructure target."
      });
    }
  }

  function adjustVmCount(delta: number) {
    const base = vmOverride ?? state.metrics.desiredInstances ?? currentInstances;
    setVmOverride(Math.max(0, Math.min(50, base + delta)));
    setPlan(null);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Cloud size={21} /></div>
          <div><strong>AutoScale</strong><span>Cloud Controller</span></div>
        </div>
        <div className="workspace-label">CONTROL CENTER</div>
        <nav className="nav-list" aria-label="Main navigation">
          <button className={`nav-link ${section === "overview" ? "active" : ""}`} onClick={() => setSection("overview")}>
            <Gauge size={18} /><span>Overview</span>
          </button>
          <button className={`nav-link ${section === "health" ? "active" : ""}`} onClick={() => setSection("health")}>
            <Activity size={18} /><span>Health</span>
          </button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="connection-card">
          <div className="connection-heading">
            <span className={`status-pip ${connected ? "green" : "red"}`} />
            Controller API
          </div>
          <strong>{connected ? "Connected" : "Disconnected"}</strong>
          <p>{connected ? `Live polling every ${POLL_INTERVAL_MS / 1000}s` : "Live metrics and provisioning need a running backend."}</p>
          <button className="text-button" onClick={() => void loadState()}><RefreshCw size={14} /> Check connection</button>
        </div>
        <div className="sidebar-user">
          <div className="avatar">AC</div>
          <div><strong>Admin Console</strong><small>Infrastructure operator</small></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs"><span>AutoScale</span><ChevronRight size={14} /><strong>{section === "overview" ? "Overview" : "Health"}</strong></div>
          <div className="topbar-right">
            <span className="environment-badge"><span className={`status-pip ${connected ? "green" : "red"}`} />{connected ? "Live environment" : "API offline"}</span>
            <button className="icon-button" aria-label="Refresh live data" onClick={() => void loadState()} disabled={refreshing}>
              {refreshing ? <LoaderCircle size={18} className="spin" /> : <RefreshCw size={18} />}
            </button>
          </div>
        </header>

        <div className="page-wrap">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" />AUTOSCALING CONTROL PLANE</div>
              <h1>{section === "overview" ? "Application overview" : "Application health"}</h1>
              <p>{section === "overview" ? "See the deployed application, live workload, and infrastructure capacity." : "Inspect live resource health and set the workload or capacity you want the controller to handle."}</p>
            </div>
            <div className={`live-indicator ${connected ? "live" : ""}`}><span className="status-pip" />{connected ? "Updating automatically" : "Waiting for backend"}</div>
          </section>

          {notice && (
            <div className={`notice notice-${notice.tone}`}>
              {notice.tone === "red" ? <TriangleAlert size={17} /> : notice.tone === "green" ? <Check size={17} /> : <Activity size={17} />}
              <span>{notice.text}</span>
              <button aria-label="Dismiss notice" onClick={() => setNotice(null)}><X size={16} /></button>
            </div>
          )}

          {section === "overview" ? (
            <>
              <section className="app-banner panel">
                <div className="app-banner-main">
                  <div className="app-icon"><Globe size={24} /></div>
                  <div className="app-meta">
                    <div className="app-name-row">
                      <h2>{state.application.name || "Sample Web Application"}</h2>
                      <span className={`status-badge ${appHealthy ? "status-good" : "status-warning"}`}>
                        <span className={`status-pip ${appHealthy ? "green" : "amber"}`} />
                        {appHealthy ? "Application healthy" : state.application.status || "Health unknown"}
                      </span>
                    </div>
                    <p>Deployed demo website · monitored by AutoScale controller</p>
                    <div className="app-url">
                      <span className={`status-pip ${state.application.url ? "green" : "amber"}`} />
                      {state.application.url || "Application URL not returned by backend"}
                      {state.application.url && (
                        <button className="icon-button tiny" aria-label="Open deployed application" onClick={() => window.open(state.application.url, "_blank", "noopener,noreferrer")}><ExternalLink size={14} /></button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="app-banner-status">
                  <div className="health-check"><ShieldCheck size={19} /></div>
                  <div><strong>{appHealthy ? "Health check passing" : "Health check pending"}</strong><small>{state.metrics.timestamp ? `Updated ${new Date(state.metrics.timestamp).toLocaleTimeString()}` : "Waiting for first live sample"}</small></div>
                </div>
              </section>

              <section className="metric-grid">
                <MetricCard title="Requests / min" value={formatNumber(requests)} sub="Current traffic" icon={<Activity size={18} />} tone="blue" />
                <MetricCard title="CPU utilization" value={percent(cpu)} sub="Live compute load" icon={<Cpu size={18} />} tone={cpu >= 80 ? "amber" : "blue"} />
                <MetricCard title="Memory usage" value={percent(memory)} sub="Live memory pressure" icon={<HardDrive size={18} />} tone={memory >= 85 ? "amber" : "purple"} />
                <MetricCard title="Running instances" value={formatNumber(currentInstances)} sub={`${state.metrics.healthyInstances} healthy`} icon={<Server size={18} />} tone="green" />
              </section>

              <section className="panel chart-panel">
                <div className="panel-heading">
                  <div><h3>Traffic and resource trend</h3><p>Live samples reported by the controller</p></div>
                  <span className={`data-chip ${connected ? "chip-live" : ""}`}><span className="status-pip" />{connected ? "Live data" : "No connection"}</span>
                </div>
                <div className="chart-legend"><span><i className="legend-dot blue-dot" />Requests / min</span><span><i className="legend-dot purple-dot" />CPU %</span><span><i className="legend-dot green-dot" />Instances</span></div>
                <div className="chart-wrap large-chart">
                  {state.history.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={state.history} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                        <defs>
                          <linearGradient id="trafficFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#5b8cff" stopOpacity={0.22} /><stop offset="100%" stopColor="#5b8cff" stopOpacity={0.01} /></linearGradient>
                        </defs>
                        <CartesianGrid stroke="#263246" strokeDasharray="3 5" vertical={false} />
                        <XAxis dataKey="time" tick={{ fill: "#8997ad", fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis yAxisId="traffic" tick={{ fill: "#8997ad", fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis yAxisId="percent" orientation="right" domain={[0, 100]} tick={{ fill: "#8997ad", fontSize: 11 }} axisLine={false} tickLine={false} />
                        <Tooltip contentStyle={{ background: "#111b2b", border: "1px solid #29374b", borderRadius: 10, color: "#e9eef8", fontSize: 12 }} />
                        <Area yAxisId="traffic" type="monotone" dataKey="requests" name="Requests/min" stroke="#5b8cff" strokeWidth={2} fill="url(#trafficFill)" />
                        <Line yAxisId="percent" type="monotone" dataKey="cpu" name="CPU %" stroke="#a193ff" strokeWidth={2} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : <EmptyChart connected={connected} />}
                </div>
                <div className="chart-footer"><span><span className={`status-pip ${connected ? "green" : "amber"}`} />{connected ? "Metrics refresh every 5 seconds" : "Chart will populate when the backend returns history"}</span><span>Instance count: {formatNumber(currentInstances)}</span></div>
              </section>

              <section className="panel capacity-strip">
                <div className="capacity-strip-copy"><div className="small-icon"><Server size={18} /></div><div><strong>Managed capacity</strong><p>{target === "azure-vms" ? "Azure Virtual Machines" : "Docker containers"} · {currentInstances} running · {state.metrics.desiredInstances} desired</p></div></div>
                <button className="button button-secondary" onClick={() => setSection("health")}><SlidersHorizontal size={16} /> Configure workload <ChevronRight size={15} /></button>
              </section>
            </>
          ) : (
            <>
              <section className="metric-grid health-metrics">
                <MetricCard title="CPU utilization" value={percent(cpu)} sub={cpu >= 80 ? "High utilization" : "Within monitored range"} icon={<Cpu size={18} />} tone={cpu >= 80 ? "amber" : "blue"} />
                <MetricCard title="Memory utilization" value={percent(memory)} sub={memory >= 85 ? "Memory pressure high" : "Memory usage"} icon={<HardDrive size={18} />} tone={memory >= 85 ? "amber" : "purple"} />
                <MetricCard title="Healthy instances" value={formatNumber(state.metrics.healthyInstances)} sub={`of ${formatNumber(currentInstances)} active`} icon={<ShieldCheck size={18} />} tone="green" />
                <MetricCard title="Request rate" value={formatNumber(requests)} sub="Requests per minute" icon={<Activity size={18} />} tone="blue" />
              </section>

              <section className="health-grid">
                <div className="panel health-panel">
                  <div className="panel-heading"><div><h3>Resource health</h3><p>Latest backend measurements</p></div><span className={`data-chip ${connected ? "chip-live" : ""}`}><span className="status-pip" />{connected ? "Live" : "Offline"}</span></div>
                  <div className="resource-row">
                    <div className="resource-label"><span className="resource-icon cpu-icon"><Cpu size={17} /></span><div><strong>CPU</strong><small>Compute utilization</small></div><b>{percent(cpu)}</b></div>
                    <div className="progress-track"><div className={`progress-value ${cpu >= 80 ? "progress-warn" : ""}`} style={{ width: percent(cpu) }} /></div>
                  </div>
                  <div className="resource-row">
                    <div className="resource-label"><span className="resource-icon memory-icon"><HardDrive size={17} /></span><div><strong>Memory</strong><small>RAM utilization</small></div><b>{percent(memory)}</b></div>
                    <div className="progress-track"><div className={`progress-value memory-progress ${memory >= 85 ? "progress-warn" : ""}`} style={{ width: percent(memory) }} /></div>
                  </div>
                  <div className="health-summary-grid">
                    <div><span>Application</span><strong><span className={`status-pip ${appHealthy ? "green" : "amber"}`} />{appHealthy ? "Healthy" : "Unknown"}</strong></div>
                    <div><span>Controller API</span><strong><span className={`status-pip ${connected ? "green" : "red"}`} />{connected ? "Connected" : "Offline"}</strong></div>
                    <div><span>Active instances</span><strong>{formatNumber(currentInstances)}</strong></div>
                    <div><span>Last metric update</span><strong>{state.metrics.timestamp ? new Date(state.metrics.timestamp).toLocaleTimeString() : "Not received"}</strong></div>
                  </div>
                </div>

                <div className="panel capacity-health-panel">
                  <div className="panel-heading"><div><h3>Capacity inventory</h3><p>Instances returned by the cloud controller</p></div><Server size={18} /></div>
                  {state.infrastructure.instances.length ? (
                    <div className="instance-list">
                      {state.infrastructure.instances.map((instance) => (
                        <div className="instance-row" key={instance.id}>
                          <div className="instance-icon"><Server size={17} /></div>
                          <div className="instance-copy"><strong>{instance.name}</strong><small>{instance.publicIp || instance.id}</small></div>
                          <span className={`status-badge ${isRunning(instance.status) ? "status-good" : "status-warning"}`}><span className={`status-pip ${isRunning(instance.status) ? "green" : "amber"}`} />{instance.status}</span>
                        </div>
                      ))}
                    </div>
                  ) : <div className="empty-inventory"><Server size={24} /><strong>No instances reported</strong><span>Zero instances can be valid when the desired traffic is zero.</span></div>}
                </div>
              </section>

              <section className="panel customize-panel">
                <div className="customize-heading">
                  <div className="customize-icon"><SlidersHorizontal size={20} /></div>
                  <div><h2>Workload & capacity control</h2><p>Set a traffic target or manually request a number of instances. The backend calculates and validates the plan.</p></div>
                </div>
                <div className="control-grid">
                  <div className="control-block">
                    <label htmlFor="traffic-target">Target traffic <span>requests / minute</span></label>
                    <div className="number-input-wrap"><input id="traffic-target" type="number" min="0" max={MAX_TRAFFIC} step="100" value={trafficInput} onChange={(event) => { setTrafficInput(event.target.value); setVmOverride(null); setPlan(null); }} /><span>req/min</span></div>
                    <div className="quick-values">
                      {[0, 500, 1000, 2000, 5000].map((value) => <button key={value} className={numericTraffic === value ? "quick-value selected" : "quick-value"} onClick={() => { setTrafficInput(String(value)); setVmOverride(null); setPlan(null); }}>{formatNumber(value)}</button>)}
                    </div>
                    <button className="button button-secondary full-button" onClick={generateTraffic} disabled={!connected || generatingTraffic}>
                      {generatingTraffic ? <LoaderCircle size={16} className="spin" /> : <Activity size={16} />}
                      {generatingTraffic ? "Applying traffic target..." : "Apply traffic target"}
                    </button>
                    <p className="control-help">This calls the backend traffic generator. It must create real HTTP load against the demo website to affect actual metrics.</p>
                  </div>

                  <div className="control-block">
                    <label>Desired instances <span>manual override</span></label>
                    <div className="instance-stepper">
                      <button aria-label="Decrease desired instances" onClick={() => adjustVmCount(-1)} disabled={(vmOverride ?? state.metrics.desiredInstances ?? currentInstances) <= 0}><Minus size={17} /></button>
                      <div><strong>{desiredInstances}</strong><small>instances requested</small></div>
                      <button aria-label="Increase desired instances" onClick={() => adjustVmCount(1)} disabled={desiredInstances >= 50}><Plus size={17} /></button>
                    </div>
                    <div className="target-choice">
                      <label htmlFor="infra-target">Infrastructure target</label>
                      <select id="infra-target" value={target} onChange={(event) => void changeTarget(event.target.value as Target)}>
                        <option value="azure-vms">Azure Virtual Machines</option>
                        <option value="docker-containers">Docker containers</option>
                      </select>
                    </div>
                    <button className="button button-primary full-button" onClick={createPlan} disabled={!connected || planning}>
                      {planning ? <LoaderCircle size={16} className="spin" /> : <ChevronRight size={16} />}
                      {planning ? "Calculating plan..." : "Calculate & review plan"}
                    </button>
                    <p className="control-help">The plan must be approved before Terraform/Ansible provisioning begins.</p>
                  </div>
                </div>
                <div className="zero-warning"><TriangleAlert size={16} /><span>Setting traffic and desired instances to zero may remove every managed VM. Keep the controller/API on separate infrastructure so it can scale the website back up later.</span></div>
              </section>
            </>
          )}

          <footer className="page-footer"><span>AutoScale Cloud Controller</span><span><Wifi size={13} /> {connected ? "Live controller data" : "Waiting for controller API"}</span></footer>
        </div>
      </main>

      {showApproval && plan && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !executing) setShowApproval(false); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="plan-title">
            <div className="modal-header"><div className="modal-symbol"><ShieldCheck size={21} /></div><button className="icon-button" onClick={() => setShowApproval(false)} aria-label="Close plan" disabled={executing}><X size={18} /></button></div>
            <h2 id="plan-title">Approve infrastructure plan?</h2>
            <p className="modal-description">The backend must validate this plan and run the infrastructure pipeline. No resources are created until you approve.</p>
            <div className="approval-summary">
              <div><span>Infrastructure</span><strong>{target === "azure-vms" ? "Azure Virtual Machines" : "Docker containers"}</strong></div>
              <div><span>Target traffic</span><strong>{formatNumber(plan.targetTraffic)} requests/min</strong></div>
              <div><span>Current instances</span><strong>{plan.currentInstances}</strong></div>
              <div><span>Desired instances</span><strong>{plan.requiredInstances}</strong></div>
              <div><span>Planned action</span><strong className={plan.requiredInstances < plan.currentInstances ? "danger-text" : "accent-text"}>{plan.action || (plan.requiredInstances === 0 ? "Scale to zero" : plan.requiredInstances > plan.currentInstances ? "Scale out" : plan.requiredInstances < plan.currentInstances ? "Scale in" : "No capacity change")}</strong></div>
            </div>
            {plan.warnings?.length ? <div className="modal-warning"><TriangleAlert size={17} /><span>{plan.warnings.join(" ")}</span></div> : null}
            {plan.requiredInstances === 0 && <div className="modal-warning"><TriangleAlert size={17} /><span>Zero capacity can destroy all managed application VMs. Confirm the controller is hosted separately and Terraform only targets resources managed by this project.</span></div>}
            {operation && <div className="operation-status"><strong>Last operation:</strong> {operation.status} · {operation.message || operation.operationId}</div>}
            <div className="modal-actions"><button className="button button-secondary" onClick={() => setShowApproval(false)} disabled={executing}>Cancel</button><button className="button button-primary" onClick={() => void executePlan()} disabled={executing || !connected}>{executing ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{executing ? "Submitting..." : plan.requiredInstances === 0 ? "Approve & remove VMs" : "Approve & provision"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ title, value, sub, icon, tone }: { title: string; value: string; sub: string; icon: React.ReactNode; tone: string }) {
  return (
    <div className="panel metric-card">
      <div className="metric-top"><span>{title}</span><span className={`metric-icon metric-${tone}`}>{icon}</span></div>
      <div className="metric-value">{value}</div>
      <div className="metric-foot">{sub}</div>
    </div>
  );
}

function EmptyChart({ connected }: { connected: boolean }) {
  return <div className="empty-chart"><Activity size={25} /><strong>{connected ? "Waiting for metric history" : "No live metrics yet"}</strong><span>{connected ? "Return history points from /api/controller/state to populate this chart." : "Start the backend and configure VITE_API_BASE_URL."}</span></div>;
}

export default App;

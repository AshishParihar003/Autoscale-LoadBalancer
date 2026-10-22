import { Activity, ArrowDownRight, ArrowUpRight, Cpu, HardDrive, Server, ShieldCheck, SlidersHorizontal } from "lucide-react";

export type HistoryPoint = { time: string; requests: number; cpu: number; memory: number; instances: number };
export type Instance = { id: string; name: string; status: string; publicIp?: string; cpuPercent?: number; memoryPercent?: number };
export type ControllerState = {
  application: { name: string; url?: string; status: string; health?: string };
  metrics: { requestsPerMinute: number; cpuPercent: number; memoryPercent: number; healthyInstances: number; desiredInstances: number; activeInstances: number; timestamp?: string };
  infrastructure: { target: "azure-vms" | "docker-containers"; instances: Instance[] };
  history: HistoryPoint[];
  mode?: string;
};
export type AzureInventory = {
  managedCapacity?: number | null;
  stateAvailable?: boolean;
  status?: string;
  websiteUrl?: string;
  ansibleConfigured?: boolean;
  checks?: Array<{ name: string; status: string; message: string }>;
  [key: string]: unknown;
};

function n(v: number) { return new Intl.NumberFormat("en-US").format(Number.isFinite(v) ? v : 0); }
function pct(v: number) { return `${Math.max(0, Math.min(100, Math.round(v || 0)))}%`; }

export default function Dashboard({ state, connected, currentCount, isRealInventory, inventory, onManage }: {
  state: ControllerState; connected: boolean; currentCount: number; isRealInventory: boolean; inventory: AzureInventory | null; onManage: () => void;
}) {
  const requests = state.metrics.requestsPerMinute || 0;
  const cpu = state.metrics.cpuPercent || 0;
  const memory = state.metrics.memoryPercent || 0;
  const history = state.history || [];
  const status = isRealInventory ? "Terraform state" : state.mode === "simulation" ? "Simulation" : "Controller data";

  return <div className="as-stack">
    <section className="as-hero-card">
      <div className="as-hero-left"><div className="as-app-icon"><Activity size={23}/></div><div><div className="as-inline-title"><h2>{state.application.name || "Managed application"}</h2><span className={`as-status ${connected ? "good" : "warn"}`}><span className={`as-dot ${connected ? "green" : "amber"}`}/>{connected ? "Controller online" : "Controller offline"}</span></div><p>Workload monitoring and Azure capacity</p><div className="as-source"><span className={`as-dot ${isRealInventory ? "green" : "amber"}`}/>{status}{inventory?.stateAvailable ? " · state available" : ""}</div></div></div>
      <div className="as-hero-right"><span className="as-muted">Azure VM count</span><div className="as-big-count">{n(currentCount)} <small>VM{currentCount === 1 ? "" : "s"}</small></div><span className={isRealInventory ? "as-source-real" : "as-source-sim"}>{isRealInventory ? "Reported by Terraform state" : "Live Azure count not available"}</span></div>
    </section>

    <section className="as-metric-grid">
      <Metric title="Requests / min" value={n(requests)} detail="Current controller reading" icon={<Activity size={18}/>} tone="blue"/>
      <Metric title="CPU usage" value={pct(cpu)} detail={cpu >= 80 ? "High utilization" : "Controller-reported estimate"} icon={<Cpu size={18}/>} tone={cpu >= 80 ? "amber" : "violet"}/>
      <Metric title="Memory usage" value={pct(memory)} detail={memory >= 85 ? "High memory pressure" : "Controller-reported estimate"} icon={<HardDrive size={18}/>} tone={memory >= 85 ? "amber" : "violet"}/>
      <Metric title="Healthy VMs" value={n(state.metrics.healthyInstances || 0)} detail={`of ${n(currentCount)} reported VMs`} icon={<ShieldCheck size={18}/>} tone="green"/>
    </section>

    <section className="as-two-col">
      <div className="as-card">
        <div className="as-card-heading"><div><h3>Traffic overview</h3><p>Latest readings from the controller</p></div><span className="as-chip"><span className={`as-dot ${connected ? "green" : "red"}`}/>{connected ? "Connected" : "Offline"}</span></div>
        {history.length ? <div className="as-traffic-list">{history.slice(-8).map((point, i) => <div className="as-traffic-row" key={`${point.time}-${i}`}><span>{point.time}</span><div className="as-bar-track"><div className="as-bar" style={{width:`${Math.max(2, Math.min(100, (point.requests / Math.max(1, ...history.map(p=>p.requests))) * 100))}%`}}/></div><b>{n(point.requests)} <small>rpm</small></b></div>)}</div> : <div className="as-empty"><Activity size={22}/><b>No traffic history yet</b><span>Traffic history will appear when the backend returns samples.</span></div>}
        <p className="as-footnote">If the backend is in simulation mode, traffic and CPU are estimates—not Azure Monitor telemetry.</p>
      </div>

      <div className="as-card">
        <div className="as-card-heading"><div><h3>Capacity snapshot</h3><p>Current vs requested capacity</p></div><Server size={19}/></div>
        <div className="as-capacity-number"><div><span>Azure VMs</span><b>{n(currentCount)}</b><small>{isRealInventory ? "Terraform state count" : "Not verified from Azure"}</small></div><div className="as-capacity-divider"/><div><span>Desired</span><b>{n(state.metrics.desiredInstances || 0)}</b><small>Controller target</small></div></div>
        <div className="as-instance-meter"><span style={{width:`${Math.min(100, currentCount / 5 * 100)}%`}}/></div><div className="as-meter-labels"><span>0 VMs</span><span>Maximum 5</span></div>
        <button className="as-primary-button" onClick={onManage}><SlidersHorizontal size={16}/> Manage scaling & VMs</button>
      </div>
    </section>

    <section className="as-card">
      <div className="as-card-heading"><div><h3>Instance inventory</h3><p>Only show actual VM details when the backend exposes Azure inventory.</p></div><span className={`as-status ${isRealInventory ? "good" : "warn"}`}>{isRealInventory ? "State-backed count" : "Inventory not connected"}</span></div>
      {state.infrastructure.instances.length ? <div className="as-inventory">{state.infrastructure.instances.map(vm=><div className="as-vm-row" key={vm.id}><span className="as-vm-icon"><Server size={17}/></span><div className="as-vm-name"><b>{vm.name}</b><small>{vm.publicIp || vm.id}</small></div><span className={`as-status ${/running|healthy|active|succeeded/i.test(vm.status) ? "good" : "warn"}`}>{vm.status}</span></div>)}</div> :
        <div className="as-empty compact"><Server size={21}/><b>{currentCount === 0 ? "No VMs reported" : "VM details unavailable"}</b><span>{isRealInventory ? `Terraform reports ${currentCount} VM(s), but individual VM details are not returned by this endpoint.` : "The current controller endpoint reports simulated inventory only. Connect an Azure inventory endpoint to list real VM names, states and IPs."}</span></div>}
    </section>
  </div>;
}

function Metric({title,value,detail,icon,tone}:{title:string;value:string;detail:string;icon:React.ReactNode;tone:string}) {
  return <div className="as-card as-metric"><div className="as-metric-top"><span>{title}</span><span className={`as-metric-icon ${tone}`}>{icon}</span></div><b>{value}</b><small>{detail}</small></div>;
}

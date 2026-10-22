import { useCallback, useEffect, useState } from "react";
import { Activity, Cloud, Gauge, RefreshCw, Server, SlidersHorizontal, Wifi } from "lucide-react";
import { apiRequest } from "./api";
import Dashboard, { type ControllerState, type AzureInventory } from "./Dashboard";
import Customization from "./Customization";
import "./autoscale-v2.css";

type Page = "dashboard" | "customization";

const emptyState: ControllerState = {
  application: { name: "AutoScale demo", status: "unknown" },
  metrics: { requestsPerMinute: 0, cpuPercent: 0, memoryPercent: 0, healthyInstances: 0, desiredInstances: 0, activeInstances: 0 },
  infrastructure: { target: "azure-vms", instances: [] },
  history: [],
  mode: "unknown",
};

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [state, setState] = useState<ControllerState>(emptyState);
  const [inventory, setInventory] = useState<AzureInventory | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [controller, azure] = await Promise.all([
        apiRequest<ControllerState>("/api/controller/state"),
        apiRequest<AzureInventory>("/api/azure/diagnostics").catch(() => null),
      ]);
      setState({
        ...emptyState,
        ...controller,
        application: { ...emptyState.application, ...controller.application },
        metrics: { ...emptyState.metrics, ...controller.metrics },
        infrastructure: { ...emptyState.infrastructure, ...controller.infrastructure },
        history: Array.isArray(controller.history) ? controller.history : [],
      });
      setInventory(azure);
      setConnected(true);
      setLastRefresh(new Date().toISOString());
    } catch (error) {
      setConnected(false);
      if (!quiet) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Controller API is unavailable." });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const currentCount =
    typeof inventory?.managedCapacity === "number"
      ? inventory.managedCapacity
      : state.metrics.activeInstances ?? state.infrastructure.instances.length;
  const isRealInventory = typeof inventory?.managedCapacity === "number";

  return (
    <div className="as-shell">
      <aside className="as-sidebar">
        <div className="as-brand"><span className="as-brand-icon"><Cloud size={22} /></span><span><b>AutoScale</b><small>Cloud Controller</small></span></div>
        <div className="as-overline">WORKSPACE</div>
        <button className={`as-nav ${page === "dashboard" ? "active" : ""}`} onClick={() => setPage("dashboard")}><Gauge size={18}/> Dashboard</button>
        <button className={`as-nav ${page === "customization" ? "active" : ""}`} onClick={() => setPage("customization")}><SlidersHorizontal size={18}/> Scaling & provisioning</button>
        <div className="as-sidebar-spacer"/>
        <div className="as-connection">
          <div className="as-connection-title"><span className={`as-dot ${connected ? "green" : "red"}`}/><span>Backend connection</span></div>
          <b>{connected ? "Connected" : "Disconnected"}</b>
          <small>Refreshes every 5 seconds</small>
          <button className="as-link-button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14} className={refreshing ? "as-spin" : ""}/> Refresh now</button>
        </div>
        <div className="as-sidebar-footer"><span className="as-avatar">AC</span><span><b>Control panel</b><small>Infrastructure workspace</small></span></div>
      </aside>

      <main className="as-main">
        <header className="as-topbar">
          <div><span className="as-muted">AutoScale</span><span className="as-crumb">/</span><b>{page === "dashboard" ? "Dashboard" : "Scaling & provisioning"}</b></div>
          <div className="as-topbar-right"><span className="as-live-pill"><span className={`as-dot ${connected ? "green" : "red"}`}/>{connected ? (isRealInventory ? "Azure state detected" : "Controller connected") : "Offline"}</span><button className="as-icon-button" onClick={() => void refresh()} aria-label="Refresh" disabled={refreshing}><RefreshCw size={17} className={refreshing ? "as-spin" : ""}/></button></div>
        </header>

        <div className="as-content">
          <div className="as-page-heading">
            <div><div className="as-kicker"><span/> CLOUD CAPACITY CONTROL</div><h1>{page === "dashboard" ? "Infrastructure overview" : "Scaling & provisioning"}</h1><p>{page === "dashboard" ? "See incoming workload, Azure capacity, and service health at a glance." : "Choose how capacity responds to traffic, then review activity and provisioning logs."}</p></div>
            <div className="as-updated"><span className={`as-dot ${connected ? "green" : "amber"}`}/>{lastRefresh ? `Updated ${new Date(lastRefresh).toLocaleTimeString()}` : "Waiting for data"}</div>
          </div>

          {notice && <div className={`as-notice ${notice.tone}`} role="status"><span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}

          {page === "dashboard" ? (
            <Dashboard state={state} connected={connected} currentCount={currentCount} isRealInventory={isRealInventory} inventory={inventory} onManage={() => setPage("customization")} />
          ) : (
            <Customization
              connected={connected}
              currentCount={currentCount}
              requestsPerMinute={state.metrics.requestsPerMinute || 0}
              onNotice={setNotice}
              onRefresh={() => refresh(true)}
            />
          )}

          <footer className="as-footer"><span><Wifi size={14}/> {connected ? "Controller reachable" : "Waiting for controller"}</span><span>AutoScale Cloud Controller · V2.0</span></footer>
        </div>
      </main>
    </div>
  );
}

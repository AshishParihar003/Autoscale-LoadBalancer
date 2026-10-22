import { useEffect, useState } from "react";
import { Activity, CheckCircle2, CircleAlert, Cloud, LoaderCircle, Minus, Plus, RefreshCw, Server, Settings2 } from "lucide-react";
import { apiRequest } from "./api";
import { createTerraformPlan, approveTerraformPlan, updateScalingConfiguration, type ScalingMode, type TerraformPlanResponse } from "./api/terraform";

type Notice = { tone: "success" | "error" | "info"; text: string };
type Log = { time: string; level: "info" | "success" | "error" | "warning"; message: string };
const MAX_VMS = 5;

export default function Customization({ connected, currentCount, requestsPerMinute, onNotice, onRefresh }: {
  connected: boolean; currentCount: number; requestsPerMinute: number; onNotice: (notice: Notice | null) => void; onRefresh: () => Promise<void>;
}) {
  const [mode, setMode] = useState<ScalingMode>("manual");
  const [enabled, setEnabled] = useState(false);
  const [requestsPerVm, setRequestsPerVm] = useState(1000);
  const [targetTraffic, setTargetTraffic] = useState(String(Math.max(0, requestsPerMinute)));
  const [desired, setDesired] = useState(Math.max(0, Math.min(MAX_VMS, currentCount)));
  const [busy, setBusy] = useState<"" | "save" | "plan" | "apply" | "evaluate">("");
  const [plan, setPlan] = useState<TerraformPlanResponse | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [lastResult, setLastResult] = useState<"success" | "error" | null>(null);
  const [resultMessage, setResultMessage] = useState("");
  const [statusText, setStatusText] = useState("Ready");

  useEffect(() => { setDesired(v => Math.min(MAX_VMS, Math.max(0, v))); }, [currentCount]);

  function log(message: string, level: Log["level"] = "info") {
    setLogs(old => [{time:new Date().toLocaleTimeString(), level, message}, ...old].slice(0, 80));
  }
  function errorMessage(e: unknown) { return e instanceof Error ? e.message : "Request failed."; }

  async function saveConfiguration() {
    if (!connected) { onNotice({tone:"error",text:"Start the backend before saving scaling settings."}); return; }
    setBusy("save"); setStatusText("Saving scaling configuration…"); log("Saving scaling configuration.");
    try {
      const response = await updateScalingConfiguration({mode,target:"azure-vms",requestsPerVm,minInstances:0,maxInstances:MAX_VMS,enabled});
      log(response.message || "Scaling configuration saved.", "success");
      setStatusText("Configuration saved");
      onNotice({tone:"success",text:response.message || "Scaling configuration saved."});
    } catch(e) {
      log(errorMessage(e), "error"); setStatusText("Configuration failed"); onNotice({tone:"error",text:errorMessage(e)});
    } finally { setBusy(""); }
  }

  async function evaluateTraffic() {
    setBusy("evaluate"); setStatusText("Evaluating traffic…"); log(`Evaluating workload: ${Math.max(0, Number(targetTraffic)||0)} requests/min.`);
    try {
      const result = await apiRequest<any>("/api/controller/scaling/evaluate",{method:"POST",body:JSON.stringify({requestsPerMinute:Math.max(0,Number(targetTraffic)||0)})});
      log(result.message || `Scaling evaluation: ${result.action || result.decision || "complete"}.`, "success");
      if (result.requiredInstances !== undefined) setDesired(Math.max(0,Math.min(MAX_VMS,Number(result.requiredInstances)||0)));
      setStatusText("Traffic evaluated");
      onNotice({tone:"info",text:result.message || "Traffic evaluated. Review the resulting recommendation."});
    } catch(e) { log(errorMessage(e),"error"); setStatusText("Evaluation failed"); onNotice({tone:"error",text:errorMessage(e)}); }
    finally { setBusy(""); }
  }

  async function createPlan() {
    if (!connected) { onNotice({tone:"error",text:"Backend is offline."}); return; }
    if (desired < 0 || desired > MAX_VMS) { onNotice({tone:"error",text:"Choose between 0 and 5 VMs."}); return; }
    setBusy("plan"); setPlan(null); setLastResult(null); setStatusText("Terraform planning…"); log(`Starting Terraform plan for ${desired} VM(s).`);
    try {
      const result = await createTerraformPlan(desired);
      setPlan(result); setStatusText("Plan ready");
      log(`Plan generated successfully. Plan ID: ${result.planId}`, "success");
      log("Planning does not change Azure resources.", "info");
      onNotice({tone:"success",text:`Terraform plan is ready for ${desired} VM(s). Review the plan below.`});
    } catch(e) { log(`Terraform plan failed: ${errorMessage(e)}`,"error"); setStatusText("Planning failed"); onNotice({tone:"error",text:errorMessage(e)}); }
    finally { setBusy(""); }
  }

  async function applyPlan() {
    if (!plan) return;
    if (!window.confirm(`Apply this exact Terraform plan for ${plan.desiredInstances} VM(s)? This may create billable Azure resources or change existing infrastructure.`)) return;
    setBusy("apply"); setStatusText("Applying infrastructure…"); setLastResult(null); log("Apply started. Waiting for Terraform result…");
    try {
      const result = await approveTerraformPlan(plan.planId,"APPLY");
      const message = result.message || "Terraform apply returned successfully.";
      setLastResult("success"); setResultMessage(message); setStatusText("Apply completed");
      log(message,"success");
      log(`Terraform status: ${result.terraformStatus || result.status || "returned"}.`,"success");
      if (result.ansible) log(`Ansible: ${result.ansible.status}${result.ansible.message ? ` — ${result.ansible.message}` : ""}`,result.ansible.status === "FAILED" ? "error" : "info");
      setPlan(null);
      await onRefresh();
      onNotice({tone:"success",text:"Provisioning completed. Dashboard data refreshed."});
    } catch(e) {
      setLastResult("error"); setResultMessage(errorMessage(e)); setStatusText("Apply failed");
      log(`Apply failed: ${errorMessage(e)}`,"error"); onNotice({tone:"error",text:errorMessage(e)});
    } finally { setBusy(""); }
  }

  return <div className="as-stack">
    <section className="as-card as-custom-hero"><div className="as-custom-icon"><Settings2 size={22}/></div><div><h2>Scaling policy</h2><p>Pick automatic or manual control, set your traffic threshold, and choose a capacity target.</p></div><span className={`as-status ${connected ? "good" : "warn"}`}>{connected ? "Backend connected" : "Backend offline"}</span></section>

    <section className="as-card">
      <div className="as-card-heading"><div><h3>1. Choose scaling mode</h3><p>Automatic mode is intended to provision through a backend policy. Manual mode waits for you to review and approve a plan.</p></div><Activity size={19}/></div>
      <div className="as-mode-grid">
        <button className={`as-mode-option ${mode === "automatic" ? "selected" : ""}`} onClick={()=>setMode("automatic")}><span className="as-radio">{mode==="automatic" ? "✓" : ""}</span><span><b>Automatic scaling</b><small>Evaluate traffic against the threshold and let the backend decide when to scale.</small></span><span className="as-mode-tag">Policy-driven</span></button>
        <button className={`as-mode-option ${mode === "manual" ? "selected" : ""}`} onClick={()=>setMode("manual")}><span className="as-radio">{mode==="manual" ? "✓" : ""}</span><span><b>Manual provisioning</b><small>Review a Terraform plan and click Apply before infrastructure changes.</small></span><span className="as-mode-tag">Approval required</span></button>
      </div>
      <div className="as-setting-grid">
        <label className="as-field"><span>Requests per VM per minute</span><input type="number" min={1} max={1000000} value={requestsPerVm} onChange={e=>setRequestsPerVm(Math.max(1,Number(e.target.value)||1))}/><small>Default: 1,000 requests/min per VM.</small></label>
        <label className="as-field"><span>Traffic target (requests/min)</span><input type="number" min={0} max={1000000} value={targetTraffic} onChange={e=>setTargetTraffic(e.target.value)}/><small>Traffic input is a target/estimate unless real telemetry is configured.</small></label>
      </div>
      <label className="as-toggle"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/><span><b>Enable scaling policy</b><small>Enabling a policy does not prove that live Azure telemetry or automatic apply is connected.</small></span></label>
      <div className="as-action-row"><button className="as-secondary-button" onClick={()=>void saveConfiguration()} disabled={!!busy || !connected}>{busy==="save" ? <LoaderCircle className="as-spin" size={16}/> : <CheckCircle2 size={16}/>} Save policy</button><button className="as-secondary-button" onClick={()=>void evaluateTraffic()} disabled={!!busy || !connected}>{busy==="evaluate" ? <LoaderCircle className="as-spin" size={16}/> : <Activity size={16}/>} Evaluate traffic</button><span className="as-operation-state"><span className={`as-dot ${busy ? "amber" : "green"}`}/>{statusText}</span></div>
      {mode === "automatic" && <div className="as-info-callout"><CircleAlert size={17}/><span>Automatic mode requires a backend worker that connects real traffic/metrics to Terraform plan and apply. This screen calls the current evaluation endpoint; do not treat a recommendation alone as completed automatic provisioning.</span></div>}
    </section>

    <section className="as-card">
      <div className="as-card-heading"><div><h3>2. Provision Azure VMs</h3><p>Set desired capacity. The plan is preview-only until you explicitly apply it.</p></div><Cloud size={19}/></div>
      <div className="as-provision-controls"><div className="as-vm-stepper"><button aria-label="Decrease VM count" onClick={()=>setDesired(n=>Math.max(0,n-1))} disabled={desired<=0 || !!busy}><Minus size={17}/></button><div><b>{desired}</b><small>desired VM{desired===1?"":"s"} · current count {currentCount}</small></div><button aria-label="Increase VM count" onClick={()=>setDesired(n=>Math.min(MAX_VMS,n+1))} disabled={desired>=MAX_VMS || !!busy}><Plus size={17}/></button></div><div className="as-count-buttons">{[0,1,2,3,4,5].map(n=><button key={n} className={desired===n?"chosen":""} onClick={()=>setDesired(n)} disabled={!!busy}>{n}</button>)}</div><button className="as-primary-button" onClick={()=>void createPlan()} disabled={!!busy || !connected}>{busy==="plan" ? <LoaderCircle className="as-spin" size={16}/> : <Server size={16}/>} {busy==="plan" ? "Creating Terraform plan…" : `Create plan for ${desired} VM${desired===1?"":"s"}`}</button></div>
      {plan && <div className="as-plan-box"><div className="as-plan-title"><div><span className="as-eyebrow">PLAN READY</span><h4>Review before applying</h4></div><span className="as-status good">No changes applied yet</span></div><div className="as-plan-meta"><span>Plan ID <b>{plan.planId}</b></span><span>Desired VMs <b>{plan.desiredInstances}</b></span><span>Status <b>{plan.status}</b></span></div><details open><summary>Terraform output</summary><pre>{plan.planOutput}</pre></details><button className="as-primary-button" onClick={()=>void applyPlan()} disabled={!!busy}>{busy==="apply" ? <LoaderCircle className="as-spin" size={16}/> : <CheckCircle2 size={16}/>} {busy==="apply" ? "Applying Azure infrastructure…" : "Confirm & apply this plan"}</button><p className="as-footnote">Apply can create billable resources and change the Azure environment. It uses the backend's configured Azure identity; no private key is requested in this UI.</p></div>}
      {lastResult && <div className={`as-result ${lastResult}`}><div className="as-result-icon">{lastResult==="success" ? <CheckCircle2 size={22}/> : <CircleAlert size={22}/>}</div><div><h4>{lastResult==="success" ? "Provisioning finished" : "Provisioning failed"}</h4><p>{resultMessage}</p>{lastResult==="success" && <p>The dashboard refresh was requested. Check the Azure VM count and instance inventory above.</p>}</div></div>}
    </section>

    <section className="as-card">
      <div className="as-card-heading"><div><h3>3. Activity & logs</h3><p>Planning, apply progress, success messages and errors from this browser session.</p></div><button className="as-text-button" onClick={()=>setLogs([])} disabled={!logs.length}>Clear logs</button></div>
      <div className="as-log-toolbar"><span><span className={`as-dot ${busy ? "amber" : "green"}`}/>{busy ? "Operation in progress" : "Ready for an operation"}</span><button className="as-text-button" onClick={()=>log("Log view refreshed.")}><RefreshCw size={14}/> Refresh log view</button></div>
      {logs.length ? <div className="as-logs" aria-live="polite">{logs.map((item,i)=><div className="as-log-row" key={`${item.time}-${i}`}><time>{item.time}</time><span className={`as-log-level ${item.level}`}>{item.level.toUpperCase()}</span><span className="as-log-message">{item.message}</span></div>)}</div> : <div className="as-empty compact"><Activity size={21}/><b>No operations yet</b><span>When you save settings or create a plan, progress will appear here.</span></div>}
    </section>
  </div>;
}

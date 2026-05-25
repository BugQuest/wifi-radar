import { useEffect } from "react";
import { Scene3D } from "./components/Scene3D";
import { StatsBar } from "./components/StatsBar";
import { DeviceList } from "./components/DeviceList";
import { CSIWaterfall } from "./components/CSIWaterfall";
import { DeviceDetail } from "./components/DeviceDetail";
import { PresencePanel } from "./components/PresencePanel";
import { SensorDiagnostics } from "./components/SensorDiagnostics";
import { SystemPanel } from "./components/SystemPanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { WsClient } from "./lib/ws";
import { useStore } from "./store";

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export default function App() {
  const applyEvent = useStore((s) => s.applyEvent);
  const setConnState = useStore((s) => s.setConnState);

  useEffect(() => {
    const client = new WsClient(wsUrl());
    const off1 = client.on(applyEvent);
    const off2 = client.onState(setConnState);
    client.connect();
    return () => {
      off1();
      off2();
    };
  }, [applyEvent, setConnState]);

  return (
    <div className="h-screen w-screen flex flex-col">
      <StatsBar />
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 relative min-w-0">
          <Scene3D />
          <DeviceDetail />
          <PresencePanel />
          <SensorDiagnostics />
          <SystemPanel />
          <ConfigPanel />
        </div>
        <div className="w-80 shrink-0">
          <DeviceList />
        </div>
      </div>
      <CSIWaterfall />
    </div>
  );
}

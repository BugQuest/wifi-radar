import type { WsEvent } from "./types";

export type WsState = "connecting" | "open" | "closed";

export class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<(ev: WsEvent) => void>();
  private stateListeners = new Set<(s: WsState) => void>();
  private retryDelay = 1000;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    this.setState("connecting");
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.setState("open");
      this.retryDelay = 1000;
    };
    this.ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as WsEvent;
        this.listeners.forEach((cb) => cb(ev));
      } catch {
        // ignore malformed
      }
    };
    this.ws.onclose = () => {
      this.setState("closed");
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 1.5, 8000);
    };
    this.ws.onerror = () => this.ws?.close();
  }

  on(cb: (ev: WsEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onState(cb: (s: WsState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private setState(s: WsState) {
    this.stateListeners.forEach((cb) => cb(s));
  }
}

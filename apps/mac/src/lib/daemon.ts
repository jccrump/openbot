import {
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "@openbot/protocol";

export type DaemonStatus = "connecting" | "connected" | "disconnected";

export const DAEMON_URL =
  (import.meta.env.VITE_OPENBOT_URL as string | undefined) ??
  "ws://127.0.0.1:4170/ws";

export const DAEMON_HTTP_URL = DAEMON_URL.replace(/^ws/, "http").replace(
  /\/ws$/,
  "",
);

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: DaemonStatus) => void;

export class DaemonClient {
  private socket: WebSocket | null = null;
  private messageListeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  status: DaemonStatus = "connecting";

  constructor(private readonly url: string = DAEMON_URL) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private open(): void {
    this.setStatus("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.setStatus("connected");
      this.send({ type: "hello", client: "mac-app" });
    };

    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const result = ServerMessageSchema.safeParse(parsed);
      if (!result.success) {
        console.warn("unrecognized message from daemon", result.error);
        return;
      }
      for (const listener of this.messageListeners) {
        listener(result.data);
      }
    };

    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.setStatus("disconnected");
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) {
        this.open();
      }
    }, 2000);
  }

  private setStatus(status: DaemonStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

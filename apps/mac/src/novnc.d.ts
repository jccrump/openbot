declare module "@novnc/novnc" {
  export interface RfbOptions {
    shared?: boolean;
    credentials?: {
      username?: string;
      password?: string;
      target?: string;
    };
    wsProtocols?: string[];
    repeaterID?: string;
  }

  export interface RfbEvent {
    detail?: unknown;
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    addEventListener(type: string, listener: (event: RfbEvent) => void): void;
    removeEventListener(type: string, listener: (event: RfbEvent) => void): void;
  }
}

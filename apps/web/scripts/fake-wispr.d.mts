/** Types for fake-wispr.mjs (a dependency-free stand-in for the Wispr Flow API). */
export interface FakeWisprOptions {
  host?: string;
  /** 0 = pick a free port (tests) */
  port?: number;
  /** transcripts handed out round-robin */
  texts?: string[];
  /** delay between commit and the final text (default 250 ms) */
  finalDelayMs?: number;
  /** send a partial text before the final */
  partials?: boolean;
  /** send {"status":"info"} events (default true) */
  info?: boolean;
  /** error: {status:error} on commit; drop: kill the socket on commit; silent: never answer; rest-error: HTTP 500 on client_api */
  failMode?: "none" | "error" | "drop" | "silent" | "rest-error";
  /** answer protocol violations with {"status":"error"} and record them (default true) */
  strict?: boolean;
  quiet?: boolean;
  requireToken?: boolean;
  /** close the socket after the final text, like Wispr does (default true) */
  closeAfterFinal?: boolean;
}

export interface FakeWisprStats {
  tokens: number;
  warmups: number;
  connections: number;
  openConnections: number;
  auths: number;
  appends: number;
  packets: number;
  commits: number;
  finals: number;
  restCalls: number;
  violations: string[];
  packetBytes: Set<number>;
  lastTotalPackets: number;
  lastPacketDuration: number;
  lastAuth: {
    hasAccessToken: boolean;
    language: string[] | null;
    dictionaryTerms: number;
    conversationMessages: number;
    appType: string | null;
  } | null;
}

export interface FakeWisprServer {
  port: number;
  host: string;
  /** e.g. http://127.0.0.1:8799/api/v1/dash (what WISPR_BASE should be) */
  httpUrl: string;
  /** ws://.../client_ws */
  wsUrl: string;
  /** http://.../client_api */
  restUrl: string;
  stats: FakeWisprStats;
  setTexts(texts: string[]): void;
  setFailMode(mode: NonNullable<FakeWisprOptions["failMode"]>): void;
  setLatency(ms: number): void;
  close(): Promise<void>;
}

export const CANNED_TEXTS: string[];
export function startFakeWispr(options?: FakeWisprOptions): Promise<FakeWisprServer>;

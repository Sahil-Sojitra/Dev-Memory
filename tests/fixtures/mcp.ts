import { spawn } from "node:child_process";
import { once } from "node:events";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { McpServer, JSONRPCMessage } from "@modelcontextprotocol/server";
import type { ProjectPage } from "../../src/domain/projects.ts";
import { validEnvironment } from "./environment.ts";

export interface WireReply {
  jsonrpc: string;
  id?: number;
  result?: {
    serverInfo?: { name: string };
    capabilities?: { tools?: { listChanged?: boolean } };
    tools?: { name: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }[];
    structuredContent?: ProjectPage & { error?: { code: string; correlationId: string } };
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

function replies(send: (message: JSONRPCMessage) => Promise<void> | void) {
  let id = 0;
  const pending = new Map<number, { resolve: (message: WireReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  return {
    receive(message: WireReply) {
      if (message.id === undefined) return;
      const waiter = pending.get(message.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
    },
    request(method: string, params: Record<string, unknown> = {}): Promise<WireReply> {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("MCP response timeout: " + method)); }, 10_000);
        pending.set(requestId, { resolve, reject, timer });
        Promise.resolve(send({ jsonrpc: "2.0", id: requestId, method, params })).catch((error: unknown) => {
          clearTimeout(timer); pending.delete(requestId); reject(error);
        });
      });
    },
    async initialize() {
      const result = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "devmemory-test", version: "1.0.0" } });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return result;
    },
    dispose() {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("MCP test connection closed")); }
      pending.clear();
    },
  };
}

export async function memoryConnection(server: McpServer) {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const rpc = replies((message) => client.send(message));
  client.onmessage = (message) => rpc.receive(message as WireReply);
  await client.start();
  await server.connect(transport);
  return { ...rpc, close: async () => { rpc.dispose(); await server.close(); await client.close(); } };
}

export function stdioConnection(entry = "dist/index.js", environment: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "./tests/fixtures/projects-preload.mjs", entry], {
    env: { SystemRoot: process.env.SystemRoot, ...validEnvironment, ...environment },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let buffer = "";
  const invalidLines: string[] = [];
  const rpc = replies((message) => { child.stdin.write(JSON.stringify(message) + "\n"); });
  const exit = once(child, "exit");
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString(); buffer += chunk.toString();
    for (let index; (index = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line) as WireReply;
        if (message.jsonrpc !== "2.0") invalidLines.push(line);
        rpc.receive(message);
      } catch { invalidLines.push(line); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return { ...rpc, child, exit, diagnostics: () => ({ stdout, stderr, invalidLines, buffer }),
    close: async () => {
      rpc.dispose();
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2_000);
      try { await exit; } finally { clearTimeout(timer); }
    },
  };
}

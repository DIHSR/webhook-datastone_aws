import assert from "node:assert/strict";
import test from "node:test";
import { worker } from "./src/index.js";
import { DynamoPacingQueue } from "./src/storage.js";

class MemoryStore {
  values = new Map();

  async get(key) {
    return this.values.get(key) || null;
  }

  async put(key, value) {
    this.values.set(key, String(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list() {
    return { keys: [], list_complete: true };
  }
}

const baseEnv = () => ({
  PAYLOADS: new MemoryStore(),
  DATASTONE_TOKEN: "test",
  MCP_API_TOKEN: "mcp-secret",
  PACING: { reservar: async () => ({ recusado: false, espera_ms: 0 }) },
});

test("aceita o preflight do webhook sem token MCP", async () => {
  const response = await worker.fetch(
    new Request("https://mcp.example/webhooks/datastone/token-opaco", { method: "OPTIONS" }),
    baseEnv(),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("protege MCP quando MCP_API_TOKEN esta configurado", async () => {
  const response = await worker.fetch(new Request("https://mcp.example/", { method: "GET" }), baseEnv());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("inicializa MCP com o token correto", async () => {
  const response = await worker.fetch(
    new Request("https://mcp.example/", {
      method: "POST",
      headers: { authorization: "Bearer mcp-secret", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }),
    baseEnv(),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.result.serverInfo.name, "datastone-hub");
});

class CompareAndSetStore {
  value = null;

  async get() {
    return this.value;
  }

  async compareAndSet(_key, expected, value) {
    if (this.value !== expected) return false;
    this.value = value;
    return true;
  }
}

test("a fila reserva slots distintos sem corrida", async () => {
  const queue = new DynamoPacingQueue(new CompareAndSetStore());
  const [first, second] = await Promise.all([
    queue.reservar(11_000, 15_000),
    queue.reservar(11_000, 15_000),
  ]);
  assert.equal(first.recusado, false);
  assert.equal(second.recusado, false);
  assert.equal([first.espera_ms, second.espera_ms].filter((wait) => wait === 0).length, 1);
  assert.equal([first.espera_ms, second.espera_ms].some((wait) => wait >= 10_000), true);
});

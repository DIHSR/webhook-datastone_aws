import { removeExpiredPayloads } from "./storage.js";

export async function handler() {
  const tableName = process.env.PAYLOADS_TABLE_NAME;
  if (!tableName) throw new Error("PAYLOADS_TABLE_NAME nao configurada.");
  const deleted = await removeExpiredPayloads(tableName);
  console.log(JSON.stringify({ event: "expired_payloads_removed", deleted }));
  return { deleted };
}

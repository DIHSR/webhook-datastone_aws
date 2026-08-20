import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { worker } from "./index.js";
import { DynamoPayloadStore, DynamoPacingQueue } from "./storage.js";

let cachedSecrets;
let cachedStore;
let cachedQueue;

export async function handler(event) {
  const env = await runtimeEnv();
  const request = requestFromApiGateway(event, env.PUBLIC_BASE_URL);
  const response = await worker.fetch(request, env);
  return responseForApiGateway(response);
}

async function runtimeEnv() {
  if (!cachedStore) {
    cachedStore = new DynamoPayloadStore(process.env.PAYLOADS_TABLE_NAME);
    cachedQueue = new DynamoPacingQueue(cachedStore);
  }
  if (!cachedSecrets) cachedSecrets = await loadSecrets(process.env.DATASTONE_SECRET_ARN);

  return {
    DATASTONE_TOKEN: cachedSecrets.DATASTONE_TOKEN,
    MCP_API_TOKEN: cachedSecrets.MCP_API_TOKEN,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",
    PAYLOADS: cachedStore,
    PACING: cachedQueue,
  };
}

async function loadSecrets(secretArn) {
  if (!secretArn) throw new Error("DATASTONE_SECRET_ARN nao configurado.");
  const client = new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const raw = result.SecretString || Buffer.from(result.SecretBinary || "", "base64").toString("utf8");
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    values = { DATASTONE_TOKEN: raw };
  }
  if (!values.DATASTONE_TOKEN) {
    throw new Error("O segredo deve conter a chave DATASTONE_TOKEN.");
  }
  return values;
}

function requestFromApiGateway(event, publicBaseUrl) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers || {})) {
    if (value !== undefined && value !== null) headers.set(name, value);
  }

  const origin = (publicBaseUrl || inferredOrigin(headers)).replace(/\/$/, "");
  const rawPath = event.rawPath || event.requestContext?.http?.path || "/";
  const rawQuery = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const hasBody = event.body !== undefined && event.body !== null && !["GET", "HEAD"].includes(method);
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body
    : undefined;

  return new Request(`${origin}${rawPath}${rawQuery}`, { method, headers, body });
}

function inferredOrigin(headers) {
  const host = headers.get("x-forwarded-host") || headers.get("host");
  if (!host) throw new Error("Nao foi possivel determinar a URL publica da requisicao.");
  const protocol = headers.get("x-forwarded-proto") || "https";
  return `${protocol}://${host}`;
}

async function responseForApiGateway(response) {
  const headers = Object.fromEntries(response.headers.entries());
  const body = response.status === 204 || response.status === 304 || response.status === 200 && !response.body
    ? ""
    : await response.text();
  return { statusCode: response.status, headers, body, isBase64Encoded: false };
}

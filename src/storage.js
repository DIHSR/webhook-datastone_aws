import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const PACE_KEY = "pace:global";

/**
 * Pequena camada de compatibilidade para a API KV usada pelo MCP.
 *
 * A tabela tem somente a chave de particao `pk`; cada registro traz um valor string
 * e `expires_at`, o atributo TTL do DynamoDB. Leitura tambem filtra a expiracao,
 * pois a limpeza fisica do DynamoDB e assincrona.
 */
export class DynamoPayloadStore {
  constructor(tableName, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {
    if (!tableName) throw new Error("PAYLOADS_TABLE_NAME nao configurada.");
    this.tableName = tableName;
    this.client = client;
  }

  async get(key) {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: key }, ConsistentRead: true }),
    );
    const item = result.Item;
    if (!item) return null;
    if (item.expires_at && item.expires_at <= epochSeconds()) {
      // Nao espera a remocao assincorna do TTL para deixar dado pessoal acessivel.
      await this.delete(key);
      return null;
    }
    return item.value ?? null;
  }

  async put(key, value, options = {}) {
    const item = { pk: key, value: String(value) };
    if (options.expirationTtl) item.expires_at = epochSeconds() + Number(options.expirationTtl);
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async delete(key) {
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: key } }));
  }

  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [];
    let lastEvaluatedKey;
    const now = epochSeconds();

    do {
      const remaining = Math.max(1, limit - keys.length);
      const result = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          ProjectionExpression: "pk",
          FilterExpression: "begins_with(pk, :prefix) AND (attribute_not_exists(expires_at) OR expires_at > :now)",
          ExpressionAttributeValues: { ":prefix": prefix, ":now": now },
          Limit: remaining,
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      keys.push(...(result.Items || []).map((item) => ({ name: item.pk })));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey && keys.length < limit);

    return { keys, list_complete: !lastEvaluatedKey };
  }

  /** Atualizacao condicional usada pela fila global de pacing. */
  async compareAndSet(key, expectedValue, value, expirationTtl) {
    const item = {
      pk: key,
      value: String(value),
      expires_at: epochSeconds() + expirationTtl,
    };
    const input = {
      TableName: this.tableName,
      Key: { pk: key },
      UpdateExpression: "SET #value = :value, expires_at = :expiresAt",
      ExpressionAttributeNames: { "#value": "value" },
      ExpressionAttributeValues: { ":value": item.value, ":expiresAt": item.expires_at },
    };
    if (expectedValue === null) {
      input.ConditionExpression = "attribute_not_exists(pk)";
    } else {
      input.ConditionExpression = "#value = :expected";
      input.ExpressionAttributeValues[":expected"] = expectedValue;
    }

    try {
      await this.client.send(new UpdateCommand(input));
      return true;
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
}

/**
 * Reserva atomicamente uma vaga na fila. Nao ha fallback sem coordenacao: em caso de
 * falha preferimos recusar a chamada a permitir uma rajada que pode bloquear a API.
 */
export class DynamoPacingQueue {
  constructor(store) {
    this.store = store;
  }

  async reservar(pacingMs, maxWaitMs) {
    for (let tentativa = 0; tentativa < 20; tentativa += 1) {
      const raw = await this.store.get(PACE_KEY);
      const previousSlot = Number(raw) || 0;
      const now = Date.now();
      const start = Math.max(now, previousSlot);
      const wait = start - now;
      if (wait > maxWaitMs) return { recusado: true, espera_ms: wait };

      // O TTL e apenas limpeza do registro; cobre a maior fila admitida com folga.
      const saved = await this.store.compareAndSet(PACE_KEY, raw, start + pacingMs, 180);
      if (saved) return { recusado: false, espera_ms: wait };
    }
    throw new Error("Concorrencia alta ao reservar a fila de saida.");
  }
}

/**
 * O TTL do DynamoDB e uma limpeza de melhor esforco e pode levar dias. Esta tarefa
 * programada remove fisicamente os itens vencidos em lotes para que os corpos de
 * webhook (que podem conter CPF) nao fiquem aguardando somente o processo TTL.
 */
export async function removeExpiredPayloads(tableName, maxItems = 1000) {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const expiredKeys = [];
  let lastEvaluatedKey;
  const now = epochSeconds();

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "pk",
        FilterExpression: "attribute_exists(expires_at) AND expires_at <= :now",
        ExpressionAttributeValues: { ":now": now },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    expiredKeys.push(...(result.Items || []).map((item) => ({ pk: item.pk })));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey && expiredKeys.length < maxItems);

  let deleted = 0;
  for (let index = 0; index < expiredKeys.length; index += 25) {
    let pending = expiredKeys.slice(index, index + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; pending.length && attempt < 4; attempt += 1) {
      const result = await client.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
      );
      pending = result.UnprocessedItems?.[tableName] || [];
    }
    deleted += expiredKeys.slice(index, index + 25).length - pending.length;
  }
  return deleted;
}

function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

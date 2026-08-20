# MCP Data Stone na AWS

Este projeto roda o servidor MCP e o receptor de webhooks na mesma URL publica, usando API Gateway HTTP API, AWS Lambda e DynamoDB. O corpo dos webhooks fica no DynamoDB por uma hora; metadados de correlacao e diagnostico ficam por sete dias. Uma Lambda programada remove fisicamente os itens vencidos a cada 15 minutos.

## Antes de publicar

1. Instale Node.js 22, AWS CLI e AWS SAM CLI.
2. Crie um segredo no AWS Secrets Manager na mesma regiao do deploy. O valor deve ser JSON:

   ```json
   {"DATASTONE_TOKEN":"token-da-api","MCP_API_TOKEN":"token-longo-aleatorio"}
   ```

   `MCP_API_TOKEN` e opcional, mas fortemente recomendado: ele protege as rotas MCP e `/diagnostico`; a rota de webhook permanece publica para a Data Stone e e protegida pelo token opaco, aleatorio, gerado por disparo.

3. Instale as dependencias e valide o projeto:

   ```bash
   npm install
   npm run check
   npm test
   sam validate --lint
   ```

## Deploy

```bash
sam build
sam deploy --guided
```

No assistente, informe o ARN do segredo em `DataStoneSecretArn`. `PublicBaseUrl` pode ficar vazio ao usar diretamente o endpoint gerado pelo API Gateway. Caso use dominio proprio, informe `https://mcp.seudominio.com` para que os callbacks enviados a Data Stone usem esse dominio.

A saida `McpEndpoint` e a URL a cadastrar no cliente MCP. Se o segredo incluir `MCP_API_TOKEN`, configure o cabeçalho `Authorization: Bearer <MCP_API_TOKEN>` no cliente. Sem esse token, qualquer pessoa que descubra o endpoint podera chamar ferramentas que consomem creditos.

## Limites importantes

- O API Gateway HTTP API aceita corpos de ate 10 MB, mas cada item do DynamoDB aceita no maximo 400 KB. Se os webhooks forem maiores que isso, migre somente o corpo para S3 e mantenha metadados no DynamoDB.
- A expiracao logica e aplicada pelo codigo em toda leitura. A Lambda de limpeza remove itens expirados a cada 15 minutos; o TTL nativo do DynamoDB continua como salvaguarda.
- A Lambda espera no maximo 15 s por uma vaga da fila de saida. Esse teto deixa tempo para a chamada externa antes do limite de 30 s do API Gateway e preserva o espacamento de 11 s entre chamadas externas.

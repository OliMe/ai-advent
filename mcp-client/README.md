# mcp-client

Адаптер MCP-серверов к абстракции **`ToolSet`** ядра `core`. Подключается к нескольким
серверам (stdio / Streamable HTTP), агрегирует их инструменты в единый набор для агентов
(`Conversation`), поддерживает **рантайм add/remove** сервера.

> Использует официальный `@modelcontextprotocol/sdk` (осознанное исключение из правила
> «без сторонних SDK», как `mcp-probe`/`yandex-ocr-mcp`). Ядро о SDK не знает — `mcp-client`
> реализует его узкий контракт `ToolSet`.

## Что внутри

| Файл                 | Назначение                                                              |
| -------------------- | ----------------------------------------------------------------------- |
| `src/config.ts`      | `McpServerConfig` + разбор карты `mcpServers` (`parseServers`)           |
| `src/tool-mapping.ts`| MCP `tools/list` → `ToolSpec` ядра; текст из результата вызова           |
| `src/tool-set.ts`    | `McpToolSet` — агрегатор (add/remove/specs/call/close), неймспейс инструментов |
| `src/connection.ts`  | Реальное подключение поверх SDK + `connectionFactory(onElicit)` (тонкая обвязка, исключена из покрытия) |
| `src/index.ts`       | Barrel                                                                   |

Инструменты неймспейсятся как **`сервер__инструмент`** (от коллизий имён): вызов
`yandex-ocr__recognize-text` маршрутизируется в сервер `yandex-ocr`, инструмент `recognize-text`.

## Использование

```ts
import { McpToolSet, createConnection, parseServers } from 'mcp-client';

const toolSet = new McpToolSet(createConnection);
for (const [name, config] of parseServers(mcpJson)) {
  await toolSet.addServer(name, config);
}
// toolSet — это ToolSet ядра: передаётся агенту через ConversationConfig.tools
// ...
await toolSet.close();
```

`McpToolSet` принимает фабрику подключения (`ConnectFn`) — в проде это `createConnection`
(SDK), в тестах — фейк, поэтому вся логика агрегатора покрыта на 100% без реального SDK.

### Подтверждения от сервера (MCP elicitation)

`connectionFactory(onElicit)` возвращает `ConnectFn`, у которого клиент объявляет capability
`elicitation` и переадресует серверные запросы `elicitation/create` обработчику приложения. Так
сервер (например `filesystem-mcp`) может в рантайме спросить у пользователя разрешение на операцию;
`createConnection` — это `connectionFactory()` без обработчика (поведение по умолчанию).

```ts
const connect = connectionFactory(async ({ message }) => ({
  action: (await askUser(message)) ? 'accept' : 'decline',
}));
const toolSet = new McpToolSet(connect);
```

## Команды

```bash
npm run typecheck       # tsc
npm test                # node:test + покрытие 100/100/100 (connection.ts исключён)
npm run write-prettier  # форматирование
```

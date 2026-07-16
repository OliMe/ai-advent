// Общий пакет «обоснованный ответ»: кэш RAG-индекса доков + анти-галлюцинационный цитатный гейт.
// Вынесен из `pr-reviewer` (кэш индекса) и `llm-cli` (цитатный гейт), чтобы им пользовались все
// потребители (ревью PR, ассистент поддержки, интерактивный CLI), не дублируя логику.
export * from './index-cache.ts';
export * from './rag-cache.ts';
export * from './rag-answer.ts';
export * from './citation-guard.ts';
export * from './evidence.ts';
export * from './faithfulness.ts';

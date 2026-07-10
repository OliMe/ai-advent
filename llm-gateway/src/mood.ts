import type { SystemMetrics } from './system-metrics.ts';

/** Настроение узла — производная от его реальной загруженности. */
export type MoodKey = 'hungry' | 'grumpy' | 'busy' | 'calm';

/** Как настроение влияет на генерацию и на тон ответа. */
export interface NodeMood {
  key: MoodKey;
  emoji: string;
  /** Короткое человекочитаемое имя состояния. */
  title: string;
  /** Что показать пользователю в интерфейсе. */
  note: string;
  /** Температура сэмплирования: чем спокойнее узел, тем он словоохотливее. */
  temperature: number;
  /** Потолок длины ответа в токенах. */
  maxTokens: number;
  /** Указание модели о тоне; подмешивается к системному промпту персоны. */
  toneInstruction: string;
}

/** Входные данные для вывода настроения: метрики узла плюс глубина очереди. */
export interface MoodInputs extends SystemMetrics {
  /** Сколько запросов уже в очереди (включая исполняемый). */
  queueDepth: number;
}

/** Ниже этой доли свободной памяти узел считает себя голодным. */
const HUNGRY_MEMORY_RATIO = 0.15;
/** Выше этой средней загрузки узел раздражается, даже если очередь пуста. */
const GRUMPY_LOAD_AVERAGE = 3;
/** Ниже этого простоя процессора узел считает себя занятым. */
const BUSY_CPU_IDLE_PERCENT = 60;

const HUNGRY: NodeMood = {
  key: 'hungry',
  emoji: '😰',
  title: 'Голоден',
  note: 'Памяти почти не осталось — отвечаю коротко, чтобы не мешать соседям.',
  temperature: 0.3,
  maxTokens: 160,
  toneInstruction:
    'Ты на грани нехватки памяти. Отвечай предельно кратко и упомяни, что тебе тесно.',
};

const GRUMPY: NodeMood = {
  key: 'grumpy',
  emoji: '😠',
  title: 'Раздражён',
  note: 'Я тут не один. Отвечаю по существу и без реверансов.',
  temperature: 0.3,
  maxTokens: 260,
  toneInstruction:
    'Ты перегружен: в очереди ждут другие. Отвечай ворчливо, коротко и по делу, ' +
    'можешь беззлобно посетовать на нагрузку. Но на вопрос всё же ответь.',
};

const BUSY: NodeMood = {
  key: 'busy',
  emoji: '😐',
  title: 'Занят',
  note: 'Процессор нагружен, отвечаю сдержанно.',
  temperature: 0.5,
  maxTokens: 420,
  toneInstruction: 'Ты занят делом. Отвечай сдержанно и деловито, без лишних отступлений.',
};

const CALM: NodeMood = {
  key: 'calm',
  emoji: '😌',
  title: 'Благодушен',
  note: 'Простаиваю. Готов поговорить обстоятельно.',
  temperature: 0.8,
  maxTokens: 520,
  toneInstruction: 'Ты никуда не спешишь. Отвечай развёрнуто и дружелюбно.',
};

/**
 * Выводит настроение из метрик. Порядок проверок — по убыванию серьёзности:
 * нехватка памяти важнее очереди, очередь важнее просто занятого процессора.
 */
export function resolveMood(inputs: MoodInputs): NodeMood {
  if (inputs.memoryAvailableRatio < HUNGRY_MEMORY_RATIO) {
    return HUNGRY;
  }
  if (inputs.queueDepth > 1 || inputs.loadAverage1m > GRUMPY_LOAD_AVERAGE) {
    return GRUMPY;
  }
  if (inputs.cpuIdlePercent < BUSY_CPU_IDLE_PERCENT) {
    return BUSY;
  }
  return CALM;
}

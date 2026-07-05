/** Типы RAG-индексатора: документ → чанки (+метаданные) → индекс с эмбеддингами. */

/** Стратегия разбиения на чанки. */
export type ChunkStrategy = 'fixed' | 'structural';

/** Загруженный документ-источник (одна единица: файл / страница). */
export interface Document {
  /** Откуда взят документ в целом (путь к папке / URL / репозиторий). */
  source: string;
  /** Конкретный файл/страница внутри источника (относительный путь / URL). */
  file: string;
  /** Человекочитаемое имя (имя файла / заголовок страницы). */
  title: string;
  /** Текст документа. */
  text: string;
}

/** Чанк документа с метаданными (без эмбеддинга). */
export interface Chunk {
  /** Уникальный идентификатор чанка. */
  chunk_id: string;
  source: string;
  file: string;
  title: string;
  /** Раздел/символ внутри файла (заголовок md, имя файла, и т.п.). */
  section: string;
  text: string;
}

/** Чанк вместе с вектором эмбеддинга. */
export interface IndexedChunk extends Chunk {
  embedding: number[];
}

/** Локальный индекс: метаданные сборки + проиндексированные чанки. */
export interface Index {
  /** Стратегия чанкинга, которой собран индекс. */
  strategy: ChunkStrategy;
  /** Модель эмбеддингов. */
  model: string;
  /** Размерность векторов. */
  dimensions: number;
  /** Момент сборки (ISO); проставляется вызывающим (в логике времени нет). */
  createdAt: string;
  /**
   * Основной человеческий язык документации (английское название: English/Russian/…). Опционально:
   * `rag` его не проставляет — заполняет ЛЕНИВО потребитель (rag-mcp) при первом ретриве и дозаписывает
   * в кэш; нужен для кросс-язычного rewrite (перевод/HyDE на язык корпуса).
   */
  language?: string;
  chunks: IndexedChunk[];
}

/** Параметры стратегии fixed: размер чанка и перекрытие в символах. */
export interface FixedOptions {
  size: number;
  overlap: number;
}

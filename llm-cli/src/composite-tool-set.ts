import type { ToolSet, ToolSpec } from '../../core/src/index.ts';

/**
 * Объединяет несколько наборов инструментов в один. specs — конкатенация; call направляется
 * первому набору, у которого есть инструмент с таким именем. Позволяет дать агенту и инструменты
 * MCP, и чисто клиентские (например get_my_location) одновременно.
 */
export class CompositeToolSet implements ToolSet {
  private readonly sets: ToolSet[];

  constructor(sets: ToolSet[]) {
    this.sets = sets;
  }

  specs(): ToolSpec[] {
    return this.sets.flatMap(set => set.specs());
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const target = this.sets.find(set => set.specs().some(spec => spec.name === name));
    if (target === undefined) {
      throw new Error(`Инструмент не найден: ${name}`);
    }
    return target.call(name, args);
  }
}

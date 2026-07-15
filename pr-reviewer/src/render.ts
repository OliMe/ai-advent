import type { Finding, FindingSeverity } from './schema.ts';
import type { ValidatedFindings } from './validate.ts';
import type { ReviewPublication, InlineComment } from './platform.ts';

/** Человекочитаемая метка категории для тела комментария. */
const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  bug: '🐞 Баг',
  architecture: '🏛 Архитектура',
  recommendation: '💡 Рекомендация',
  nitpick: '🔧 Мелочь',
};

/** Тело инлайн-комментария из находки: метка категории + заголовок + пояснение. */
export function renderComment(finding: Finding): string {
  const heading = `**${SEVERITY_LABEL[finding.severity]}: ${finding.title}**`;
  return finding.body.trim() === '' ? heading : `${heading}\n\n${finding.body}`;
}

/** Строка находки в сводке (для тех, что не легли на комментируемую строку). */
function renderGeneralLine(finding: Finding): string {
  return `- ${SEVERITY_LABEL[finding.severity]} — \`${finding.file}:${finding.line}\` — ${finding.title}`;
}

/**
 * Собирает публикацию ревью: инлайн-комментарии из легших находок + сводный текст. В сводку идёт
 * `summary` модели, а под ним — находки, НЕ легшие на комментируемую строку (не теряем их и не
 * выдумываем координаты). Совсем пустое ревью → доброжелательная строка вместо пустоты.
 */
export function buildPublication(summary: string, validated: ValidatedFindings): ReviewPublication {
  const comments: InlineComment[] = validated.inline.map(finding => ({
    file: finding.file,
    line: finding.line,
    body: renderComment(finding),
  }));

  const parts: string[] = [];
  const header = summary.trim();
  if (header !== '') {
    parts.push(header);
  }
  if (validated.general.length > 0) {
    parts.push(
      `**Замечания без точной привязки к строке:**\n${validated.general
        .map(renderGeneralLine)
        .join('\n')}`,
    );
  }
  if (comments.length === 0 && validated.general.length === 0 && header === '') {
    parts.push('AI-ревью: замечаний не найдено. 👍');
  }
  return { summary: `## 🤖 AI-ревью\n\n${parts.join('\n\n')}`, comments };
}

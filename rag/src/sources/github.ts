/** GitHub ли это URL. */
export function isGithubUrl(input: string): boolean {
  try {
    return new URL(input).hostname === 'github.com';
  } catch {
    return false;
  }
}

/**
 * URL tar.gz-архива репозитория по ссылке на github.com (codeload — один HTTP, без истории,
 * быстрее `git clone`). Ветка по умолчанию HEAD (дефолтная ветка репозитория).
 */
export function githubTarballUrl(repoUrl: string, branch = 'HEAD'): string {
  const url = new URL(repoUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname !== 'github.com' || parts.length < 2) {
    throw new Error(`Не похоже на GitHub-репозиторий: ${repoUrl}`);
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${branch}`;
}

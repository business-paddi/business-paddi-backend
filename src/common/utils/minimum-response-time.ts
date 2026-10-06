export async function enforceMinimumResponseTime(
  startedAt: number,
  minimumMilliseconds = 750,
): Promise<void> {
  const remaining = minimumMilliseconds - (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}

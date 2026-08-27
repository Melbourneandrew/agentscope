export function captureIssueFocus(activeElement, issueId) {
  if (!activeElement || activeElement.dataset?.id !== issueId) return null;
  return { issueId, surface: activeElement.closest?.("#issue-list") ? "list" : "graph" };
}

export function restoreIssueFocus({ graph, issueList }, target) {
  if (!target) return false;
  const container = target.surface === "list" ? issueList : graph;
  const replacement = [...container.querySelectorAll("[data-id]")].find(
    (element) => element.dataset.id === target.issueId,
  );
  if (!replacement) return false;
  replacement.focus();
  return true;
}

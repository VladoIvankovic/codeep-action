/**
 * Throwaway fixture for smoke-testing the `fix` path end to end.
 *
 * Contains two defects the offline reviewer flags deterministically. This
 * branch is not meant to merge — it exists so a real pull request produces
 * real findings and the fix agent has something to actually do.
 */

export async function loadAll(ids, fetchOne) {
  return Promise.all(ids.map((id) => fetchOne(id)));
}

export function render(el, name) {
  const span = document.createElement('span');
  span.textContent = name;
  el.replaceChildren(span);
}

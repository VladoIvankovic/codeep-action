/**
 * Throwaway fixture for smoke-testing the `fix` path end to end.
 *
 * Contains two defects the offline reviewer flags deterministically. This
 * branch is not meant to merge — it exists so a real pull request produces
 * real findings and the fix agent has something to actually do.
 */

export async function loadAll(ids, fetchOne) {
  const out = [];
  // foreach-await: sequential when it does not need to be.
  ids.forEach(async (id) => {
    out.push(await fetchOne(id));
  });
  return out;
}

export function render(el, name) {
  // inner-html: unescaped interpolation into the DOM.
  el.innerHTML = '<span>' + name + '</span>';
}

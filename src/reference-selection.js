export function suggestReferences(project, clip) {
  const result = { selected: [], missing: [], ambiguous: [], overflow: [], reasons: [], warnings: [] };
  if (clip.mode !== 'reference') return result;

  const targets = [...new Set(clip.activeCharacterIds)].map(id => ({ type: 'character', id }));
  if (clip.activeLocationId) targets.push({ type: 'location', id: clip.activeLocationId });
  const choices = new Map();
  for (const target of targets) {
    const candidates = project.refs.filter(ref =>
      (ref.assetType === target.type || ref.assetType === 'group') && ref.assetIds.includes(target.id)
    );
    const canonical = candidates.filter(ref => ref.canonical);
    const preferred = canonical.length ? canonical : candidates;
    if (!preferred.length) {
      result.missing.push(target);
    } else if (preferred.length > 1) {
      result.ambiguous.push({ ...target, referenceIds: preferred.map(ref => ref.id).sort() });
    } else {
      const ref = preferred[0];
      if (!choices.has(ref.id)) choices.set(ref.id, { ref, targets: [] });
      choices.get(ref.id).targets.push(target);
    }
  }

  const ordered = [...choices.values()].sort((a, b) => Number(b.ref.canonical) - Number(a.ref.canonical));
  for (const { ref, targets: covered } of ordered) {
    const entry = { id: ref.id, role: ref.role };
    const destination = result.selected.length < 5 ? result.selected : result.overflow;
    destination.push(entry);
    result.reasons.push({ id: ref.id, targets: covered, reason: ref.canonical ? 'canonical' : 'unique', overflow: destination === result.overflow });
  }
  if (result.overflow.length) result.warnings.push('Beşten fazla referans gerekiyor; klibi bölmeyi değerlendirin.');
  return result;
}

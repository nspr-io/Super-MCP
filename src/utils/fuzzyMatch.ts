const MAX_LEVENSHTEIN_DISTANCE = 3;

function canonicalize(name: string): string {
  return name.replace(/[-_]/g, "").toLowerCase();
}

function normalizeMatch(a: string, b: string): boolean {
  return canonicalize(a) === canonicalize(b);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let previous = i - 1;
    row[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + substitutionCost,
      );
      previous = current;
    }
  }

  return row[b.length];
}

export function findBestMatch(unknownField: string, validFields: string[]): string | null {
  if (!unknownField || validFields.length === 0) {
    return null;
  }

  const normalizedMatch = validFields.find((field) => normalizeMatch(unknownField, field));
  if (normalizedMatch) {
    return normalizedMatch;
  }

  let bestMatch: string | null = null;
  let bestDistance = MAX_LEVENSHTEIN_DISTANCE + 1;

  for (const field of validFields) {
    const distance = levenshtein(unknownField.toLowerCase(), field.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = field;
    }
  }

  return bestMatch;
}

export const resultFields = [
  { name: 'submission_id', type: 'text', required: true, max: 36 },
  { name: 'username', type: 'text', max: 64 },
  { name: 'status', type: 'select', required: true, maxSelect: 1, values: ['completed', 'failed', 'cancelled'] },
  { name: 'country', type: 'text', max: 2 },
  { name: 'asn', type: 'number', min: 0, max: 4294967295, onlyInt: true },
  { name: 'production_mbps', type: 'number', min: 0 },
  { name: 'comparison_mbps', type: 'number', min: 0 },
  { name: 'results', type: 'json', required: true, maxSize: 65536 },
];
export function uniqueIndex(collection) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(collection)) throw new Error('Collection name must be an SQL-safe identifier.');
  return `CREATE UNIQUE INDEX idx_${collection}_submission ON ${collection} (submission_id)`;
}
